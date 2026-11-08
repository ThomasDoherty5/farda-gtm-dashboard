import { createHash, createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openOperationsToken, sealOperationsToken } from "../operationsTokens.ts";
import { principalGrantSchema, type PrincipalGrant } from "../actions/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { SettlementError, settlementFilters, nativeCommissionLedgerSchema, nativeSettlementSchema, nativePayableSchema,
  balanceKeys, type SettlementScope, type SettlementViewKey, type SettlementRecord } from "./contract.ts";
import { settlementSnapshotSchema, type SettlementSnapshot, type SettlementBindings, type SettlementPrincipal } from "./source.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const token = z.object({ kind: z.enum(["settlement", "payable"]), id: z.string().min(1).max(4096) }).strict();
const cursorSchema = z.object({ context: z.string(), cursor: z.string(), snapshot: z.string(), version: z.string(), total: z.number().nullable(),
  offset: z.number().int().nonnegative().safe(), expires: z.number().int().safe() }).strict();
const unknownMoney = { state: "unknown" as const, value: null, evidenceRef: null, observedAt: null, reasonCode: "NOT_OBSERVED" as const };
const unknownTotals = { eligible: unknownMoney, accrued: unknownMoney, creatorPaid: unknownMoney, contribution: unknownMoney };
const fail = (code: string, status = 409): never => { throw new SettlementError(code, status); };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export type SettlementRead = { data: z.infer<typeof nativeCommissionLedgerSchema> | z.infer<typeof nativeSettlementSchema> | z.infer<typeof nativePayableSchema>;
  version: string; observedAt: string; partial: boolean; stale: boolean; empty: boolean; total: number | null; nextCursor: string | null; assertCurrent: () => void };

