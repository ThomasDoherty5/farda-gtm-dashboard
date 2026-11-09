// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { offerPolicyFixture } from "../offers/policyFixture.testkit.ts";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import { withCommercialOffers } from "../commercialPolicy/approvalGuard.ts";
import { createCommercialProjection } from "../commercialPolicy/projection.ts";
import { createActionService } from "../actions/service.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import type { DispatchHandler, DispatchIntent } from "../jobs/dispatchSchema.ts";
import { createRecruitmentService } from "./service.ts";
import { recruitmentSourceFixture } from "./fixtures.testkit.ts";
import { recruitmentBatchSourceSchema } from "./source.ts";
import { InvitationDraftRepository } from "./drafts.ts";
import { invitationFiltersSchema, unknownRecruitmentModels, type InvitationSave } from "./contract.ts";
import { recruitmentInvitationOwnerFixture } from "./ownerFixture.testkit.ts";
import { RECRUITMENT_INVITATION_ACTION, RECRUITMENT_INVITATION_HANDLER } from "./proposalBridge.ts";

const key = "synthetic-private-recruitment-test-key-not-for-deployment";
const principal = { principalRef: "synthetic:requester" };
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); });
function setup() {
  const o = offerPolicyFixture(":memory:", scope), a = approvalFixture();
  close.push(() => o.store.database.close(), () => a.db.close());
  a.state.now = o.now();
  for (const actor of a.humans.values()) { actor.observedAt = a.at(); actor.validUntil = a.until(); }
  a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  a.draft.sourceValidUntil = a.until(); a.draft.expiresAt = a.until();
  a.draft.providerAccountRef = "synthetic-provider-account";
  a.draft.gates.sampleAuthority = structuredClone(a.draft.gates.providerTerms);
  for (const gate of Object.values(a.draft.gates)) if (gate.state === "satisfied") gate.validUntil = a.until();
  const offer = o.save();
  const approvals = new ApprovalRepository(o.store.database, { ...a.options, now: o.now });
  const jobs = new JobRepository(o.store.database, { scope, now: o.now });
  const na = { state: "notApplicable" as const, policyVersion: "synthetic-policy-v1", reason: "Fictional local fixture artifact only." };
  const handler: DispatchHandler = { policyVersion: a.policy.version, idempotency: "source-enforced", sourceEffect: "localArtifact", provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }),
    budgets: { maxItems: 10, maxSteps: 10, maxAttempts: 2, maxRunMs: 5000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async () => ({ state: "unknown", reasonCode: "FIXTURE_NOT_EXECUTED" }), reconcile: async () => ({ state: "unknown", reasonCode: "FIXTURE_NOT_EXECUTED" }) };
  const dispatch = new DispatchGuard({ db: o.store.database, scope, jobs, approvals, handlers: new Map([["synthetic-invitation.v1", handler]]), now: o.now });
  const actions = createActionService({ scope, secret: key, approvals, dispatch, registry: new Map([[a.draft.actionKind, { handlerRef: "synthetic-invitation.v1" }]]),
    authorize: a.sources.resolveActor, assertAuthority: a.sources.assertCurrent, now: o.now });
  const source = recruitmentSourceFixture(scope, o.now);
  const drafts=new InvitationDraftRepository(o.store.database,scope,o.now);
  const options = { scope, referenceKey: key, now: o.now, source: source.source, authority: a.sources, offers: o.repo,drafts,
    commercial: createCommercialProjection({ db: o.store.database, offers: o.repo, scope, secret: key, now: o.now }),
    actions, records: { readApproval: (ref: string) => approvals.readApproval(ref), readRun: (ref: string) => dispatch.read(ref, false) } };
  const service = createRecruitmentService(options);
  const filters = { context:"recruitment" as const,creatorId: offer.terms.creatorId, offerId: offer.offerId, offerVersion: offer.version };
  async function batch() {
    const preview = await approvals.preparePreview(a.command, principal, "synthetic-recruitment-preview");
    const requested = await approvals.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: preview.manifest.manifestVersion }, principal, "synthetic-recruitment-request");
    const event = a.event(requested, "approved", "synthetic:founder");
    const approved = await approvals.observeDecision(event.locator, { ingressRef: "synthetic:authenticated-ingress" });
    const item = approved.manifest.items[0]!;
    const intent: DispatchIntent = { approval: approvalDispatchBinding(approved.manifest, item.itemRef), handlerRef: "synthetic-invitation.v1", payloadRef: approved.manifest.draft.payloadRef };
    const run = await dispatch.handoff(intent, { principalRef: principal.principalRef, idempotencyKey: "synthetic-recruitment-handoff" });
    source.state.batch = {
      approvalRef: approved.manifest.approvalRef, manifestVersion: approved.manifest.manifestVersion, manifestHash: approved.manifest.manifestHash,
      runRef: run.runRef, runRevision: run.revision, complete: true, total: 1, models: unknownRecruitmentModels(),
      rows: [{ itemRef: item.itemRef, creatorRef: item.targetRef, source: "social-cat", deal: "affiliate", ownerRef: "synthetic-private-owner",
        owner: source.visible("Fictional owner"), deadline: a.until(), membership: "included", holdReasons: [], recipient: source.visible("Fictional creator"),
        product: source.visible("Fictional product"), terms: source.visible("Commission only; no guaranteed fee.") }],
      owners: [{ ref: "synthetic-private-owner", label: source.visible("Fictional owner") }], capacity: [], samples: [],
      forecastCommissionMinor: null, sourceLink: { state: "unavailable", url: null, label: "Open source record", reasonCode: "SOURCE_LINK_UNAVAILABLE" },
    };
    return { run, approval: approved };
  }
  return { o, a, offer, approvals, jobs, dispatch, actions, source, options, service, filters, batch };
}
async function draftRequest(w:ReturnType<typeof setup>):Promise<InvitationSave>{
  const {data}=await w.service.readInvitation(w.filters,principal),p=data.products[0]!,t=data.templates[0]!;
  return {kind:"recruitmentInvitation",draftId:"synthetic-invitation",expectedVersion:null,terms:{creatorId:w.filters.creatorId,offerId:w.filters.offerId,offerVersion:w.filters.offerVersion,
    sourceVersion:data.sourceVersion,productRef:p.ref,programRef:p.programRef,templateRef:t.ref,templateVersion:t.version,claimsVersion:t.claimsVersion,
    message:"A fictional everyday routine invitation.",startsAt:new Date(w.o.now()+30_000).toISOString(),expiresAt:new Date(w.o.now()+120_000).toISOString(),timezone:"America/Los_Angeles",sampleRequested:true}};
}

