import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import {
  FULFILLMENT_DAYS, cashMovementSchema, decisionSchema, entitlementSchema, outcomeSchema, prepareSchema, providerStateSchema, purchaseReceiptSchema,
  quoteSchema, redemptionViewSchema, ref, rewardPolicySchema, type Entitlement, type PrepareInput, type Quote, type RedemptionState,
  type RedemptionView, type RewardOption, type RewardScope,
} from "./contract.ts";

/** Trusted, server-configured sources. A caller never supplies these objects. */
export interface RewardAuthority {
  entitlement?(entitlementRef: string, scope: RewardScope): unknown;
  rewardPolicy?(version: string): unknown;
  quote?(quoteRef: string, scope: RewardScope): unknown;
  provider?(providerRef: string, deliveryRoute: string): unknown;
  decision?(sourceRef: string, scope: RewardScope): unknown;
  outcome?(sourceRef: string, scope: RewardScope): unknown;
  cashMovement?(sourceRef: string, scope: RewardScope): unknown;
  /** The provider purchase executor. Keyed and idempotent at the provider; read() finds an earlier attempt by its key. */
  executor?: { purchase(key: string, manifest: unknown): unknown; read(key: string): unknown };
}
export class RewardSourceUnavailable extends Error {}

type Stored = {
  redemptionId: string; revision: number; state: RedemptionState; revisedAt: string; entitlement: Entitlement; input: PrepareInput;
  policyState: "adopted" | "proposed" | "unavailable"; option: RewardOption | null; quote: Quote | null; requestHash: string;
  heldReasons: string[]; ownerRef: string | null; decisionRef: string | null; physicalAllocationRef: string | null;
  purchaseKey: string | null; providerOrderRef: string | null; transactionRef: string | null; chargedMinor: number | null; refundedMinor: number;
  fulfilled: boolean; outcomeRefs: string[]; cashRef: string | null; settledCostMinor: number | null; purchaseAttempted: boolean;
  history: { state: RedemptionState; at: string; ref: string | null }[];
};
const REVISABLE: RedemptionState[] = ["held", "awaiting-details", "awaiting-approval", "approved", "rejected"];
const PRE_PURCHASE: RedemptionState[] = [...REVISABLE];
const NEXT: Partial<Record<RedemptionState, RedemptionState[]>> = {
  purchased: ["shipped", "delivered", "failed", "refunded"], shipped: ["delivered", "failed", "returned"],
  delivered: ["returned", "refunded"], returned: ["refunded"], failed: ["refunded"],
};
const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const sameScope = (a: RewardScope, b: RewardScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId;
const usd = (minor: number) => `$${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

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
      CREATE TABLE IF NOT EXISTS reward_receipts (source_ref TEXT PRIMARY KEY, redemption_id TEXT NOT NULL, kind TEXT NOT NULL);`);
  }

  private apply<T>(key: string, command: unknown, fn: () => T): T {
    if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED");
    const hash = digest(command);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT hash,body FROM reward_commands WHERE key=?").get(key);
      if (prior && prior.hash !== hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const result = prior ? JSON.parse(String(prior.body)) as T : fn();
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
  private claimReceipt(sourceRef: string, redemptionId: string, kind: string) {
    const used = this.db.prepare("SELECT redemption_id,kind FROM reward_receipts WHERE source_ref=?").get(sourceRef);
    if (used && (used.redemption_id !== redemptionId || used.kind !== kind)) throw new AgentConflict("RECEIPT_REUSED");
    if (!used) this.db.prepare("INSERT INTO reward_receipts VALUES(?,?,?)").run(sourceRef, redemptionId, kind);
  }
  private entitlement(entitlementRef: string): Entitlement {
    const e = parse(entitlementSchema, this.authority.entitlement?.(entitlementRef, this.scope));
    if (!e || !sameScope(e.scope, this.scope) || e.entitlementRef !== entitlementRef) throw new RewardSourceUnavailable("ENTITLEMENT_UNVERIFIED");
    return e;
  }

  /** Prepares, or revises before purchase, the one redemption request for a mature entitlement. Problems hold it with reasons. */
  prepare(body: unknown, key: string): RedemptionView {
    const input = prepareSchema.parse(body);
    return this.apply(key, { op: "prepare", input }, () => {
      const now = this.now();
      const entitlement = this.entitlement(input.entitlementRef);
      if (entitlement.state !== "mature") throw new AgentConflict(entitlement.state === "reversed" ? "ENTITLEMENT_REVERSED" : "ENTITLEMENT_NOT_MATURE");
      const activeRow = this.db.prepare("SELECT body FROM reward_redemptions WHERE entitlement_ref=? AND active=1").get(input.entitlementRef);
      const active = activeRow ? JSON.parse(String(activeRow.body)) as Stored : null;
      if (active && !REVISABLE.includes(active.state)) throw new AgentConflict("REDEMPTION_ALREADY_IN_PROGRESS");

      const reasons: string[] = [];
      const policy = parse(rewardPolicySchema, this.authority.rewardPolicy?.(entitlement.rewardVersion));
      if (!policy || policy.version !== entitlement.rewardVersion) reasons.push("REWARD_TERMS_UNAVAILABLE");
      else if (policy.state !== "adopted") reasons.push("REWARD_TERMS_NOT_ADOPTED");
      const option = policy?.options.find((o) => o.optionId === input.optionId && o.milestone === entitlement.milestone) ?? null;
      if (policy && !option) reasons.push("REWARD_OPTION_NOT_ALLOWED");
      const quote = parse(quoteSchema, this.authority.quote?.(input.quoteRef, this.scope));
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
      let ownerRef: string | null = null;
      if (option) {
        const provider = parse(providerStateSchema, this.authority.provider?.(option.providerRef, option.deliveryRoute));
        ownerRef = provider?.ownerRef ?? null;
        if (!provider) reasons.push("PROVIDER_ROUTE_UNVERIFIED");
        else {
          if (provider.state !== "Ready") reasons.push(`PROVIDER_ROUTE_${provider.state.toUpperCase()}`);
          if (!provider.fundingVerified) reasons.push("FUNDING_METHOD_UNVERIFIED");
        }
      }
      if (Date.parse(input.expiresAt) <= now.getTime()) reasons.push("REQUEST_EXPIRED");
      if (input.detailsCompleteAt && Date.parse(input.detailsCompleteAt) > now.getTime()) throw new AgentConflict("FUTURE_TIMESTAMP");

      const requestHash = digest({ scope: this.scope, entitlementRef: input.entitlementRef, cap: entitlement.amountMinor, rewardVersion: entitlement.rewardVersion,
        option, quote, recipientRef: input.recipientRef, expiresAt: input.expiresAt, detailsCompleteAt: input.detailsCompleteAt });
      if (active && active.requestHash === requestHash && digest(active.heldReasons) === digest(reasons)) return this.view(active);
      const attempts = Number(this.db.prepare("SELECT COUNT(*) AS n FROM reward_redemptions WHERE entitlement_ref=?").get(input.entitlementRef)!.n);
      const s: Stored = active ? { ...active, revision: active.revision + 1, decisionRef: null, physicalAllocationRef: null } : {
        redemptionId: `redemption-${digest({ entitlementRef: input.entitlementRef, attempt: attempts + 1 }).slice(0, 32)}`, revision: 1, state: "held",
        revisedAt: now.toISOString(), entitlement, input, policyState: "unavailable", option: null, quote: null, requestHash, heldReasons: [], ownerRef: null,
        decisionRef: null, physicalAllocationRef: null, purchaseKey: null, providerOrderRef: null, transactionRef: null, chargedMinor: null, refundedMinor: 0,
        fulfilled: false, outcomeRefs: [], cashRef: null, settledCostMinor: null, purchaseAttempted: false, history: [],
      };
      Object.assign(s, { revisedAt: now.toISOString(), entitlement, input, option, quote, requestHash, heldReasons: reasons, ownerRef,
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
      if (d.decision === "approved" && s.option?.deliveryRoute === "farda-physical" && !d.physicalAllocationRef)
        throw new AgentConflict("PHYSICAL_ALLOCATION_REQUIRED");
      this.claimReceipt(decisionRef, s.redemptionId, "decision");
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

  /**
   * Purchases once. The state is committed as purchasing before the executor runs; an error or unreadable receipt leaves it uncertain,
   * and the next call reads the provider by the same key before any retry.
   */
  async purchase(redemptionId: string, key: string): Promise<RedemptionView> {
    if (!key?.trim() || key.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED");
    const executor = this.authority.executor;
    if (!executor) throw new RewardSourceUnavailable("PURCHASE_EXECUTOR_UNAVAILABLE");
    const { s: prepared, resumed } = this.tx(() => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (s.state === "purchasing" || s.state === "uncertain") return { s, resumed: true };
      if (s.state !== "approved") throw new AgentConflict(PRE_PURCHASE.includes(s.state) ? "J04_APPROVAL_REQUIRED" : "ALREADY_PURCHASED");
      this.currentDecision(s, s.decisionRef!);
      const e = this.entitlement(s.entitlement.entitlementRef);
      if (e.state !== "mature" || e.amountMinor !== s.entitlement.amountMinor) throw new AgentConflict("ENTITLEMENT_CHANGED");
      if (!s.quote || Date.parse(s.quote.validUntil) <= this.now().getTime()) throw new AgentConflict("QUOTE_EXPIRED");
      s.purchaseKey = `purchase:${s.redemptionId}:r${s.revision}`;
      s.purchaseAttempted = true;
      this.move(s, "purchasing", s.decisionRef);
      this.save(s);
      return { s, resumed: false };
    });
    let receipt: z.infer<typeof purchaseReceiptSchema> | null = null;
    try {
      // A purchase left purchasing (a stopped worker) or uncertain is read back by its key before anything is retried.
      if (resumed) {
        receipt = parse(purchaseReceiptSchema, await executor.read(prepared.purchaseKey!));
        // Nothing was found under the key. Retry only while the approval is still current.
        if (!receipt) this.currentDecision(prepared, prepared.decisionRef!);
      }
      receipt ??= parse(purchaseReceiptSchema, await executor.purchase(prepared.purchaseKey!, {
        redemptionId: prepared.redemptionId, revision: prepared.revision, requestHash: prepared.requestHash, optionId: prepared.option?.optionId,
        quoteRef: prepared.quote?.quoteRef, recipientRef: prepared.input.recipientRef, capMinor: prepared.entitlement.amountMinor,
        physicalAllocationRef: prepared.physicalAllocationRef,
      }));
    } catch (error) {
      if (error instanceof AgentConflict) throw error;
      receipt = null;
    }
    return this.tx(() => {
      const s = this.load(redemptionId)!;
      if (!receipt) { if (s.state !== "uncertain") this.move(s, "uncertain", null); this.save(s); return this.view(s); }
      this.claimReceipt(receipt.transactionRef, s.redemptionId, "purchase");
      Object.assign(s, { providerOrderRef: receipt.providerOrderRef, transactionRef: receipt.transactionRef, chargedMinor: receipt.chargedMinor });
      if (receipt.chargedMinor > s.entitlement.amountMinor) s.heldReasons = [...new Set([...s.heldReasons, "CHARGE_EXCEEDS_CAP"])];
      this.move(s, "purchased", receipt.transactionRef);
      this.save(s);
      return this.view(s);
    });
  }

  /** Records a provider outcome in order: shipped, delivered, failed, returned or refunded. */
  recordOutcome(redemptionId: string, sourceRef: string, key: string): RedemptionView {
    return this.apply(key, { op: "outcome", redemptionId, sourceRef }, () => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      const o = parse(outcomeSchema, this.authority.outcome?.(sourceRef, this.scope));
      if (!o || !sameScope(o.scope, this.scope) || o.sourceRef !== sourceRef || o.redemptionId !== s.redemptionId || o.providerOrderRef !== s.providerOrderRef)
        throw new RewardSourceUnavailable("OUTCOME_UNVERIFIED");
      if (Date.parse(o.occurredAt) > this.now().getTime()) throw new AgentConflict("FUTURE_TIMESTAMP");
      if (s.outcomeRefs.includes(sourceRef)) return this.view(s);
      if (!NEXT[s.state]?.includes(o.kind)) throw new AgentConflict("OUTCOME_OUT_OF_ORDER");
      if ((o.kind === "refunded") !== (o.refundMinor > 0)) throw new AgentConflict("REFUND_AMOUNT_REQUIRED");
      if (s.refundedMinor + o.refundMinor > (s.chargedMinor ?? 0)) throw new AgentConflict("REFUND_EXCEEDS_CHARGE");
      this.claimReceipt(sourceRef, s.redemptionId, "outcome");
      s.outcomeRefs.push(sourceRef);
      s.refundedMinor += o.refundMinor;
      if (o.kind === "delivered") s.fulfilled = true;
      if (o.kind === "returned") s.fulfilled = false;
      // A partial refund on a delivered reward adjusts its cost; the reward stays delivered.
      const partialAfterDelivery = o.kind === "refunded" && s.state === "delivered" && s.refundedMinor < (s.chargedMinor ?? 0);
      if (!partialAfterDelivery) this.move(s, o.kind, sourceRef); else s.history.push({ state: s.state, at: this.now().toISOString(), ref: sourceRef });
      // A failed or returned reward that is fully refunded frees the entitlement for a new request. The earned obligation remains.
      const released = !s.fulfilled && s.state === "refunded" && s.refundedMinor === s.chargedMinor;
      this.save(s, !released);
      return this.view(s);
    });
  }

  /** Reconciles the posted cash once against the purchase receipt and refunds. */
  reconcile(redemptionId: string, cashRef: string, key: string): RedemptionView {
    return this.apply(key, { op: "reconcile", redemptionId, cashRef }, () => {
      const s = this.load(redemptionId);
      if (!s) throw new AgentConflict("REDEMPTION_UNKNOWN");
      if (s.cashRef) { if (s.cashRef !== cashRef) throw new AgentConflict("ALREADY_RECONCILED"); return this.view(s); }
      if (!["delivered", "refunded"].includes(s.state)) throw new AgentConflict("NOT_READY_TO_RECONCILE");
      const c = parse(cashMovementSchema, this.authority.cashMovement?.(cashRef, this.scope));
      if (!c || !sameScope(c.scope, this.scope) || c.sourceRef !== cashRef) throw new RewardSourceUnavailable("CASH_MOVEMENT_UNVERIFIED");
      if (c.providerOrderRef !== s.providerOrderRef || c.transactionRef !== s.transactionRef || c.paidMinor !== s.chargedMinor || c.refundedMinor !== s.refundedMinor)
        throw new AgentConflict("CASH_DOES_NOT_MATCH_RECEIPTS");
      this.claimReceipt(cashRef, s.redemptionId, "cash");
      s.cashRef = cashRef;
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
    return redemptionViewSchema.parse({
      kind: "reward-redemption", redemptionId: s.redemptionId, revision: s.revision, state: s.state,
      availability: s.policyState !== "adopted" ? "proposed" : s.state === "held" ? "unavailable" : "executable",
      entitlementRef: s.entitlement.entitlementRef, creatorId: s.entitlement.creatorId, milestone: s.entitlement.milestone, rewardVersion: s.entitlement.rewardVersion,
      option: s.option ? { optionId: s.option.optionId, kind: s.option.kind, label: s.option.label, deliveryRoute: s.option.deliveryRoute } : null,
      promise: s.option ? promiseFor(s.option, s.entitlement.amountMinor, s.policyState === "adopted") : null,
      requestHash: s.requestHash, heldReasons: overdue ? [...s.heldReasons, "INITIATION_OVERDUE"] : s.heldReasons, ownerRef: s.ownerRef,
      clock: { qualifiedAt: s.entitlement.qualifiedAt, detailsCompleteAt: s.input.detailsCompleteAt, initiateBy, overdue },
      money: { capMinor: s.entitlement.amountMinor, fardaQuotedMinor, creatorFundedMinor: s.quote?.creatorFundedMinor ?? 0, reserveMinor: s.entitlement.reserveMinor,
        earnedLiabilityMinor: s.entitlement.amountMinor, outstandingLiabilityMinor: s.fulfilled ? 0 : s.entitlement.amountMinor,
        chargedMinor: s.chargedMinor, refundedMinor: s.refundedMinor, settledCostMinor: s.settledCostMinor },
      receipts: { decisionRef: s.decisionRef, providerOrderRef: s.providerOrderRef, transactionRef: s.transactionRef, cashRef: s.cashRef, outcomeRefs: s.outcomeRefs },
      history: s.history, sourceEffects: s.purchaseAttempted ? "purchase-attempted" : "none",
    });
  }
}
