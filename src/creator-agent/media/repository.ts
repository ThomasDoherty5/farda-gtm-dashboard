import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import { canonicalMediaRequestSchema, canonicalMediaReadbackSchema, mediaResourceBasisSchema, type CanonicalMediaAction, type CanonicalMediaRequest, type CanonicalMediaCheckpoint, type MediaOperationIdentity, type CanonicalMediaReadback } from "./canonicalContract.ts";
import { EXEC_ROUTES, MEDIA_GATES, OPERATIONS, ROUTE_PRESETS, accountSchema, assetSchema, campaignViewSchema, capabilityObservationSchema, checkoutSchema, gateReceiptSchema, inventoryInputSchema, inventoryViewSchema, manifestSchema, mutationInputSchema, mutationViewSchema, offerVersionSchema, prepareSchema, ref, type CampaignRoute, type CampaignState, type CampaignView, type CapabilityEntry, type Checkout, type ExecRoute, type InventoryView, type Manifest, type MediaAccount, type MediaDecision, type MediaGate, type MediaOperation, type MediaProvider, type MediaScope, type MutationKind, type MutationAuthorization, type MutationState, type MutationView, type NativeSettings, type PrepareInput, type ReceiptOrigin, type MediaAttempt } from "./contract.ts";

type Binding = { provider: MediaProvider; providerAccountRef: string; environment: "sandbox" | "production" };
/** The provider account a write or read is for. Every executor call names it, and every read-back must match it. */
export type MediaIdentity = Binding;
/** The provider writer. Every write is keyed and idempotent at the provider; read() finds an earlier write by its key. */
export interface MediaExecutor {
  createDraft(key: string, payload: { manifest: Manifest; manifestHash: string; nativeCampaignId: string | null; status: "PAUSED" }, route: ExecRoute,
    identity: MediaIdentity): unknown;
  publish(key: string, payload: { nativeCampaignId: string; manifestHash: string; releaseHash: string }, route: ExecRoute, identity: MediaIdentity): unknown;
  mutate(key: string, payload: { nativeCampaignId: string; action: MutationKind; dailyBudgetMinor: number | null }, route: ExecRoute, identity: MediaIdentity): unknown;
  read(key: string, route: ExecRoute, identity: MediaIdentity): unknown;
  readBack(nativeCampaignId: string, route: ExecRoute, identity: MediaIdentity): unknown;
  /** Independent exact attempt lookup; null/malformed/denied results leave the original uncertainty fence intact. */
  readClosure?(attempt: MediaAttempt, route: ExecRoute): unknown;
}
/** Trusted, server-configured sources. A caller never supplies these objects. */
export interface MediaAuthority {
  account?(provider: MediaProvider, providerAccountRef: string, scope: MediaScope): unknown;
  capability?(binding: Binding & { operation: MediaOperation; route: ExecRoute }, scope: MediaScope): unknown;
  checkout?(checkoutRef: string, scope: MediaScope): unknown;
  offer?(offerRef: string, scope: MediaScope): unknown;
  asset?(assetRef: string, scope: MediaScope): unknown;
  gate?(gate: MediaGate, subject: { campaignId: string; manifestHash: string }, scope: MediaScope): unknown;
  decision?(sourceRef: string, scope: MediaScope): unknown;
  /** A previously authorized safety policy that may pause spend without a per-action decision. */
  safetyPolicy?(policyRef: string, scope: MediaScope): unknown;
  executor?: MediaExecutor;
}
export class MediaSourceUnavailable extends Error {}
/** A provider write was attempted and its outcome is not known. The record is uncertain and is reconciled before any retry. */
export class MediaWriteUncertain extends Error {}

/** A pending provider write. The token identifies the worker holding the lease; only that worker may finish or release it. */
type Pending = { key: string; token: string; route: ExecRoute; leaseUntil: string; handoff: string | null; startedAt: string; sentAt: string;
  pausesAtStart: number; attemptRef?: string };
type Receipt = { kind: string; ref: string; origin: ReceiptOrigin; at: string };
type GateStatus = CampaignView["gates"][number];
type Stored = {
  campaignId: string; campaignRef: string; revision: number; state: CampaignState; revisedAt: string; input: PrepareInput; manifestHash: string | null;
  heldReasons: string[]; nativeCampaignId: string | null; nativeAdIds: string[]; previewRef: string | null; readback: NativeSettings | null;
  releaseHash: string | null; releaseRequestedAt: string | null; decisionRef: string | null; decision: "none" | "approved" | "rejected";
  decisionValidUntil: string | null; approvedScope: MediaDecision["financialScope"] | null; effectiveDailyBudgetMinor: number | null;
  providerReview: CampaignView["providerReview"]; gates: GateStatus[]; pendingKind: "draft" | "publish" | null; pending: Pending | null; pauses: number;
  route: ExecRoute | null; reconciledBy: "receipt" | "native-readback" | null; receipts: Receipt[]; draftCreated: boolean; publishAttempted: boolean;
  history: { state: CampaignState; at: string; ref: string | null }[];
  canonical?: { attempts: CanonicalMediaCheckpoint[] };
};
type StoredMutation = {
  mutationId: string; campaignId: string; action: MutationKind; dailyBudgetMinor: number | null; requestHash: string; state: MutationState; createdAt: string;
  heldReasons: string[]; decisionRef: string | null; policyRef: string | null; authorizedBy: "j04" | "safety-policy" | null; route: ExecRoute | null;
  before: NativeSettings | null; after: NativeSettings | null;
  receiptRef: string | null; receiptOrigin: ReceiptOrigin | null; providerRejectionCode: string | null; reconciledBy: "receipt" | "native-readback" | null;
  pending: Pending | null; attempted: boolean; history: { state: MutationState; at: string; ref: string | null }[];
};