describe("native recruitment views reuse exact scoped offers and canonical runs", () => {
  it("reads actual saved offer with unknown willingness and quota, without inventing acceptance or dispatch", async () => {
    const w = setup(), result = await w.service.readInvitation(w.filters, principal);
    expect(result.data).toMatchObject({ kind: "native-invitation", willingness: "unknown", canPreview: false, dispatchAuthorized: false,
      offer: { offerId: w.offer.offerId, accepted: null, upfrontFeeMinor: 0, guaranteedFeeMinor: 0 }, capacity: [{ remaining: null }] });
    expect(JSON.stringify(result.data)).not.toMatch(/synthetic-private-profile|synthetic-private-recruitment-source|synthetic-provider-account/);
    expect(w.o.store.database.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);
  });
  it("defaults absent provider source to an honest integration hold", async () => {
    const w = setup(), service = createRecruitmentService({ ...w.options, source: undefined });
    await expect(service.readInvitation(w.filters, principal)).rejects.toMatchObject({ code: "INTEGRATION_PENDING", status: 503 });
  });
  it.each(["scope", "actor", "directory", "filters"])("rejects mismatched source %s", async wrong => {
    const w = setup(); w.source.state.transform = snapshot => {
      if (wrong === "scope") snapshot.binding.scope.accountId = "foreign-account";
      if (wrong === "actor") snapshot.binding.principalRef = "foreign-principal";
      if (wrong === "directory") snapshot.binding.directoryVersion = "foreign-directory";
      if (wrong === "filters" && snapshot.kind === "invitation") snapshot.filters.offerId = "foreign-offer";
    };
    await expect(w.service.readInvitation(w.filters, principal)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["future", "expired", "overlong"])("holds %s source lease", async change => {
    const w = setup();
    if (change === "future") w.source.state.observedAt++;
    if (change === "expired") w.source.state.validUntil = w.o.now();
    if (change === "overlong") w.source.state.validUntil++;
    await expect(w.service.readInvitation(w.filters, principal)).rejects.toMatchObject({ code: "RECRUITMENT_SOURCE_STALE" });
  });
  it("rejects actor/source withdrawal after an awaited source read", async () => {
    const w = setup(); w.source.state.afterRead = () => { w.a.humans.get(principal.principalRef)!.active = false; };
    await expect(w.service.readInvitation(w.filters, principal)).rejects.toMatchObject({ status: 403 });
    w.a.humans.get(principal.principalRef)!.active = true;
    w.source.state.afterRead = () => { w.source.state.denied = true; };
    await expect(w.service.readInvitation(w.filters, principal)).rejects.toMatchObject({ status: 403 });
  });
  it.each(["false", "object", "promise", "rejectedPromise"])("rejects non-synchronous-void source fences: %s", async kind => {
    const w = setup(); w.options.source.assertCurrent = () => (kind === "false" ? false : kind === "object" ? {} : kind === "promise" ? Promise.resolve() : Promise.reject(new Error("synthetic denial"))) as never;
    await expect(w.service.readInvitation(w.filters, principal)).rejects.toMatchObject({ code: "RECRUITMENT_SOURCE_CHANGED" });
  });
  it("fences final local offer changes and mutated returned data", async () => {
    const w = setup(), result = await w.service.readInvitation(w.filters, principal);
    result.data.willingness = "willing";
    expect(result.assertCurrent).toThrow("RECRUITMENT_RECORD_CHANGED");
    const fresh = await w.service.readInvitation(w.filters, principal);
    w.o.repo.saveFromAdapter(w.offer.offerId, w.offer.version, { ...w.offer.terms, expiresAt: new Date(w.o.now() + 7200000).toISOString() }, "synthetic-next-offer");
    expect(fresh.assertCurrent).toThrow("RECRUITMENT_RECORD_CHANGED");
  });
  it("reads a real J04/SQLite finite run, preserving receipt absence and exact safe item identity", async () => {
    const w = setup(), b = await w.batch(), result = await w.service.readBatch({ context:"recruitment",batchId: b.run.runRef }, principal);
    expect(result.data.run.runRef).toBe(b.run.runRef);
    expect(result.data.rows[0]!.itemRef).toBe(result.data.run.items[0]!.itemRef);
    expect(result.data.run.items[0]!.receiptRef).toBeNull();
    expect(result.data.forecastIsEarnedCap).toBe(false);
    expect(JSON.stringify(result.data)).not.toContain("synthetic-private-owner");
    result.assertCurrent();
  });
  it("keeps both checkout models unknown without source evidence, and fences exact source-owned model changes", async () => {
    const w=setup(),b=await w.batch();
    const unknown=await w.service.readBatch({context:"recruitment",batchId:b.run.runRef},principal);
    expect(unknown.data.models).toEqual(unknownRecruitmentModels());
    w.source.state.batch!.models[0]={route:"website",name:"WEBSITE-AFFILIATE-v3",version:"fictional-reviewed-v3",state:"current",reasonCodes:[]};
    const current=await w.service.readBatch({context:"recruitment",batchId:b.run.runRef},principal);
    expect(current.data.models[0]).toMatchObject({name:"WEBSITE-AFFILIATE-v3",version:"fictional-reviewed-v3",state:"current"});
    w.source.state.batch!.models[0]!.version="fictional-next-v3";expect(current.assertCurrent).toThrow("RECRUITMENT_SOURCE_CHANGED");
  });
  it.each(["route","version","unknown","duplicate"])("rejects inconsistent source model %s",async kind=>{
    const w=setup(),b=await w.batch(),models=w.source.state.batch!.models;
    models[0]={route:"website",name:"WEBSITE-AFFILIATE-v3",version:"fictional-v3",state:"current",reasonCodes:[]};
    if(kind==="route")models[0].name="TIKTOK-SHOP-AFFILIATE-v3";
    if(kind==="version")models[0].version=null;
    if(kind==="unknown")models[0].state="unknown";
    if(kind==="duplicate")models[1]={...models[0]};
    await expect(w.service.readBatch({context:"recruitment",batchId:b.run.runRef},principal)).rejects.toMatchObject({code:"RECRUITMENT_SOURCE_INVALID"});
  });
  it("fences pause or source withdrawal during the last awaited safe run projection", async () => {
    const w = setup(), b = await w.batch(), original = w.options.actions.readRun;
    w.options.actions.readRun = async (...args) => { const result = await original(...args); w.jobs.controlRun(b.run.runRef, "pause"); return result; };
    await expect(w.service.readBatch({ context:"recruitment",batchId: b.run.runRef }, principal)).rejects.toMatchObject({ code: "RECRUITMENT_BATCH_CHANGED" });
  });
  it("rejects foreign manifest membership and permission denial browser fallback", async () => {
    const w = setup(), b = await w.batch();
    w.source.state.batch!.rows[0]!.itemRef = "foreign-item";
    await expect(w.service.readBatch({ context:"recruitment",batchId: b.run.runRef }, principal)).rejects.toMatchObject({ code: "RECRUITMENT_BATCH_MEMBERSHIP_CHANGED" });
    const raw = { ...w.source.state.batch!, kind: "batch",provenance:{evidenceStage:"synthetic",synthetic:true}, filters: { context:"recruitment",batchId: b.run.runRef, source: "all", deal: "all", owner: null, deadline: "all" },
      binding: { scope, principalRef: principal.principalRef, directoryVersion: "directory-v1", providerAccountRef: "synthetic-account", providerAccountVersion: "v1" },
      sourceRef: "synthetic-source", sourceVersion: "v1", observedAt: w.a.at(), validUntil: w.a.until(), permission: "permitted", reasonCodes: [],
      samples: [{ requestRef: "synthetic-sample", version: "v1", creatorRef: "synthetic-creator",sourceRef:"synthetic-sample-source",observedAt:w.a.at(),validUntil:w.a.until(), requestType: "target", nativeState: "pending", deadline: w.a.until(),
        route: "permittedBrowser", capabilityVersion: "v1", reasonCodes: ["TIKTOK_PERMISSION_DENIED_16022020"], approvalRef: null, runRef: null, receiptRef: null }] };
    expect(recruitmentBatchSourceSchema.safeParse(raw).success).toBe(false);
  });
});

describe("exact saved invitation -> existing J04 bridge",()=>{
  async function connected(){
    const w=setup(),owner=recruitmentInvitationOwnerFixture({drafts:w.options.drafts,offers:w.o.repo,baseDraft:w.a.draft,now:w.o.now});
    let repo:ApprovalRepository;
    const service=createRecruitmentService({...w.options,invitationOwner:owner.owner,records:{...w.options.records,
      readPreview:(command,actor,key)=>repo.readCommand("propose",command,actor,key)}});
    const request=await draftRequest(w),saved=await service.saveInvitation(request,principal,"save-for-preview");
    const view=await service.readInvitation({...w.filters,draftId:request.draftId},principal);
    repo=new ApprovalRepository(w.o.store.database,{...w.a.options,registry:withCommercialOffers(service.domain!.registry,w.o.repo,w.o.now),now:w.o.now});
    const command={actionKind:RECRUITMENT_INVITATION_ACTION,entityRef:request.draftId,entityVersion:saved.data.version,selectionRefs:view.data.previewSelectionRefs,expectedVersion:0};
    return {...w,service,owner,request,saved,view,repo,command};
  }
  it("records the exact public selection and raw target/payload once, without acceptance or dispatch",async()=>{
    const w=await connected();expect(w.view.data).toMatchObject({canPreview:true,willingness:"unknown",offer:{accepted:null},dispatchAuthorized:false});
    const a=await w.repo.preparePreview(w.command,principal,"original-preview-key");
    expect(a.manifest.items[0]).toMatchObject({itemRef:w.command.selectionRefs[0],targetRef:"synthetic-creator",payloadHash:w.saved.data.resource.payloadDigest});
    expect(a.manifest.draft.commercialOffers).toEqual([{itemRef:w.command.selectionRefs[0],offerRef:w.offer.offerId,offerVersion:w.offer.version,basisHash:expect.stringMatching(/^[a-f0-9]{64}$/)}]);
    expect(a.current).toEqual({state:"held",reasonCodes:["APPROVAL_REQUEST_UNVERIFIED","DECISION_READBACK_UNVERIFIED"]});
    expect(a.request).toEqual({state:"local",record:null});expect(a.decisionReceipt).toBeNull();expect(w.a.state.writes).toBe(0);expect(w.owner.state.contexts).toEqual([]);
    expect(await w.repo.preparePreview(w.command,principal,"original-preview-key")).toEqual(a);
    await expect(w.repo.preparePreview(w.command,principal,"fresh-key-same-draft")).rejects.toMatchObject({code:"APPROVAL_CURRENT_SOURCE_UNVERIFIED"});
    const another={...w.request,draftId:"second-local-id"};await w.service.saveInvitation(another,principal,"another-local-save");
    await expect(w.repo.preparePreview({...w.command,entityRef:another.draftId},principal,"fresh-key-new-local-id")).rejects.toMatchObject({code:"APPROVAL_CURRENT_SOURCE_UNVERIFIED"});
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(1);
    const recovered=await w.service.readInvitation({...w.filters,draftId:w.request.draftId},principal);
    expect(recovered.data).toMatchObject({previewApprovalRef:a.manifest.approvalRef,previewManifestVersion:a.manifest.manifestVersion});
  });
  it("recovers only the original preview after newer draft, offer and source revisions without preparing or sending",async()=>{
    const w=await connected(),preview=await w.repo.preparePreview(w.command,principal,"original-preview-key");
    const next=await w.service.saveInvitation({...w.request,expectedVersion:w.saved.data.version,terms:{...w.request.terms,message:"A separate newer local revision."}},principal,"newer-draft-key");
    const revised=await w.repo.preparePreview({...w.command,entityVersion:next.data.version,approvalRef:preview.manifest.approvalRef,
      expectedVersion:preview.manifest.manifestVersion},principal,"different-material-preview-key");
    expect(revised.manifest.manifestVersion).toBe(2);
    w.o.repo.saveFromAdapter(w.offer.offerId,w.offer.version,{...w.offer.terms,expiresAt:new Date(w.o.now()+7_200_000).toISOString()},"newer-offer-key");
    w.source.state.version="synthetic-source-v2";
    const filters={...w.filters,draftId:w.request.draftId,previewRequestKey:"original-preview-key",previewVersion:w.saved.data.version};
    const recovered=await w.service.readInvitation(filters,principal);recovered.assertCurrent();
    expect(recovered.data).toMatchObject({draft:w.saved.data.resource,offer:null,previewApprovalRef:preview.manifest.approvalRef,previewManifestVersion:1,
      canSaveDraft:false,canPreview:false,previewSelectionRefs:[]});
    expect(w.options.drafts.read(w.request.draftId,principal)?.version).toBe("invitation-v2");
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(2);
    expect(w.o.store.database.prepare("SELECT count(*) n FROM job_runs").get()?.n).toBe(0);
    expect(w.a.state.writes).toBe(0);expect(w.owner.state.contexts).toEqual([]);
    w.source.state.denied=true;
    expect(recovered.assertCurrent).toThrow("RECRUITMENT_SOURCE_SCOPE_DENIED");
    await expect(w.service.readInvitation(filters,principal)).rejects.toMatchObject({status:403});
  });
  it.each(["ordinary","original-key"])("fences a concurrent preview commit before publishing %s absence",async mode=>{
    const w=await connected(),filters={...w.filters,draftId:w.request.draftId,
      ...(mode==="original-key"?{previewRequestKey:"late-original-key",previewVersion:w.saved.data.version}:{})};
    const before=await w.service.readInvitation(filters,principal);expect(before.data).toMatchObject({previewApprovalRef:null,previewManifestVersion:null});
    if(mode==="original-key")expect(before.data).toMatchObject({canSaveDraft:false,canPreview:false,previewSelectionRefs:[]});
    const recorded=await w.repo.preparePreview(w.command,principal,"late-original-key");
    expect(before.assertCurrent).toThrow("RECRUITMENT_RECORD_CHANGED");
    const after=await w.service.readInvitation(filters,principal);after.assertCurrent();expect(after.data.previewApprovalRef).toBe(recorded.manifest.approvalRef);
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.a.state.writes).toBe(0);
  });
  it("keeps absent original preview keys read-only and rejects conflicting revisions or actor identities",async()=>{
    const w=await connected();await w.repo.preparePreview(w.command,principal,"original-preview-key");
    const filters={...w.filters,draftId:w.request.draftId,previewRequestKey:"unknown-key",previewVersion:w.saved.data.version};
    const absent=await w.service.readInvitation(filters,principal);
    expect(absent.data).toMatchObject({previewApprovalRef:null,previewManifestVersion:null,canSaveDraft:false,canPreview:false});absent.assertCurrent();
    await w.service.saveInvitation({...w.request,expectedVersion:w.saved.data.version,terms:{...w.request.terms,message:"A newer exact draft."}},principal,"newer-draft-key");
    await expect(w.service.readInvitation({...filters,previewRequestKey:"original-preview-key",previewVersion:"invitation-v2"},principal))
      .rejects.toMatchObject({code:"RECRUITMENT_PREVIEW_RECOVERY_MISMATCH",status:403});
    w.a.humans.get(principal.principalRef)!.personRef="synthetic:different-person";
    await expect(w.service.readInvitation({...filters,previewRequestKey:"original-preview-key"},principal))
      .rejects.toMatchObject({code:"RECRUITMENT_DRAFT_OWNER_DENIED",status:403});
  });
  it("requires the paired original preview selectors and a configured pure canonical lookup",async()=>{
    const w=await connected(),filters={...w.filters,draftId:w.request.draftId,previewRequestKey:"original-preview-key",previewVersion:w.saved.data.version};
    for(const patch of [{previewRequestKey:undefined},{previewVersion:undefined},{draftId:undefined},{creatorId:undefined},{offerId:undefined,offerVersion:undefined},{requestKey:"different-save-key"}])
      expect(invitationFiltersSchema.safeParse({...filters,...patch}).success).toBe(false);
    const unbound=createRecruitmentService(w.options);
    await expect(unbound.readInvitation(filters,principal)).rejects.toMatchObject({code:"RECRUITMENT_PREVIEW_RECOVERY_UNCONFIGURED",status:503});
  });
  it("rolls the identity claim back if the canonical manifest transaction fails",async()=>{
    const w=await connected();w.o.store.database.exec("CREATE TRIGGER synthetic_fail_manifest BEFORE INSERT ON approval_manifests BEGIN SELECT RAISE(ABORT,'fictional interrupted commit'); END");
    await expect(w.repo.preparePreview(w.command,principal,"atomic-key")).rejects.toThrow();
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_approval_refs").get()?.n).toBe(0);
    w.o.store.database.exec("DROP TRIGGER synthetic_fail_manifest");await w.repo.preparePreview(w.command,principal,"atomic-key");
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_approval_refs").get()?.n).toBe(1);
  });
  it("keeps original canonical proof and handler identity; a saved draft edit invalidates the old dispatch basis",async()=>{
    const w=await connected(),a=await w.repo.preparePreview(w.command,principal,"preview-key");
    expect(w.service.domain!.handlers.get(RECRUITMENT_INVITATION_HANDLER)).toBe(w.owner.owner.handler);
    const observed=await w.service.domain!.registry.currentDraft(a.manifest);
    expect(observed).toMatchObject({items:[{itemRef:w.command.selectionRefs[0],targetRef:"synthetic-creator"}]});
    w.service.domain!.registry.assertCurrentDraft!(a.manifest,observed as typeof a.manifest.draft,w.o.now());
    await w.service.saveInvitation({...w.request,expectedVersion:w.saved.data.version,terms:{...w.request.terms,message:"A revised fictional invitation."}},principal,"edited-draft");
    await expect(w.service.domain!.registry.currentDraft(a.manifest)).rejects.toMatchObject({code:"RECRUITMENT_DRAFT_CHANGED"});
    expect(w.owner.state.contexts).toEqual([]);
  });
  it("fences owner/source denial after the last await and rejects an exact TTL boundary",async()=>{
    const w=await connected(),resolve=w.owner.owner.registry.resolvePreview;
    w.owner.owner.registry.resolvePreview=async(...args)=>{const result=await resolve(...args);w.source.state.denied=true;return result;};
    await expect(w.repo.preparePreview(w.command,principal,"denied-preview")).rejects.toMatchObject({status:403});
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0);
    w.source.state.denied=false;w.owner.owner.registry.resolvePreview=resolve;w.o.advance(300_000);
    await expect(w.repo.preparePreview(w.command,principal,"expired-preview")).rejects.toBeDefined();
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0);
  });
  it("requires the published opaque selector and exact payload mapping",async()=>{
    const w=await connected();await expect(w.repo.preparePreview({...w.command,selectionRefs:["synthetic-private-profile"]},principal,"raw-selector")).rejects.toMatchObject({code:"RECRUITMENT_INVITATION_SELECTION_INVALID"});
    const resolve=w.owner.owner.registry.resolvePreview;w.owner.owner.registry.resolvePreview=async(...args)=>({...(await resolve(...args) as object),payloadRef:"different-payload"});
    await expect(w.repo.preparePreview(w.command,principal,"changed-payload")).rejects.toMatchObject({code:"RECRUITMENT_INVITATION_BINDING_CHANGED"});
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0);
  });
});

