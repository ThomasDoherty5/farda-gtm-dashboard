import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import {
  EXEC_ROUTES, MEDIA_GATES, OPERATIONS, ROUTE_PRESETS, accountSchema, assetSchema, campaignViewSchema, capabilityObservationSchema, checkoutSchema,
  decisionSchema, draftReceiptSchema, gateReceiptSchema, handoffSchema, inventoryInputSchema, inventoryViewSchema, manifestSchema, mutationAuthorizationSchema,
  mutationInputSchema, safetyPolicySchema,
  mutationReceiptSchema, mutationViewSchema, nativeSettingsSchema, offerVersionSchema, prepareSchema, publishReceiptSchema, ref,
  type CampaignRoute, type CampaignState, type CampaignView, type CapabilityEntry, type Checkout, type ExecRoute, type InventoryView, type Manifest,
  type MediaAccount, type MediaDecision, type MediaGate, type MediaOperation, type MediaProvider, type MediaScope, type MutationKind,
  type MutationAuthorization, type MutationState, type MutationView, type NativeSettings, type PrepareInput, type ReceiptOrigin,
} from "./contract.ts";

type Binding = { provider: MediaProvider; providerAccountRef: string; environment: "sandbox" | "production" };
/** The provider writer. Every write is keyed and idempotent at the provider; read() finds an earlier write by its key. */
export interface MediaExecutor {
  createDraft(key: string, payload: { manifest: Manifest; manifestHash: string; nativeCampaignId: string | null; status: "PAUSED" }, route: ExecRoute): unknown;
  publish(key: string, payload: { nativeCampaignId: string; manifestHash: string; releaseHash: string }, route: ExecRoute): unknown;
  mutate(key: string, payload: { nativeCampaignId: string; action: MutationKind; dailyBudgetMinor: number | null }, route: ExecRoute): unknown;
  read(key: string, route: ExecRoute): unknown;
  readBack(nativeCampaignId: string, route: ExecRoute): unknown;
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

/** A pending provider write. The token identifies the worker holding the lease; only that worker may finish or release it. */
type Pending = { key: string; token: string; route: ExecRoute; leaseUntil: string; handoff: string | null };
type Receipt = { kind: string; ref: string; origin: ReceiptOrigin; at: string };
type GateStatus = CampaignView["gates"][number];
type Stored = {
  campaignId: string; campaignRef: string; revision: number; state: CampaignState; revisedAt: string; input: PrepareInput; manifestHash: string | null;
  heldReasons: string[]; nativeCampaignId: string | null; nativeAdIds: string[]; previewRef: string | null; readback: NativeSettings | null;
  releaseHash: string | null; releaseRequestedAt: string | null; decisionRef: string | null; decision: "none" | "approved" | "rejected";
  decisionValidUntil: string | null; approvedScope: MediaDecision["financialScope"] | null; effectiveDailyBudgetMinor: number | null;
  providerReview: CampaignView["providerReview"]; gates: GateStatus[]; pendingKind: "draft" | "publish" | null; pending: Pending | null;
  route: ExecRoute | null; reconciledBy: "receipt" | "native-readback" | null; receipts: Receipt[]; draftCreated: boolean; publishAttempted: boolean;
  history: { state: CampaignState; at: string; ref: string | null }[];
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
const LEASE_MS = 120_000;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const sameScope = (a: MediaScope, b: MediaScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
const code = (value: string) => value.toUpperCase().replace(/-/g, "_");
const requireKey = (key: string) => { if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED"); };
const settingsOf = ({ observedAt: _observed, receiptOrigin: _origin, ...settings }: NativeSettings) => settings;
const setOf = (values: string[]) => digest([...values].sort());
const LIVE: NativeSettings["status"][] = ["ACTIVE", "IN_REVIEW"];
const owns = (p: Pending | null, mine: Pending): p is Pending => !!p && p.key === mine.key && p.token === mine.token;
const refOf = (auth: MutationAuthorization) => ("policyRef" in auth ? auth.policyRef : auth.decisionRef);
/** Released: confirmed, or read live on the provider. A released campaign changes only through mutations. */
const released = (s: { state: CampaignState; readback: NativeSettings | null }) => s.state === "confirmed" || (!!s.readback && LIVE.includes(s.readback.status));
const passthrough = (error: unknown) => error instanceof AgentConflict || error instanceof MediaSourceUnavailable;
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
      CREATE TABLE IF NOT EXISTS media_inventories (inventory_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_ref TEXT NOT NULL, recorded_at TEXT NOT NULL,
        body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media_receipts (source_ref TEXT PRIMARY KEY, subject_id TEXT NOT NULL, kind TEXT NOT NULL);`);
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
  private claimReceipt(sourceRef: string, subjectId: string, kind: string) {
    const used = this.db.prepare("SELECT subject_id,kind FROM media_receipts WHERE source_ref=?").get(sourceRef);
    if (used && (used.subject_id !== subjectId || used.kind !== kind)) throw new AgentConflict("RECEIPT_REUSED");
    if (!used) this.db.prepare("INSERT INTO media_receipts VALUES(?,?,?)").run(sourceRef, subjectId, kind);
  }
  private executor(): MediaExecutor {
    if (!this.authority.executor) throw new MediaSourceUnavailable("MEDIA_EXECUTOR_UNAVAILABLE");
    return this.authority.executor;
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
    if (!o.checkedAt || Date.parse(o.checkedAt) > now) reasons.push("CAPABILITY_CHECK_UNDATED");
    if (!o.expiresAt || Date.parse(o.expiresAt) <= now) reasons.push("CAPABILITY_EXPIRED");
    return reasons.length ? { ...entry, state: "Unverified", reasons } : entry;
  }
  /**
   * The execution route for an operation. A programmatic route is used when Ready. A Denied programmatic route is never bypassed in a
   * browser; the browser route is used only when both programmatic routes are Unsupported and the browser capability is itself Ready.
   */
  private routeFor(b: Binding, operation: MediaOperation): { route: ExecRoute } | { reason: string } {
    const [api, mcp, browser] = EXEC_ROUTES.map((r) => this.capability(b, operation, r)) as [CapabilityEntry, CapabilityEntry, CapabilityEntry];
    const op = code(operation);
    if (api.state === "Ready") return { route: "api" };
    if (mcp.state === "Ready") return { route: "mcp" };
    if (api.state === "Denied" || mcp.state === "Denied") return { reason: `${op}_CAPABILITY_DENIED` };
    if (api.state === "Unsupported" && mcp.state === "Unsupported") return browser.state === "Ready" ? { route: "browser" } : { reason: `${op}_CAPABILITY_UNSUPPORTED` };
    return { reason: `${op}_CAPABILITY_UNVERIFIED` };
  }
  private requireRoute(b: Binding, operation: MediaOperation): ExecRoute {
    const r = this.routeFor(b, operation);
    if ("reason" in r) throw new AgentConflict(r.reason);
    return r.route;
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
      if (Date.parse(checkout.validUntil) <= now) reasons.push("CHECKOUT_STALE");
      const chosen = routeForCheckout(input.provider, checkout);
      if ("reason" in chosen) reasons.push(chosen.reason); else if (chosen.route !== input.campaignRoute) reasons.push("ROUTE_DOES_NOT_MATCH_CHECKOUT");
      if (checkout.destinationRef !== input.destinationRef) reasons.push("DESTINATION_MISMATCH");
    }
    const offer = parse(offerVersionSchema, this.authority.offer?.(input.offerRef, this.scope));
    const offerOk = !!offer && sameScope(offer.scope, this.scope) && offer.offerRef === input.offerRef;
    if (!offerOk) reasons.push("OFFER_UNVERIFIED");
    else {
      if (offer.state !== "approved") reasons.push("OFFER_NOT_APPROVED");
      if (Date.parse(offer.validUntil) <= now) reasons.push("OFFER_EXPIRED");
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
      if (Date.parse(a.rights.expiresAt) <= now) reasons.push(`RIGHTS_EXPIRED:${assetRef}`);
      else if (Date.parse(a.rights.expiresAt) < Date.parse(input.schedule.endAt)) reasons.push(`RIGHTS_EXPIRE_BEFORE_SCHEDULE_END:${assetRef}`);
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
      if (Date.parse(g.verifiedAt) > now || Date.parse(g.expiresAt) <= now) return { ...base, state: "expired" };
      return { ...base, state: "verified" };
    });
  }
  private currentDecision(s: Stored, decisionRef: string, action: MediaDecision["action"], subjectHash: string, requestedAt: string): MediaDecision {
    const d = parse(decisionSchema, this.authority.decision?.(decisionRef, this.scope)), now = this.now().getTime();
    if (!d || !sameScope(d.scope, this.scope) || d.sourceRef !== decisionRef || d.campaignId !== s.campaignId) throw new MediaSourceUnavailable("J04_DECISION_UNVERIFIED");
    // A Slack or Notion decision is a signal, not release authority.
    if (d.system !== "linear") throw new AgentConflict("J04_LINEAR_DECISION_REQUIRED");
    if (d.action !== action || d.revision !== s.revision || d.manifestHash !== s.manifestHash || d.subjectHash !== subjectHash)
      throw new AgentConflict("J04_DECISION_FOR_ANOTHER_REQUEST");
    if (d.state !== "current" || Date.parse(d.validUntil) <= now) throw new AgentConflict("J04_DECISION_NOT_CURRENT");
    if (Date.parse(d.decidedAt) > now || Date.parse(d.decidedAt) < Date.parse(requestedAt)) throw new AgentConflict("J04_DECISION_PREDATES_REQUEST");
    return d;
  }
  private scopeIssue(d: MediaDecision, m: Manifest, dailyBudgetMinor: number): string | null {
    const f = d.financialScope;
    if (f.providerAccountRef !== m.account.providerAccountRef || f.campaignRoute !== m.campaignRoute || !m.targeting.placements.every((p) => f.placements.includes(p)))
      return "APPROVED_SCOPE_MISMATCH";
    if (dailyBudgetMinor > f.maxDailyBudgetMinor || m.caps.lifetimeBudgetMinor > f.maxLifetimeBudgetMinor) return "FINANCIAL_SCOPE_EXCEEDED";
    return null;
  }
  /** Claims the execution lease for a pending write. A live lease means another worker is applying it. */
  private claimLease(p: Pending) {
    if (Date.parse(p.leaseUntil) > this.now().getTime()) throw new AgentConflict("EXECUTION_IN_PROGRESS");
    p.leaseUntil = new Date(this.now().getTime() + LEASE_MS).toISOString();
    p.token = randomUUID();
  }
  private newPending(key: string, route: ExecRoute): Pending {
    return { key, token: randomUUID(), route, leaseUntil: new Date(this.now().getTime() + LEASE_MS).toISOString(), handoff: null };
  }
  /** Binds the caller's key to exactly one command, so reusing it for anything else is refused. */
  private bindKey(key: string, command: unknown) {
    requireKey(key);
    const hash = digest(command);
    this.tx(() => {
      const prior = this.db.prepare("SELECT hash FROM media_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      if (!prior) this.db.prepare("INSERT INTO media_commands VALUES(?,?,?)").run(key, hash, JSON.stringify(command));
    });
  }
  private async readNative(nativeCampaignId: string, route: ExecRoute): Promise<NativeSettings | null> {
    try { return parse(nativeSettingsSchema, await this.executor().readBack(nativeCampaignId, route)); } catch (error) { if (passthrough(error)) throw error; return null; }
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
      this.db.prepare("INSERT INTO media_inventories VALUES(?,?,?,?,?)").run(view.inventoryId, input.provider, input.providerAccountRef, recordedAt, JSON.stringify(view));
      return view;
    });
  }
  latestInventory(provider: string, providerAccountRef: string): InventoryView | null {
    const row = this.db.prepare("SELECT body FROM media_inventories WHERE provider=? AND account_ref=? ORDER BY recorded_at DESC, rowid DESC LIMIT 1")
      .get(provider, ref.parse(providerAccountRef));
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
      if (Date.parse(input.schedule.startAt) <= now.getTime()) reasons.push("SCHEDULE_START_PASSED");
      if (Date.parse(input.expiresAt) <= now.getTime()) reasons.push("REQUEST_EXPIRED");
      const manifestHash = manifest ? digest(manifest) : null;
      if (prior && prior.manifestHash === manifestHash && digest(prior.input) === digest(input) && digest(prior.heldReasons) === digest(reasons)) return this.view(prior);
      const s: Stored = prior ? { ...prior, revision: prior.revision + 1 } : {
        campaignId, campaignRef: input.campaignRef, revision: 1, state: "held", revisedAt: now.toISOString(), input, manifestHash, heldReasons: [],
        nativeCampaignId: null, nativeAdIds: [], previewRef: null, readback: null, releaseHash: null, releaseRequestedAt: null, decisionRef: null, decision: "none",
        decisionValidUntil: null, approvedScope: null, effectiveDailyBudgetMinor: null, providerReview: { state: "not-submitted", rejectionCode: null },
        gates: MEDIA_GATES.map((gate) => ({ gate, state: "not-checked", sourceRef: null, receiptOrigin: null })), pendingKind: null, pending: null, route: null,
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

  /**
   * Creates or updates the native campaign as a paused draft and reads its settings back. It never publishes or activates spend. A
   * matching read-back requests release; anything else holds the campaign with the mismatched fields.
   */
  async createDraft(campaignId: string, key: string): Promise<CampaignView> {
    this.bindKey(key, { op: "native-draft", campaignId });
    const executor = this.executor();
    const step = this.tx(() => {
      const s = this.require(campaignId);
      if (s.pending) {
        if (s.pendingKind !== "draft") throw new AgentConflict("RECONCILE_FIRST");
        this.claimLease(s.pending); this.save(s);
        return { s, mine: { ...s.pending }, resumed: true };
      }
      if (s.state === "draft" && s.releaseHash) return { s, mine: null, resumed: false };
      if (s.state !== "draft") throw new AgentConflict(s.state === "held" ? "CAMPAIGN_HELD" : "DRAFT_STAGE_PASSED");
      this.assertSourcesUnchanged(s);
      const route = this.requireRoute(s.input, "create-draft");
      this.requireRoute(s.input, "upload-creative"); this.requireRoute(s.input, "preview-creative"); this.requireRoute(s.input, "retrieve-outcome");
      s.pendingKind = "draft";
      s.pending = this.newPending(`draft:${s.campaignId}:r${s.revision}`, route);
      s.route = route; s.draftCreated = true;
      this.save(s);
      return { s, mine: { ...s.pending }, resumed: false };
    });
    if (!step.mine) return this.view(step.s);
    const mine = step.mine, manifest = this.manifestOf(step.s);
    let receipt: z.infer<typeof draftReceiptSchema> | null = null, handoff: string | null = null, readback: NativeSettings | null = null;
    try {
      let raw: unknown = step.resumed ? await executor.read(mine.key, mine.route) : undefined;
      if (!parse(draftReceiptSchema, raw)) {
        // A draft never spends, so nothing found under the key is retried with the same key.
        raw = await executor.createDraft(mine.key, { manifest, manifestHash: step.s.manifestHash ?? "", nativeCampaignId: step.s.nativeCampaignId,
          status: "PAUSED" }, mine.route);
      }
      handoff = parse(handoffSchema, raw)?.handoff ?? null;
      receipt = parse(draftReceiptSchema, raw);
      if (receipt && receipt.key !== mine.key) receipt = null;
      if (receipt) readback = await this.readNative(receipt.nativeCampaignId, this.requireRoute(step.s.input, "retrieve-outcome"));
    } catch (error) {
      if (passthrough(error)) { this.releaseLease(campaignId, mine); throw error; }
      receipt = null;
    }
    return this.tx(() => {
      const s = this.require(campaignId);
      // A late result from a worker whose lease was taken over never moves the record.
      if (!owns(s.pending, mine)) return this.view(s);
      const pending = s.pending;
      pending.leaseUntil = this.iso();
      if (handoff && pending.route === "browser" && !receipt) return this.handoff(s, pending, handoff);
      if (!receipt) { if (s.state !== "uncertain") this.move(s, "uncertain", null); this.save(s); return this.view(s); }
      if (s.nativeCampaignId && s.nativeCampaignId !== receipt.nativeCampaignId) throw new AgentConflict("NATIVE_ID_CHANGED");
      this.claimNative(s, receipt.nativeCampaignId);
      this.claimReceipt(receipt.receiptRef, s.campaignId, `draft:r${s.revision}`);
      Object.assign(s, { nativeCampaignId: receipt.nativeCampaignId, nativeAdIds: receipt.nativeAdIds, previewRef: receipt.previewRef, pending: null, pendingKind: null });
      s.receipts.push({ kind: "draft", ref: receipt.receiptRef, origin: receipt.receiptOrigin, at: this.iso() });
      if (!readback) { s.heldReasons = ["READBACK_UNAVAILABLE"]; this.move(s, "held", receipt.receiptRef); this.save(s); return this.view(s); }
      this.recordReadback(s, readback);
      const mismatches = readbackMismatches(manifest, readback, ["DRAFT", "PAUSED"]);
      if (readback.previewRef !== s.previewRef || setOf(readback.nativeAdIds) !== setOf(s.nativeAdIds)) mismatches.push("READBACK_MISMATCH:NATIVE_ADS");
      if (LIVE.includes(readback.status)) mismatches.unshift("DRAFT_ACTIVE_ON_PROVIDER");
      if (mismatches.length) { s.heldReasons = mismatches; this.move(s, "held", receipt.receiptRef); this.save(s); return this.view(s); }
      s.heldReasons = [];
      s.releaseHash = this.releaseHashOf(s, readback);
      s.releaseRequestedAt = this.iso();
      this.move(s, "draft", receipt.receiptRef);
      this.save(s);
      return this.view(s);
    });
  }
  private claimNative(s: Stored, nativeId: string) {
    const used = this.db.prepare("SELECT campaign_id FROM media_native WHERE provider=? AND native_id=?").get(s.input.provider, nativeId);
    if (used && used.campaign_id !== s.campaignId) throw new AgentConflict("NATIVE_ID_REUSED");
    if (!used) this.db.prepare("INSERT INTO media_native VALUES(?,?,?)").run(s.input.provider, nativeId, s.campaignId);
  }
  private recordReadback(s: Stored, n: NativeSettings) {
    s.readback = n;
    s.receipts.push({ kind: "readback", ref: `readback:${n.nativeCampaignId}@${n.observedAt}`, origin: n.receiptOrigin, at: this.iso() });
  }
  private releaseHashOf(s: Stored, n: NativeSettings) {
    return digest({ manifestHash: s.manifestHash, nativeCampaignId: s.nativeCampaignId, nativeAdIds: s.nativeAdIds, previewRef: s.previewRef, settings: settingsOf(n) });
  }
  /** Everything about the native draft that release covered: manifest fields, extras, placements, identity, ads, preview and settings. */
  private draftDrift(s: Stored, n: NativeSettings): string[] {
    const reasons = readbackMismatches(this.manifestOf(s), n, ["DRAFT", "PAUSED"]);
    if (n.previewRef !== s.previewRef || setOf(n.nativeAdIds) !== setOf(s.nativeAdIds)) reasons.push("READBACK_MISMATCH:NATIVE_ADS");
    if (!reasons.length && this.releaseHashOf(s, n) !== s.releaseHash) reasons.push("NATIVE_DRAFT_CHANGED");
    return reasons;
  }
  private handoff(s: Stored, pending: Pending, reason: string): CampaignView {
    pending.handoff = reason;
    s.heldReasons = [`BROWSER_HANDOFF_${code(reason)}`];
    this.move(s, "held", null);
    this.save(s);
    return this.view(s);
  }
  /** Ends this worker's lease early after a refusal. A lease another worker has taken over is never touched. */
  private releaseLease(campaignId: string, mine: Pending) {
    this.tx(() => { const s = this.load(campaignId); if (s && owns(s.pending, mine)) { s.pending.leaseUntil = this.iso(); this.save(s); } });
  }

  /** Records the exact J04 Linear decision for this revision, manifest and read-back release request. */
  decide(campaignId: string, decisionRef: string, key: string): CampaignView {
    return this.apply(key, { op: "decide", campaignId, decisionRef }, () => {
      const s = this.require(campaignId);
      if (s.state !== "draft" || !s.releaseHash || !s.releaseRequestedAt) throw new AgentConflict("RELEASE_NOT_REQUESTED");
      const d = this.currentDecision(s, decisionRef, "publish", s.releaseHash, s.releaseRequestedAt);
      if (d.decision === "approved") {
        const manifest = this.manifestOf(s);
        const issue = this.scopeIssue(d, manifest, manifest.caps.dailyBudgetMinor);
        if (issue) throw new AgentConflict(issue);
      }
      this.claimReceipt(decisionRef, s.campaignId, `decision:publish:r${s.revision}`);
      Object.assign(s, { decisionRef, decision: d.decision, decisionValidUntil: d.validUntil, approvedScope: d.decision === "approved" ? d.financialScope : null,
        heldReasons: [] });
      this.move(s, d.decision === "approved" ? "approved" : "rejected", decisionRef);
      this.save(s);
      return this.view(s);
    });
  }

  /** Every release check, run again before any publish write. Gate results are recorded even when they refuse. */
  private releaseChecks(s: Stored): { route: ExecRoute } | { refusal: string } {
    const m = this.manifestOf(s), now = this.now().getTime();
    if (s.input.environment === "production") throw new AgentConflict("PRODUCTION_HELD");
    this.assertSourcesUnchanged(s);
    if (Date.parse(s.input.expiresAt) <= now) throw new AgentConflict("REQUEST_EXPIRED");
    if (Date.parse(s.input.schedule.startAt) <= now) throw new AgentConflict("SCHEDULE_START_PASSED");
    if (!s.decisionRef || !s.releaseHash || !s.releaseRequestedAt) throw new AgentConflict("J04_APPROVAL_REQUIRED");
    const d = this.currentDecision(s, s.decisionRef, "publish", s.releaseHash, s.releaseRequestedAt);
    if (d.decision !== "approved") throw new AgentConflict("J04_APPROVAL_REQUIRED");
    const issue = this.scopeIssue(d, m, m.caps.dailyBudgetMinor);
    if (issue) throw new AgentConflict(issue);
    s.gates = this.gateStatus(s);
    if (s.gates.some((g) => g.state !== "verified")) return { refusal: "MEDIA_GATES_NOT_VERIFIED" };
    const route = this.requireRoute(s.input, "publish");
    this.requireRoute(s.input, "retrieve-outcome");
    return { route };
  }
  /** The reasons a retry of a write may not be sent now, or none. */
  private blockers(fn: () => string[]): string[] {
    try { return fn(); } catch (error) { if (passthrough(error)) return [(error as Error).message]; throw error; }
  }

  /**
   * Publishes one revision once. The native draft is re-read and compared in full before every publish write, first or retry. The state
   * is committed as applying under a lease before the executor runs. An error or unreadable receipt leaves it uncertain. The next call
   * reconciles by the original key, then by the native campaign, without needing a current decision; only re-sending the write does.
   */
  async publish(campaignId: string, key: string): Promise<CampaignView> {
    this.bindKey(key, { op: "publish", campaignId });
    const executor = this.executor();
    const first = this.require(campaignId);
    if (first.state === "confirmed") return this.view(first);
    if (!first.nativeCampaignId) throw new AgentConflict(first.state === "approved" ? "NATIVE_DRAFT_MISSING" : "J04_APPROVAL_REQUIRED");
    const nativeId = first.nativeCampaignId, readRoute = this.requireRoute(first.input, "retrieve-outcome");
    let fresh: NativeSettings | null = null;
    if (first.state === "approved" && !first.pending) {
      fresh = await this.readNative(nativeId, readRoute);
      if (!fresh) throw new MediaSourceUnavailable("NATIVE_READBACK_UNAVAILABLE");
    }
    const step = this.tx(() => {
      const s = this.require(campaignId);
      const none = { s, mine: null, resumed: false, refusal: null as string | null };
      if (s.state === "confirmed") return none;
      if (s.pending) {
        if (s.pendingKind !== "publish") throw new AgentConflict("RECONCILE_FIRST");
        this.claimLease(s.pending); this.save(s);
        return { ...none, mine: { ...s.pending }, resumed: true };
      }
      if (s.state === "provider-rejected") throw new AgentConflict("PROVIDER_REJECTED_REVISE_FIRST");
      if (s.state !== "approved") throw new AgentConflict(released(s) ? "ALREADY_PUBLISHED" : "J04_APPROVAL_REQUIRED");
      if (!fresh) throw new AgentConflict("CAMPAIGN_CHANGED_DURING_REQUEST");
      // A draft edited outside Farda after approval is held, never published.
      const drift = this.draftDrift(s, fresh);
      if (drift.length) { this.recordReadback(s, fresh); s.heldReasons = drift; this.move(s, "held", null); this.save(s); return none; }
      const checked = this.releaseChecks(s);
      if ("refusal" in checked) { this.save(s); return { ...none, refusal: checked.refusal }; }
      s.pendingKind = "publish";
      s.pending = this.newPending(`publish:${s.campaignId}:r${s.revision}`, checked.route);
      s.route = checked.route; s.publishAttempted = true;
      this.move(s, "applying", s.decisionRef);
      this.save(s);
      return { ...none, mine: { ...s.pending } };
    });
    if (step.refusal) throw new AgentConflict(step.refusal);
    if (!step.mine) return this.view(step.s);
    const mine = step.mine;
    const payload = { nativeCampaignId: nativeId, manifestHash: step.s.manifestHash ?? "", releaseHash: step.s.releaseHash ?? "" };
    const readPublish = (raw: unknown) => { const r = parse(publishReceiptSchema, raw); return r && r.key === mine.key && r.nativeCampaignId === nativeId ? r : null; };
    let receipt: z.infer<typeof publishReceiptSchema> | null = null, handoff: string | null = null, readback: NativeSettings | null = null;
    let reconciledBy: "receipt" | "native-readback" | null = null, notApplied: { native: NativeSettings; reasons: string[] } | null = null;
    const send = async () => {
      const raw = await executor.publish(mine.key, payload, mine.route);
      handoff = parse(handoffSchema, raw)?.handoff ?? null;
      receipt = readPublish(raw);
      if (receipt) reconciledBy = "receipt";
    };
    try {
      if (step.resumed) {
        receipt = readPublish(await executor.read(mine.key, mine.route));
        if (receipt) reconciledBy = "receipt";
        else {
          const native = await this.readNative(nativeId, readRoute);
          if (native && !["DRAFT", "PAUSED"].includes(native.status)) { readback = native; reconciledBy = "native-readback"; }
          else if (native) {
            // Nothing happened under the original identity. Re-sending needs the unchanged draft and every release check, decision included.
            const reasons = this.tx(() => {
              const s = this.require(campaignId);
              const drift = this.draftDrift(s, native);
              return drift.length ? drift : this.blockers(() => { const r = this.releaseChecks(s); return "refusal" in r ? [r.refusal] : []; });
            });
            if (reasons.length) notApplied = { native, reasons };
            else {
              const again = await this.readNative(nativeId, readRoute);
              if (!again || this.tx(() => this.draftDrift(this.require(campaignId), again)).length) notApplied = { native: again ?? native, reasons: ["NATIVE_DRAFT_CHANGED"] };
              else await send();
            }
          }
        }
      } else await send();
      if (receipt && !readback) readback = await this.readNative(nativeId, readRoute);
    } catch (error) {
      if (passthrough(error)) { this.releaseLease(campaignId, mine); throw error; }
      receipt = null; reconciledBy = null;
    }
    const result = { receipt, handoff, readback, reconciledBy, notApplied } as {
      receipt: z.infer<typeof publishReceiptSchema> | null; handoff: string | null; readback: NativeSettings | null;
      reconciledBy: "receipt" | "native-readback" | null; notApplied: { native: NativeSettings; reasons: string[] } | null };
    return this.tx(() => {
      const s = this.require(campaignId);
      if (!owns(s.pending, mine)) return this.view(s);
      const pending = s.pending;
      pending.leaseUntil = this.iso();
      if (result.notApplied) {
        // Closed as not applied: the lock is released and the campaign can be decided or revised again.
        const { native, reasons } = result.notApplied;
        this.recordReadback(s, native);
        Object.assign(s, { pending: null, pendingKind: null });
        if (reasons.some((r) => r.startsWith("READBACK_MISMATCH") || r === "NATIVE_DRAFT_CHANGED")) { s.heldReasons = reasons; this.move(s, "held", null); }
        else if (reasons.some((r) => /^J04_|SCOPE/.test(r))) {
          Object.assign(s, { decisionRef: null, decision: "none", decisionValidUntil: null, approvedScope: null, releaseRequestedAt: this.iso(),
            heldReasons: ["NEW_DECISION_REQUIRED", ...reasons] });
          this.move(s, "draft", null);
        } else { s.heldReasons = reasons; this.move(s, "approved", null); }
        this.save(s);
        return this.view(s);
      }
      if (result.handoff && pending.route === "browser" && !result.receipt) return this.handoff(s, pending, result.handoff);
      if (!result.reconciledBy) { if (s.state !== "uncertain") this.move(s, "uncertain", null); this.save(s); return this.view(s); }
      const r = result.receipt, n = result.readback;
      if (r) {
        this.claimReceipt(r.receiptRef, s.campaignId, `publish:r${s.revision}`);
        if (!s.receipts.some((x) => x.ref === r.receiptRef)) s.receipts.push({ kind: "publish", ref: r.receiptRef, origin: r.receiptOrigin, at: this.iso() });
      }
      if (r?.providerStatus === "REJECTED" || n?.status === "REJECTED") {
        if (n) this.recordReadback(s, n);
        Object.assign(s, { pending: null, pendingKind: null, reconciledBy: result.reconciledBy, heldReasons: [],
          providerReview: { state: "rejected", rejectionCode: r?.rejectionCode ?? null } });
        this.move(s, "provider-rejected", r?.receiptRef ?? null);
        this.save(s);
        return this.view(s);
      }
      if (!n) { s.heldReasons = ["READBACK_UNAVAILABLE"]; if (s.state !== "uncertain") this.move(s, "uncertain", r?.receiptRef ?? null); this.save(s); return this.view(s); }
      this.recordReadback(s, n);
      Object.assign(s, { pending: null, pendingKind: null, reconciledBy: result.reconciledBy,
        providerReview: { state: n.status === "ACTIVE" ? "active" : "in-review", rejectionCode: null } });
      const mismatches = readbackMismatches(this.manifestOf(s), n, LIVE);
      s.heldReasons = mismatches;
      this.move(s, mismatches.length ? "held" : "confirmed", r?.receiptRef ?? null);
      this.save(s);
      return this.view(s);
    });
  }

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
      if (open) return this.mutationView(JSON.parse(String(open.body)) as StoredMutation);
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

  /**
   * Checks the authority for one mutation. A budget edit needs its own J04 decision within the approved financial scope. A pause may use
   * its own J04 decision or a current, in-date safety policy that allows pausing this account. A pause never needs a budget.
   */
  private authorize(s: Stored, m: StoredMutation, auth: MutationAuthorization, claim: boolean): "j04" | "safety-policy" | "rejected" {
    if ("policyRef" in auth) {
      if (m.action !== "pause") throw new AgentConflict("SAFETY_POLICY_ONLY_PAUSES");
      const p = parse(safetyPolicySchema, this.authority.safetyPolicy?.(auth.policyRef, this.scope));
      if (!p || !sameScope(p.scope, this.scope) || p.policyRef !== auth.policyRef) throw new MediaSourceUnavailable("SAFETY_POLICY_UNVERIFIED");
      if (p.state !== "current" || Date.parse(p.validUntil) <= this.now().getTime()) throw new AgentConflict("SAFETY_POLICY_NOT_CURRENT");
      if (!p.allows.includes("pause") || !p.providerAccountRefs.includes(s.input.providerAccountRef)) throw new AgentConflict("SAFETY_POLICY_SCOPE_MISMATCH");
      return "safety-policy";
    }
    const d = this.currentDecision(s, auth.decisionRef, m.action, m.requestHash, m.createdAt);
    if (claim) this.claimReceipt(auth.decisionRef, m.mutationId, `decision:${m.action}`);
    if (d.decision === "rejected") return "rejected";
    if (m.action === "edit-budget") {
      if (m.dailyBudgetMinor === null) throw new AgentConflict("BUDGET_UNKNOWN");
      const issue = this.scopeIssue(d, this.manifestOf(s), m.dailyBudgetMinor);
      if (issue) throw new AgentConflict(issue);
    }
    return "j04";
  }

  /**
   * Applies one authorized mutation once, recording the native state before and after with the provider receipt. A pause is never
   * blocked by another mutation's pending write. An uncertain write is reconciled by its key, then by the native campaign; if nothing
   * happened and it cannot be re-sent now, it is closed as not applied and its lock released.
   */
  async applyMutation(campaignId: string, mutationId: string, authorization: MutationAuthorization, key: string): Promise<MutationView> {
    const auth = mutationAuthorizationSchema.parse(authorization);
    this.bindKey(key, { op: "apply-mutation", campaignId, mutationId });
    const executor = this.executor();
    const first = this.loadMutation(mutationId);
    if (!first || first.campaignId !== campaignId) throw new AgentConflict("MUTATION_UNKNOWN");
    if (first.state === "confirmed") return this.mutationView(first);
    const campaign = this.require(campaignId);
    if (!campaign.nativeCampaignId) throw new AgentConflict("CAMPAIGN_NOT_LIVE");
    const nativeId = campaign.nativeCampaignId, readRoute = this.requireRoute(campaign.input, "retrieve-outcome");
    let before: NativeSettings | null = null;
    if (!first.pending) {
      before = await this.readNative(nativeId, readRoute);
      if (!before) throw new MediaSourceUnavailable("NATIVE_READBACK_UNAVAILABLE");
      if (first.action === "pause" && !LIVE.includes(before.status)) throw new AgentConflict("NATIVE_CAMPAIGN_NOT_ACTIVE");
    }
    const step = this.tx(() => {
      const m = this.loadMutation(mutationId), s = this.require(campaignId);
      if (!m) throw new AgentConflict("MUTATION_UNKNOWN");
      if (m.pending) {
        if (refOf(auth) !== (m.decisionRef ?? m.policyRef)) throw new AgentConflict("MUTATION_BOUND_TO_ANOTHER_AUTHORIZATION");
        this.claimLease(m.pending); this.saveMutation(m);
        return { m, s, mine: { ...m.pending }, resumed: true };
      }
      if (m.state === "confirmed") return { m, s, mine: null, resumed: false };
      if (m.state !== "draft") throw new AgentConflict(m.state === "held" ? "MUTATION_HELD" : "MUTATION_NOT_AWAITING_APPROVAL");
      if (!before) throw new AgentConflict("MUTATION_CHANGED_DURING_REQUEST");
      if (m.action !== "pause") {
        if (s.pending) throw new AgentConflict("RECONCILE_FIRST");
        const others = this.db.prepare("SELECT body FROM media_mutations WHERE campaign_id=? AND active=1 AND mutation_id<>?").all(campaignId, mutationId)
          .map((row) => JSON.parse(String(row.body)) as StoredMutation);
        if (others.some((o) => o.pending && o.action !== "pause")) throw new AgentConflict("MUTATION_IN_PROGRESS");
      }
      const by = this.authorize(s, m, auth, true);
      Object.assign(m, "policyRef" in auth ? { policyRef: auth.policyRef } : { decisionRef: auth.decisionRef });
      if (by === "rejected") { this.moveMutation(m, "rejected", refOf(auth)); this.saveMutation(m); return { m, s, mine: null, resumed: false }; }
      const route = this.requireRoute(s.input, m.action);
      this.moveMutation(m, "approved", refOf(auth));
      const pending = this.newPending(`${m.action}:${m.mutationId}`, route);
      Object.assign(m, { before, route, attempted: true, authorizedBy: by, pending });
      this.moveMutation(m, "applying", refOf(auth));
      this.saveMutation(m);
      return { m, s, mine: { ...pending } as Pending | null, resumed: false };
    });
    if (!step.mine) return this.mutationView(step.m);
    const mine = step.mine, m0 = step.m;
    const base = this.manifestOf(step.s);
    const expected: Manifest = { ...base, caps: { ...base.caps, dailyBudgetMinor: m0.dailyBudgetMinor ?? base.caps.dailyBudgetMinor } };
    const applied = (n: NativeSettings) => (m0.action === "pause" ? n.status === "PAUSED" : n.dailyBudgetMinor === m0.dailyBudgetMinor);
    const payload = { nativeCampaignId: nativeId, action: m0.action, dailyBudgetMinor: m0.dailyBudgetMinor };
    const readMutation = (raw: unknown) => { const r = parse(mutationReceiptSchema, raw); return r && r.key === mine.key && r.nativeCampaignId === nativeId ? r : null; };
    let receipt: z.infer<typeof mutationReceiptSchema> | null = null, handoff: string | null = null, after: NativeSettings | null = null;
    let reconciledBy: "receipt" | "native-readback" | null = null, notApplied: { native: NativeSettings; reasons: string[] } | null = null;
    try {
      if (step.resumed) {
        receipt = readMutation(await executor.read(mine.key, mine.route));
        if (!receipt) {
          const native = await this.readNative(nativeId, readRoute);
          if (native && applied(native)) { after = native; reconciledBy = "native-readback"; }
          else if (native) {
            // Re-sending needs the same authority, scope and route as a first write.
            const reasons = this.tx(() => {
              const m = this.loadMutation(mutationId), s = this.require(campaignId);
              if (!m) return ["MUTATION_UNKNOWN"];
              return this.blockers(() => {
                if (this.authorize(s, m, m.policyRef ? { policyRef: m.policyRef } : { decisionRef: m.decisionRef ?? "" }, false) === "rejected") return ["J04_DECISION_REJECTED"];
                this.requireRoute(s.input, m.action);
                return [];
              });
            });
            if (reasons.length) notApplied = { native, reasons };
            else {
              const raw = await executor.mutate(mine.key, payload, mine.route);
              handoff = parse(handoffSchema, raw)?.handoff ?? null;
              receipt = readMutation(raw);
            }
          }
        }
      } else {
        const raw = await executor.mutate(mine.key, payload, mine.route);
        handoff = parse(handoffSchema, raw)?.handoff ?? null;
        receipt = readMutation(raw);
      }
      if (receipt) { reconciledBy = "receipt"; after = await this.readNative(nativeId, readRoute); }
    } catch (error) {
      if (passthrough(error)) {
        this.tx(() => { const m = this.loadMutation(mutationId); if (m && owns(m.pending, mine)) { m.pending.leaseUntil = this.iso(); this.saveMutation(m); } });
        throw error;
      }
      receipt = null; reconciledBy = null;
    }
    const result = { receipt, handoff, after, reconciledBy, notApplied } as {
      receipt: z.infer<typeof mutationReceiptSchema> | null; handoff: string | null; after: NativeSettings | null;
      reconciledBy: "receipt" | "native-readback" | null; notApplied: { native: NativeSettings; reasons: string[] } | null };
    return this.tx(() => {
      const m = this.loadMutation(mutationId), s = this.require(campaignId);
      if (!m) throw new AgentConflict("MUTATION_UNKNOWN");
      if (!owns(m.pending, mine)) return this.mutationView(m);
      const pending = m.pending;
      pending.leaseUntil = this.iso();
      if (result.notApplied) {
        Object.assign(m, { pending: null, heldReasons: result.notApplied.reasons });
        this.recordReadback(s, result.notApplied.native);
        this.moveMutation(m, "not-applied", null);
        this.saveMutation(m); this.save(s);
        return this.mutationView(m);
      }
      if (result.handoff && pending.route === "browser" && !result.receipt) {
        pending.handoff = result.handoff; m.heldReasons = [`BROWSER_HANDOFF_${code(result.handoff)}`];
        this.moveMutation(m, "held", null); this.saveMutation(m); return this.mutationView(m);
      }
      const r = result.receipt, n = result.after;
      if (!result.reconciledBy || !n) {
        if (r) m.heldReasons = ["READBACK_UNAVAILABLE"];
        if (m.state !== "uncertain") this.moveMutation(m, "uncertain", null);
        this.saveMutation(m); return this.mutationView(m);
      }
      if (r) {
        this.claimReceipt(r.receiptRef, m.mutationId, "mutation");
        Object.assign(m, { receiptRef: r.receiptRef, receiptOrigin: r.receiptOrigin });
      }
      Object.assign(m, { after: n, reconciledBy: result.reconciledBy, pending: null });
      this.recordReadback(s, n);
      if (r?.outcome === "rejected") {
        m.providerRejectionCode = r.rejectionCode; m.heldReasons = [];
        this.moveMutation(m, "provider-rejected", r.receiptRef);
      } else {
        const mismatches = m.action === "pause" ? (n.status === "PAUSED" ? [] : ["READBACK_MISMATCH:STATUS"])
          : readbackMismatches(expected, n, m.before ? [m.before.status] : LIVE);
        m.heldReasons = mismatches;
        this.moveMutation(m, mismatches.length ? "held" : "confirmed", r?.receiptRef ?? null);
        if (!mismatches.length && m.action === "edit-budget") s.effectiveDailyBudgetMinor = m.dailyBudgetMinor;
      }
      this.saveMutation(m); this.save(s);
      return this.mutationView(m);
    });
  }

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
    return campaignViewSchema.parse({
      kind: "paid-media-campaign", campaignId: s.campaignId, campaignRef: s.campaignRef, revision: s.revision, state: s.state, provider: s.input.provider,
      environment: s.input.environment, campaignRoute: s.input.campaignRoute, manifest, manifestHash: s.manifestHash, releaseHash: s.releaseHash,
      releaseRequested: s.state === "draft" && s.releaseHash !== null, heldReasons: s.heldReasons,
      native: { nativeCampaignId: s.nativeCampaignId, nativeAdIds: s.nativeAdIds, previewRef: s.previewRef, status: s.readback?.status ?? null, readback: s.readback },
      approval: { decision: s.decision, decisionRef: s.decisionRef, validUntil: s.decisionValidUntil }, providerReview: s.providerReview, gates: s.gates,
      execution: { route: s.route, key: s.pending?.key ?? null, leaseUntil: s.pending?.leaseUntil ?? null, pending: s.pending !== null, reconciledBy: s.reconciledBy },
      receipts: s.receipts, evidenceLabel: label(s.receipts.map((r) => r.origin)), mutations, history: s.history,
      sourceEffects: s.publishAttempted ? "publish-attempted" : s.draftCreated ? "draft-created" : "none",
    });
  }
}