const REVISABLE: CampaignState[] = ["held", "draft", "approved", "rejected", "provider-rejected"];
const OPEN_MUTATION: MutationState[] = ["held", "draft", "approved", "applying", "uncertain"];
const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const sameScope = (a: MediaScope, b: MediaScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
const code = (value: string) => value.toUpperCase().replace(/-/g, "_");
const requireKey = (key: string) => { if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED"); };
const setOf = (values: string[]) => digest([...values].sort());
const LIVE: NativeSettings["status"][] = ["ACTIVE", "IN_REVIEW"];
/** Released: confirmed, or read live on the provider. A released campaign changes only through mutations. */
const released = (s: { state: CampaignState; readback: NativeSettings | null }) => s.state === "confirmed" || (!!s.readback && LIVE.includes(s.readback.status));
/** Milliseconds for an instant, or NaN when it cannot be read. */
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
/** True when the instant has passed or cannot be read: an unreadable expiry fails closed. */
const lapsed = (iso: string | null | undefined, now: number) => { const t = ms(iso); return !Number.isFinite(t) || t <= now; };
/** True when the instant is in the future or cannot be read. */
const notYet = (iso: string | null | undefined, now: number) => { const t = ms(iso); return !Number.isFinite(t) || t > now; };
/** Provider receipts are unique per provider, account and environment; decision receipts have their own namespace. */
const namespaceOf = (s: { input: PrepareInput }) => `${s.input.provider}/${s.input.providerAccountRef}/${s.input.environment}`;
function label(origins: (ReceiptOrigin | null | undefined)[]): "none" | "synthetic" | "account-backed" | "mixed" {
  const known = new Set(origins.filter((o): o is ReceiptOrigin => !!o));
  return known.size === 0 ? "none" : known.size > 1 ? "mixed" : known.has("account") ? "account-backed" : "synthetic";
}

/** The route follows the actual checkout. A route the checkout cannot support is never chosen as a substitute. */
export function routeForCheckout(provider: MediaProvider, checkout: Checkout): { route: CampaignRoute } | { reason: string } {
  if (provider === "meta") {
    if (checkout.kind !== "website") return { reason: "ROUTE_UNSUPPORTED_FOR_CHECKOUT" };
    return checkout.purchaseEventsVerified ? { route: "meta-sales-purchase" } : { reason: "PURCHASE_EVENTS_UNVERIFIED" };
  }
  if (checkout.kind === "tiktok-shop") return checkout.shopAuthorizationVerified ? { route: "tiktok-gmv-max-product" } : { reason: "SHOP_AUTHORIZATION_UNVERIFIED" };
  return checkout.purchaseEventsVerified ? { route: "tiktok-smart-plus-web-sales" } : { reason: "PURCHASE_EVENTS_UNVERIFIED" };
}

/** Native settings that differ from the manifest. Any extra delivery budget, Max Delivery, auto-recharge or placement expansion fails. */
export function readbackMismatches(m: Manifest, n: NativeSettings, statuses: NativeSettings["status"][]): string[] {
  const set = setOf;
  const at = (value: string | null) => (value === null ? null : Date.parse(value));
  const checks: [string, boolean][] = [
    ["account", n.providerAccountRef === m.account.providerAccountRef], ["identity", n.identityRef === m.account.identityRef],
    ["status", statuses.includes(n.status)],
    ["objective", n.objective === m.objective && n.optimizationEvent === m.optimizationEvent], ["currency", n.currency === m.currency],
    ["daily-budget", n.dailyBudgetMinor === m.caps.dailyBudgetMinor], ["lifetime-budget", n.lifetimeBudgetMinor === m.caps.lifetimeBudgetMinor],
    ["schedule", at(n.startAt) === at(m.schedule.startAt) && at(n.endAt) === at(m.schedule.endAt)],
    ["attribution", n.attributionSetting === m.attributionSetting], ["destination", n.destinationRef === m.destinationRef],
    ["creatives", set(n.creativeHashes) === set(m.creatives.map((c) => c.contentHash))], ["markets", set(n.markets) === set(m.targeting.markets)],
    ["age", n.ageMin === m.targeting.ageMin && n.ageMax === m.targeting.ageMax], ["placements", set(n.placements) === set(m.targeting.placements)],
    ["bid", n.bidStrategy === m.bid.strategy && n.costCapMinor === m.bid.costCapMinor && n.targetRoasBps === m.bid.targetRoasBps],
    ["extra-delivery-budget", !n.extraDeliveryBudget], ["max-delivery", !n.maxDelivery], ["auto-recharge", !n.autoRecharge],
    ["placement-expansion", !n.placementExpansion],
  ];
  return checks.filter(([, ok]) => !ok).map(([field]) => `READBACK_MISMATCH:${code(field)}`);
}

export class PaidMediaRepository {
  private readonly db: DatabaseSync;
  private readonly scope: MediaScope;
  private readonly authority: MediaAuthority;
  private readonly now: () => Date;
  constructor(db: DatabaseSync, scope: MediaScope, authority: MediaAuthority = {}, now: () => Date = () => new Date()) {
    this.db = db; this.scope = scope; this.authority = authority; this.now = now;
    const actual = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (actual?.workspace_id !== scope.workspaceId || actual.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS media_campaigns (campaign_id TEXT PRIMARY KEY, campaign_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_manifests (campaign_id TEXT NOT NULL, revision INTEGER NOT NULL, manifest_hash TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(campaign_id,revision));
      CREATE TABLE IF NOT EXISTS media_native (provider TEXT NOT NULL, native_id TEXT NOT NULL, campaign_id TEXT NOT NULL, PRIMARY KEY(provider,native_id));
      CREATE TABLE IF NOT EXISTS media_mutations (mutation_id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, request_hash TEXT NOT NULL, active INTEGER NOT NULL,
        body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS media_one_open_mutation ON media_mutations(campaign_id,request_hash) WHERE active=1;
      CREATE TABLE IF NOT EXISTS media_inventories (inventory_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_ref TEXT NOT NULL, environment TEXT NOT NULL, recorded_at TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_receipts (source_ref TEXT PRIMARY KEY, subject_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_resource_basis (entity_ref TEXT NOT NULL, entity_version TEXT NOT NULL, payload_hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(entity_ref,entity_version,payload_hash));`);
  }

  /** Exact domain material only; J04 and JobRepository remain the approval and execution owners. */
  canonicalRequest(entityRef: string, action: CanonicalMediaAction): CanonicalMediaRequest {
    const mutation = ["media.changeBudget", "media.pause"].includes(action) ? this.loadMutation(entityRef) : null;
    const s = this.load(mutation?.campaignId ?? entityRef);
    if (!s || !s.manifestHash) throw new AgentConflict("CAMPAIGN_UNKNOWN");
    const manifest = this.manifestOf(s);
    if (!manifest || (action === "media.changeBudget" && mutation?.action !== "edit-budget") ||
        (action === "media.pause" && mutation?.action !== "pause")) throw new AgentConflict("MEDIA_REQUEST_MISMATCH");
    return canonicalMediaRequestSchema.parse({ campaignId:s.campaignId,revision:s.revision,manifestHash:s.manifestHash,manifest,
      entityRef,entityVersion:mutation?.requestHash ?? String(s.revision),action,requestHash:mutation?.requestHash ?? s.manifestHash,
      expiresAt:s.input.expiresAt,dailyBudgetMinor:mutation?.dailyBudgetMinor ?? null,nativeCampaignId:s.nativeCampaignId,safetyGeneration:s.pauses,
      legacyPending:!!s.pending || !!mutation?.pending });
  }
  assertCanonicalSources(entityRef:string,action:CanonicalMediaAction,growth:boolean) {
    const r=this.canonicalRequest(entityRef,action),s=this.require(r.campaignId);
    if(action!=="media.pause"&&growth){this.assertSourcesUnchanged(s);if(lapsed(s.input.expiresAt,this.now().getTime()))throw new AgentConflict("REQUEST_EXPIRED");
      if(action==="media.publish"&&ms(s.input.schedule.startAt)<=this.now().getTime())throw new AgentConflict("SCHEDULE_ALREADY_STARTED");
      const gates=this.gateStatus(s);if(gates.some(g=>g.state!=="verified"))throw new AgentConflict("MEDIA_GATE_NOT_CURRENT");}
  }
  freezeResourceBasis(input: unknown) {
    const b=mediaResourceBasisSchema.parse(input), json=JSON.stringify(b);
    this.tx(()=>{const prior=this.db.prepare("SELECT body FROM media_resource_basis WHERE entity_ref=? AND entity_version=? AND payload_hash=?").get(b.entityRef,b.entityVersion,b.payloadHash);
      if(prior && digest(JSON.parse(String(prior.body)))!==digest(b)) throw new AgentConflict("MEDIA_RESOURCE_BASIS_CHANGED");
      if(!prior)this.db.prepare("INSERT INTO media_resource_basis VALUES(?,?,?,?)").run(b.entityRef,b.entityVersion,b.payloadHash,json);});
  }
  resourceBasis(entityRef:string,entityVersion:string,payloadHash:string) {
    const row=this.db.prepare("SELECT body FROM media_resource_basis WHERE entity_ref=? AND entity_version=? AND payload_hash=?").get(entityRef,entityVersion,payloadHash);
    if(!row)throw new AgentConflict("MEDIA_RESOURCE_BASIS_REQUIRED");return mediaResourceBasisSchema.parse(JSON.parse(String(row.body)));
  }
  frozenRequest(payloadHash:string):CanonicalMediaRequest {
    const rows=this.db.prepare("SELECT body FROM media_resource_basis WHERE payload_hash=?").all(payloadHash);
    if(rows.length!==1)throw new AgentConflict("MEDIA_EXACT_PAYLOAD_REQUIRED");return mediaResourceBasisSchema.parse(JSON.parse(String(rows[0]!.body))).request;
  }
  beginCanonical(input:CanonicalMediaCheckpoint,assertCurrent:()=>void) {
    this.tx(()=>{ assertCurrent(); const id=input.identity,s=this.load(id.campaignId);if(!s)throw new AgentConflict("CAMPAIGN_UNKNOWN");
      const request=this.canonicalRequest(id.entityRef,id.action);
      if(request.revision!==id.revision||request.requestHash!==id.requestHash||request.manifestHash!==id.manifestHash||request.legacyPending)throw new AgentConflict("MEDIA_REQUEST_CHANGED");
      const attempts=s.canonical?.attempts??[], same=attempts.find(a=>digest(a.identity)===digest(id));
      if(same){if(digest({...same,receipt:null,closed:null})!==digest({...input,receipt:null,closed:null}))throw new AgentConflict("MEDIA_ATTEMPT_CHANGED");return;}
      const unresolved=attempts.find(a=>!a.receipt&&!a.closed);
      if(unresolved&&id.action!=="media.pause")throw new AgentConflict("MEDIA_ORIGINAL_ATTEMPT_UNCERTAIN");
      if(id.action!=="media.pause"&&s.pauses>(input.source.native?.safetyGeneration??0))throw new AgentConflict("SUPERSEDED_BY_PAUSE");
      s.canonical={attempts:[...attempts,structuredClone(input)]};s.state="applying";
      if(id.action==="media.publish")s.publishAttempted=true;
      if(id.entityRef!==id.campaignId){const m=this.loadMutation(id.entityRef);if(m){m.state="applying";m.attempted=true;m.before=input.source.native?.settings??null;m.authorizedBy="j04";m.decisionRef=input.decisionReceiptRef;this.saveMutation(m);}}
      this.save(s);
    });
  }
  canonicalCheckpoint(identity:MediaOperationIdentity):CanonicalMediaCheckpoint {
    const a=this.load(identity.campaignId)?.canonical?.attempts.find(x=>digest(x.identity)===digest(identity));
    if(!a)throw new MediaWriteUncertain("MEDIA_ORIGINAL_ATTEMPT_REQUIRED");return structuredClone(a);
  }
  /** Called inside the owning reservation transaction; an older closed attempt cannot settle a newer attempt's exposure. */
  isCurrentCanonicalAttempt(identity:MediaOperationIdentity):boolean {
    const latest=this.load(identity.campaignId)?.canonical?.attempts.filter(a=>a.identity.dispatchKey===identity.dispatchKey).at(-1);
    return !!latest&&digest(latest.identity)===digest(identity);
  }
  recordCanonical(identity:MediaOperationIdentity,raw:unknown):CanonicalMediaReadback {
    return this.tx(()=>{const s=this.load(identity.campaignId);if(!s)throw new MediaWriteUncertain("MEDIA_ORIGINAL_ATTEMPT_REQUIRED");
      const all=s.canonical?.attempts??[], a=all.find(x=>digest(x.identity)===digest(identity));if(!a)throw new MediaWriteUncertain("MEDIA_ORIGINAL_ATTEMPT_REQUIRED");
      if(a.receipt)return structuredClone(a.receipt);if(a.closed)return structuredClone(a.closed);
      const isLatest=all.at(-1)===a,parsed=canonicalMediaReadbackSchema.safeParse(raw);
      const hold=(reasonCode:string):CanonicalMediaReadback=>{if(isLatest){s.state="uncertain";s.heldReasons=[reasonCode];
        if(identity.entityRef!==identity.campaignId){const m=this.loadMutation(identity.entityRef);if(m){m.state="uncertain";m.heldReasons=[reasonCode];this.saveMutation(m);}}this.save(s);}return{state:"unknown",reasonCode};};
      if(!parsed.success)return hold("MEDIA_READBACK_UNVERIFIED");
      if(parsed.data.state==="unknown")return hold(parsed.data.reasonCode);
      const result=parsed.data,actual=result as Record<string,unknown>, t=Date.parse(result.observedAt);
      if(Object.entries(identity).some(([k,v])=>digest(actual[k])!==digest(v))||t<Date.parse(a.startedAt)||t>this.now().getTime())return hold("MEDIA_READBACK_IDENTITY_MISMATCH");
      if(result.state==="notApplied"){
        if(Date.parse(result.validUntil)<=this.now().getTime()||Date.parse(result.validUntil)<=t)return hold("MEDIA_CLOSURE_EXPIRED");
        a.closed=result;if(isLatest){s.state="held";s.heldReasons=["MEDIA_ORIGINAL_ATTEMPT_CLOSED"];if(identity.entityRef!==identity.campaignId){const m=this.loadMutation(identity.entityRef);if(m){m.state="not-applied";m.heldReasons=["MEDIA_ORIGINAL_ATTEMPT_CLOSED"];this.saveMutation(m);}}}this.save(s);return structuredClone(result);
      }
      const n=result.native.settings;
      if(n.provider!==identity.provider||n.providerAccountRef!==identity.providerAccountRef||n.environment!==identity.scope.environment||
        (identity.nativeCampaignId!==null&&n.nativeCampaignId!==identity.nativeCampaignId)||Date.parse(n.observedAt)>t||Date.parse(n.observedAt)<Date.parse(a.startedAt))return hold("MEDIA_NATIVE_IDENTITY_MISMATCH");
      const before=a.source.native, request=this.frozenRequest(identity.payloadHash);
      const nativeMaterial=(settings:NativeSettings)=>({...settings,observedAt:undefined,receiptOrigin:undefined});
      if(result.outcome==="applied"){
        if(result.rejectionCode!==null)return hold("MEDIA_READBACK_OUTCOME_MISMATCH");
        if(identity.action==="media.createDraft"||identity.action==="media.publish"){
          const mismatches=readbackMismatches(request.manifest,n,identity.action==="media.createDraft"?["PAUSED"]:["ACTIVE","IN_REVIEW"]);
          if(mismatches.length)return hold("MEDIA_APPLIED_STATE_MISMATCH");
        }else{
          if(!before)return hold("MEDIA_ORIGINAL_NATIVE_BASIS_REQUIRED");
          const expected={...before.settings,...(identity.action==="media.pause"?{status:"PAUSED" as const}:{dailyBudgetMinor:request.dailyBudgetMinor})};
          if(digest(nativeMaterial(n))!==digest(nativeMaterial(expected)))return hold("MEDIA_APPLIED_STATE_MISMATCH");
        }
        const priorSafety=before?.safetyGeneration??0;
        if(result.native.safetyGeneration!==priorSafety+(identity.action==="media.pause"?1:0)||
          (before&&result.native.nativeVersion===before.nativeVersion)||
          (before&&identity.action!=="media.publish"&&result.native.publicationGeneration!==before.publicationGeneration)||
          (before&&identity.action==="media.publish"&&result.native.publicationGeneration===before.publicationGeneration))return hold("MEDIA_NATIVE_VERSION_UNVERIFIED");
      }else{
        if(result.rejectionCode===null)return hold("MEDIA_READBACK_OUTCOME_MISMATCH");
        if(identity.action==="media.createDraft"||identity.action==="media.publish"){
          if(readbackMismatches(request.manifest,n,["REJECTED"]).length)return hold("MEDIA_REJECTION_STATE_MISMATCH");
        }else if(!before||digest(nativeMaterial(n))!==digest(nativeMaterial(before.settings)))return hold("MEDIA_REJECTION_STATE_MISMATCH");
      }
      try{this.claimCanonicalNative(s,n.nativeCampaignId);}catch{return hold("MEDIA_NATIVE_OWNERSHIP_CONFLICT");}
      try{this.claimReceipt(`${namespaceOf(s)}/${result.receiptRef}`,identity.dispatchKey,"canonical");}catch{return hold("MEDIA_RECEIPT_REUSED");}
      a.receipt=result;s.gates=a.source.gates.map(g=>({gate:g.gate,state:g.state,sourceRef:g.sourceRef,receiptOrigin:g.receiptOrigin}));s.receipts.push({kind:"canonical-operation",ref:result.receiptRef,origin:n.receiptOrigin,at:result.observedAt});
      // An older publication receipt is historical; it can never undo a later confirmed safety pause.
      const staleSafety=identity.action!=="media.pause"&&result.native.safetyGeneration<s.pauses;
      if(!staleSafety&&isLatest){
        s.nativeCampaignId=n.nativeCampaignId;s.nativeAdIds=n.nativeAdIds;s.previewRef=n.previewRef;s.readback=n;s.effectiveDailyBudgetMinor=n.dailyBudgetMinor;
        if(identity.action==="media.createDraft")s.draftCreated=true;
        if(identity.action==="media.publish")s.publishAttempted=true;
        if(identity.action==="media.pause"&&result.outcome==="applied")s.pauses=Math.max(s.pauses,result.native.safetyGeneration);
        s.state=result.outcome==="rejected"?"provider-rejected":identity.action==="media.createDraft"?"draft":"confirmed";
        s.providerReview={state:n.status==="ACTIVE"?"active":n.status==="IN_REVIEW"?"in-review":n.status==="REJECTED"?"rejected":"not-submitted",rejectionCode:result.rejectionCode};
        s.heldReasons=[];
      }
      if(identity.action==="media.pause"&&result.outcome==="applied")s.pauses=Math.max(s.pauses,result.native.safetyGeneration);
      if(identity.entityRef!==identity.campaignId){const mutation=this.loadMutation(identity.entityRef);if(mutation){
        mutation.state=result.outcome==="rejected"?"provider-rejected":"confirmed";mutation.receiptRef=result.receiptRef;mutation.receiptOrigin=n.receiptOrigin;
        mutation.after=n;mutation.providerRejectionCode=result.rejectionCode;mutation.heldReasons=[];mutation.attempted=true;mutation.reconciledBy="receipt";
        mutation.history.push({state:mutation.state,at:result.observedAt,ref:result.receiptRef});this.saveMutation(mutation);}}
      this.save(s);return structuredClone(result);
    });
  }

  private apply<T>(key: string, command: unknown, fn: () => T): T {
    requireKey(key);
    const hash = digest(command);
    return this.tx(() => {
      const prior = this.db.prepare("SELECT hash,body FROM media_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const result = prior ? JSON.parse(String(prior.body)) as T : fn();
      if (!prior) this.db.prepare("INSERT INTO media_commands VALUES(?,?,?)").run(key, hash, JSON.stringify(result));
      return result;
    });
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private iso() { return this.now().toISOString(); }
  private load(campaignId: string): Stored | null {
    const row = this.db.prepare("SELECT body FROM media_campaigns WHERE campaign_id=?").get(ref.parse(campaignId));
    return row ? JSON.parse(String(row.body)) as Stored : null;
  }
  private require(campaignId: string): Stored {
    const s = this.load(campaignId);
    if (!s) throw new AgentConflict("CAMPAIGN_UNKNOWN");
    return s;
  }
  private save(s: Stored) {
    this.db.prepare("INSERT INTO media_campaigns VALUES(?,?,?) ON CONFLICT(campaign_id) DO UPDATE SET body=excluded.body").run(s.campaignId, s.campaignRef, JSON.stringify(s));
  }
  private loadMutation(mutationId: string): StoredMutation | null {
    const row = this.db.prepare("SELECT body FROM media_mutations WHERE mutation_id=?").get(ref.parse(mutationId));
    return row ? JSON.parse(String(row.body)) as StoredMutation : null;
  }
  private saveMutation(m: StoredMutation) {
    this.db.prepare("INSERT INTO media_mutations VALUES(?,?,?,?,?) ON CONFLICT(mutation_id) DO UPDATE SET active=excluded.active, body=excluded.body")
      .run(m.mutationId, m.campaignId, m.requestHash, OPEN_MUTATION.includes(m.state) ? 1 : 0, JSON.stringify(m));
  }
  private move(s: Stored, state: CampaignState, sourceRef: string | null) { s.state = state; s.history.push({ state, at: this.iso(), ref: sourceRef }); }
  private moveMutation(m: StoredMutation, state: MutationState, sourceRef: string | null) { m.state = state; m.history.push({ state, at: this.iso(), ref: sourceRef }); }
  private claimable(receiptKey: string, subjectId: string, kind: string) {
    const used = this.db.prepare("SELECT subject_id,kind FROM media_receipts WHERE source_ref=?").get(receiptKey);
    return !used || (used.subject_id === subjectId && used.kind === kind);
  }
  /** Claims a namespaced receipt key for one subject. Before any external write this may refuse; after one, callers check claimable first. */
  private claimReceipt(receiptKey: string, subjectId: string, kind: string) {
    if (!this.claimable(receiptKey, subjectId, kind)) throw new AgentConflict("RECEIPT_REUSED");
    this.db.prepare("INSERT OR IGNORE INTO media_receipts VALUES(?,?,?)").run(receiptKey, subjectId, kind);
  }
  /** Existing ownership table, scoped to the provider's actual native-ID namespace. Caller holds the SQLite write transaction. */
  private claimCanonicalNative(s:Stored,nativeId:string) {
    const namespace=JSON.stringify([s.input.provider,s.input.providerAccountRef,s.input.environment]);
    const legacy=this.db.prepare("SELECT campaign_id FROM media_native WHERE provider=? AND native_id=?").get(s.input.provider,nativeId);
    if(legacy&&legacy.campaign_id!==s.campaignId){
      // Retain old provider-only claims; widen their namespace only when the owning campaign proves a different account/environment.
      const owner=typeof legacy.campaign_id==="string"?this.load(legacy.campaign_id):null;
      if(!owner||owner.input.provider!==s.input.provider||owner.input.providerAccountRef===s.input.providerAccountRef&&owner.input.environment===s.input.environment)
        throw new AgentConflict("MEDIA_NATIVE_OWNERSHIP_CONFLICT");
    }
    const used=this.db.prepare("SELECT campaign_id FROM media_native WHERE provider=? AND native_id=?").get(namespace,nativeId);
    if(used&&used.campaign_id!==s.campaignId)throw new AgentConflict("MEDIA_NATIVE_OWNERSHIP_CONFLICT");
    if(!used)this.db.prepare("INSERT INTO media_native VALUES(?,?,?)").run(namespace,nativeId,s.campaignId);
  }
  /** The manifest as stored for this revision. A body that no longer matches its hash is never used. */
  private manifestOf(s: Stored): Manifest {
    const row = this.db.prepare("SELECT manifest_hash,body FROM media_manifests WHERE campaign_id=? AND revision=?").get(s.campaignId, s.revision);
    const manifest = row ? parse(manifestSchema, JSON.parse(String(row.body))) : null;
    if (!manifest || row?.manifest_hash !== s.manifestHash || digest(manifest) !== s.manifestHash) throw new AgentConflict("MANIFEST_UNAVAILABLE");
    return manifest;
  }

  /** One operation on one route, made effective. Ready needs an in-date account test receipt; discovery or documentation stays Unverified. */
  private capability(b: Binding, operation: MediaOperation, route: ExecRoute): CapabilityEntry {
    const binding = { provider: b.provider, providerAccountRef: b.providerAccountRef, environment: b.environment, operation, route };
    const o = parse(capabilityObservationSchema, this.authority.capability?.(binding, this.scope));
    if (!o) return { operation, route, observedState: null, state: "Unverified", evidence: null, sourceRef: null, toolVersion: null, receiptRef: null,
      receiptOrigin: null, checkedAt: null, expiresAt: null, reasons: ["CAPABILITY_UNOBSERVED"] };
    const entry: CapabilityEntry = { operation, route, observedState: o.state, state: o.state, evidence: o.evidence, sourceRef: o.sourceRef,
      toolVersion: o.toolVersion, receiptRef: o.receiptRef, receiptOrigin: o.receiptOrigin, checkedAt: o.checkedAt, expiresAt: o.expiresAt, reasons: [] };
    if (!sameScope(o.scope, this.scope) || o.provider !== b.provider || o.providerAccountRef !== b.providerAccountRef || o.environment !== b.environment
      || o.operation !== operation || o.route !== route) return { ...entry, state: "Unverified", reasons: ["CAPABILITY_BINDING_MISMATCH"] };
    if (o.state !== "Ready") return { ...entry, reasons: [`CAPABILITY_${o.state.toUpperCase()}`] };
    const now = this.now().getTime(), reasons: string[] = [];
    if (o.evidence !== "account-test") reasons.push(o.evidence === "mcp-discovery" ? "MCP_DISCOVERY_IS_NOT_AUTHORIZATION" : "DOCUMENTATION_IS_NOT_AUTHORIZATION");
    if (!o.receiptRef) reasons.push("TEST_RECEIPT_MISSING");
    if (notYet(o.checkedAt, now)) reasons.push("CAPABILITY_CHECK_UNDATED");
    if (lapsed(o.expiresAt, now)) reasons.push("CAPABILITY_EXPIRED");
    return reasons.length ? { ...entry, state: "Unverified", reasons } : entry;
  }

  private accountReasons(a: MediaAccount | null, b: Binding): string[] {
    if (!a) return ["ACCOUNT_UNVERIFIED"];
    if (!sameScope(a.scope, this.scope) || a.provider !== b.provider || a.providerAccountRef !== b.providerAccountRef || a.environment !== b.environment)
      return ["ACCOUNT_MISMATCH"];
    const reasons: string[] = [];
    if (a.currency === null) reasons.push("ACCOUNT_CURRENCY_UNKNOWN"); else if (a.currency !== "USD") reasons.push("ACCOUNT_CURRENCY_NOT_USD");
    if (a.market === null) reasons.push("ACCOUNT_MARKET_UNKNOWN");
    if (a.timezone === null) reasons.push("ACCOUNT_TIMEZONE_UNKNOWN");
    if (!a.identityRef || !a.identityApproved) reasons.push("IDENTITY_NOT_APPROVED");
    return reasons;
  }

  /** Compiles the manifest from trusted sources. Problems are reasons; the manifest is null when a source it needs is missing. */
  private compile(input: PrepareInput): { manifest: Manifest | null; reasons: string[] } {
    const now = this.now().getTime(), reasons: string[] = [];
    if (input.environment === "production") reasons.push("PRODUCTION_HELD");
    const account = parse(accountSchema, this.authority.account?.(input.provider, input.providerAccountRef, this.scope));
    const accountIssues = this.accountReasons(account, input);
    reasons.push(...accountIssues);
    const preset = ROUTE_PRESETS[input.campaignRoute];
    if (preset.provider !== input.provider) reasons.push("ROUTE_UNSUPPORTED_FOR_PROVIDER");
    if (!preset.bidStrategies.includes(input.bid.strategy)) reasons.push("BID_STRATEGY_NOT_NATIVE_TO_ROUTE");
    const checkout = parse(checkoutSchema, this.authority.checkout?.(input.checkoutRef, this.scope));
    const checkoutOk = !!checkout && sameScope(checkout.scope, this.scope) && checkout.checkoutRef === input.checkoutRef;
    if (!checkoutOk) reasons.push("CHECKOUT_UNVERIFIED");
    else {
      if (lapsed(checkout.validUntil, now)) reasons.push("CHECKOUT_STALE");
      const chosen = routeForCheckout(input.provider, checkout);
      if ("reason" in chosen) reasons.push(chosen.reason); else if (chosen.route !== input.campaignRoute) reasons.push("ROUTE_DOES_NOT_MATCH_CHECKOUT");
      if (checkout.destinationRef !== input.destinationRef) reasons.push("DESTINATION_MISMATCH");
    }
    const offer = parse(offerVersionSchema, this.authority.offer?.(input.offerRef, this.scope));
    const offerOk = !!offer && sameScope(offer.scope, this.scope) && offer.offerRef === input.offerRef;
    if (!offerOk) reasons.push("OFFER_UNVERIFIED");
    else {
      if (offer.state !== "approved") reasons.push("OFFER_NOT_APPROVED");
      if (lapsed(offer.validUntil, now)) reasons.push("OFFER_EXPIRED");
      if (checkoutOk && offer.skuRef !== checkout.skuRef) reasons.push("OFFER_CHECKOUT_MISMATCH");
    }
    const creatives: Manifest["creatives"] = [];
    for (const assetRef of input.creativeRefs) {
      const a = parse(assetSchema, this.authority.asset?.(assetRef, this.scope));
      if (!a || !sameScope(a.scope, this.scope) || a.assetRef !== assetRef) { reasons.push(`ASSET_UNVERIFIED:${assetRef}`); continue; }
      if (!a.reviewed) reasons.push(`ASSET_NOT_REVIEWED:${assetRef}`);
      if (offerOk && a.claimsVersion !== offer.claimsVersion) reasons.push(`CLAIMS_VERSION_MISMATCH:${assetRef}`);
      if (!a.rights.paidUsage) reasons.push(`PAID_RIGHTS_MISSING:${assetRef}`);
      if (!a.rights.nativePermission) reasons.push(`NATIVE_PERMISSION_MISSING:${assetRef}`);
      if (lapsed(a.rights.expiresAt, now)) reasons.push(`RIGHTS_EXPIRED:${assetRef}`);
      else if (!(ms(a.rights.expiresAt) >= ms(input.schedule.endAt))) reasons.push(`RIGHTS_EXPIRE_BEFORE_SCHEDULE_END:${assetRef}`);
      creatives.push({ assetRef, contentHash: a.contentHash, rightsRef: a.rights.rightsRef, rightsHash: a.rights.rightsHash, rightsExpiresAt: a.rights.expiresAt });
    }
    const unique = [...new Set(reasons)];
    if (!account || accountIssues.length || !checkoutOk || !offerOk || creatives.length !== input.creativeRefs.length) return { manifest: null, reasons: unique };
    const manifest = manifestSchema.parse({
      scope: this.scope, campaignRef: input.campaignRef, provider: input.provider, environment: input.environment,
      account: { providerAccountRef: account.providerAccountRef, kind: account.kind, market: account.market, currency: account.currency, timezone: account.timezone,
        identityRef: account.identityRef },
      campaignRoute: input.campaignRoute, objective: preset.objective, optimizationEvent: preset.optimizationEvent,
      checkout: { checkoutRef: checkout.checkoutRef, kind: checkout.kind, skuRef: checkout.skuRef },
      offer: { offerRef: offer.offerRef, version: offer.version, skuRef: offer.skuRef, claimsVersion: offer.claimsVersion },
      creatives, destinationRef: input.destinationRef, attributionSetting: input.attributionSetting, schedule: input.schedule, currency: "USD",
      targeting: input.targeting, bid: input.bid, caps: input.caps,
      deliveryExtras: { extraDeliveryBudget: false, maxDelivery: false, autoRecharge: false, placementExpansion: false },
    });
    return { manifest, reasons: unique };
  }
  /** Re-resolves every source before a provider write. A changed asset, offer, rights or checkout never rides on an older approval. */
  private assertSourcesUnchanged(s: Stored) {
    const { manifest, reasons } = this.compile(s.input);
    if (!manifest || digest(manifest) !== s.manifestHash) throw new AgentConflict("MANIFEST_SOURCES_CHANGED");
    if (reasons.length) throw new AgentConflict(reasons[0]!.split(":")[0]!);
  }
  private gateStatus(s: Stored): GateStatus[] {
    const now = this.now().getTime();
    return MEDIA_GATES.map((gate): GateStatus => {
      const g = parse(gateReceiptSchema, this.authority.gate?.(gate, { campaignId: s.campaignId, manifestHash: s.manifestHash! }, this.scope));
      if (!g) return { gate, state: "missing", sourceRef: null, receiptOrigin: null };
      const base = { gate, sourceRef: g.sourceRef, receiptOrigin: g.receiptOrigin };
      if (!sameScope(g.scope, this.scope) || g.gate !== gate || g.campaignId !== s.campaignId || g.manifestHash !== s.manifestHash) return { ...base, state: "mismatch" };
      if (g.state !== "verified") return { ...base, state: g.state };
      if (notYet(g.verifiedAt, now) || lapsed(g.expiresAt, now)) return { ...base, state: "expired" };
      return { ...base, state: "verified" };
    });
  }

  /** Records the account and every per-operation capability on every route, with source, tool version and receipt. */
  recordInventory(body: unknown, key: string): InventoryView {
    const input = inventoryInputSchema.parse(body);
    return this.apply(key, { op: "inventory", input }, () => {
      const account = parse(accountSchema, this.authority.account?.(input.provider, input.providerAccountRef, this.scope));
      const accountReasons = this.accountReasons(account, input);
      const capabilities = OPERATIONS.flatMap((op) => EXEC_ROUTES.map((r) => this.capability(input, op, r)));
      const recordedAt = this.iso();
      const visible = account && !accountReasons.includes("ACCOUNT_MISMATCH") ? (({ scope: _scope, ...rest }) => rest)(account) : null;
      const view = inventoryViewSchema.parse({
        kind: "paid-media-inventory", inventoryId: `inventory-${digest({ input, recordedAt, key }).slice(0, 32)}`, ...input, account: visible, accountReasons,
        capabilities, recordedAt, evidenceLabel: label([visible?.receiptOrigin, ...capabilities.map((c) => c.receiptOrigin)]),
      });
      this.db.prepare("INSERT INTO media_inventories VALUES(?,?,?,?,?,?)").run(view.inventoryId, input.provider, input.providerAccountRef, input.environment, recordedAt,
        JSON.stringify(view));
      return view;
    });
  }
  latestInventory(provider: string, environment: string, providerAccountRef: string): InventoryView | null {
    const row = this.db.prepare("SELECT body FROM media_inventories WHERE provider=? AND environment=? AND account_ref=? ORDER BY recorded_at DESC, rowid DESC LIMIT 1")
      .get(provider, environment, ref.parse(providerAccountRef));
    return row ? JSON.parse(String(row.body)) as InventoryView : null;
  }

  /** Compiles, or revises before release, the one campaign for a campaign reference. Any change makes a new revision and clears approval. */
  prepare(body: unknown, key: string): CampaignView {
    const input = prepareSchema.parse(body);
    return this.apply(key, { op: "prepare", input }, () => {
      const now = this.now();
      const campaignId = `media-${digest({ scope: this.scope, campaignRef: input.campaignRef }).slice(0, 32)}`;
      const prior = this.load(campaignId);
      if (prior?.pending) throw new AgentConflict("RECONCILE_FIRST");
      if (prior && released(prior)) throw new AgentConflict("CAMPAIGN_ALREADY_RELEASED");
      if (prior && !REVISABLE.includes(prior.state)) throw new AgentConflict("CAMPAIGN_IN_PROGRESS");
      if (prior?.nativeCampaignId && (prior.input.provider !== input.provider || prior.input.providerAccountRef !== input.providerAccountRef
        || prior.input.environment !== input.environment)) throw new AgentConflict("NATIVE_DRAFT_BOUND_TO_ANOTHER_ACCOUNT");
      const { manifest, reasons } = this.compile(input);
      if (lapsed(input.schedule.startAt, now.getTime())) reasons.push("SCHEDULE_START_PASSED");
      if (lapsed(input.expiresAt, now.getTime())) reasons.push("REQUEST_EXPIRED");
      const manifestHash = manifest ? digest(manifest) : null;
      if (prior && prior.manifestHash === manifestHash && digest(prior.input) === digest(input) && digest(prior.heldReasons) === digest(reasons)) return this.view(prior);
      const s: Stored = prior ? { ...prior, revision: prior.revision + 1 } : {
        campaignId, campaignRef: input.campaignRef, revision: 1, state: "held", revisedAt: now.toISOString(), input, manifestHash, heldReasons: [],
        nativeCampaignId: null, nativeAdIds: [], previewRef: null, readback: null, releaseHash: null, releaseRequestedAt: null, decisionRef: null, decision: "none",
        decisionValidUntil: null, approvedScope: null, effectiveDailyBudgetMinor: null, providerReview: { state: "not-submitted", rejectionCode: null },
        gates: MEDIA_GATES.map((gate) => ({ gate, state: "not-checked", sourceRef: null, receiptOrigin: null })), pendingKind: null, pending: null, pauses: 0, route: null,
        reconciledBy: null, receipts: [], draftCreated: false, publishAttempted: false, history: [],
      };
      Object.assign(s, { revisedAt: now.toISOString(), input, manifestHash, heldReasons: reasons, readback: null, releaseHash: null, releaseRequestedAt: null,
        decisionRef: null, decision: "none", decisionValidUntil: null, approvedScope: null, effectiveDailyBudgetMinor: manifest?.caps.dailyBudgetMinor ?? null,
        providerReview: { state: "not-submitted", rejectionCode: null }, reconciledBy: null,
        gates: MEDIA_GATES.map((gate) => ({ gate, state: "not-checked", sourceRef: null, receiptOrigin: null })) });
      // The manifest is written once per revision and never updated.
      if (manifest) this.db.prepare("INSERT INTO media_manifests VALUES(?,?,?,?)").run(campaignId, s.revision, manifestHash, JSON.stringify(manifest));
      this.move(s, reasons.length || !manifest ? "held" : "draft", null);
      this.save(s);
      return this.view(s);
    });
  }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async createDraft(_campaignId: string, _key: string): Promise<CampaignView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  decide(_campaignId: string, _decisionRef: string, _key: string): CampaignView { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async publish(_campaignId: string, _key: string): Promise<CampaignView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  /**
   * Proposes one budget edit or pause. A budget edit needs a released campaign. A pause needs only a native campaign; it is applied when
   * the provider reads it active, including a draft the provider activated. A repeated event returns the same open mutation.
   */
  proposeMutation(campaignId: string, body: unknown, key: string): MutationView {
    const input = mutationInputSchema.parse(body);
    return this.apply(key, { op: "mutation", campaignId, input }, () => {
      const s = this.require(campaignId);
      if (!s.nativeCampaignId) throw new AgentConflict("CAMPAIGN_NOT_LIVE");
      if (input.kind === "edit-budget" && (s.pending || !released(s))) throw new AgentConflict("CAMPAIGN_NOT_LIVE");
      const requestHash = digest({ campaignId, revision: s.revision, manifestHash: s.manifestHash, nativeCampaignId: s.nativeCampaignId, action: input.kind,
        dailyBudgetMinor: input.dailyBudgetMinor });
      const open = this.db.prepare("SELECT body FROM media_mutations WHERE campaign_id=? AND request_hash=? AND active=1").get(campaignId, requestHash);
      if (open) {
        const prior = JSON.parse(String(open.body)) as StoredMutation;
        // A held pause with no write in flight never blocks a new pause: it is closed and the new attempt reads the native state first.
        if (!(prior.action === "pause" && prior.state === "held" && !prior.pending)) return this.mutationView(prior);
        prior.heldReasons = [...prior.heldReasons, "SUPERSEDED_BY_NEW_PAUSE"];
        this.moveMutation(prior, "not-applied", null);
        this.saveMutation(prior);
      }
      const reasons: string[] = [];
      if (input.kind === "edit-budget" && input.dailyBudgetMinor !== null) {
        const m = this.manifestOf(s);
        if (input.dailyBudgetMinor > m.caps.lifetimeBudgetMinor) reasons.push("BUDGET_EXCEEDS_LIFETIME_CAP");
        if (!s.approvedScope || input.dailyBudgetMinor > s.approvedScope.maxDailyBudgetMinor) reasons.push("FINANCIAL_SCOPE_EXCEEDED");
        if (input.dailyBudgetMinor === s.effectiveDailyBudgetMinor) reasons.push("NO_CHANGE");
      }
      const n = Number(this.db.prepare("SELECT COUNT(*) AS n FROM media_mutations WHERE campaign_id=?").get(campaignId)?.n ?? 0);
      const mutation: StoredMutation = {
        mutationId: `mutation-${digest({ campaignId, requestHash, n: n + 1 }).slice(0, 32)}`, campaignId, action: input.kind, dailyBudgetMinor: input.dailyBudgetMinor,
        requestHash, state: "held", createdAt: this.iso(), heldReasons: reasons, decisionRef: null, policyRef: null, authorizedBy: null, route: null, before: null,
        after: null, receiptRef: null, receiptOrigin: null, providerRejectionCode: null, reconciledBy: null, pending: null, attempted: false, history: [],
      };
      this.moveMutation(mutation, reasons.length ? "held" : "draft", null);
      this.saveMutation(mutation);
      return this.mutationView(mutation);
    });
  }

  /** Retired effect entrypoint. The shared J04 action and job services exclusively own this operation. */
  async applyMutation(_campaignId: string, _mutationId: string, _authorization: MutationAuthorization, _key: string): Promise<MutationView> { throw new AgentConflict("CANONICAL_MEDIA_ACTION_REQUIRED"); }

  read(campaignId: string): CampaignView | null { const s = this.load(campaignId); return s ? this.view(s) : null; }
  readMutation(campaignId: string, mutationId: string): MutationView | null {
    const m = this.loadMutation(mutationId);
    return m && m.campaignId === campaignId ? this.mutationView(m) : null;
  }

  private mutationView(m: StoredMutation): MutationView {
    return mutationViewSchema.parse({
      kind: "paid-media-mutation", mutationId: m.mutationId, campaignId: m.campaignId, action: m.action, dailyBudgetMinor: m.dailyBudgetMinor,
      requestHash: m.requestHash, state: m.state, heldReasons: m.heldReasons, decisionRef: m.decisionRef, policyRef: m.policyRef,
      authorizedBy: m.authorizedBy, route: m.route, before: m.before, after: m.after,
      receiptRef: m.receiptRef, providerRejectionCode: m.providerRejectionCode, reconciledBy: m.reconciledBy,
      evidenceLabel: label([m.receiptOrigin, m.before?.receiptOrigin, m.after?.receiptOrigin]), history: m.history,
      sourceEffects: m.attempted ? "mutation-attempted" : "none",
    });
  }
  private view(s: Stored): CampaignView {
    const manifest = s.manifestHash ? this.manifestOf(s) : null;
    const mutations = this.db.prepare("SELECT body FROM media_mutations WHERE campaign_id=? ORDER BY rowid").all(s.campaignId)
      .map((row) => JSON.parse(String(row.body)) as StoredMutation).map((m) => ({ mutationId: m.mutationId, action: m.action, state: m.state }));
    const uncertain=s.canonical?.attempts.find(a=>!a.receipt&&!a.closed);
    return campaignViewSchema.parse({
      kind: "paid-media-campaign", campaignId: s.campaignId, campaignRef: s.campaignRef, revision: s.revision, state: s.state, provider: s.input.provider,
      environment: s.input.environment, campaignRoute: s.input.campaignRoute, manifest, manifestHash: s.manifestHash, releaseHash: s.releaseHash,
      releaseRequested: s.state === "draft" && s.releaseHash !== null, heldReasons: s.heldReasons,
      native: { nativeCampaignId: s.nativeCampaignId, nativeAdIds: s.nativeAdIds, previewRef: s.previewRef, status: s.readback?.status ?? null, readback: s.readback },
      approval: { decision: s.decision, decisionRef: s.decisionRef, validUntil: s.decisionValidUntil }, providerReview: s.providerReview, gates: s.canonical ? this.gateStatus(s) : s.gates,
      execution: { route: s.route, key: uncertain?.identity.dispatchKey ?? s.pending?.key ?? null, leaseUntil: s.pending?.leaseUntil ?? null, pending: !!uncertain || s.pending !== null, reconciledBy: s.reconciledBy },
      receipts: s.receipts, evidenceLabel: label(s.receipts.map((r) => r.origin)), mutations, history: s.history,
      sourceEffects: s.publishAttempted ? "publish-attempted" : s.draftCreated ? "draft-created" : uncertain?.identity.action==="media.createDraft" ? "draft-attempted" : "none",
    });
  }
}
