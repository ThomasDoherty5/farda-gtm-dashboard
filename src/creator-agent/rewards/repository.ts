import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import {
  FULFILLMENT_DAYS, allocationSchema, cashMovementSchema, decisionSchema, entitlementSchema, outcomeSchema, prepareSchema, providerStateSchema, purchaseLookupSchema, purchaseReceiptSchema,
  quoteSchema, redemptionViewSchema, ref, rewardPolicySchema, type Entitlement, type PrepareInput, type Quote, type RedemptionState,
  type RedemptionView, type RewardOption, type RewardScope,
} from "./contract.ts";

export type RewardProviderIdentity = { providerRef: string; providerBindingRef: string };

/** Trusted, server-configured sources. A caller never supplies these objects. */
export interface RewardAuthority {
  entitlement?(entitlementRef: string, scope: RewardScope): unknown;
  rewardPolicy?(version: string, scope: RewardScope): unknown;
  quote?(quoteRef: string, scope: RewardScope): unknown;
  provider?(providerRef: string, deliveryRoute: string, scope: RewardScope): unknown;
  allocation?(allocationRef:string, scope:RewardScope): unknown;
  decision?(sourceRef: string, scope: RewardScope): unknown;
  outcome?(sourceRef: string, scope: RewardScope, provider: RewardProviderIdentity): unknown;
  cashMovement?(sourceRef: string, scope: RewardScope, provider: RewardProviderIdentity): unknown;
  /** The provider purchase executor. Keyed and idempotent at the provider; read() finds an earlier attempt by its key. */
  executor?: { purchase(key: string, manifest: unknown): unknown; read(key: string, provider: RewardProviderIdentity): unknown };
}
export class RewardSourceUnavailable extends Error {}
export class RewardPurchaseUnknown extends Error {}

type Stored = {
  redemptionId: string; revision: number; state: RedemptionState; revisedAt: string; entitlement: Entitlement; input: PrepareInput;
  policyState: "adopted" | "proposed" | "unavailable"; option: RewardOption | null; quote: Quote | null; requestHash: string;
  heldReasons: string[]; ownerRef: string | null; decisionRef: string | null; physicalAllocationRef: string | null;
  purchaseKey: string | null; purchaseLeaseUntil: string | null; providerOrderRef: string | null; transactionRef: string | null; chargedMinor: number | null; refundedMinor: number;
  fulfilled: boolean; outcomeRefs: string[]; cashRef: string | null; cashRefs: string[]; settledCostMinor: number | null; purchaseAttempted: boolean;
  adoptionRef?: string | null; providerBasis?: string | null; providerBindingRef?:string|null; fundingRef?:string|null;
  leaseId?: string | null; purchasedAt?: string; outcomeAt?: string; refundedAt?: string; cashAt?: string;
  physicalAt?: string; physicalState?: "purchased" | "shipped" | "delivered" | "failed" | "returned";
  history: { state: RedemptionState; at: string; ref: string | null }[];
};
const REVISABLE: RedemptionState[] = ["held", "awaiting-details", "awaiting-approval", "approved", "rejected"];
const PRE_PURCHASE: RedemptionState[] = [...REVISABLE];
/** Fulfilment moves. A refund is a money adjustment, recorded from any of REFUNDABLE; only a full refund moves the state to refunded. */
const NEXT: Partial<Record<RedemptionState, RedemptionState[]>> = {
  purchased: ["shipped", "delivered", "failed"], shipped: ["delivered", "failed", "returned"], delivered: ["returned"], reconciled: ["returned"],
};
const REFUNDABLE: RedemptionState[] = ["purchased", "shipped", "delivered", "failed", "returned", "reconciled"];
/** How long a purchase may run before another call treats the worker as stopped and reads the provider back. */
const PURCHASE_LEASE_MS = 5 * 60_000;
const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const sameScope = (a: RewardScope, b: RewardScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
const usd = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

function entitlementBasis(e: Entitlement) {
  return [e.scope,e.entitlementRef,e.sourceRef,e.creatorId,e.programRef,e.milestone,e.amountMinor,e.currency,e.rewardVersion,e.qualifiedAt];
}
function providerBasis(p: z.infer<typeof providerStateSchema>) {
  return digest([p.scope,p.providerRef,p.deliveryRoute,p.bindingRef,p.fundingRef]);
}
function assertSourceTime(timestamp: string, minimum: string, now: number) {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value) || !Number.isFinite(Date.parse(minimum)) || value < Date.parse(minimum)) throw new AgentConflict("RECEIPT_OUT_OF_ORDER");
  if (value > now) throw new AgentConflict("FUTURE_TIMESTAMP");
}

/** Copy bound to the actual approved item or allowance. A cap is never described as a retail price or an unlimited promise. */
export function promiseFor(option: RewardOption, capMinor: number, adopted: boolean) {
  const text = option.kind === "item" ? `${option.label}, or an allowed equivalent, up to ${usd(capMinor)} all-in including tax and shipping`
    : option.kind === "allowance" ? `${usd(capMinor)} all-in allowance toward ${option.label}`
    : `${usd(capMinor)} toward ${option.label}, with destination and dates chosen by the creator; flights, accommodation and experiences stay within that total`;
  return adopted ? text : `Proposed, not yet adopted: ${text}`;
}