describe("source-owned sample and provenance boundaries",()=>{
  function retainOfferObservation(w:ReturnType<typeof setup>){
    // Isolate the recruitment clock boundary from the general offer fixture's fresh
    // observation on every call. The same fictional provider packet remains current.
    const packet=structuredClone(w.o.auth.provider!(w.offer.terms,scope));
    w.o.auth.provider=()=>structuredClone(packet);
    const record=w.o.repo.readOffer(w.offer.offerId);expect(record?.provider).not.toBeNull();
    return ()=>expect(w.o.repo.readOffer(w.offer.offerId)).toEqual(record);
  }
  function sample(w:ReturnType<typeof setup>){return {requestRef:"fictional-pending-sample",version:"fictional-sample-v1",creatorRef:"synthetic-private-profile",sourceRef:"fictional-sample-source",
    observedAt:new Date(w.source.state.observedAt).toISOString(),validUntil:new Date(w.source.state.observedAt+120_000).toISOString(),requestType:"open" as const,nativeState:"pending" as const,
    deadline:new Date(w.source.state.observedAt+60_000).toISOString(),route:"verifiedApi" as const,capabilityVersion:"fictional-api-grant-v1",reasonCodes:[] as string[],approvalRef:null,runRef:null,receiptRef:null};}
  it("projects a source-verified PENDING Open API route without granting approval, stock or dispatch",async()=>{
    const w=setup(),assertOfferUnchanged=retainOfferObservation(w);w.source.state.transform=s=>{s.samples=[sample(w)];};
    const result=await w.service.readInvitation(w.filters,principal);result.assertCurrent();
    expect(result.data).toMatchObject({provenance:{evidenceStage:"synthetic",synthetic:true},dispatchAuthorized:false,samples:[{requestType:"open",nativeState:"pending",route:"verifiedApi",approvalRef:null,runRef:null,receiptRef:null}]});
    expect(JSON.stringify(result.data.samples)).not.toMatch(/fictional-pending-sample|fictional-api-grant-v1|fictional-sample-source|synthetic-private-profile/);
    w.o.advance(120_000);assertOfferUnchanged();expect(result.assertCurrent).toThrow("RECRUITMENT_SOURCE_STALE");
  });
  it.each(["verifiedApi", "permittedBrowser"] as const)("expires a published %s capability at the earlier native request deadline", async route => {
    const w=setup(),assertOfferUnchanged=retainOfferObservation(w),deadline=new Date(w.source.state.observedAt+30_000).toISOString();
    w.source.state.transform=s=>{s.samples=[{...sample(w),route,deadline}];};
    const result=await w.service.readInvitation(w.filters,principal);
    expect(result.data.samples[0]?.route).toBe(route);expect(result.data.validUntil).toBe(deadline);
    w.o.advance(29_999);assertOfferUnchanged();result.assertCurrent();
    w.o.advance(1);assertOfferUnchanged();expect(result.assertCurrent).toThrow("RECRUITMENT_SOURCE_STALE");
    const refreshed=await w.service.readInvitation(w.filters,principal);refreshed.assertCurrent();
    expect(refreshed.data.samples[0]).toMatchObject({route:"held",reasonCodes:["SAMPLE_DEADLINE_EXPIRED"]});
  });
  it("bounds a published accepted fact by its own evidence lease, without erasing owner handoff", async()=>{
    const w=setup(),assertOfferUnchanged=retainOfferObservation(w),deadline=new Date(w.source.state.observedAt+1_000).toISOString();w.source.state.willingness="willing";
    w.source.state.transform=s=>{if(s.kind==="invitation")s.acceptedOffer={offerId:w.offer.offerId,version:w.offer.version,receiptRef:"fictional-accepted-receipt",validUntil:deadline};
      s.samples=[{...sample(w),route:"ownerHandoff",deadline:new Date(w.source.state.observedAt-1).toISOString(),reasonCodes:["TIKTOK_PERMISSION_DENIED_16022020"]}];};
    const result=await w.service.readInvitation(w.filters,principal);expect(result.data.offer?.accepted).toBe(true);expect(result.data.validUntil).toBe(deadline);
    expect(result.data.samples[0]?.route).toBe("ownerHandoff");w.o.advance(999);assertOfferUnchanged();result.assertCurrent();
    w.o.advance(1);assertOfferUnchanged();expect(result.assertCurrent).toThrow("RECRUITMENT_SOURCE_STALE");
    const refreshed=await w.service.readInvitation(w.filters,principal);refreshed.assertCurrent();
    expect(refreshed.data.offer?.accepted).not.toBe(true);expect(refreshed.data.samples[0]?.route).toBe("ownerHandoff");
    expect(Date.parse(refreshed.data.validUntil)).toBeGreaterThan(w.o.now());
  });
  it.each(["type","state","capability","denied","future"])("refuses malformed source sample %s without browser fallback",async kind=>{
    const w=setup();w.source.state.transform=s=>{const value={...sample(w)};
      if(kind==="type")Object.assign(value,{requestType:"target"});if(kind==="state")Object.assign(value,{nativeState:"approved"});
      if(kind==="capability")Object.assign(value,{capabilityVersion:null});if(kind==="denied")value.reasonCodes=["TIKTOK_PERMISSION_DENIED_16022020"];
      if(kind==="future")value.observedAt=new Date(w.o.now()+1).toISOString();s.samples=[value];};
    await expect(w.service.readInvitation(w.filters,principal)).rejects.toBeDefined();
  });
  it("preserves explicit 16022020 owner handoff after a deadline and permits another browser route only with independent capability",async()=>{
    const w=setup();w.source.state.transform=s=>{s.samples=[{...sample(w),route:"ownerHandoff",reasonCodes:["TIKTOK_PERMISSION_DENIED_16022020"],deadline:new Date(w.o.now()-1).toISOString()}];};
    const denied=await w.service.readInvitation(w.filters,principal);expect(denied.data.samples[0]).toMatchObject({route:"ownerHandoff",reasonCodes:["TIKTOK_PERMISSION_DENIED_16022020"]});
    w.source.state.transform=s=>{s.samples=[{...sample(w),requestType:"target",route:"permittedBrowser",capabilityVersion:"fictional-browser-grant-v2"}];};
    expect((await w.service.readInvitation(w.filters,principal)).data.samples[0]?.route).toBe("permittedBrowser");
    w.source.state.transform=s=>{s.samples=[{...sample(w),requestType:"target",route:"permittedBrowser",capabilityVersion:null}];};
    await expect(w.service.readInvitation(w.filters,principal)).rejects.toMatchObject({code:"RECRUITMENT_SOURCE_INVALID"});
  });
  it("rejects mixed synthetic provenance and withholds synthetic URLs even on an allowlisted origin",async()=>{
    const w=setup();w.source.state.transform=s=>{Object.assign(s.provenance,{synthetic:false});};
    await expect(w.service.readInvitation(w.filters,principal)).rejects.toMatchObject({code:"RECRUITMENT_SOURCE_INVALID"});
    w.source.state.transform=s=>{s.sourceLink={state:"available",url:"https://fictional.example.test/source",label:"Source"};};
    const svc=createRecruitmentService({...w.options,permittedLinkOrigins:["https://fictional.example.test"]});expect((await svc.readInvitation(w.filters,principal)).data.sourceLink.state).toBe("unavailable");
  });
  it("expires a displayed known capacity at its own earlier deadline",async()=>{
    const w=setup(),assertOfferUnchanged=retainOfferObservation(w);w.source.state.transform=s=>{s.capacity=[{kind:"invitations",unit:"native invitations",currency:null,remaining:3,limit:5,observedAt:new Date(w.source.state.observedAt).toISOString(),validUntil:new Date(w.source.state.observedAt+1000).toISOString(),resetAt:null,reasonCodes:[]}];};
    const result=await w.service.readInvitation(w.filters,principal);expect(result.data.capacity[0]?.remaining).toBe(3);
    w.o.advance(1000);assertOfferUnchanged();expect(result.assertCurrent).toThrow("RECRUITMENT_SOURCE_STALE");
  });
});

