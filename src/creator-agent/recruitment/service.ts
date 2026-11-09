import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { approvalScopeSchema, principalSchema, trustedHumanSchema, type ApprovalPrincipal, type ApprovalRead, type ApprovalScope, type ApprovalSources, type TrustedHuman } from "../approvals/contract.ts";
import type { NativeApprovalView, NativeRunView } from "../actions/views.ts";
import type { ReviewField, ReviewLink } from "../actions/reviewViews.ts";
import type { OfferRepository } from "../offers/repository.ts";
import type { CommercialProjection, CommercialProjectionContext } from "../commercialPolicy/projection.ts";
import type { DispatchRead } from "../jobs/dispatchSchema.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { ActionServiceError } from "../actions/contract.ts";
import { InvitationDraftRepository, type InvitationBasis } from "./drafts.ts";
import { createRecruitmentActionDomain } from "./proposalBridge.ts";
import { invitationFiltersSchema, recruitmentBatchFiltersSchema, nativeInvitationViewSchema, nativeRecruitmentBatchSchema,
  invitationSaveSchema, type InvitationSaveReceipt, type NativeInvitationView, type NativeRecruitmentBatch } from "./contract.ts";
import { invitationSourceSchema, recruitmentBatchSourceSchema, RECRUITMENT_SOURCE_MAX_AGE_MS, RecruitmentError,
  type RecruitmentSource, type RecruitmentSourceRequest, type RecruitmentSnapshot, type RecruitmentInvitationOwner } from "./source.ts";

export type RecruitmentServiceOptions = {
  scope: ApprovalScope; referenceKey: string; now?: () => number; source?: RecruitmentSource; authority: ApprovalSources;
  offers: Pick<OfferRepository, "readOffer">;
  commercial: { project(input: CommercialProjectionContext): CommercialProjection };
  actions: {
    readApproval(ref: string, principal: ApprovalPrincipal): Promise<NativeApprovalView>;
    readRun(ref: string, principal: ApprovalPrincipal): Promise<NativeRunView>;
  };
  records: {
    readApproval(ref: string): ApprovalRead | null;
    readRun(ref: string): DispatchRead;
  };
  drafts?: InvitationDraftRepository;
  invitationOwner?: RecruitmentInvitationOwner;
  timeoutMs?: number;
  permittedLinkOrigins?: readonly string[];
};
type Projection<T> = { data: T; assertCurrent(): void };
const secretPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b(?:Bearer\s+\S+|(?:password|cookie|access_token|refresh_token|session_token|api[_ -]?key)\s*[:=]\s*\S+)|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:ghp_|github_pat_|xoxb-|sk_live_)[A-Za-z0-9_-]{12,}/i;
const hidden = (code = "RECRUITMENT_FIELD_UNAVAILABLE"): ReviewField => ({ state: "unavailable", value: null, reasonCode: code });
const field = (value: ReviewField): ReviewField => value.value !== null && (secretPattern.test(value.value) || /(?:\+?\d[\s().-]*){10,}/.test(value.value))
  ? hidden("RECRUITMENT_PRIVATE_MATERIAL_WITHHELD") : structuredClone(value);
const runMaterial = (run: DispatchRead) => ({ ...run, run: { ...run.run, observedAt: null } });
const freeze = <T>(value:T):T => { if(value&&typeof value==="object") { Object.freeze(value); for(const child of Object.values(value))freeze(child); } return value; };