export class RewardRedemptionRepository {
  private readonly db: DatabaseSync;
  private readonly scope: RewardScope;
  private readonly authority: RewardAuthority;
  private readonly now: () => Date;
  constructor(db: DatabaseSync, scope: RewardScope, authority: RewardAuthority = {}, now: () => Date = () => new Date()) {
    this.db = db; this.scope = scope; this.authority = authority; this.now = now;
    const actual = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (actual?.workspace_id !== scope.workspaceId || actual.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS reward_redemptions (redemption_id TEXT PRIMARY KEY, entitlement_ref TEXT NOT NULL, active INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS reward_one_active_redemption ON reward_redemptions(entitlement_ref) WHERE active=1;
      CREATE TABLE IF NOT EXISTS reward_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reward_receipts (source_ref TEXT PRIMARY KEY, redemption_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reward_receipt_bases (source_ref TEXT PRIMARY KEY, receipt_hash TEXT NOT NULL);`);
  }

  private apply(key: string, command: unknown, fn: () => RedemptionView): RedemptionView {
    if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED");
    const hash = digest(command);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT hash,body FROM reward_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const result = prior ? this.read((JSON.parse(String(prior.body)) as RedemptionView).redemptionId) : fn();
      if (!result) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (!prior) this.db.prepare("INSERT INTO reward_commands VALUES(?,?,?)").run(key, hash, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private load(redemptionId: string): Stored | null {
    const row = this.db.prepare("SELECT body FROM reward_redemptions WHERE redemption_id=?").get(ref.parse(redemptionId));
    return row ? JSON.parse(String(row.body)) as Stored : null;
  }
  private save(s: Stored, active = true) {
    this.db.prepare("INSERT INTO reward_redemptions VALUES(?,?,?,?) ON CONFLICT(redemption_id) DO UPDATE SET active=excluded.active, body=excluded.body")
      .run(s.redemptionId, s.entitlement.entitlementRef, active ? 1 : 0, JSON.stringify(s));
  }
  private move(s: Stored, state: RedemptionState, sourceRef: string | null) {
    s.state = state;
    s.history.push({ state, at: this.now().toISOString(), ref: sourceRef });
  }
  private claimReceipt(sourceRef: string, redemptionId: string, kind: string, body: unknown) {
    const used = this.db.prepare("SELECT redemption_id,kind FROM reward_receipts WHERE source_ref=?").get(sourceRef);
    if (used && (used.redemption_id !== redemptionId || used.kind !== kind)) throw new AgentConflict("RECEIPT_REUSED");
    const hash = digest(body);
    if (used) {
      const prior = this.db.prepare("SELECT receipt_hash FROM reward_receipt_bases WHERE source_ref=?").get(sourceRef);
      if (!prior || prior.receipt_hash !== hash) throw new AgentConflict("RECEIPT_BASIS_CHANGED");
      return;
    }
    this.db.prepare("INSERT INTO reward_receipts VALUES(?,?,?)").run(sourceRef, redemptionId, kind);
    this.db.prepare("INSERT INTO reward_receipt_bases VALUES(?,?)").run(sourceRef, hash);
  }
  private providerIdentity(s: Stored): RewardProviderIdentity {
    if (!s.option?.providerRef || !s.providerBindingRef) throw new RewardSourceUnavailable("PROVIDER_RECEIPT_NAMESPACE_UNVERIFIED");
    return {providerRef:s.option.providerRef,providerBindingRef:s.providerBindingRef};
  }
  private providerMatches(s: Stored, receipt: RewardProviderIdentity): boolean {
    return !!s.providerBindingRef && receipt.providerRef===s.option?.providerRef && receipt.providerBindingRef===s.providerBindingRef;
  }
  private providerReceiptKey(s: Stored, sourceRef: string, kind: string) {
    return "provider-receipt:"+digest([this.scope,this.providerIdentity(s),kind,sourceRef]);
  }
  private claimProviderReceipt(s: Stored, sourceRef: string, kind: string, body: RewardProviderIdentity) {
    if (!this.providerMatches(s,body)) throw new RewardSourceUnavailable("PROVIDER_RECEIPT_NAMESPACE_UNVERIFIED");
    const key=this.providerReceiptKey(s,sourceRef,kind);
    // Historical global claims are never rewritten. A known different provider/account can legitimately reuse a native ID.
    const legacy=this.db.prepare("SELECT redemption_id,kind FROM reward_receipts WHERE source_ref=?").get(sourceRef);
    if (legacy && legacy.kind===kind) {
      const owner=this.load(String(legacy.redemption_id));
      if (!owner?.option?.providerRef || !owner.providerBindingRef) throw new AgentConflict("LEGACY_RECEIPT_NAMESPACE_UNVERIFIED");
      if (this.providerMatches(owner,body)) {
        if (owner.redemptionId!==s.redemptionId) throw new AgentConflict("RECEIPT_REUSED");
        const basis=this.db.prepare("SELECT receipt_hash FROM reward_receipt_bases WHERE source_ref=?").get(sourceRef);
        // Old receipts lacked the explicit bound-account field (and outcomes/cash also lacked providerRef).
        const oldBody={...body} as Record<string,unknown>;
        delete oldBody.providerBindingRef;
        if (kind!=="purchase") delete oldBody.providerRef;
        if (!basis || (basis.receipt_hash!==digest(body) && basis.receipt_hash!==digest(oldBody))) throw new AgentConflict("RECEIPT_BASIS_CHANGED");
        return;
      }
    }
    this.claimReceipt(key,s.redemptionId,kind,body);
  }
  private entitlement(entitlementRef: string): Entitlement {
    const e = parse(entitlementSchema, this.authority.entitlement?.(entitlementRef, this.scope));
    if (!e || !sameScope(e.scope, this.scope) || e.entitlementRef !== entitlementRef) throw new RewardSourceUnavailable("ENTITLEMENT_UNVERIFIED");
    return e;
  }

  private provider(option: RewardOption) {
    const p = parse(providerStateSchema, this.authority.provider?.(option.providerRef, option.deliveryRoute, this.scope));
    return p && sameScope(p.scope,this.scope) && p.providerRef === option.providerRef && p.deliveryRoute === option.deliveryRoute &&
      Date.parse(p.validUntil) > this.now().getTime() ? p : null;
  }

  /** Prepares, or revises before purchase, the one redemption request for a mature entitlement. Problems hold it with reasons. */
  prepare(body: unknown, key: string): RedemptionView {
    const input = prepareSchema.parse(body);
    return this.apply(key, { op: "prepare", input }, () => {
      const now = this.now();
      const entitlement = this.entitlement(input.entitlementRef);
      if (entitlement.state !== "mature") throw new AgentConflict(entitlement.state === "reversed" ? "ENTITLEMENT_REVERSED" : "ENTITLEMENT_NOT_MATURE");
      if (entitlement.fulfilled || Date.parse(entitlement.qualifiedAt) > now.getTime()) throw new AgentConflict("ENTITLEMENT_NOT_REDEEMABLE");
      const existingMilestone = this.db.prepare(`SELECT entitlement_ref FROM reward_redemptions WHERE active=1
        AND json_extract(body,'$.entitlement.creatorId')=? AND json_extract(body,'$.entitlement.programRef')=?
        AND json_extract(body,'$.entitlement.milestone')=? AND entitlement_ref!=? LIMIT 1`).get(
          entitlement.creatorId,entitlement.programRef,entitlement.milestone,entitlement.entitlementRef);
      if (existingMilestone) throw new AgentConflict("MILESTONE_ALREADY_RESERVED");
      const activeRow = this.db.prepare("SELECT body FROM reward_redemptions WHERE entitlement_ref=? AND active=1").get(input.entitlementRef);
      const active = activeRow ? JSON.parse(String(activeRow.body)) as Stored : null;
      if (active && !REVISABLE.includes(active.state)) throw new AgentConflict("REDEMPTION_ALREADY_IN_PROGRESS");

      const reasons: string[] = [];
      const policySource = parse(rewardPolicySchema, this.authority.rewardPolicy?.(entitlement.rewardVersion,this.scope));
      const policy = policySource && sameScope(policySource.scope,this.scope) ? policySource : null;
      if (!policy || policy.version !== entitlement.rewardVersion) reasons.push("REWARD_TERMS_UNAVAILABLE");
      else if (policy.state !== "adopted") reasons.push("REWARD_TERMS_NOT_ADOPTED");
      const option = policy?.options.find((o) => o.optionId === input.optionId && o.milestone === entitlement.milestone) ?? null;
      if (policy && !option) reasons.push("REWARD_OPTION_NOT_ALLOWED");
      const quoteSource = parse(quoteSchema, this.authority.quote?.(input.quoteRef, this.scope));
      const quote = quoteSource && sameScope(quoteSource.scope,this.scope) ? quoteSource : null;
      let fardaMinor: number | null = null;
      if (!quote || quote.quoteRef !== input.quoteRef) reasons.push("QUOTE_UNVERIFIED");
      else {
        if (quote.optionId !== input.optionId || (option && quote.providerRef !== option.providerRef)) reasons.push("QUOTE_MISMATCH");
        if (!quote.available) reasons.push("REWARD_UNAVAILABLE");
        if (Date.parse(quote.validUntil) <= now.getTime()) reasons.push("QUOTE_EXPIRED");
        if (quote.creatorFundedMinor > quote.itemMinor) reasons.push("QUOTE_INVALID");
        // Everything Farda pays is inside the cap. An optional creator-funded upgrade never raises Farda's liability.
        fardaMinor = Math.max(0, quote.itemMinor - quote.creatorFundedMinor) + quote.taxMinor + quote.shippingMinor + quote.bookingMinor + quote.adminMinor;
        if (fardaMinor > entitlement.amountMinor) reasons.push("ALL_IN_CAP_EXCEEDED");
      }
      const provider = option ? this.provider(option) : null;
      const ownerRef = provider?.ownerRef ?? "reward-operations";
      if (option) {
        if (!provider) reasons.push("PROVIDER_ROUTE_UNVERIFIED");
        else {
          if (provider.state !== "Ready") reasons.push(`PROVIDER_ROUTE_${provider.state.toUpperCase()}`);
          if (!provider.fundingVerified || !provider.fundingRef) reasons.push("FUNDING_METHOD_UNVERIFIED");
        }
      }
      if (Date.parse(input.expiresAt) <= now.getTime()) reasons.push("REQUEST_EXPIRED");
      if (input.detailsCompleteAt && Date.parse(input.detailsCompleteAt) > now.getTime()) throw new AgentConflict("FUTURE_TIMESTAMP");

      const adoptionRef = policy?.adoptionRef ?? null;
      const binding = provider ? providerBasis(provider) : null;
      const requestHash = digest({ scope: this.scope, entitlement:entitlementBasis(entitlement), adoptionRef, binding, option, quote, input });
      if (active && active.requestHash === requestHash && digest(active.heldReasons) === digest(reasons)) return this.view(active);
      const attempts = Number(this.db.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE entitlement_ref=?").get(input.entitlementRef)!.n);
      const s: Stored = active ? { ...active, revision: active.revision + 1, decisionRef: null, physicalAllocationRef: null } : {
        redemptionId: `redemption-${digest({ scope:this.scope,entitlementRef:input.entitlementRef,attempt:attempts+1 }).slice(0, 32)}`, revision: 1, state: "held",
        revisedAt: now.toISOString(), entitlement, input, policyState: "unavailable", option: null, quote: null, requestHash, heldReasons: [], ownerRef: null,
        decisionRef: null, physicalAllocationRef: null, purchaseKey: null, purchaseLeaseUntil: null, providerOrderRef: null, transactionRef: null, chargedMinor: null,
        refundedMinor: 0, fulfilled: false, outcomeRefs: [], cashRef: null, cashRefs: [], settledCostMinor: null, purchaseAttempted: false, history: [],
      };
      Object.assign(s, { revisedAt: now.toISOString(), entitlement, input, option, quote, requestHash, heldReasons: reasons, ownerRef,
        adoptionRef, providerBasis:binding, providerBindingRef:provider?.bindingRef ?? null, fundingRef:provider?.fundingRef ?? null,
        policyState: !policy ? "unavailable" : policy.state });
      this.move(s, reasons.length ? "held" : input.detailsCompleteAt === null ? "awaiting-details" : "awaiting-approval", null);
      this.save(s);
      return this.view(s);
    });
  }

  /** Records the exact founder-authorized J04 decision for this revision and request. A reserve or earned commission is not authority. */
  decide(redemptionId: string, decisionRef: string, key: string): RedemptionView {
    return this.apply(key, { op: "decide", redemptionId, decisionRef }, () => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (s.state !== "awaiting-approval") throw new AgentConflict("NOT_AWAITING_APPROVAL");
      const d = this.currentDecision(s, decisionRef);
      if (d.decision === "approved") {
        this.checkBasis(s);
        this.checkAllocation(s,d.physicalAllocationRef);
      }
      this.claimReceipt(decisionRef, s.redemptionId, "decision", d);
      s.decisionRef = decisionRef;
      s.physicalAllocationRef = d.physicalAllocationRef;
      this.move(s, d.decision === "approved" ? "approved" : "rejected", decisionRef);
      this.save(s);
      return this.view(s);
    });
  }
  private currentDecision(s: Stored, decisionRef: string) {
    const d = parse(decisionSchema, this.authority.decision?.(decisionRef, this.scope)), now = this.now().getTime();
    if (!d || !sameScope(d.scope, this.scope) || d.sourceRef !== decisionRef || d.redemptionId !== s.redemptionId) throw new RewardSourceUnavailable("J04_DECISION_UNVERIFIED");
    if (d.revision !== s.revision || d.requestHash !== s.requestHash) throw new AgentConflict("J04_DECISION_FOR_ANOTHER_REQUEST");
    if (d.state !== "current" || Date.parse(d.validUntil) <= now) throw new AgentConflict("J04_DECISION_NOT_CURRENT");
    if (Date.parse(d.decidedAt) > now || Date.parse(d.decidedAt) < Date.parse(s.revisedAt)) throw new AgentConflict("J04_DECISION_PREDATES_REQUEST");
    return d;
  }

  private checkAllocation(s:Stored, allocationRef:string|null) {
    if (s.option?.deliveryRoute !== "farda-physical") {
      if (allocationRef !== null) throw new AgentConflict("UNEXPECTED_PHYSICAL_ALLOCATION");
      return;
    }
    if (!allocationRef) throw new AgentConflict("PHYSICAL_ALLOCATION_REQUIRED");
    const a = parse(allocationSchema,this.authority.allocation?.(allocationRef,this.scope));
    if (!a || !sameScope(a.scope,this.scope) || a.sourceRef !== allocationRef || a.redemptionId !== s.redemptionId ||
        a.revision !== s.revision || a.requestHash !== s.requestHash || a.optionId !== s.input.optionId ||
        a.recipientRef !== s.input.recipientRef || Date.parse(a.validUntil) <= this.now().getTime()) throw new AgentConflict("PHYSICAL_ALLOCATION_UNVERIFIED");
  }
  private checkBasis(s: Stored) {
    const now=this.now().getTime();
    if (!Number.isFinite(Date.parse(s.input.expiresAt)) || Date.parse(s.input.expiresAt) <= now) throw new AgentConflict("REQUEST_EXPIRED");
    const e=this.entitlement(s.entitlement.entitlementRef);
    if (e.state !== "mature" || e.fulfilled || Date.parse(e.qualifiedAt)>now ||
        digest(entitlementBasis(e)) !== digest(entitlementBasis(s.entitlement))) throw new AgentConflict("ENTITLEMENT_CHANGED");
    const policy=parse(rewardPolicySchema,this.authority.rewardPolicy?.(e.rewardVersion,this.scope));
    const option=policy?.options.find(o=>o.optionId===s.input.optionId && o.milestone===e.milestone);
    if (!policy || !sameScope(policy.scope,this.scope) || policy.version!==e.rewardVersion || policy.state!=="adopted" || !s.adoptionRef ||
        policy.adoptionRef!==s.adoptionRef || !option || digest(option)!==digest(s.option)) throw new AgentConflict("REWARD_TERMS_CHANGED");
    const quote = s.quote ? parse(quoteSchema, this.authority.quote?.(s.quote.quoteRef, this.scope)) : null;
    if (!s.quote || !quote || quote.quoteRef !== s.quote.quoteRef || !quote.available || Date.parse(quote.validUntil) <= this.now().getTime()
      || digest(quote) !== digest(s.quote)) throw new AgentConflict("QUOTE_CHANGED");
    const provider = this.provider(option);
    if (!provider || provider.state !== "Ready" || !provider.fundingVerified || !provider.fundingRef || providerBasis(provider)!==s.providerBasis)
      throw new AgentConflict("PROVIDER_ROUTE_NOT_READY");
  }
  private checkPurchasable(s:Stored) {
    if (!s.decisionRef) throw new AgentConflict("J04_APPROVAL_REQUIRED");
    const d=this.currentDecision(s,s.decisionRef);
    if (d.decision!=="approved") throw new AgentConflict("J04_APPROVAL_REQUIRED");
    if (d.physicalAllocationRef!==s.physicalAllocationRef) throw new AgentConflict("PHYSICAL_ALLOCATION_CHANGED");
    this.checkBasis(s);
    this.checkAllocation(s,d.physicalAllocationRef);
  }

  /**
   * Purchases once. The state is committed as purchasing, under a lease, before the executor runs; an error or unreadable receipt leaves
   * it uncertain. A call during an unexpired lease is refused. After the lease expires (a stopped worker), or once uncertain, the next
   * call reads the provider by the same key before any retry. A late result never moves a record that has already moved on.
   */
  async purchase(redemptionId: string, key: string): Promise<RedemptionView> {
    if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED");
    const executor = this.authority.executor;
    const claim = this.tx(() => {
      const hash = digest({ op:"purchase", redemptionId });
      const prior = this.db.prepare("SELECT hash FROM reward_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (prior && s.transactionRef) return { state:s, mode:"complete" as const };
      const resumed = s.state === "purchasing" || s.state === "uncertain";
      if (!executor) {
        if (resumed) throw new RewardPurchaseUnknown("PURCHASE_EXECUTOR_UNAVAILABLE");
        throw new RewardSourceUnavailable("PURCHASE_EXECUTOR_UNAVAILABLE");
      }
      const now = this.now().getTime();
      if (resumed && s.purchaseLeaseUntil && Date.parse(s.purchaseLeaseUntil) > now) throw new RewardPurchaseUnknown("PURCHASE_IN_FLIGHT");
      if (!resumed) {
        if (s.state !== "approved") throw new AgentConflict(PRE_PURCHASE.includes(s.state) ? "J04_APPROVAL_REQUIRED" : "ALREADY_PURCHASED");
        this.checkPurchasable(s);
        s.purchaseKey = "purchase:" + digest([this.scope, s.redemptionId, s.revision, s.requestHash]);
        s.purchaseAttempted = true;
        this.move(s, "purchasing", s.decisionRef);
      }
      if (!s.purchaseKey) throw new RewardPurchaseUnknown("PURCHASE_KEY_UNAVAILABLE");
      if (!prior) this.db.prepare("INSERT INTO reward_commands VALUES(?,?,?)").run(key,hash,JSON.stringify({redemptionId}));
      s.leaseId = randomUUID();
      s.purchaseLeaseUntil = new Date(now + PURCHASE_LEASE_MS).toISOString();
      this.save(s);
      return { state:s, mode:resumed ? "recover" as const : "dispatch" as const };
    });
    const prepared=claim.state;
    if (claim.mode === "complete") return this.view(prepared);
    const purchaseKey=prepared.purchaseKey!;
    const providerRef=prepared.option!.providerRef;
    let receipt: z.infer<typeof purchaseReceiptSchema> | null = null;
    try {
      if (claim.mode === "recover") {
        const readStarted=this.now().getTime();
        const lookup=parse(purchaseLookupSchema,await executor!.read(purchaseKey,this.providerIdentity(prepared)));
        if (lookup?.state === "found") receipt=lookup.receipt;
        else if (lookup?.state !== "notFound" || lookup.purchaseKey !== purchaseKey || lookup.providerRef !== providerRef || lookup.providerBindingRef !== prepared.providerBindingRef ||
          Date.parse(lookup.checkedAt)<readStarted || Date.parse(lookup.checkedAt)>this.now().getTime()) {
          return this.finishPurchase(prepared,null,"PURCHASE_READBACK_UNVERIFIED");
        }
      }
      if (!receipt) {
        // Re-read ownership and sources after asynchronous lookup, immediately before invoking the same keyed provider operation.
        const current=this.tx(() => {
          const s=this.load(redemptionId)!;
          if (s.leaseId!==prepared.leaseId || !s.purchaseLeaseUntil || Date.parse(s.purchaseLeaseUntil)<=this.now().getTime())
            throw new RewardPurchaseUnknown("PURCHASE_LEASE_CHANGED");
          this.checkPurchasable(s);
          return s;
        });
        try {
          receipt=parse(purchaseReceiptSchema,await executor!.purchase(purchaseKey,{
            scope:this.scope, redemptionId, revision:current.revision, requestHash:current.requestHash, providerRef,
            providerBindingRef:current.providerBindingRef, fundingRef:current.fundingRef, deliveryRoute:current.option!.deliveryRoute,
            optionId:current.input.optionId, quoteRef:current.input.quoteRef, recipientRef:current.input.recipientRef,
            capMinor:current.entitlement.amountMinor, currency:current.entitlement.currency, physicalAllocationRef:current.physicalAllocationRef,
          }));
        } catch { return this.finishPurchase(prepared,null,"PURCHASE_RESPONSE_UNVERIFIED"); }
      }
    } catch (cause) {
      const reason=cause instanceof AgentConflict || cause instanceof RewardPurchaseUnknown || cause instanceof RewardSourceUnavailable ? cause.message : "PURCHASE_READBACK_UNVERIFIED";
      this.finishPurchase(prepared,null,reason);
      throw new RewardPurchaseUnknown(reason);
    }
    return this.finishPurchase(prepared,receipt,"PURCHASE_RESPONSE_UNVERIFIED");
  }

  private finishPurchase(prepared:Stored, receipt:z.infer<typeof purchaseReceiptSchema>|null, reason:string) {
    try { return this.tx(() => {
      const s=this.load(prepared.redemptionId)!;
      if (s.leaseId !== prepared.leaseId || !["purchasing","uncertain"].includes(s.state)) return this.view(s);
      s.purchaseLeaseUntil=null;
      s.leaseId=null;
      const start=s.history.find(h=>h.state==="purchasing")?.at;
      const matches=receipt && start && receipt.purchaseKey===s.purchaseKey && this.providerMatches(s,receipt) &&
        Date.parse(receipt.purchasedAt)>=Date.parse(start) && Date.parse(receipt.purchasedAt)<=this.now().getTime();
      if (matches) {
        const duplicate=this.db.prepare(`SELECT redemption_id FROM reward_redemptions WHERE redemption_id!=? AND
          (json_extract(body,'$.transactionRef')=? OR json_extract(body,'$.providerOrderRef')=?) AND
          (json_extract(body,'$.option.providerRef') IS NULL OR (json_extract(body,'$.option.providerRef')=? AND
          (json_extract(body,'$.providerBindingRef') IS NULL OR json_extract(body,'$.providerBindingRef')=?))) LIMIT 1`).get(
            s.redemptionId,receipt.transactionRef,receipt.providerOrderRef,receipt.providerRef,receipt.providerBindingRef);
        const used=this.db.prepare("SELECT redemption_id,kind FROM reward_receipts WHERE source_ref=?").get(this.providerReceiptKey(s,receipt.transactionRef,"purchase"));
        if (!duplicate && (!used || (used.redemption_id===s.redemptionId && used.kind==="purchase"))) {
          this.claimProviderReceipt(s,receipt.transactionRef,"purchase",receipt);
          Object.assign(s,{providerOrderRef:receipt.providerOrderRef,transactionRef:receipt.transactionRef,chargedMinor:receipt.chargedMinor,
            purchasedAt:receipt.purchasedAt,physicalAt:receipt.purchasedAt,physicalState:"purchased"});
          s.heldReasons=receipt.chargedMinor>s.entitlement.amountMinor ? ["CHARGE_EXCEEDS_CAP"] : [];
          this.move(s,"purchased",receipt.transactionRef);
          this.save(s);
          return this.view(s);
        }
        reason="PURCHASE_RECEIPT_REUSED";
      }
      if (s.state!=="uncertain") this.move(s,"uncertain",null);
      s.heldReasons=[reason];
      this.save(s);
      return this.view(s);
    }); } catch {
      // A provider may already have charged the scoped key. A failed local commit requires keyed reconciliation.
      throw new RewardPurchaseUnknown("PURCHASE_RECEIPT_RECONCILIATION_REQUIRED");
    }
  }

  /**
   * Records physical provider outcomes in order: shipped, delivered, failed or returned. A refund is an independently timed, uniquely identified money adjustment that keeps the state,
   * from purchase onwards and after reconciliation; only the refund that makes the refunds equal the charge moves it to refunded.
   */
  recordOutcome(redemptionId: string, sourceRef: string, key: string): RedemptionView {
    return this.apply(key, { op: "outcome", redemptionId, sourceRef }, () => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      const o = parse(outcomeSchema, this.authority.outcome?.(sourceRef, this.scope, this.providerIdentity(s)));
      if (!o || !sameScope(o.scope, this.scope) || o.sourceRef !== sourceRef || o.redemptionId !== s.redemptionId || o.providerOrderRef !== s.providerOrderRef || !this.providerMatches(s,o))
        throw new RewardSourceUnavailable("OUTCOME_UNVERIFIED");
      if (s.outcomeRefs.includes(sourceRef)) {
        this.claimProviderReceipt(s,sourceRef,"outcome",o);
        return this.view(s);
      }
      const refund = o.kind === "refunded";
      if (refund && s.chargedMinor === null) throw new AgentConflict("NO_CHARGE_TO_REFUND");
      const purchaseAt = s.purchasedAt;
      if (!purchaseAt) throw new AgentConflict("PURCHASE_TIME_UNVERIFIED");
      assertSourceTime(o.occurredAt,purchaseAt,this.now().getTime());
      if (refund) {
        if (s.refundedMinor>0 && !s.refundedAt) throw new AgentConflict("REFUND_TIME_UNVERIFIED");
      } else {
        // Ingestion history has no authoritative occurrence times. Legacy physical events with no separate clock stay held.
        const physicalAt=s.physicalAt ?? (s.outcomeRefs.length===0 ? purchaseAt : null);
        if (!physicalAt) throw new AgentConflict("PHYSICAL_TIME_UNVERIFIED");
        assertSourceTime(o.occurredAt,physicalAt,this.now().getTime());
      }
      // A financial receipt cannot establish that a shipment arrived, failed, or came back.
      const lastPhysical = s.physicalState ?? [...s.history].reverse().find(h=>["purchased","shipped","delivered","failed","returned"].includes(h.state))?.state;
      if (refund ? !REFUNDABLE.includes(s.state) : !lastPhysical || !NEXT[lastPhysical]?.includes(o.kind))
        throw new AgentConflict("OUTCOME_OUT_OF_ORDER");
      if (refund !== (o.refundMinor > 0)) throw new AgentConflict("REFUND_AMOUNT_REQUIRED");
      if (s.refundedMinor + o.refundMinor > (s.chargedMinor ?? 0)) throw new AgentConflict("REFUND_EXCEEDS_CHARGE");
      this.claimProviderReceipt(s,sourceRef,"outcome",o);
      s.outcomeRefs.push(sourceRef);
      if (refund) s.refundedAt=!s.refundedAt || Date.parse(o.occurredAt)>Date.parse(s.refundedAt) ? o.occurredAt : s.refundedAt;
      else if (o.kind!=="refunded") { s.physicalAt=o.occurredAt; s.physicalState=o.kind; }
      s.refundedMinor += o.refundMinor;
      if (o.kind === "delivered") s.fulfilled = true;
      if (o.kind === "returned") s.fulfilled = false;
      // A partial refund adjusts the cost and keeps the state, so fulfilment and a later refund can still follow.
      if (refund && s.refundedMinor < s.chargedMinor!) s.history.push({ state: s.state, at: this.now().toISOString(), ref: sourceRef });
      else this.move(s, o.kind, sourceRef);
      const physical = refund ? lastPhysical : o.kind;
      const released = (physical === "failed" || physical === "returned") && s.refundedMinor === s.chargedMinor;
      this.save(s, !released);
      return this.view(s);
    });
  }

  /**
   * Reconciles the posted cash against the purchase receipt and refunds. The same cash reference is idempotent. A reconciled record is
   * reconciled again only after its refunds changed, with a new cash reference whose totals match.
   */
  reconcile(redemptionId: string, cashRef: string, key: string): RedemptionView {
    return this.apply(key, { op: "reconcile", redemptionId, cashRef }, () => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (s.cashRefs.includes(cashRef)) {
        const previous = parse(cashMovementSchema,this.authority.cashMovement?.(cashRef,this.scope,this.providerIdentity(s)));
        if (!previous || !sameScope(previous.scope,this.scope) || previous.sourceRef!==cashRef || !this.providerMatches(s,previous)) throw new RewardSourceUnavailable("CASH_MOVEMENT_UNVERIFIED");
        this.claimProviderReceipt(s,cashRef,"cash",previous);
        return this.view(s);
      }
      if (s.cashRef && s.settledCostMinor === s.chargedMinor! - s.refundedMinor) throw new AgentConflict("ALREADY_RECONCILED");
      const failedAndRefunded = (s.state==="failed" || s.state==="returned") && s.refundedMinor===s.chargedMinor;
      if (!["delivered","refunded","reconciled"].includes(s.state) && !failedAndRefunded) throw new AgentConflict("NOT_READY_TO_RECONCILE");
      const c = parse(cashMovementSchema, this.authority.cashMovement?.(cashRef, this.scope, this.providerIdentity(s)));
      if (!c || !sameScope(c.scope, this.scope) || c.sourceRef !== cashRef || !this.providerMatches(s,c)) throw new RewardSourceUnavailable("CASH_MOVEMENT_UNVERIFIED");
      if (c.providerOrderRef !== s.providerOrderRef || c.transactionRef !== s.transactionRef || c.paidMinor !== s.chargedMinor || c.refundedMinor !== s.refundedMinor)
        throw new AgentConflict("CASH_DOES_NOT_MATCH_RECEIPTS");
      const purchaseAt = s.purchasedAt;
      if (!purchaseAt) throw new AgentConflict("PURCHASE_TIME_UNVERIFIED");
      if (s.refundedMinor>0 && !s.refundedAt) throw new AgentConflict("REFUND_TIME_UNVERIFIED");
      const minimum = [purchaseAt,s.refundedAt,s.cashAt].filter((at): at is string => !!at)
        .sort((a,b)=>Date.parse(b)-Date.parse(a))[0]!;
      assertSourceTime(c.postedAt,minimum,this.now().getTime());
      s.cashAt=c.postedAt;
      this.claimProviderReceipt(s,cashRef,"cash",c);
      s.cashRef = cashRef;
      s.cashRefs.push(cashRef);
      s.settledCostMinor = c.paidMinor - c.refundedMinor;
      this.move(s, "reconciled", cashRef);
      this.save(s, this.db.prepare("SELECT active FROM reward_redemptions WHERE redemption_id=?").get(s.redemptionId)?.active === 1);
      return this.view(s);
    });
  }

  read(redemptionId: string): RedemptionView | null { const s = this.load(redemptionId); return s ? this.view(s) : null; }
  activeFor(entitlementRef: string): RedemptionView | null {
    const row = this.db.prepare("SELECT body FROM reward_redemptions WHERE entitlement_ref=? AND active=1").get(ref.parse(entitlementRef));
    return row ? this.view(JSON.parse(String(row.body)) as Stored) : null;
  }

  private view(s: Stored): RedemptionView {
    const now = this.now().getTime();
    const start = s.input.detailsCompleteAt ? Math.max(Date.parse(s.entitlement.qualifiedAt), Date.parse(s.input.detailsCompleteAt)) : null;
    const initiateBy = start === null ? null : new Date(start + FULFILLMENT_DAYS * 86_400_000).toISOString();
    const overdue = initiateBy !== null && PRE_PURCHASE.includes(s.state) && now > Date.parse(initiateBy);
    const fardaQuotedMinor = s.quote ? Math.max(0, s.quote.itemMinor - s.quote.creatorFundedMinor) + s.quote.taxMinor + s.quote.shippingMinor + s.quote.bookingMinor + s.quote.adminMinor : null;
    let availability: RedemptionView["availability"] = s.policyState === "proposed" ? "proposed" : "unavailable";
    const heldReasons = new Set(s.heldReasons);
    if (s.state === "approved") {
      try {
        if (!this.authority.executor) throw new RewardSourceUnavailable("PURCHASE_EXECUTOR_UNAVAILABLE");
        this.checkPurchasable(s);
        availability="executable";
      } catch (error) { heldReasons.add(error instanceof AgentConflict || error instanceof RewardSourceUnavailable ? error.message : "SOURCE_UNAVAILABLE"); }
    }
    if (overdue) heldReasons.add("INITIATION_OVERDUE");
    return redemptionViewSchema.parse({
      kind: "reward-redemption", redemptionId: s.redemptionId, revision: s.revision, state: s.state,
      availability,
      entitlementRef:s.entitlement.entitlementRef, entitlementSourceRef:s.entitlement.sourceRef, programRef:s.entitlement.programRef,
      creatorId:s.entitlement.creatorId, milestone:s.entitlement.milestone, rewardVersion:s.entitlement.rewardVersion,
      option: s.option ? { optionId: s.option.optionId, kind: s.option.kind, label: s.option.label, deliveryRoute: s.option.deliveryRoute } : null,
      promise: s.option ? promiseFor(s.option, s.entitlement.amountMinor, s.policyState === "adopted") : null,
      requestHash: s.requestHash, heldReasons: [...heldReasons], ownerRef: s.ownerRef ?? "reward-operations",
      clock: { qualifiedAt: s.entitlement.qualifiedAt, detailsCompleteAt: s.input.detailsCompleteAt, initiateBy, overdue },
      money: { currency:s.entitlement.currency,capMinor: s.entitlement.amountMinor, fardaQuotedMinor, creatorFundedMinor: s.quote?.creatorFundedMinor ?? null, reserveMinor: s.entitlement.reserveMinor,
        earnedLiabilityMinor: s.entitlement.amountMinor, outstandingLiabilityMinor: s.fulfilled ? 0 : s.entitlement.amountMinor,
        chargedMinor: s.chargedMinor, refundedMinor: s.refundedMinor, settledCostMinor: s.settledCostMinor },
      receipts: { providerRef:s.option?.providerRef ?? null,providerBindingRef:s.providerBindingRef ?? null,decisionRef:s.decisionRef, physicalAllocationRef:s.physicalAllocationRef, providerOrderRef:s.providerOrderRef, transactionRef:s.transactionRef, cashRef:s.cashRef, cashRefs:s.cashRefs,
        outcomeRefs: s.outcomeRefs },
      history: s.history, sourceEffects: s.purchaseAttempted ? "purchase-attempted" : "none",
    });
  }
}