/** Scoped source projection plus observation-conflict hashes, not a commission/payment ledger. */
export function createSettlementReader(options: { db: DatabaseSync; scope: SettlementScope; secret: string; bindings?: SettlementBindings; now?: () => number; timeoutMs?: number }) {
  const { db, scope, secret } = options, bindings = options.bindings ?? {}, now = options.now ?? Date.now;
  const scopeKey = digest(scope), source = bindings.source;
  const maxAge = 24 * 60 * 60_000;
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, {once:true});
    if (signal?.aborted) cancel();
    try { return await new Promise<T>((resolve,reject) => {
      const abort = () => reject(new SettlementError(signal?.aborted ? "REQUEST_CANCELLED" : "SETTLEMENT_SOURCE_TIMEOUT", signal?.aborted ? 499 : 504));
      if(controller.signal.aborted) return abort();
      controller.signal.addEventListener("abort", abort, {once:true});
      timer=setTimeout(()=>controller.abort(), options.timeoutMs ?? 10_000);
      Promise.resolve().then(()=>operation(controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener("abort",abort));
    }); } finally { if(timer)clearTimeout(timer);signal?.removeEventListener("abort",cancel); }
  }
  function assertGrant(grant: PrincipalGrant, principal: SettlementPrincipal) {
    if(!bindings.authority || !equal(grant.scope,scope) || grant.principalRef!==principal.principalRef || !grant.active ||
      Date.parse(grant.observedAt)>now() || Date.parse(grant.validUntil)<=now() || Date.parse(grant.observedAt)>=Date.parse(grant.validUntil)) fail("SETTLEMENT_AUTHORITY_DENIED",403);
    try { assertSynchronousVoid(()=>bindings.authority!.assertCurrent({scope,actor:grant,slack:null,linearRecords:[]},now())); }
    catch { fail("SETTLEMENT_AUTHORITY_DENIED",403); }
  }
  function freeze<T>(value:T):T { if(value && typeof value==="object") { Object.freeze(value);for(const child of Object.values(value))freeze(child); }return value; }
  db.exec("CREATE TABLE IF NOT EXISTS settlement_observation_hashes(scope_key TEXT NOT NULL, identity TEXT NOT NULL, version TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(scope_key,identity,version))");
  db.exec("CREATE TABLE IF NOT EXISTS settlement_receipt_hashes(scope_key TEXT NOT NULL, identity TEXT NOT NULL, body_hash TEXT NOT NULL, PRIMARY KEY(scope_key,identity))");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["settlement-alias.v1", scope, kind, value])).digest("hex").slice(0, 24);
  const ref = (kind: "settlement" | "payable", id: string) => "sf1-" + sealOperationsToken(scope, secret, "settlement-record.v1", { kind, id });
  function open(refValue: string, kind: "settlement" | "payable") {
    try { if (!refValue.startsWith("sf1-")) return fail("SETTLEMENT_REFERENCE_INVALID", 404);
      const r = token.parse(openOperationsToken(scope, secret, "settlement-record.v1", refValue.slice(4)));
      if (r.kind !== kind) return fail("SETTLEMENT_REFERENCE_INVALID", 404); return r.id;
    } catch { return fail("SETTLEMENT_REFERENCE_INVALID", 404); }
  }
  function assert(snapshot: SettlementSnapshot, principal: SettlementPrincipal) {
    if (!source) return fail("SETTLEMENT_SOURCE_UNCONFIGURED", 503);
    if (!equal(snapshot.scope, scope) || snapshot.access !== "allowed" || snapshot.principalRef !== principal.principalRef) return fail("SETTLEMENT_SOURCE_DENIED", 403);
    try { assertSynchronousVoid(() => source.assertCurrent(snapshot, principal, now(), snapshot.request)); }
    catch (e) { if (e instanceof SettlementError) throw e; return fail("SETTLEMENT_SOURCE_DENIED", 403); }
  }
  function observe(s: SettlementSnapshot, request: { identity: string; target: string | null; limit: number; offset: number }) {
    const clock = now(), observed = Date.parse(s.observedAt);
    if (!Number.isSafeInteger(clock) || observed > clock || Date.parse(s.validUntil) <= observed || s.sourceUpdatedAt && Date.parse(s.sourceUpdatedAt) > observed)
      fail("SETTLEMENT_SOURCE_TIME_INVALID", 502);
    if (s.records.length > request.limit || s.offset !== request.offset || s.total !== null && (s.offset + s.records.length > s.total || s.complete && s.nextCursor === null && s.offset + s.records.length !== s.total) ||
      s.complete && s.total === null || s.nextCursor && !s.records.length || s.records.length === 0 && s.nextCursor) fail("SETTLEMENT_COVERAGE_INVALID", 502);
    if (new Set(s.records.map(r => r.ref)).size !== s.records.length) fail("SETTLEMENT_DUPLICATE_RECORD", 502);
    if (request.target && (s.records.length > 1 || s.records.some(r => r.ref !== request.target))) fail("SETTLEMENT_RECORD_MISMATCH", 502);
    for (const r of s.records) {
      if (s.currency && r.currency !== s.currency) fail("SETTLEMENT_CURRENCY_MISMATCH", 502);
      if (s.viewKey === "payableDetail" && (r.provider !== "externalManual" || !r.historical || r.historical.payoutOwner !== "externalManual") ||
        s.viewKey === "settlementDetail" && r.provider === "externalManual") fail("SETTLEMENT_OWNER_MISMATCH", 502);
      const monies = [r.eligibleBase, r.grossSales, r.fee, ...Object.values(r.balances)];
      for (const fact of monies) if (fact.state === "known" && (fact.value.currency !== r.currency || Date.parse(fact.observedAt) > observed)) fail("SETTLEMENT_FACT_INVALID", 502);
      for (const key of balanceKeys.filter(k => k !== "adjusted")) if (r.balances[key].state === "known" && r.balances[key].value!.minorUnits < 0) fail("SETTLEMENT_BALANCE_INVALID", 502);
      for (const rate of [r.commissionRatePct, r.feeRatePct, ...r.rates.flatMap(v => [v.activePct, v.proposedPct])])
        if (rate.state === "known" && (rate.value < 0 || rate.value > 100 || Date.parse(rate.observedAt) > observed)) fail("SETTLEMENT_RATE_INVALID", 502);
      const receipts = new Map(r.receipts.map(v => [v.ref, v]));
      if (receipts.size !== r.receipts.length || new Set(r.adjustments.map(v => v.ref)).size !== r.adjustments.length || new Set(r.candidates.map(v=>v.ref)).size!==r.candidates.length || new Set(r.rates.map(v=>v.lane)).size!==r.rates.length)
        fail("SETTLEMENT_DUPLICATE_EVIDENCE", 502);
      for (const receipt of r.receipts) {
        if (receipt.componentRef !== r.componentRef || receipt.amount.currency !== r.currency || Date.parse(receipt.settledAt) > Date.parse(receipt.observedAt) || Date.parse(receipt.observedAt) > observed) fail("SETTLEMENT_RECEIPT_INVALID", 502);
        const identity=digest([r.provider,r.accountRef,receipt.ref]),hash=digest(receipt);
        const prior=db.prepare("SELECT body_hash FROM settlement_receipt_hashes WHERE scope_key=? AND identity=?").get(scopeKey,identity);
        if(prior && prior.body_hash!==hash)fail("SETTLEMENT_IMMUTABLE_RECEIPT_CONFLICT");
      }
      for (const adjustment of r.adjustments) if (!receipts.has(adjustment.receiptRef) || adjustment.amount.currency !== r.currency || Date.parse(adjustment.effectiveAt)>Date.parse(adjustment.observedAt) || Date.parse(adjustment.observedAt)>observed) fail("SETTLEMENT_ADJUSTMENT_INVALID", 502);
      for (const fact of r.facts) if (fact.amount && fact.amount.currency !== r.currency || fact.eventAt && Date.parse(fact.eventAt)>Date.parse(fact.observedAt) || Date.parse(fact.observedAt)>observed) fail("SETTLEMENT_FACT_INVALID", 502);
      for (const candidate of r.candidates) if (candidate.componentRef!==r.componentRef || candidate.amount.currency!==r.currency || Date.parse(candidate.periodStart)>=Date.parse(candidate.periodEnd)) fail("SETTLEMENT_CANDIDATE_INVALID",502);
      if (r.historical && (r.historical.acceptedAmount.currency!==r.currency || Date.parse(r.historical.acceptedAt)>observed || r.historical.acceptedAmount.minorUnits<0)) fail("SETTLEMENT_OBLIGATION_INVALID",502);
      if(r.accounting.state!=="unknown" && r.accounting.state!=="unposted" && (!r.accounting.evidenceRef || !r.accounting.qboRef)) fail("SETTLEMENT_ACCOUNTING_INVALID",502);
    }
    for(const fact of Object.values(s.totals)) if(fact.state==="known" && (!s.complete || !s.currency || fact.value.currency!==s.currency || Date.parse(fact.observedAt)>observed || s.total===0 && fact.value.minorUnits!==0)) fail("SETTLEMENT_TOTALS_UNVERIFIED",502);
    if(s.economics) {
      const e=s.economics;
      if(!s.complete || !s.currency || Date.parse(e.periodStart)>=Date.parse(e.periodEnd))fail("SETTLEMENT_ECONOMICS_UNVERIFIED",502);
      for(const value of [e.grossSales,e.refunds,e.netRevenue,e.creatorCommissions,e.providerFees,e.fulfillmentCost,e.sampleCost,e.contribution])
        if(value.state==="known" && (value.value.currency!==s.currency || Date.parse(value.observedAt)>observed))fail("SETTLEMENT_ECONOMICS_UNVERIFIED",502);
      if(e.eligibleOrders.state==="known" && (!Number.isSafeInteger(e.eligibleOrders.value) || e.eligibleOrders.value<0 || Date.parse(e.eligibleOrders.observedAt)>observed))fail("SETTLEMENT_ECONOMICS_UNVERIFIED",502);
    }
    const material = { ...s, observedAt: undefined, validUntil: undefined, access: undefined, permissionVersion: undefined };
    const hash = digest(material), identity = digest([request.identity, s.snapshotRef, s.offset]);
    const prior = db.prepare("SELECT body_hash FROM settlement_observation_hashes WHERE scope_key=? AND identity=? AND version=?").get(scopeKey, identity, s.version);
    if (prior && prior.body_hash !== hash) fail("SETTLEMENT_SOURCE_CONFLICT", 409);
    db.prepare("INSERT OR IGNORE INTO settlement_observation_hashes VALUES(?,?,?,?)").run(scopeKey, identity, s.version, hash);
    for(const r of s.records)for(const receipt of r.receipts)db.prepare("INSERT OR IGNORE INTO settlement_receipt_hashes VALUES(?,?,?)").run(scopeKey,digest([r.provider,r.accountRef,receipt.ref]),digest(receipt));
  }
  function fact<T extends { evidenceRef: string | null }>(v: T): T { return { ...v, evidenceRef: v.evidenceRef ? alias("evidence", v.evidenceRef) : null }; }
  function project(r: SettlementRecord, suppliedRef?: string, synthetic=false): SettlementRecord {
    const a = (k: string, v: string | null) => v === null ? null : alias(k, v);
    return { ...r, ref: suppliedRef ?? ref(r.provider === "externalManual" ? "payable" : "settlement", r.ref), version: alias("version", r.version),
      collaborationRef: a("collaboration",r.collaborationRef), budgetCategory:r.budgetCategory?fact(r.budgetCategory):null,
      accountRef: alias("account", r.accountRef), creatorRef: alias("creator", r.creatorRef), programmeRef: alias("programme", r.programmeRef), programmeVersion: alias("version", r.programmeVersion),
      componentRef: alias("component", r.componentRef), orderRef: a("order", r.orderRef), nativeRef: a("native", r.nativeRef),
      eligibleBase: fact(r.eligibleBase), grossSales: fact(r.grossSales), fee: fact(r.fee), commissionRatePct: fact(r.commissionRatePct), feeRatePct: fact(r.feeRatePct),
      balances: Object.fromEntries(balanceKeys.map(k => [k, fact(r.balances[k])])) as SettlementRecord["balances"],
      facts: r.facts.map(v => ({...v,ref:alias("event",v.ref),evidenceRef:alias("evidence",v.evidenceRef),nativeRef:a("native",v.nativeRef)})),
      receipts:r.receipts.map(v=>({...v,ref:alias("receipt",v.ref),componentRef:alias("component",v.componentRef),providerRef:a("native",v.providerRef),evidenceRef:alias("evidence",v.evidenceRef)})),
      adjustments:r.adjustments.map(v=>({...v,ref:alias("adjustment",v.ref),receiptRef:alias("receipt",v.receiptRef),evidenceRef:alias("evidence",v.evidenceRef)})),
      crosswalk:{...r.crosswalk,payeeRef:a("payee",r.crosswalk.payeeRef),orderRef:a("order",r.crosswalk.orderRef),evidenceRefs:r.crosswalk.evidenceRefs.map(v=>alias("evidence",v))},
      accounting:{...r.accounting,qboRef:a("accounting",r.accounting.qboRef),policyRef:a("policy",r.accounting.policyRef),policyVersion:a("version",r.accounting.policyVersion),evidenceRef:a("evidence",r.accounting.evidenceRef)},
      rates:r.rates.map(v=>({...v,activePct:fact(v.activePct),proposedPct:fact(v.proposedPct),termsVersion:a("version",v.termsVersion)})),
      historical:r.historical?{...r.historical,termsRef:alias("terms",r.historical.termsRef),termsVersion:alias("version",r.historical.termsVersion),contractRef:alias("contract",r.historical.contractRef),invoiceRef:alias("invoice",r.historical.invoiceRef),deliverableRef:alias("deliverable",r.historical.deliverableRef),approvalRef:a("approval",r.historical.approvalRef),fundingRef:a("funding",r.historical.fundingRef)}:null,
      candidates:r.candidates.map(v=>({...v,ref:alias("candidate",v.ref),statementRef:alias("statement",v.statementRef),componentRef:alias("component",v.componentRef),evidenceRef:alias("evidence",v.evidenceRef)})),
      samples:r.samples.map(v=>({...v,ref:alias("sample",v.ref),cost:fact(v.cost),evidenceRef:a("evidence",v.evidenceRef)})),
      exceptions:r.exceptions.map(v=>({...v,ref:alias("exception",v.ref),evidenceRef:a("evidence",v.evidenceRef)})),
      links:r.links.map(v=>{
        if(v.state!=="verified" || !v.url || !v.validUntil || Date.parse(v.validUntil)<=now() || !v.observedAt || Date.parse(v.observedAt)>now()) return {...v,targetRef:null,state:v.state==="verified"?"expired":v.state,url:null};
        const url=new URL(v.url); const targetValid=v.kind==="order"?v.targetRef!==null&&v.targetRef===r.orderRef:v.kind==="sample"?r.samples.some(sample=>sample.ref===v.targetRef):true;
        const allowed=!synthetic && targetValid && (bindings.permittedLinkOrigins??[]).includes(url.origin) && url.protocol==="https:" && !url.username && !url.password && !url.search && !url.hash;
        return allowed?{...v,targetRef:v.targetRef?alias(v.kind,v.targetRef):null}:{...v,targetRef:null,state:"missing",url:null};
      }),
    };
  }
  async function load(viewKey:SettlementViewKey, rawFilters:unknown, principal:SettlementPrincipal, page:{cursor:string|null;limit:number}, signal?:AbortSignal) {
    const filters=settlementFilters[viewKey].parse(rawFilters), parsedPage=z.object({cursor:z.string().nullable(),limit:z.number().int().min(1).max(100)}).strict().parse(page);
    if(!principal.principalRef || !["reader","reviewer"].includes(principal.role)) fail("SETTLEMENT_SOURCE_DENIED",403);
    const suppliedRef="settlementId"in filters?filters.settlementId:"payableId"in filters?filters.payableId:undefined;
    const target=suppliedRef?open(suppliedRef,viewKey==="payableDetail"?"payable":"settlement"):null;
    const context=digest([scope,principal,viewKey,filters,parsedPage.limit]);let cursor:z.infer<typeof cursorSchema>|null=null;
    if(parsedPage.cursor) {try{cursor=cursorSchema.parse(openOperationsToken(scope,secret,"settlement-cursor.v1",parsedPage.cursor));}catch{fail("SETTLEMENT_CURSOR_INVALID");}
      if(cursor!.context!==context || cursor!.expires<=now() || viewKey!=="commissionLedger") fail("SETTLEMENT_CURSOR_INVALID");}
    if(!source) return {snapshot:null,filters,suppliedRef,target,context,cursor};
    const provider="provider"in filters?filters.provider??"all":"all",currency="currency"in filters?filters.currency??null:null;
    const request=freeze(structuredClone({scope,principal,viewKey,targetRef:target,provider,currency,
      limit:viewKey==="commissionLedger"?parsedPage.limit:1,cursor:cursor?.cursor??null,snapshot:cursor?{ref:cursor.snapshot,version:cursor.version}:null}));
    let raw:unknown;try{raw=await bounded(signal=>source.read(request,{signal}),signal);}
    catch(e){if(e instanceof SettlementError) throw e;return fail("SETTLEMENT_SOURCE_UNAVAILABLE",503);}
    const p=settlementSnapshotSchema.safeParse(raw);if(!p.success)return fail("SETTLEMENT_SOURCE_INVALID",502);const s=freeze(p.data);
    if(!equal(s.request,request))fail("SETTLEMENT_REQUEST_MISMATCH",502);
    if((provider!=="all" && s.records.some(r=>r.provider!==provider)) || (currency && s.currency!==currency))fail("SETTLEMENT_FILTER_MISMATCH",502);
    if(s.viewKey!==viewKey || !equal(s.scope,scope) || s.access!=="allowed") fail("SETTLEMENT_SOURCE_DENIED",403);
    if(cursor && (s.snapshotRef!==cursor.snapshot || s.version!==cursor.version || s.total!==cursor.total))fail("SETTLEMENT_SNAPSHOT_CHANGED");
    assert(s,principal);
    db.exec("BEGIN IMMEDIATE");
    try {observe(s,{identity:context,target,limit:viewKey==="commissionLedger"?parsedPage.limit:1,offset:cursor?.offset??0});assert(s,principal);db.exec("COMMIT");}
    catch(e){db.exec("ROLLBACK");throw e;}
    return {snapshot:s,filters,suppliedRef,target,context,cursor};
  }
  async function read(viewKey:SettlementViewKey, filters:unknown, principal:SettlementPrincipal, page={cursor:null as string|null,limit:25}, signal?:AbortSignal):Promise<SettlementRead> {
    principal=freeze(structuredClone(principal));
    const loaded=await load(viewKey,filters,principal,page,signal),s=loaded.snapshot;
    let grant: PrincipalGrant | null = null;
    if(s && principal.role==="reviewer" && bindings.authority) {
      const parsed=principalGrantSchema.safeParse(await bounded(()=>bindings.authority!.resolve(principal.principalRef,scope),signal));
      if(parsed.success){try{assertGrant(parsed.data,principal);grant=freeze(parsed.data);}catch{ /* Read access does not confer named action authority. */ }}
    }
    const sourceExpired=Boolean(s && (Date.parse(s.validUntil)<=now() || now()-Date.parse(s.observedAt)>maxAge));
    const assertCurrent=()=>{if(!sourceExpired && s && (Date.parse(s.validUntil)<=now() || now()-Date.parse(s.observedAt)>maxAge))fail("SETTLEMENT_SNAPSHOT_CHANGED");if(signal?.aborted)fail("REQUEST_CANCELLED",499);if(s)assert(s,principal);if(grant)assertGrant(grant,principal);};
    const canAct=Boolean(grant && (grant.roles.includes("founder") || grant.roles.includes("finance")));
    const stale=Boolean(s && (s.state==="stale" || Date.parse(s.validUntil)<=now() || now()-Date.parse(s.observedAt)>maxAge)),partial=!s || !s.complete || s.state==="partial";
    const version=s?alias("snapshot",s.version):"settlement-unconfigured",observedAt=new Date(now()).toISOString();
    const common={version,source:{state:!s?"unconfigured" as const:stale?"stale" as const:partial?"partial" as const:"current" as const,
      observedAt:s?.observedAt??null,sourceUpdatedAt:s?.sourceUpdatedAt??null,validUntil:s?.validUntil??null,revision:s?alias("revision",s.version):null,
      reasonCodes:!s?["SOURCE_UNCONFIGURED" as const]:stale?["SOURCE_STALE" as const]:partial?["SOURCE_PARTIAL" as const]:[],synthetic:s?.synthetic??false},
      accountingPolicy:s?{...s.accountingPolicy,reference:s.accountingPolicy.reference?alias("policy",s.accountingPolicy.reference):null}:{state:"unknown" as const,reference:null},
      capabilities:{match:Boolean(s && !stale && !partial && canAct && bindings.matching),export:Boolean(s && !stale && !partial && canAct && bindings.ledger && s.export && (!(("provider" in loaded.filters)&&loaded.filters.provider&&loaded.filters.provider!=="all")) && s.currency===s.export.filters.currency),pay:false as const}};
    const records=s?.records.map(r=>project(r,loaded.suppliedRef,s?.synthetic))??[];
    let data:SettlementRead["data"];
    if(viewKey==="commissionLedger")data=nativeCommissionLedgerSchema.parse({...common,kind:"native-commission-ledger",currency:s?.currency??null,records,
      coverage:{returned:records.length,total:s?.total??null,complete:Boolean(s?.complete)},economics:s?.economics?{...s.economics,cohortRef:alias("cohort",s.economics.cohortRef),...Object.fromEntries(Object.entries(s.economics).filter(([,v])=>v && typeof v==="object").map(([k,v])=>[k,fact(v as {evidenceRef:string|null})]))}:null,totals:s?Object.fromEntries(Object.entries(s.totals).map(([k,v])=>[k,fact(v)])):unknownTotals,
      export:s?.export && (!("provider" in loaded.filters)||!loaded.filters.provider||loaded.filters.provider==="all") && s.currency===s.export.filters.currency?{...s.export,sourceVersion:alias("export-version",s.export.sourceVersion)}:null});
    else data=(viewKey==="payableDetail"?nativePayableSchema:nativeSettlementSchema).parse({...common,kind:viewKey==="payableDetail"?"native-payable":"native-settlement",record:records[0]??null});
    const nextCursor=s?.nextCursor?sealOperationsToken(scope,secret,"settlement-cursor.v1",{context:loaded.context,cursor:s.nextCursor,snapshot:s.snapshotRef,version:s.version,total:s.total,offset:s.offset+s.records.length,expires:Math.min(Date.parse(s.validUntil),now()+900_000)}):null;
    assertCurrent();
    return{data,version,observedAt,partial,stale,empty:Boolean(s?.complete && s.total===0 && !partial && !stale),total:s?.total??null,nextCursor,assertCurrent};
  }
  return {read,load,assert,alias,open,reference:ref,isCurrent:(s:SettlementSnapshot)=>s.state==="current" && s.complete && Date.parse(s.validUntil)>now() && now()-Date.parse(s.observedAt)<=maxAge};
}
export type SettlementReader=ReturnType<typeof createSettlementReader>;