describe("immutable invitation-only draft save and original recovery",()=>{
  it("saves one exact scoped revision and returns the original receipt after an offer/source revision changes",async()=>{
    const w=setup(),request=await draftRequest(w),saved=await w.service.saveInvitation(request,principal,"synthetic-save-draft");saved.assertCurrent();
    expect(saved.data).toMatchObject({scope,expectedVersion:null,requestKey:"synthetic-save-draft",sourceEffect:"none",resource:{version:"invitation-v1",terms:request.terms}});
    const read=await w.service.readInvitation({...w.filters,draftId:request.draftId},principal);expect(saved.data.actorRef).toBe(read.data.actorRef);
    w.o.repo.saveFromAdapter(w.offer.offerId,w.offer.version,{...w.offer.terms,expiresAt:new Date(w.o.now()+7200000).toISOString()},"synthetic-new-offer");w.source.state.version="synthetic-source-v2";
    const recovered=await w.service.readInvitation({...w.filters,draftId:request.draftId,requestKey:"synthetic-save-draft"},principal);recovered.assertCurrent();
    expect(recovered.data.requestRecovery).toEqual({requestKey:"synthetic-save-draft",state:"recorded",receipt:saved.data,confersRetry:false});
    expect(recovered.data.canPreview).toBe(false);expect(recovered.data.offer).toBeNull();
    expect((await w.service.saveInvitation(request,principal,"synthetic-save-draft")).data).toEqual(saved.data);
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(1);
    expect(w.o.store.database.prepare("SELECT count(*) n FROM approval_manifests").get()?.n).toBe(0);
  });
  it("rejects conflicting reuse and stale draft revisions without changing the original receipt",async()=>{
    const w=setup(),request=await draftRequest(w),first=await w.service.saveInvitation(request,principal,"exact-key");
    await expect(w.service.saveInvitation({...request,terms:{...request.terms,message:"Changed invitation"}},principal,"exact-key")).rejects.toMatchObject({code:"IDEMPOTENCY_KEY_REUSED"});
    await expect(w.service.saveInvitation(request,principal,"different-key")).rejects.toMatchObject({code:"STALE_VERSION"});
    const current=await w.service.saveInvitation({...request,expectedVersion:first.data.version},principal,"second-revision");expect(current.data.version).toBe("invitation-v2");
    const old=await w.service.readInvitation({...w.filters,draftId:request.draftId,requestKey:"exact-key"},principal);expect(old.data.requestRecovery?.receipt).toEqual(first.data);
  });
  it.each(["sourceVersion","productRef","programRef","templateRef","templateVersion","claimsVersion"] as const)("refuses a forged opaque %s without saving",async field=>{
    const w=setup(),request=await draftRequest(w);request.terms[field]="forged-selector";
    await expect(w.service.saveInvitation(request,principal,"forged-key")).rejects.toBeDefined();
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
  });
  it.each(["rate","time","sample","partial","secret"])("rejects %s outside the source-authorized exact draft",async kind=>{
    const w=setup(),request=await draftRequest(w);
    if(kind==="rate")w.source.state.transform=s=>{if(s.kind==="invitation")s.limits.maxRateBps=100;};
    if(kind==="time")request.terms.expiresAt=new Date(w.o.now()+7_200_000).toISOString();
    if(kind==="sample")request.terms.sampleRequested=false;
    if(kind==="partial")w.source.state.transform=s=>{s.complete=false;};
    if(kind==="secret")request.terms.message="access_token=fictional-private-token";
    await expect(w.service.saveInvitation(request,principal,"bad-key")).rejects.toBeDefined();
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
  });
  it("keeps authoritative absence read-only and fences a concurrent save before publishing absence",async()=>{
    const w=setup(),request=await draftRequest(w),lookup=await w.service.readInvitation({...w.filters,draftId:request.draftId,requestKey:"absent-key"},principal);
    expect(lookup.data.requestRecovery).toEqual({requestKey:"absent-key",state:"notFound",receipt:null,confersRetry:false});
    await w.service.saveInvitation(request,principal,"absent-key");expect(lookup.assertCurrent).toThrow("RECRUITMENT_RECORD_CHANGED");
  });
  it("denies source permission after an awaited read and after save publication without losing durable recovery",async()=>{
    const w=setup(),request=await draftRequest(w);w.source.state.afterRead=()=>{w.source.state.denied=true;};
    await expect(w.service.saveInvitation(request,principal,"denied-key")).rejects.toMatchObject({status:403});
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
    w.source.state.denied=false;w.source.state.afterRead=null;const saved=await w.service.saveInvitation(request,principal,"saved-key");w.source.state.denied=true;
    expect(saved.assertCurrent).toThrow("RECRUITMENT_SOURCE_SCOPE_DENIED");
    await expect(w.service.readInvitation({...w.filters,draftId:request.draftId,requestKey:"saved-key"},principal)).rejects.toMatchObject({status:403});
  });
  it("bounds a hung source and does not write after a late response",async()=>{
    const w=setup(),request=await draftRequest(w);let release!:()=>void;
    w.source.state.afterRead=()=>new Promise<void>(resolve=>{release=resolve;});
    const service=createRecruitmentService({...w.options,timeoutMs:1});
    await expect(service.saveInvitation(request,principal,"timeout-key")).rejects.toMatchObject({code:"SOURCE_READ_TIMEOUT",status:504});release();
    expect(w.o.store.database.prepare("SELECT count(*) n FROM recruitment_invitation_drafts").get()?.n).toBe(0);
  });
});