/** Views compose existing offers/J04/jobs. This service owns no approval or execution ledger. */
export function createRecruitmentService(options: RecruitmentServiceOptions) {
  const scope = approvalScopeSchema.parse(structuredClone(options.scope));
  if (options.referenceKey.length < 32) throw new Error("Recruitment references require a private server key.");
  const key = options.referenceKey, source = options.source;
  const timeoutMs=options.timeoutMs??10_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10_000)throw new Error("Recruitment source timeout must be bounded.");
  const now = () => { const value = (options.now ?? Date.now)(); if (!Number.isSafeInteger(value)) throw new RecruitmentError("INVALID_CLOCK", 500); return value; };
  const fail = (code: string, status = 409): never => { throw new RecruitmentError(code, status); };
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", key).update(JSON.stringify([scope, kind, value])).digest("hex");
  const origins = new Set((options.permittedLinkOrigins ?? []).map(origin => {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Recruitment link origins must be exact HTTPS origins.");
    return origin;
  }));
  const link = (value: ReviewLink, synthetic:boolean): ReviewLink => {
    if (value.state !== "available") return structuredClone(value);
    const url = new URL(value.url);
    if (synthetic || !origins.has(url.origin) || url.username || url.password || url.hash ||
        [...url.searchParams.keys()].some(name => /token|secret|auth|session|cookie|key/i.test(name)) || secretPattern.test(value.label))
      return { state: "unavailable", url: null, label: "Open source record", reasonCode: "RECRUITMENT_LINK_WITHHELD" };
    return { ...value, label: "Open source record" };
  };
  function assertActor(actor: TrustedHuman, principal: ApprovalPrincipal) {
    const timestamp = now(), observed = Date.parse(actor.observedAt), until = Date.parse(actor.validUntil);
    if (digest(actor.scope) !== digest(scope) || actor.principalRef !== principal.principalRef || !actor.active ||
        observed > timestamp || until <= timestamp || until <= observed || until - observed > RECRUITMENT_SOURCE_MAX_AGE_MS)
      fail("RECRUITMENT_ACTOR_DENIED", 403);
    if (!options.authority.assertCurrent) fail("RECRUITMENT_AUTHORITY_UNAVAILABLE", 403);
    try { assertSynchronousVoid(() => options.authority.assertCurrent!({ scope, actor: structuredClone(actor), slack: null, linearRecords: [] }, timestamp)); }
    catch { fail("RECRUITMENT_ACTOR_DENIED", 403); }
  }
  async function actorFor(input: ApprovalPrincipal) {
    const principal = principalSchema.parse(structuredClone(input));
    if (!options.authority.resolveActor) fail("RECRUITMENT_AUTHORITY_UNAVAILABLE", 403);
    let raw: unknown;
    try { raw = await boundedSourceRead(()=>options.authority.resolveActor!(principal.principalRef, scope),undefined,timeoutMs); }
    catch { return fail("RECRUITMENT_ACTOR_DENIED", 403); }
    const parsed = trustedHumanSchema.safeParse(raw);
    if (!parsed.success) return fail("RECRUITMENT_ACTOR_DENIED", 403);
    const actor = freeze(structuredClone(parsed.data));
    assertActor(actor, principal);
    return { actor, principal };
  }
  function assertSource(request: RecruitmentSourceRequest, snapshot: RecruitmentSnapshot, principal: ApprovalPrincipal) {
    assertActor(request.actor, principal);
    const timestamp = now(), observed = Date.parse(snapshot.observedAt), until = Date.parse(snapshot.validUntil);
    if (snapshot.kind !== request.kind || digest(snapshot.binding.scope) !== digest(scope) ||
        snapshot.binding.principalRef !== request.actor.principalRef || snapshot.binding.directoryVersion !== request.actor.directoryVersion ||
        digest(snapshot.filters) !== digest(request.filters)) fail("RECRUITMENT_SOURCE_SCOPE_DENIED", 403);
    if (snapshot.permission === "denied") fail("RECRUITMENT_SOURCE_SCOPE_DENIED", 403);
    if (snapshot.permission !== "permitted") fail("RECRUITMENT_PERMISSION_UNVERIFIED", 503);
    if (observed > timestamp || until <= timestamp || until <= observed || until - observed > RECRUITMENT_SOURCE_MAX_AGE_MS)
      fail("RECRUITMENT_SOURCE_STALE");
    if (!source) fail("INTEGRATION_PENDING", 503);
    try { assertSynchronousVoid(() => source!.assertCurrent(structuredClone(request), structuredClone(snapshot), timestamp)); }
    catch (error) { if (error instanceof RecruitmentError) throw error; fail("RECRUITMENT_SOURCE_CHANGED"); }
    assertActor(request.actor, principal);
  }
  async function readSource(request: RecruitmentSourceRequest, principal: ApprovalPrincipal) {
    if (!source) return fail("INTEGRATION_PENDING", 503);
    let raw: unknown;
    try { raw = await boundedSourceRead(()=>source.read(structuredClone(request)),undefined,timeoutMs); }
    catch (error) { if (error instanceof RecruitmentError) throw error; if(error instanceof ActionServiceError)return fail(error.code,error.status);return fail("RECRUITMENT_SOURCE_UNAVAILABLE", 503); }
    const parsed = request.kind === "invitation" ? invitationSourceSchema.safeParse(raw) : recruitmentBatchSourceSchema.safeParse(raw);
    if (!parsed.success) return fail("RECRUITMENT_SOURCE_INVALID", 502);
    const snapshot = freeze(structuredClone(parsed.data));
    assertSource(request, snapshot, principal);
    return snapshot;
  }
  const capacity = (values: NativeInvitationView["capacity"], sourceUntil: string) => values.map(value => {
    const current = value.observedAt !== null && value.validUntil !== null && Date.parse(value.observedAt) <= now() &&
      Date.parse(value.validUntil) > now() && Date.parse(value.validUntil) > Date.parse(value.observedAt) &&
      Date.parse(value.validUntil) - Date.parse(value.observedAt) <= RECRUITMENT_SOURCE_MAX_AGE_MS;
    return current ? { ...value, validUntil: new Date(Math.min(Date.parse(value.validUntil!), Date.parse(sourceUntil))).toISOString() }
      : { ...value, remaining: null, limit: null, reasonCodes: [...new Set([...value.reasonCodes, "RECRUITMENT_CAPACITY_UNVERIFIED"])] };
  });
  const samples = (values: NativeInvitationView["samples"]) => values.map(value => ({ ...value,
    requestRef: alias("sample", value.requestRef), version: alias("sample-version", value.version),
    sourceRef: alias("sample-source",value.sourceRef),
    creatorRef: alias("creator", value.creatorRef), capabilityVersion: value.capabilityVersion ? alias("capability", value.capabilityVersion) : null,
    receiptRef: value.receiptRef ? alias("receipt", value.receiptRef) : null,
    ...(value.route!=="ownerHandoff" && value.deadline !== null && Date.parse(value.deadline) <= now() ? { route: "held" as const, reasonCodes: [...new Set([...value.reasonCodes, "SAMPLE_DEADLINE_EXPIRED"])] } : {}),
  }));
  function header(snapshot: RecruitmentSnapshot, actor: TrustedHuman) {
    const sampleDeadlines=snapshot.samples.flatMap(sample=>{
      if(Date.parse(sample.observedAt)>Date.parse(snapshot.observedAt)||Date.parse(sample.validUntil)<=Date.parse(sample.observedAt)||Date.parse(sample.validUntil)-Date.parse(sample.observedAt)>RECRUITMENT_SOURCE_MAX_AGE_MS)
        return fail("RECRUITMENT_SAMPLE_EVIDENCE_INVALID",502);
      return [Date.parse(sample.validUntil)];
    });
    return { provenance: snapshot.provenance, sourceVersion: alias("source-version", snapshot.sourceVersion), observedAt: snapshot.observedAt,
      validUntil: new Date(Math.min(Date.parse(snapshot.validUntil), Date.parse(actor.validUntil),...sampleDeadlines,
        ...snapshot.capacity.filter(v=>v.remaining!==null||v.limit!==null).flatMap(v=>v.validUntil&&Date.parse(v.validUntil)>now()?[Date.parse(v.validUntil)]:[]))).toISOString(), actorRef: alias("person", actor.personRef),
      sourceState: snapshot.complete ? "current" as const : "partial" as const, reasonCodes: snapshot.reasonCodes };
  }
  async function loadInvitation(raw: unknown, input: ApprovalPrincipal) {
    const filters = invitationFiltersSchema.parse(structuredClone(raw)), { actor, principal } = await actorFor(input);
    const request: RecruitmentSourceRequest = freeze({ kind: "invitation", scope, actor, filters });
    const snapshot = await readSource(request, principal);
    if (snapshot.kind !== "invitation") return fail("RECRUITMENT_SOURCE_INVALID", 502);
    const recovery=filters.requestKey&&filters.draftId ? options.drafts?.lookup(filters.draftId,principal,filters.requestKey)??null : null;
    const selectedRecord = filters.offerId ? options.offers.readOffer(filters.offerId) : null;
    const record=filters.requestKey&&selectedRecord?.version!==filters.offerVersion?null:selectedRecord;
    if (record && (record.terms.creatorId !== filters.creatorId || record.version !== filters.offerVersion))
      fail("RECRUITMENT_OFFER_CHANGED");
    if (filters.creatorId && !snapshot.creators.some(value => value.creatorId === filters.creatorId))
      fail("RECRUITMENT_CREATOR_NOT_PERMITTED", 403);
    const commercial = !filters.requestKey&&filters.creatorId ? options.commercial.project({ creatorId: filters.creatorId, offerId: filters.offerId, offerVersion: filters.offerVersion, phase: "invitation" }) : null;
    const draft = filters.requestKey?recovery?.resource??null:filters.draftId ? options.drafts?.read(filters.draftId, principal) ?? null : null;
    if (draft && (draft.terms.creatorId !== filters.creatorId || draft.terms.offerId !== filters.offerId || draft.terms.offerVersion !== filters.offerVersion))
      fail("RECRUITMENT_DRAFT_SELECTION_MISMATCH");
    const canEdit = actor.roles.some(role => ["founder", "operator", "reviewer"].includes(role));
    const accepted = record && snapshot.acceptedOffer && snapshot.willingness === "willing" &&
      snapshot.acceptedOffer.offerId === record.offerId && snapshot.acceptedOffer.version === record.version &&
      Date.parse(snapshot.acceptedOffer.validUntil) > now() && Date.parse(snapshot.acceptedOffer.validUntil) <= Date.parse(snapshot.validUntil);
    const data = nativeInvitationViewSchema.parse({ kind: "native-invitation", ...header(snapshot, actor), filters,
      provider: snapshot.provider, account: field(snapshot.account),
      creators: snapshot.creators.map(value => ({ ...value, ref: alias("creator", value.ref), label: field(value.label) })),
      products: snapshot.products.map(value => ({ ...value, ref: alias("product", value.ref), programRef: alias("program", value.programRef), label: field(value.label), market: field(value.market), category: field(value.category) })),
      templates: snapshot.templates.map(value => ({ ...value, ref: alias("template", value.ref), version: alias("template-version", value.version),
        claimsVersion: alias("claims", value.claimsVersion), label: field(value.label), text: field(value.text) })),
      limits: {...snapshot.limits,expiresNotAfter:record?.terms.expiresAt
        ? new Date(Math.min(Date.parse(record.terms.expiresAt),snapshot.limits.expiresNotAfter?Date.parse(snapshot.limits.expiresNotAfter):Infinity)).toISOString()
        : snapshot.limits.expiresNotAfter}, willingness: snapshot.willingness, draft,
      requestRecovery: filters.requestKey?{requestKey:filters.requestKey,state:recovery?"recorded":"notFound",receipt:recovery,confersRetry:false}:null,
      offer: record && commercial ? { offerId: record.offerId, version: record.version, creatorId: record.terms.creatorId,
        expiresAt: record.terms.expiresAt,
        publishingNetwork: record.terms.publishingNetwork, checkoutRoute: record.terms.checkoutRoute,
        standardRateBps: record.terms.commission.standardRateBps, fixedPerSaleMinor: record.terms.commission.fixedMinor,
        shopAdsRateBps: record.terms.commission.shopAdsRateBps, sampleUnits: record.terms.sample.seededCreators * record.terms.sample.unitsPerCreator,
        currency: "USD", relationship: "commission-only", upfrontFeeMinor: 0, guaranteedFeeMinor: 0,
        accepted: accepted ? true : snapshot.willingness === "unknown" ? null : false, commercialEligibility: commercial.data } : null,
      capacity: capacity(snapshot.capacity, snapshot.validUntil), samples: samples(snapshot.samples), sourceLink: link(snapshot.sourceLink,snapshot.provenance.synthetic),
      canSaveDraft: !filters.requestKey && canEdit && snapshot.draftPermission && Boolean(record) && snapshot.complete && Boolean(options.drafts)&&snapshot.creators.some(c=>c.creatorId===filters.creatorId&&c.eligible===true),
      canPreview: !filters.requestKey && canEdit && snapshot.complete && draft !== null && commercial?.data.state === "eligible" && Boolean(options.invitationOwner) && draft?.terms.sourceVersion===alias("source-version",snapshot.sourceVersion)&&Date.parse(draft.terms.expiresAt)>now()&&snapshot.creators.some(c=>c.creatorId===filters.creatorId&&c.eligible===true),
      previewSelectionRefs: filters.creatorId?snapshot.creators.filter(c=>c.creatorId===filters.creatorId&&c.eligible===true).map(c=>alias("creator",c.ref)):[],
      previewApprovalRef: draft?options.drafts?.approvalRef(draft.payloadDigest)??null:null,
      dispatchAuthorized: false,
    });
    const recordHash = digest(selectedRecord), draftHash = digest(draft), dataHash = digest(data),recoveryHash=digest(recovery);
    const assertCurrent = () => {
      assertSource(request, snapshot, principal);
      if (digest(filters.offerId ? options.offers.readOffer(filters.offerId) : null) !== recordHash ||
          (!filters.requestKey&&digest(filters.draftId ? options.drafts?.read(filters.draftId, principal) ?? null : null) !== draftHash) || digest(data) !== dataHash ||
          filters.requestKey&&digest(filters.draftId?options.drafts?.lookup(filters.draftId,principal,filters.requestKey)??null:null)!==recoveryHash)
        fail("RECRUITMENT_RECORD_CHANGED");
      if(Date.parse(data.validUntil)<=now())fail("RECRUITMENT_SOURCE_STALE");
      for(const dimension of data.capacity)if((dimension.remaining!==null||dimension.limit!==null)&&dimension.validUntil&&Date.parse(dimension.validUntil)<=now())fail("RECRUITMENT_SOURCE_STALE");
      if(commercial)assertSynchronousVoid(()=>commercial.assertCurrent()); assertSource(request, snapshot, principal);
    };
    assertCurrent(); return { data, assertCurrent, snapshot, request, actor, principal, record, commercial };
  }
  async function readBatch(raw: unknown, input: ApprovalPrincipal): Promise<Projection<NativeRecruitmentBatch>> {
    const filters = recruitmentBatchFiltersSchema.parse(structuredClone(raw)), { actor, principal } = await actorFor(input);
    const request: RecruitmentSourceRequest = freeze({ kind: "batch", scope, actor, filters });
    const snapshot = await readSource(request, principal);
    if (snapshot.kind !== "batch") return fail("RECRUITMENT_SOURCE_INVALID", 502);
    const original = options.records.readApproval(snapshot.approvalRef), runOriginal = options.records.readRun(snapshot.runRef);
    if (!original || digest(original.manifest.scope) !== digest(scope) || snapshot.filters.batchId !== snapshot.runRef ||
        original.manifest.manifestVersion !== snapshot.manifestVersion || original.manifest.manifestHash !== snapshot.manifestHash ||
        original.manifest.draft.providerAccountRef !== snapshot.binding.providerAccountRef ||
        original.manifest.draft.providerAccountVersion !== snapshot.binding.providerAccountVersion ||
        runOriginal.runRef !== snapshot.runRef || runOriginal.revision !== snapshot.runRevision ||
        runOriginal.intent.approval.approvalRef !== snapshot.approvalRef ||
        runOriginal.intent.approval.manifestHash !== snapshot.manifestHash)
      fail("RECRUITMENT_BATCH_BINDING_CHANGED");
    const approval = await boundedSourceRead(()=>options.actions.readApproval(snapshot.approvalRef, principal),undefined,timeoutMs);
    assertSource(request,snapshot,principal);
    const run = await boundedSourceRead(()=>options.actions.readRun(snapshot.runRef, principal),undefined,timeoutMs);
    const rows = snapshot.rows.map(row => ({ ...row, itemRef: alias("item", row.itemRef), creatorRef: alias("creator", row.creatorRef),
      ownerRef: row.ownerRef ? alias("owner", row.ownerRef) : null, owner: field(row.owner), recipient: field(row.recipient), product: field(row.product), terms: field(row.terms) }));
    if (rows.some(row => row.membership === "included" && !run.items.some(item => item.itemRef === row.itemRef)) ||
        rows.some(row => row.membership === "held" && run.items.some(item => item.itemRef === row.itemRef)))
      fail("RECRUITMENT_BATCH_MEMBERSHIP_CHANGED");
    if(snapshot.rows.some(row=>row.membership==="included"&&!original.manifest.items.some(item=>item.itemRef===row.itemRef&&item.targetRef===row.creatorRef)))fail("RECRUITMENT_BATCH_MEMBERSHIP_CHANGED");
    const matching = rows.filter(row => (filters.source === "all" || row.source === filters.source) &&
      (filters.deal === "all" || row.deal === filters.deal) && (filters.owner === null || row.ownerRef === filters.owner) &&
      (filters.deadline === "all" || filters.deadline === "undated" && row.deadline === null ||
        filters.deadline === "dated" && row.deadline !== null || filters.deadline === "overdue" && row.deadline !== null && Date.parse(row.deadline) < now()));
    if (matching.length !== rows.length) fail("RECRUITMENT_FILTER_MEMBERSHIP_INVALID", 502);
    const data = nativeRecruitmentBatchSchema.parse({ kind: "native-recruitment-batch", ...header(snapshot, actor), filters,
      batchId: filters.batchId, approval, run, rows,
      coverage: { returned: rows.length, total: snapshot.total, complete: snapshot.complete },
      owners: snapshot.owners.map(owner => ({ ref: alias("owner", owner.ref), label: field(owner.label) })),
      capacity: capacity(snapshot.capacity, snapshot.validUntil), samples: samples(snapshot.samples),
      models: snapshot.models, forecastCommissionMinor: snapshot.forecastCommissionMinor, forecastIsEarnedCap: false, sourceLink: link(snapshot.sourceLink,snapshot.provenance.synthetic), sourceEffect: "none",
    });
    const approvalHash = digest(original), runHash = digest(runMaterial(runOriginal)), dataHash = digest(data);
    const assertCurrent = () => {
      assertSource(request, snapshot, principal);
      if (digest(options.records.readApproval(snapshot.approvalRef)) !== approvalHash ||
          digest(runMaterial(options.records.readRun(snapshot.runRef))) !== runHash || digest(data) !== dataHash)
        fail("RECRUITMENT_BATCH_CHANGED");
      if(Date.parse(data.validUntil)<=now())fail("RECRUITMENT_SOURCE_STALE");
      for(const dimension of data.capacity)if((dimension.remaining!==null||dimension.limit!==null)&&dimension.validUntil&&Date.parse(dimension.validUntil)<=now())fail("RECRUITMENT_SOURCE_STALE");
      assertSource(request, snapshot, principal);
    };
    assertCurrent(); return { data, assertCurrent };
  }
  async function readInvitation(raw:unknown,principal:ApprovalPrincipal):Promise<Projection<NativeInvitationView>> {
    const result=await loadInvitation(raw,principal);result.assertCurrent();return {data:result.data,assertCurrent:result.assertCurrent};
  }
  function exactBasis(loaded:Awaited<ReturnType<typeof loadInvitation>>,terms:import("./contract.ts").InvitationTerms,started=false):InvitationBasis {
    const {snapshot,record,data}=loaded;
    if(!record||!snapshot.complete||!data.canSaveDraft||terms.creatorId!==record.terms.creatorId||terms.offerId!==record.offerId||terms.offerVersion!==record.version||
      terms.sourceVersion!==data.sourceVersion) return fail("RECRUITMENT_DRAFT_BASIS_CHANGED");
    const creator=snapshot.creators.find(c=>c.creatorId===terms.creatorId&&c.eligible===true);
    const product=snapshot.products.find(p=>alias("product",p.ref)===terms.productRef&&alias("program",p.programRef)===terms.programRef&&p.eligible===true);
    const template=snapshot.templates.find(t=>alias("template",t.ref)===terms.templateRef&&alias("template-version",t.version)===terms.templateVersion&&alias("claims",t.claimsVersion)===terms.claimsVersion);
    if(!creator||!product||!template||template.text.state!=="visible"||field(template.text).state!=="visible"||
      product.ref!==record.terms.manifest.productRef||product.programRef!==record.terms.programRef||!record.terms.manifest.productRevision)
      return fail("RECRUITMENT_SELECTOR_NOT_PERMITTED",403);
    const start=Date.parse(terms.startsAt),end=Date.parse(terms.expiresAt),limits=snapshot.limits;
    if(secretPattern.test(terms.message)||field({state:"visible",value:terms.message,reasonCode:null}).state!=="visible")return fail("RECRUITMENT_PRIVATE_MATERIAL_WITHHELD",422);
    if(limits.maxValiditySeconds===null||!limits.timezone||terms.timezone!==limits.timezone||!started&&start<now()||end<=now()||end-start>limits.maxValiditySeconds*1000||
      limits.startsNotBefore&&start<Date.parse(limits.startsNotBefore)||limits.expiresNotAfter&&end>Date.parse(limits.expiresNotAfter)||
      record.terms.expiresAt&&end>Date.parse(record.terms.expiresAt)||terms.sampleRequested!==record.terms.sample.requested||
      record.terms.commission.standardRateBps!==null&&(limits.maxRateBps===null||record.terms.commission.standardRateBps>limits.maxRateBps)||
      record.terms.commission.shopAdsRateBps!==null&&(limits.maxRateBps===null||record.terms.commission.shopAdsRateBps>limits.maxRateBps))
      return fail("RECRUITMENT_TERMS_OUTSIDE_SOURCE_BOUNDS",422);
    loaded.assertCurrent();
    return {provider:snapshot.provider,providerAccountRef:snapshot.binding.providerAccountRef,providerAccountVersion:snapshot.binding.providerAccountVersion,
      sourceRef:snapshot.sourceRef,sourceVersion:snapshot.sourceVersion,offerManifestHash:record.manifestHash,creatorRef:creator.ref,creatorId:creator.creatorId,
      productRef:product.ref,productVersion:record.terms.manifest.productRevision,programRef:product.programRef,templateRef:template.ref,templateVersion:template.version,claimsVersion:template.claimsVersion};
  }
  async function saveInvitation(raw:unknown,input:ApprovalPrincipal,requestKey:string):Promise<Projection<InvitationSaveReceipt>> {
    const parsed=invitationSaveSchema.safeParse(structuredClone(raw));if(!parsed.success)return fail("RECRUITMENT_DRAFT_INVALID",422);
    const request=freeze(parsed.data),principal=principalSchema.parse(input),repo=options.drafts;
    if(!repo)return fail("RECRUITMENT_DRAFTS_UNCONFIGURED",503);
    const filters={context:"recruitment" as const,draftId:request.draftId,creatorId:request.terms.creatorId,offerId:request.terms.offerId,offerVersion:request.terms.offerVersion};
    const lookup=await readInvitation({...filters,requestKey},principal);lookup.assertCurrent();
    const old=repo.exact(request,principal,requestKey);
    if(old){const recovery=lookup;recovery.assertCurrent();
      if(digest(recovery.data.requestRecovery?.receipt)!==digest(old))return fail("RECRUITMENT_RECORD_CHANGED");return {data:old,assertCurrent:recovery.assertCurrent};}
    const loaded=await loadInvitation(filters,principal),basis=exactBasis(loaded,request.terms);
    // The repository's transaction uses this source/offer fence, but the expected draft revision changes on save.
    const fence=()=>{assertSource(loaded.request,loaded.snapshot,principal);if(digest(options.offers.readOffer(request.terms.offerId))!==digest(loaded.record))fail("RECRUITMENT_OFFER_CHANGED");
      if(loaded.commercial)assertSynchronousVoid(()=>loaded.commercial!.assertCurrent());if(Date.parse(loaded.data.validUntil)<=now())fail("RECRUITMENT_SOURCE_STALE");assertSource(loaded.request,loaded.snapshot,principal);};
    const data=repo.save(request,principal,loaded.data.actorRef,requestKey,basis,fence),fingerprint=digest(data);
    const assertCurrent=()=>{try{fence();if(digest(repo.lookup(request.draftId,principal,requestKey))!==fingerprint)fail("RECRUITMENT_RECORD_CHANGED");}
      catch(error){if(error instanceof RecruitmentError)throw new RecruitmentError(error.code,error.status,"applied",error.currentVersion);throw new RecruitmentError("RECRUITMENT_SAVE_READBACK_UNVERIFIED",409,"applied");}};
    assertCurrent();return {data,assertCurrent};
  }
  async function loadSaved(draftId:string,version:string,principal:ApprovalPrincipal){
    const repo=options.drafts,stored=repo?.readStored(draftId,principal,version);if(!repo||!stored)return fail("RECRUITMENT_DRAFT_NOT_FOUND",404);
    if(repo.read(draftId,principal)?.version!==version)return fail("RECRUITMENT_DRAFT_CHANGED");
    const terms=stored.draft.terms,loaded=await loadInvitation({context:"recruitment",draftId,creatorId:terms.creatorId,offerId:terms.offerId,offerVersion:terms.offerVersion},principal);
    if(!loaded.data.canPreview)return fail("RECRUITMENT_PREVIEW_HELD");
    const basis=exactBasis(loaded,terms,true);if(digest(basis)!==digest(stored.basis))return fail("RECRUITMENT_DRAFT_BASIS_CHANGED");
    const expected=digest(stored),assertCurrent=()=>{loaded.assertCurrent();if(digest(repo.readStored(draftId,principal,version))!==expected||repo.read(draftId,principal)?.version!==version)fail("RECRUITMENT_DRAFT_CHANGED");};
    assertCurrent();return {stored,snapshot:loaded.snapshot,actor:loaded.actor,record:loaded.record!,assertCurrent,bindApproval:(ref:string,v:number)=>repo.bindApproval(stored.draft.payloadDigest,ref,v)};
  }
  const domain=createRecruitmentActionDomain({owner:options.invitationOwner,loadSaved,alias,scope,now,timeoutMs});
  return { readInvitation, readBatch, saveInvitation, domain, alias };
}
