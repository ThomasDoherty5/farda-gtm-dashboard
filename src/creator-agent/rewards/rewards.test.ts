// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../store";
import { digest } from "../config";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import type { Entitlement, PrepareInput, Quote, RewardPolicy } from "./contract";
import { RewardRedemptionRepository, type RewardAuthority, type RewardProviderIdentity } from "./repository";
import { handleRewardRoute } from "./routes";

// Synthetic creators, providers and receipts only. No purchase, programme or provider account is real.
const defaultProvider = {providerRef:"provider:retail",providerBindingRef:"binding:1"};
const scope = { workspaceId: "fictional-workspace", accountId: "fictional-account" };
let clock = new Date("2026-11-06T12:00:00Z");
const at = (iso: string) => { clock = new Date(iso); };

function world(over: { policyState?: "adopted" | "proposed" } = {}) {
  clock = new Date("2026-11-06T12:00:00Z");
  const entitlements = new Map<string, Entitlement>();
  const quotes = new Map<string, Quote>();
  const decisions = new Map<string, unknown>();
  const outcomes = new Map<string, unknown>();
  const cash = new Map<string, unknown>();
  const providers = new Map<string, unknown>([["provider:retail", { state: "Ready", fundingVerified: true, ownerRef: "owner:ops" }],
    ["provider:travel", { state: "Ready", fundingVerified: true, ownerRef: "owner:ops" }], ["provider:warehouse", { state: "Ready", fundingVerified: true, ownerRef: "owner:ops" }]]);
  const policy: RewardPolicy = { scope, version: "CEO-v1", state: over.policyState ?? "adopted", adoptionRef: over.policyState === "proposed" ? null : "adoption:owner-1", options: [
    { optionId: "tech-earbuds", milestone: "tech", kind: "item", label: "Wireless earbuds", providerRef: "provider:retail", deliveryRoute: "provider-direct" },
    { optionId: "tech-allowance", milestone: "tech", kind: "allowance", label: "a tech accessory of the creator's choice", providerRef: "provider:retail", deliveryRoute: "allowance-transfer" },
    { optionId: "tech-kit", milestone: "tech", kind: "item", label: "Organizer kit", providerRef: "provider:warehouse", deliveryRoute: "farda-physical" },
    { optionId: "trip", milestone: "vacation", kind: "trip", label: "a trip for two", providerRef: "provider:travel", deliveryRoute: "booking" },
  ] };
  const allocations = new Map<string, unknown>();
  const purchases = new Map<string, { purchaseKey:string; providerRef:string; providerBindingRef:string; purchasedAt:string; providerOrderRef:string; transactionRef:string; chargedMinor:number; currency:"USD" }>();
  // fail and gate apply to the next call only. A gate holds that call after the provider accepted, until the test resolves it.
  const executor = { calls: 0, fail: null as null | "before" | "after", gate: null as null | Promise<void>,
    async purchase(key: string, manifest: { capMinor: number; providerRef:string; providerBindingRef:string }) {
      this.calls++;
      const { fail, gate } = this;
      this.fail = null; this.gate = null;
      if (fail === "before") throw new Error("connection reset before the provider answered");
      const quote = [...quotes.values()][0]!;
      const receipt = { purchaseKey:key, providerRef:manifest.providerRef, providerBindingRef:manifest.providerBindingRef, purchasedAt:clock.toISOString(), providerOrderRef:`order:${key}`, transactionRef:`txn:${key}`,
        chargedMinor: Math.min(manifest.capMinor, quote.itemMinor - quote.creatorFundedMinor + quote.taxMinor + quote.shippingMinor), currency:"USD" as const };
      purchases.set(key, receipt);
      if (gate) await gate;
      if (fail === "after") throw new Error("timeout after the provider accepted");
      return receipt;
    },
    read(key: string, provider: RewardProviderIdentity = defaultProvider) {
      const receipt=purchases.get(key);
      return receipt ? {state:"found",receipt} : {state:"notFound",purchaseKey:key,...provider,sourceRef:"verified-lookup",checkedAt:clock.toISOString()};
    } };
  const authority: RewardAuthority = {
    entitlement: (r) => entitlements.get(r) ?? null, rewardPolicy: (v) => (v === policy.version ? policy : null), quote: (r) => quotes.get(r) ?? null,
    provider: (providerRef,deliveryRoute) => providers.has(providerRef) ? {scope,providerRef,deliveryRoute,action:"purchase-reward",bindingRef:"binding:1",fundingRef:"fund:1",
      validUntil:"2027-01-01T00:00:00Z",...providers.get(providerRef) as object} : null,
    allocation:r=>allocations.get(r), decision: (r) => decisions.get(r) ?? null, outcome: (r) => outcomes.get(r) ?? null,
    cashMovement: (r) => cash.get(r) ?? null, executor,
  };
  const store = new AgentStore(":memory:", scope);
  const repo = new RewardRedemptionRepository(store.database, scope, authority, () => clock);
  const entitle = (over: Partial<Entitlement> = {}) => {
    const e: Entitlement = { scope, entitlementRef: "entitlement:tech-1", sourceRef: "j11:award-1", creatorId: "creator-synthetic", programRef: "program:launch",
      milestone: "tech", amountMinor: 30000, currency: "USD", rewardVersion: "CEO-v1", state: "mature", qualifiedAt: "2026-11-01T00:00:00Z", programPaused: false,
      fulfilled:false, reserveMinor:30000, ...over };
    entitlements.set(e.entitlementRef, e);
    return e;
  };
  const quote = (over: Partial<Quote> = {}) => {
    const q: Quote = { scope, quoteRef: "quote:1", optionId: "tech-earbuds", providerRef: "provider:retail", available: true, currency: "USD", itemMinor: 24900,
      taxMinor: 2000, shippingMinor: 0, bookingMinor: 0, adminMinor: 0, creatorFundedMinor: 0, validUntil: "2026-11-20T00:00:00Z", ...over };
    quotes.set(q.quoteRef, q);
    return q;
  };
  const request = (over: Partial<PrepareInput> = {}): PrepareInput => ({ entitlementRef: "entitlement:tech-1", optionId: "tech-earbuds", quoteRef: "quote:1",
    recipientRef: "recipient:creator-synthetic", detailsCompleteAt: "2026-11-02T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", ...over });
  const approve = (redemptionId: string, revision: number, requestHash: string, over: Record<string, unknown> = {}) => {
    const sourceRef = `j04:${redemptionId}:r${revision}`;
    decisions.set(sourceRef, { scope, sourceRef, redemptionId, revision, requestHash, decision: "approved", state: "current", physicalAllocationRef: null,
      source:"linear-j04",actorRole:"founder",decidedAt: clock.toISOString(), validUntil: "2026-11-30T00:00:00Z", ...over });
    return sourceRef;
  };
  const outcome = (redemptionId: string, providerOrderRef: string, kind: string, refundMinor = 0) => {
    const sourceRef = `outcome:${kind}:${outcomes.size}`;
    const identity=repo.read(redemptionId)!.receipts;
    outcomes.set(sourceRef, { scope, sourceRef, redemptionId, providerRef:identity.providerRef,providerBindingRef:identity.providerBindingRef,providerOrderRef, kind, refundMinor, occurredAt: clock.toISOString() });
    return sourceRef;
  };
  const hold = () => { let release!: () => void; executor.gate = new Promise<void>((resolve) => { release = resolve; }); return () => release(); };
  return { repo, store, entitle, quote, request, approve, outcome, decisions, cash, providers, executor, purchases, quotes, hold, authority, policy, outcomes, allocations };
}
type World = ReturnType<typeof world>;
function approved(w: World) {
  w.entitle(); w.quote();
  const prepared = w.repo.prepare(w.request(), "prepare-1");
  w.repo.decide(prepared.redemptionId, w.approve(prepared.redemptionId, prepared.revision, prepared.requestHash), "decide-1");
  return prepared.redemptionId;
}
async function purchased(w: World) {
  return w.repo.purchase(approved(w), "purchase-1");
}
const afterPurchasing = (view: { history: { state: string }[] }) => view.history.map((h) => h.state).slice(view.history.findIndex((h) => h.state === "purchasing"));

describe("consuming a mature J11 entitlement (acceptance 1)", () => {
  it("redeems the owner's entitlement as reported, without recalculating it", async () => {
    const w = world();
    const view = await purchased(w);
    expect(view).toMatchObject({ state: "purchased", entitlementRef: "entitlement:tech-1", milestone: "tech", rewardVersion: "CEO-v1",
      money: { capMinor: 30000, earnedLiabilityMinor: 30000, chargedMinor: 26900 } });
  });
  it("refuses an unverified, pending or reversed entitlement", () => {
    const w = world();
    w.quote();
    expect(() => w.repo.prepare(w.request(), "k0")).toThrow("ENTITLEMENT_UNVERIFIED");
    w.entitle({ state: "pending" });
    expect(() => w.repo.prepare(w.request(), "k1")).toThrow("ENTITLEMENT_NOT_MATURE");
    w.entitle({ state: "reversed" });
    expect(() => w.repo.prepare(w.request(), "k2")).toThrow("ENTITLEMENT_REVERSED");
    w.entitle({ scope: { ...scope, accountId: "other" } });
    expect(() => w.repo.prepare(w.request(), "k3")).toThrow("ENTITLEMENT_UNVERIFIED");
  });
  it("keeps a paused programme's earned entitlement redeemable", () => {
    const w = world();
    w.entitle({ programPaused: true }); w.quote();
    expect(w.repo.prepare(w.request(), "k").state).toBe("awaiting-approval");
  });
});

describe("bounded request, provider capability and owner (acceptance 2)", () => {
  it("holds proposed terms as proposed and never makes them executable", async () => {
    const w = world({ policyState: "proposed" });
    w.entitle(); w.quote();
    const view = w.repo.prepare(w.request(), "k");
    expect(view).toMatchObject({ state: "held", availability: "proposed" });
    expect(view.heldReasons).toContain("REWARD_TERMS_NOT_ADOPTED");
    expect(view.promise).toMatch(/^Proposed, not yet adopted: /);
    expect(() => w.repo.decide(view.redemptionId, w.approve(view.redemptionId, 1, view.requestHash), "d")).toThrow("NOT_AWAITING_APPROVAL");
    await expect(w.repo.purchase(view.redemptionId, "p")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(w.executor.calls).toBe(0);
  });
  it("holds an unverified provider route or funding method with its owner", () => {
    const w = world();
    w.entitle(); w.quote();
    w.providers.set("provider:retail", { state: "Unverified", fundingVerified: false, ownerRef: "owner:ops" });
    const view = w.repo.prepare(w.request(), "k");
    expect(view).toMatchObject({ state: "held", availability: "unavailable", ownerRef: "owner:ops" });
    expect(view.heldReasons).toEqual(expect.arrayContaining(["PROVIDER_ROUTE_UNVERIFIED", "FUNDING_METHOD_UNVERIFIED"]));
  });
  it("refuses an option outside the approved version, a mismatched quote and an expired request", () => {
    const w = world();
    w.entitle(); w.quote({ optionId: "tech-allowance" });
    expect(w.repo.prepare(w.request({ optionId: "trip" }), "k1").heldReasons).toContain("REWARD_OPTION_NOT_ALLOWED");
    expect(w.repo.prepare(w.request(), "k2").heldReasons).toContain("QUOTE_MISMATCH");
    expect(w.repo.prepare(w.request({ optionId: "tech-allowance", expiresAt: "2026-11-01T00:00:00Z" }), "k3").heldReasons).toContain("REQUEST_EXPIRED");
  });
});

describe("exact J04 decision before purchase (acceptance 3)", () => {
  it("treats a reserve or an earned entitlement as no purchase authority", async () => {
    const w = world();
    w.entitle({ reserveMinor: 30000 }); w.quote();
    const view = w.repo.prepare(w.request(), "k");
    await expect(w.repo.purchase(view.redemptionId, "p")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(w.executor.calls).toBe(0);
  });
  it("rejects a decision for another revision or request, a revoked one and one made before the request", () => {
    const w = world();
    w.entitle(); w.quote();
    const v1 = w.repo.prepare(w.request(), "k1");
    expect(() => w.repo.decide(v1.redemptionId, w.approve(v1.redemptionId, 1, "0".repeat(64)), "d1")).toThrow("J04_DECISION_FOR_ANOTHER_REQUEST");
    expect(() => w.repo.decide(v1.redemptionId, w.approve(v1.redemptionId, 1, v1.requestHash, { state: "revoked" }), "d2")).toThrow("J04_DECISION_NOT_CURRENT");
    expect(() => w.repo.decide(v1.redemptionId, w.approve(v1.redemptionId, 1, v1.requestHash, { decidedAt: "2026-11-01T00:00:00Z" }), "d3")).toThrow("J04_DECISION_PREDATES_REQUEST");
    expect(() => w.repo.decide(v1.redemptionId, "j04:unknown", "d4")).toThrow("J04_DECISION_UNVERIFIED");
  });
  it("clears an approval when the request changes, and refuses purchase after the decision is revoked", async () => {
    const w = world();
    w.entitle(); w.quote(); w.quote({ quoteRef: "quote:2", taxMinor: 2500 });
    const v1 = w.repo.prepare(w.request(), "k1");
    const decisionRef = w.approve(v1.redemptionId, 1, v1.requestHash);
    expect(w.repo.decide(v1.redemptionId, decisionRef, "d1").state).toBe("approved");
    const v2 = w.repo.prepare(w.request({ quoteRef: "quote:2" }), "k2");
    expect(v2).toMatchObject({ revision: 2, state: "awaiting-approval", receipts: { decisionRef: null } });
    const ref2 = w.approve(v2.redemptionId, 2, v2.requestHash);
    w.repo.decide(v2.redemptionId, ref2, "d2");
    w.decisions.set(ref2, { ...(w.decisions.get(ref2) as object), state: "revoked" });
    await expect(w.repo.purchase(v2.redemptionId, "p")).rejects.toThrow("J04_DECISION_NOT_CURRENT");
    expect(w.executor.calls).toBe(0);
  });
});

describe("one redemption per entitlement and uncertain purchases (acceptance 4)", () => {
  it("returns the same redemption for a duplicate qualification and refuses a second once purchasing", async () => {
    const w = world();
    const view = await purchased(w);
    expect(w.repo.prepare(w.request(), "prepare-1").redemptionId).toBe(view.redemptionId);
    expect(() => w.repo.prepare(w.request(), "prepare-2")).toThrow("REDEMPTION_ALREADY_IN_PROGRESS");
    await expect(w.repo.purchase(view.redemptionId, "purchase-2")).rejects.toThrow("ALREADY_PURCHASED");
    expect(w.executor.calls).toBe(1);
  });
  it("reads an uncertain purchase back before retrying, so an accepted purchase is not repeated", async () => {
    const w = world();
    w.executor.fail = "after";
    const uncertain = await purchased(w);
    expect(uncertain).toMatchObject({ state: "uncertain", sourceEffects: "purchase-attempted", receipts: { transactionRef: null } });
    const resolved = await w.repo.purchase(uncertain.redemptionId, "purchase-again");
    expect(resolved.state).toBe("purchased");
    expect(w.executor.calls).toBe(1);
  });
  it("retries with the same key only when nothing was found and the approval is still current", async () => {
    const w = world();
    w.executor.fail = "before";
    const uncertain = await purchased(w);
    expect(uncertain.state).toBe("uncertain");
    const retried = await w.repo.purchase(uncertain.redemptionId, "purchase-again");
    expect(retried.state).toBe("purchased");
    expect(w.executor.calls).toBe(2);
    expect(w.purchases.size).toBe(1);
  });
  it("keeps purchased, shipped, delivered, failed, returned, refunded and reconciled separate and in order", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    expect(() => w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "returned"), "o0")).toThrow("OUTCOME_OUT_OF_ORDER");
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "shipped"), "o1");
    const delivered = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "delivered"), "o2");
    expect(delivered.history.map((h) => h.state)).toEqual(["awaiting-approval", "approved", "purchasing", "purchased", "shipped", "delivered"]);
    expect(delivered.money.outstandingLiabilityMinor).toBe(0);
  });
  it("refuses a concurrent purchase while one is in flight, so the provider is called once and the state never rolls back", async () => {
    const w = world();
    const id = approved(w);
    const release = w.hold();
    const first = w.repo.purchase(id, "purchase-1");
    await expect(w.repo.purchase(id, "purchase-2")).rejects.toThrow("PURCHASE_IN_FLIGHT");
    release();
    const view = await first;
    expect(view.state).toBe("purchased");
    expect(w.executor.calls).toBe(1);
    expect(afterPurchasing(view)).toEqual(["purchasing", "purchased"]);
  });
  it("reads a stopped worker's purchase back by its key once the lease expires, and completes without buying again", async () => {
    const w = world();
    const id = approved(w);
    const release = w.hold();
    const stalled = w.repo.purchase(id, "purchase-1");
    at("2026-11-06T12:06:00Z");
    const resumed = await w.repo.purchase(id, "purchase-2");
    expect(resumed.state).toBe("purchased");
    expect(w.executor.calls).toBe(1);
    release();
    expect((await stalled).state).toBe("purchased");
    expect(afterPurchasing(w.repo.read(id)!)).toEqual(["purchasing", "purchased"]);
  });
  it("never lets a late failing call move a purchased or delivered record back", async () => {
    const w = world();
    const id = approved(w);
    w.executor.fail = "after";
    const release = w.hold();
    const late = w.repo.purchase(id, "purchase-1");
    at("2026-11-06T12:06:00Z");
    const p = await w.repo.purchase(id, "purchase-2");
    w.repo.recordOutcome(id, w.outcome(id, p.receipts.providerOrderRef!, "delivered"), "o1");
    release();
    expect((await late).state).toBe("delivered");
    const view = w.repo.read(id)!;
    expect(view.state).toBe("delivered");
    expect(afterPurchasing(view)).toEqual(["purchasing", "purchased", "delivered"]);
  });
  it("binds a purchase idempotency key to its redemption", async () => {
    const w = world();
    await purchased(w);
    await expect(w.repo.purchase("redemption-other", "purchase-1")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(w.repo.purchase("redemption-other", "prepare-1")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("re-reads the quote at purchase time and refuses a changed, expired or unavailable one", async () => {
    const w = world();
    const id = approved(w);
    w.quote({ taxMinor: 2500 });
    await expect(w.repo.purchase(id, "p1")).rejects.toThrow("QUOTE_CHANGED");
    w.quote({ available: false });
    await expect(w.repo.purchase(id, "p2")).rejects.toThrow("QUOTE_CHANGED");
    w.quotes.delete("quote:1");
    await expect(w.repo.purchase(id, "p3")).rejects.toThrow("QUOTE_CHANGED");
    w.quote();
    at("2026-11-21T00:00:00Z");
    await expect(w.repo.purchase(id, "p4")).rejects.toThrow("QUOTE_CHANGED");
    expect(w.executor.calls).toBe(0);
    expect(w.repo.read(id)!.state).toBe("approved");
  });
  it("re-reads the provider route at purchase time and refuses one that is no longer Ready or funded", async () => {
    const w = world();
    const id = approved(w);
    w.providers.set("provider:retail", { state: "Denied", fundingVerified: true, ownerRef: "owner:ops" });
    await expect(w.repo.purchase(id, "p1")).rejects.toThrow("PROVIDER_ROUTE_NOT_READY");
    w.providers.set("provider:retail", { state: "Ready", fundingVerified: false, ownerRef: "owner:ops" });
    await expect(w.repo.purchase(id, "p2")).rejects.toThrow("PROVIDER_ROUTE_NOT_READY");
    expect(w.executor.calls).toBe(0);
    w.providers.set("provider:retail", { state: "Ready", fundingVerified: true, ownerRef: "owner:ops" });
    expect((await w.repo.purchase(id, "p3")).state).toBe("purchased");
  });
});

describe("physical fulfillment and recovery handoffs (acceptance 5)", () => {
  it("needs an explicitly approved J15 allocation for a Farda-shipped item", () => {
    const w = world();
    w.entitle(); w.quote({ optionId: "tech-kit", providerRef: "provider:warehouse" });
    const view = w.repo.prepare(w.request({ optionId: "tech-kit" }), "k");
    expect(() => w.repo.decide(view.redemptionId, w.approve(view.redemptionId, 1, view.requestHash), "d1")).toThrow("PHYSICAL_ALLOCATION_REQUIRED");
    w.allocations.set("j15:allocation-4",{scope,sourceRef:"j15:allocation-4",redemptionId:view.redemptionId,requestHash:view.requestHash,revision:1,
      purpose:"creator-reward",optionId:"tech-kit",recipientRef:"recipient:creator-synthetic",state:"reserved",validUntil:"2026-12-01T00:00:00Z"});
    const ok = w.repo.decide(view.redemptionId, w.approve(view.redemptionId, 1, view.requestHash, { physicalAllocationRef: "j15:allocation-4" }), "d2");
    expect(ok.state).toBe("approved");
  });
  it("frees a failed, fully refunded redemption for a new request while the earned obligation stays outstanding", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "failed"), "o1");
    const refunded = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 26900), "o2");
    expect(refunded).toMatchObject({ state: "refunded", money: { outstandingLiabilityMinor: 30000, refundedMinor: 26900 } });
    expect(w.repo.activeFor("entitlement:tech-1")).toBeNull();
    const next = w.repo.prepare(w.request(), "prepare-new");
    expect(next.redemptionId).not.toBe(p.redemptionId);
  });
  it("releases a failed reward refunded in parts, and keeps the earned obligation outstanding", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "failed"), "o1");
    const partial = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 1000), "o2");
    expect(partial).toMatchObject({ state: "failed", money: { refundedMinor: 1000 } });
    expect(w.repo.activeFor("entitlement:tech-1")?.redemptionId).toBe(p.redemptionId);
    const refunded = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 25900), "o3");
    expect(refunded).toMatchObject({ state: "refunded", money: { refundedMinor: 26900, outstandingLiabilityMinor: 30000 } });
    expect(w.repo.activeFor("entitlement:tech-1")).toBeNull();
    const next = w.repo.prepare(w.request(), "prepare-new");
    expect(next.state).toBe("awaiting-approval");
    expect(next.redemptionId).not.toBe(p.redemptionId);
  });
  it("keeps a partial refund before shipping as a money adjustment, so shipping and delivery still follow", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    const partial = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 500), "o1");
    expect(partial).toMatchObject({ state: "purchased", money: { refundedMinor: 500 } });
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "shipped"), "o2");
    const delivered = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "delivered"), "o3");
    expect(delivered).toMatchObject({ state: "delivered", money: { refundedMinor: 500, outstandingLiabilityMinor: 0 } });
    expect(delivered.history.slice(-4).map((h) => h.state)).toEqual(["purchased", "purchased", "shipped", "delivered"]);
  });
  it("refuses a refund when there is no charge to refund", async () => {
    const w = world();
    const p = await purchased(w);
    w.store.database.prepare("UPDATE reward_redemptions SET body=json_set(body,'$.chargedMinor',json('null')) WHERE redemption_id=?").run(p.redemptionId);
    expect(() => w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, p.receipts.providerOrderRef!, "refunded", 100), "o1")).toThrow("NO_CHARGE_TO_REFUND");
  });
});

describe("cash reconciliation once against the receipts (acceptance 6)", () => {
  it("settles a partial refund once and keeps reserve, earned liability and settled cost apart", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "delivered"), "o1");
    const partial = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 1500), "o2");
    expect(partial).toMatchObject({ state: "delivered", money: { refundedMinor: 1500 } });
    w.cash.set("cash:bad", { scope, sourceRef: "cash:bad", ...defaultProvider,providerOrderRef: order, transactionRef: p.receipts.transactionRef, paidMinor: 26900, refundedMinor: 0, currency: "USD", postedAt: clock.toISOString() });
    expect(() => w.repo.reconcile(p.redemptionId, "cash:bad", "r0")).toThrow("CASH_DOES_NOT_MATCH_RECEIPTS");
    w.cash.set("cash:1", { scope, sourceRef: "cash:1", ...defaultProvider,providerOrderRef: order, transactionRef: p.receipts.transactionRef, paidMinor: 26900, refundedMinor: 1500, currency: "USD", postedAt: clock.toISOString() });
    const done = w.repo.reconcile(p.redemptionId, "cash:1", "r1");
    expect(done).toMatchObject({ state: "reconciled", money: { reserveMinor: 30000, earnedLiabilityMinor: 30000, outstandingLiabilityMinor: 0, settledCostMinor: 25400 },
      receipts: { cashRef: "cash:1" } });
    expect(() => w.repo.reconcile(p.redemptionId, "cash:2", "r2")).toThrow("ALREADY_RECONCILED");
    expect(w.repo.reconcile(p.redemptionId, "cash:1", "r3").receipts.cashRefs).toEqual(["cash:1"]);
  });
  it("records a late refund after reconciliation and reconciles again with a new cash reference", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    const posted = (sourceRef: string, refundedMinor: number) =>
      w.cash.set(sourceRef, { scope, sourceRef, ...defaultProvider,providerOrderRef: order, transactionRef: p.receipts.transactionRef, paidMinor: 26900, refundedMinor, currency: "USD", postedAt: clock.toISOString() });
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "delivered"), "o1");
    posted("cash:1", 0);
    expect(w.repo.reconcile(p.redemptionId, "cash:1", "r1").money.settledCostMinor).toBe(26900);
    const late = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 2000), "o2");
    expect(late).toMatchObject({ state: "reconciled", money: { refundedMinor: 2000, settledCostMinor: 26900 } });
    posted("cash:stale", 0);
    expect(() => w.repo.reconcile(p.redemptionId, "cash:stale", "r2")).toThrow("CASH_DOES_NOT_MATCH_RECEIPTS");
    posted("cash:2", 2000);
    const again = w.repo.reconcile(p.redemptionId, "cash:2", "r3");
    expect(again).toMatchObject({ state: "reconciled", money: { settledCostMinor: 24900, outstandingLiabilityMinor: 0 }, receipts: { cashRef: "cash:2", cashRefs: ["cash:1", "cash:2"] } });
    posted("cash:3", 2000);
    expect(() => w.repo.reconcile(p.redemptionId, "cash:3", "r4")).toThrow("ALREADY_RECONCILED");
  });
});

describe("Notion knowledge: RW-K01 to RW-K04", () => {
  it("RW-K01 counts tax, shipping, booking and fees inside the cap, allows an equivalent, and keeps a creator upgrade off Farda's books", () => {
    const w = world();
    w.entitle();
    w.quote({ taxMinor: 4000, shippingMinor: 2000 });
    expect(w.repo.prepare(w.request(), "k1").heldReasons).toContain("ALL_IN_CAP_EXCEEDED");
    w.quote({ quoteRef: "quote:2", optionId: "tech-allowance", itemMinor: 30000, taxMinor: 0 });
    expect(w.repo.prepare(w.request({ optionId: "tech-allowance", quoteRef: "quote:2" }), "k2").state).toBe("awaiting-approval");
    w.quote({ quoteRef: "quote:3", itemMinor: 39900, creatorFundedMinor: 12000, taxMinor: 2000 });
    const upgrade = w.repo.prepare(w.request({ quoteRef: "quote:3" }), "k3");
    expect(upgrade).toMatchObject({ state: "awaiting-approval", money: { creatorFundedMinor: 12000, fardaQuotedMinor: 29900, capMinor: 30000 } });
  });
  it("RW-K02 binds copy to the approved allowance or trip, never to a retail value or an unlimited promise", () => {
    const w = world();
    w.entitle(); w.quote({ optionId: "tech-allowance", itemMinor: 30000, taxMinor: 0 });
    const allowance = w.repo.prepare(w.request({ optionId: "tech-allowance" }), "k1");
    expect(allowance.promise).toBe("$300 all-in allowance toward a tech accessory of the creator's choice");
    w.entitle({ entitlementRef: "entitlement:trip", milestone: "vacation", amountMinor: 500000 });
    w.quote({ quoteRef: "quote:trip", optionId: "trip", providerRef: "provider:travel", itemMinor: 450000, taxMinor: 0, bookingMinor: 30000 });
    const trip = w.repo.prepare(w.request({ entitlementRef: "entitlement:trip", optionId: "trip", quoteRef: "quote:trip" }), "k2");
    expect(trip.promise).toBe("$5,000 toward a trip for two, with destination and dates chosen by the creator; flights, accommodation and experiences stay within that total");
    for (const text of [allowance.promise, trip.promise]) expect(text).not.toMatch(/worth|retail|unlimited|luxury|guarantee/i);
  });
  it("RW-K03 keeps the qualified and details-complete clocks apart and never forfeits a late redemption", () => {
    const w = world();
    w.entitle(); w.quote();
    const waiting = w.repo.prepare(w.request({ detailsCompleteAt: null }), "k1");
    expect(waiting).toMatchObject({ state: "awaiting-details", clock: { qualifiedAt: "2026-11-01T00:00:00Z", detailsCompleteAt: null, initiateBy: null, overdue: false },
      money: { outstandingLiabilityMinor: 30000 } });
    at("2026-11-06T13:00:00Z");
    const complete = w.repo.prepare(w.request({ detailsCompleteAt: "2026-11-06T12:30:00Z" }), "k2");
    expect(complete.clock.initiateBy).toBe("2026-12-06T12:30:00.000Z");
    at("2026-12-10T00:00:00Z");
    const late = w.repo.read(complete.redemptionId)!;
    expect(late).toMatchObject({ clock: { overdue: true }, money: { outstandingLiabilityMinor: 30000 } });
    expect(late.heldReasons).toContain("INITIATION_OVERDUE");
    expect(late.state).toBe("awaiting-approval");
  });
  it("shows an unknown creator-funded amount as null, not zero, when there is no quote", () => {
    const w = world();
    w.entitle();
    expect(w.repo.prepare(w.request(), "k").money).toMatchObject({ fardaQuotedMinor: null, creatorFundedMinor: null });
  });
  it("RW-K04 covers an unavailable reward, an all-in overrun and a delayed booking without a purchase", async () => {
    const w = world();
    w.entitle(); w.quote({ available: false });
    const unavailable = w.repo.prepare(w.request(), "k1");
    expect(unavailable).toMatchObject({ state: "held", availability: "unavailable" });
    expect(unavailable.heldReasons).toContain("REWARD_UNAVAILABLE");
    await expect(w.repo.purchase(unavailable.redemptionId, "p")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(w.executor.calls).toBe(0);
    expect(unavailable.sourceEffects).toBe("none");
  });
});

describe("authority across redemption and recovery", () => {
  it("requires a positive current J04 approval on the actual purchase, even after a recorded approval", async () => {
    const w = world(), id = approved(w);
    const decision = w.repo.read(id)!.receipts.decisionRef!;
    w.decisions.set(decision, { ...w.decisions.get(decision) as object, decision: "rejected" });
    expect(w.repo.read(id)!.availability).toBe("unavailable");
    await expect(w.repo.purchase(id, "buy")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(w.executor.calls).toBe(0);
  });
  it("refuses an expired request even while its quote and decision remain current", async () => {
    const w = world(); w.entitle(); w.quote();
    const p = w.repo.prepare(w.request({expiresAt:"2026-11-06T13:00:00Z"}), "prepare");
    w.repo.decide(p.redemptionId, w.approve(p.redemptionId, 1, p.requestHash), "approve");
    at("2026-11-06T13:00:00Z");
    await expect(w.repo.purchase(p.redemptionId, "buy")).rejects.toThrow("REQUEST_EXPIRED");
    expect(w.executor.calls).toBe(0);
  });
  it.each(["creatorId","programRef","rewardVersion","sourceRef"] as const)("holds a changed J11 %s before purchase", async field => {
    const w = world(), id = approved(w);
    w.entitle({[field]:"different-source"});
    await expect(w.repo.purchase(id,"buy")).rejects.toThrow("ENTITLEMENT_CHANGED");
    expect(w.executor.calls).toBe(0);
  });
  it("keeps pending approval and changed policy unavailable", async () => {
    const w = world(); w.entitle(); w.quote();
    const p = w.repo.prepare(w.request(),"prepare");
    expect(p.availability).toBe("unavailable");
    w.repo.decide(p.redemptionId,w.approve(p.redemptionId,1,p.requestHash),"decide");
    w.policy.adoptionRef="other-adoption";
    await expect(w.repo.purchase(p.redemptionId,"buy")).rejects.toThrow("REWARD_TERMS_CHANGED");
    expect(w.executor.calls).toBe(0);
  });
  it("never retries on unreadable provider history or a J11 reversal", async () => {
    const w = world(), id=approved(w); w.executor.fail="after";
    expect((await w.repo.purchase(id,"buy")).state).toBe("uncertain");
    w.authority.executor = { purchase:w.executor.purchase.bind(w.executor),read:()=>({state:"forbidden"}) };
    expect((await w.repo.purchase(id,"recover")).state).toBe("uncertain");
    expect(w.executor.calls).toBe(1);
    w.purchases.clear(); w.entitle({state:"reversed"}); w.authority.executor=w.executor;
    await expect(w.repo.purchase(id,"recover-again")).rejects.toThrow("ENTITLEMENT_CHANGED");
    expect(w.executor.calls).toBe(1);
  });
  it("rejects malformed times, a delivery older than purchase and a postdated cash receipt", async () => {
    const w = world(); w.entitle(); w.quote();
    expect(()=>w.repo.prepare(w.request({expiresAt:"2026-11-07T12:00:00+99:99"}),"bad-date")).toThrow();
    const p=await purchased(w), order=p.receipts.providerOrderRef!;
    const early=w.outcome(p.redemptionId,order,"delivered");
    Object.assign(w.outcomes.get(early) as object,{occurredAt:"2020-01-01T00:00:00Z"});
    expect(()=>w.repo.recordOutcome(p.redemptionId,early,"early")).toThrow("RECEIPT_OUT_OF_ORDER");
    expect(w.repo.read(p.redemptionId)!.money.outstandingLiabilityMinor).toBe(30_000);
    w.repo.recordOutcome(p.redemptionId,w.outcome(p.redemptionId,order,"delivered"),"delivered");
    w.cash.set("future-cash",{scope,sourceRef:"future-cash",...defaultProvider,providerOrderRef:order,transactionRef:p.receipts.transactionRef,
      paidMinor:26900,refundedMinor:0,currency:"USD",postedAt:"2099-01-01T00:00:00Z"});
    expect(()=>w.repo.reconcile(p.redemptionId,"future-cash","cash")).toThrow("FUTURE_TIMESTAMP");
    expect(w.repo.read(p.redemptionId)!.money.settledCostMinor).toBeNull();
  });
});

describe("redemption receipt fencing", () => {
  it("does not dispatch when J15 reservation is released or the J04 allocation changes",async()=>{
    const w=world();w.entitle();w.quote({optionId:"tech-kit",providerRef:"provider:warehouse"});
    const r=w.repo.prepare(w.request({optionId:"tech-kit"}),"prepare");
    const allocation={scope,sourceRef:"alloc:1",redemptionId:r.redemptionId,requestHash:r.requestHash,revision:r.revision,
      purpose:"creator-reward",optionId:"tech-kit",recipientRef:"recipient:creator-synthetic",state:"reserved",validUntil:"2026-12-01T00:00:00Z"};
    w.allocations.set("alloc:1",allocation);
    const decision=w.approve(r.redemptionId,r.revision,r.requestHash,{physicalAllocationRef:"alloc:1"});
    w.repo.decide(r.redemptionId,decision,"approve");
    w.allocations.set("alloc:1",{...allocation,state:"released"});
    await expect(w.repo.purchase(r.redemptionId,"buy")).rejects.toThrow("PHYSICAL_ALLOCATION_UNVERIFIED");
    w.allocations.set("alloc:1",allocation);
    w.decisions.set(decision,{...w.decisions.get(decision) as object,physicalAllocationRef:null});
    await expect(w.repo.purchase(r.redemptionId,"buy-again")).rejects.toThrow("PHYSICAL_ALLOCATION_CHANGED");
    expect(w.executor.calls).toBe(0);
  });
  it("requires the same entitlement and decision even when the source changes during an awaited negative lookup",async()=>{
    const w=world(),id=approved(w);
    w.executor.fail="before";await w.repo.purchase(id,"first");
    let release!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    w.authority.executor={purchase:w.executor.purchase.bind(w.executor),read:async key=>{await wait;return w.executor.read(key);}};
    const recovery=w.repo.purchase(id,"recover");
    w.entitle({state:"reversed"});release();
    await expect(recovery).rejects.toThrow("ENTITLEMENT_CHANGED");
    expect(w.repo.read(id)!.state).toBe("uncertain");
    expect(w.executor.calls).toBe(1);
  });
  it("fences a stopped lookup from dispatch after a newer worker recovers its lease",async()=>{
    const w=world(),id=approved(w);
    w.executor.fail="before";await w.repo.purchase(id,"first");
    let release!:()=>void;let reads=0;
    const wait=new Promise<void>(resolve=>{release=resolve;});
    w.authority.executor={purchase:w.executor.purchase.bind(w.executor),read:async key=>{
      const absence=w.executor.read(key);
      if (++reads===1) await wait;
      return absence;
    }};
    const late=w.repo.purchase(id,"stopped");
    at("2026-11-06T12:06:00Z");
    expect((await w.repo.purchase(id,"recovered")).state).toBe("purchased");
    release();
    await expect(late).rejects.toThrow("PURCHASE_LEASE_CHANGED");
    expect(w.executor.calls).toBe(2);
    expect(w.purchases.size).toBe(1);
  });
  it("recovers positive provider proof after entitlement reversal without attempting another purchase",async()=>{
    const w=world(),id=approved(w);
    w.executor.fail="after";await w.repo.purchase(id,"first");
    w.entitle({state:"reversed"});
    const recovered=await w.repo.purchase(id,"reconcile");
    expect(recovered.state).toBe("purchased");
    expect((await w.repo.purchase(id,"first")).receipts).toEqual(recovered.receipts);
    expect(w.executor.calls).toBe(1);
  });
  it("keeps an in-transit reward reserved after a full refund until the provider confirms a failed or returned delivery",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    w.repo.recordOutcome(id,w.outcome(id,order,"shipped"),"ship");
    w.repo.recordOutcome(id,w.outcome(id,order,"refunded",26900),"refund");
    expect(w.repo.activeFor(p.entitlementRef)?.redemptionId).toBe(id);
    expect(()=>w.repo.prepare(w.request(),"other")).toThrow("REDEMPTION_ALREADY_IN_PROGRESS");
    const returned=w.repo.recordOutcome(id,w.outcome(id,order,"returned"),"return");
    expect(returned.money.outstandingLiabilityMinor).toBe(30_000);
    expect(w.repo.activeFor(p.entitlementRef)).toBeNull();
  });
  it("can record a physically returned item after cash was fully refunded and reconciled",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    w.repo.recordOutcome(id,w.outcome(id,order,"delivered"),"deliver");
    w.repo.recordOutcome(id,w.outcome(id,order,"refunded",26900),"refund");
    w.cash.set("posted",{scope,sourceRef:"posted",...defaultProvider,providerOrderRef:order,transactionRef:p.receipts.transactionRef,
      paidMinor:26900,refundedMinor:26900,currency:"USD",postedAt:clock.toISOString()});
    w.repo.reconcile(id,"posted","reconcile");
    w.repo.recordOutcome(id,w.outcome(id,order,"returned"),"return");
    expect(w.repo.activeFor(p.entitlementRef)).toBeNull();
  });
  it("rejects a changed outcome under a previously applied receipt reference",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    const ref=w.outcome(id,order,"refunded",100);
    w.repo.recordOutcome(id,ref,"partial");
    Object.assign(w.outcomes.get(ref) as object,{refundMinor:200});
    expect(()=>w.repo.recordOutcome(id,ref,"changed")).toThrow("RECEIPT_BASIS_CHANGED");
    expect(w.repo.read(id)!.money.refundedMinor).toBe(100);
  });
  it("does not reserve a mature milestone twice under a second entitlement alias",()=>{
    const w=world(); approved(w);
    w.entitle({entitlementRef:"entitlement:alias"});
    expect(()=>w.repo.prepare(w.request({entitlementRef:"entitlement:alias"}),"alias")).toThrow("MILESTONE_ALREADY_RESERVED");
  });
  it("does not accept fulfilled or future-qualified J11 facts",()=>{
    const w=world();w.quote();w.entitle({fulfilled:true});
    expect(()=>w.repo.prepare(w.request(),"fulfilled")).toThrow("ENTITLEMENT_NOT_REDEEMABLE");
    w.entitle({qualifiedAt:"2099-01-01T00:00:00Z"});
    expect(()=>w.repo.prepare(w.request(),"future")).toThrow("ENTITLEMENT_NOT_REDEEMABLE");
  });
});

describe("reward routes and the authenticated service", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });
  it("maps errors to not-applied responses and needs the reviewer role to write", async () => {
    const w = world();
    w.entitle(); w.quote();
    const call = (path: string, body?: unknown, role: "reviewer" | "reader" = "reviewer", key = "k") =>
      handleRewardRoute({ method: body === undefined ? "GET" : "POST", path, role, body, idempotencyKey: key }, w.repo);
    expect(await call("/v1/rewards/redemptions", w.request(), "reader")).toMatchObject({ status: 403 });
    expect(await call("/v1/rewards/redemptions", {})).toMatchObject({ status: 422, body: { executionCertainty: "notApplied" } });
    const created = await call("/v1/rewards/redemptions", w.request());
    expect(created).toMatchObject({ status: 200, body: { state: "awaiting-approval" } });
    const id = (created!.body as { redemptionId: string }).redemptionId;
    expect(await call(`/v1/rewards/redemptions/${id}/purchase`, {}, "reviewer", "p")).toMatchObject({ status: 409, body: { code: "J04_APPROVAL_REQUIRED" } });
    expect(await call(`/v1/rewards/redemptions/${id}/decisions`, { decisionRef: "j04:missing" }, "reviewer", "d")).toMatchObject({ status: 503 });
    expect(await call(`/v1/rewards/redemptions/${id}`)).toMatchObject({ status: 200 });
    expect(await call("/v1/rewards/entitlements/entitlement:tech-1/redemption")).toMatchObject({ status: 200, body: { redemptionId: id } });
    expect(await handleRewardRoute({ method: "GET", path: "/v1/offers/x", role: "reader" }, w.repo)).toBeNull();
  });
  it("keeps an ambiguous HTTP purchase uncertain across recovery and records the one confirmed provider order",async()=>{
    vi.useFakeTimers({toFake:["Date"]});
    const w=world();vi.setSystemTime(clock);w.entitle();w.quote();
    try {
      app=createAgentServer({databasePath:":memory:",readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,...scope,rewardAuthority:w.authority});
      await new Promise<void>(resolve=>app!.server.listen(0,"127.0.0.1",resolve));
      const address=app.server.address();
      if (!address || typeof address==="string") throw new Error("Expected local server");
      const post=async(path:string,body:unknown,key:string,reviewer=true)=>{
        const r=await fetch(`http://127.0.0.1:${address.port}/v1/rewards/redemptions`+path,{method:"POST",headers:{
          authorization:"Bearer "+(reviewer?SYNTHETIC_REVIEW_TOKEN:SYNTHETIC_READ_TOKEN),"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
        return {status:r.status,data:await r.json()};
      };
      expect((await post("",w.request(),"reader",false)).status).toBe(403);
      const p=(await post("",w.request(),"prepare")).data;
      expect(p).toMatchObject({state:"awaiting-approval",availability:"unavailable"});
      const decision=w.approve(p.redemptionId,p.revision,p.requestHash),prefix="/"+p.redemptionId;
      expect((await post(prefix+"/decisions",{decisionRef:decision},"approve")).data.availability).toBe("executable");
      w.executor.fail="after";
      expect((await post(prefix+"/purchase",{},"attempt")).data).toMatchObject({state:"uncertain",availability:"unavailable"});
      w.authority.executor=undefined;
      expect(await post(prefix+"/purchase",{},"missing-executor")).toMatchObject({status:409,
        data:{code:"PURCHASE_EXECUTOR_UNAVAILABLE",executionCertainty:"uncertain"}});
      expect(w.executor.calls).toBe(1);
      w.authority.executor={purchase:w.executor.purchase.bind(w.executor),read:()=>({state:"denied"})};
      expect((await post(prefix+"/purchase",{},"reconcile")).data).toMatchObject({state:"uncertain"});
      expect(w.executor.calls).toBe(1);
      w.authority.executor=w.executor;
      const recovered=(await post(prefix+"/purchase",{},"reconcile-found")).data;
      expect(recovered).toMatchObject({state:"purchased",availability:"unavailable",money:{chargedMinor:26900},receipts:{...defaultProvider,transactionRef:expect.any(String)}});
      expect((await post(prefix+"/purchase",{},"attempt")).data.receipts).toEqual(recovered.receipts);
      expect(w.executor.calls).toBe(1);
      at("2026-11-06T12:03:00Z");vi.setSystemTime(clock);
      const refund={scope,...defaultProvider,sourceRef:"http-refund",redemptionId:p.redemptionId,providerOrderRef:recovered.receipts.providerOrderRef,
        kind:"refunded",refundMinor:1000,occurredAt:clock.toISOString()};
      w.outcomes.set("http-refund",{...refund,providerBindingRef:"wrong-account"});
      expect(await post(prefix+"/outcomes",{sourceRef:"http-refund"},"wrong-account")).toMatchObject({status:503,
        data:{code:"OUTCOME_UNVERIFIED",executionCertainty:"notApplied"}});
      w.outcomes.set("http-refund",refund);
      expect((await post(prefix+"/outcomes",{sourceRef:"http-refund"},"refund")).data.money.refundedMinor).toBe(1000);
      w.outcomes.set("http-shipped",{...refund,sourceRef:"http-shipped",kind:"shipped",refundMinor:0,occurredAt:"2026-11-06T12:01:00Z"});
      expect(await post(prefix+"/outcomes",{sourceRef:"http-shipped"},"delayed-shipment")).toMatchObject({status:200,
        data:{state:"shipped",money:{refundedMinor:1000},receipts:{...defaultProvider}}});
    } finally {vi.useRealTimers();w.store.close();}
  });
  it("serves reward routes through the HTTP service with the reviewer credential", async () => {
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...scope,
      rewardAuthority: { entitlement: () => null } });
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const post = (token: string) => fetch(`http://127.0.0.1:${address.port}/v1/rewards/redemptions`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "http-1" },
      body: JSON.stringify({ entitlementRef: "entitlement:x", optionId: "o", quoteRef: "q", recipientRef: "r", detailsCompleteAt: null, expiresAt: "2099-01-01T00:00:00Z" }) });
    expect((await post(SYNTHETIC_READ_TOKEN)).status).toBe(403);
    const res = await post(SYNTHETIC_REVIEW_TOKEN);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "ENTITLEMENT_UNVERIFIED", executionCertainty: "notApplied",
      message: "The service could not complete the request.", requestId: null, correlationId: expect.any(String), retryable: true, retryAfterMs: null });
  });
});

// Independent review regressions: event occurrence order is separate from receipt arrival order.
describe("independent physical and financial receipt clocks", () => {
  it.each(["refund-before-shipment", "delivery-before-refund", "later-refund-first"])("accepts valid delayed %s evidence exactly once", async scenario => {
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    at("2026-11-06T12:03:00Z");
    const firstKind=scenario==="delivery-before-refund" ? "delivered" : "refunded";
    w.repo.recordOutcome(id,w.outcome(id,order,firstKind,firstKind==="refunded"?1000:0),"first-event");
    const nextKind=scenario==="refund-before-shipment"?"shipped":"refunded";
    const delayed=w.outcome(id,order,nextKind,nextKind==="refunded"?2000:0);
    Object.assign(w.outcomes.get(delayed) as object,{occurredAt:"2026-11-06T12:01:00Z"});
    const result=w.repo.recordOutcome(id,delayed,"delayed-event");
    const total=scenario==="refund-before-shipment"?1000:scenario==="delivery-before-refund"?2000:3000;
    expect(result.money.refundedMinor).toBe(total);
    expect(result.state).toBe(scenario==="refund-before-shipment"?"shipped":scenario==="delivery-before-refund"?"delivered":"purchased");
    expect(w.repo.recordOutcome(id,delayed,"repeat-delayed-event").money.refundedMinor).toBe(total);
    expect(w.repo.read(id)!.receipts.outcomeRefs).toHaveLength(2);
  });
});

describe("independent receipt clock boundaries",()=>{
  it("keeps the latest refund occurrence as the cash lower bound after an older refund arrives",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    at("2026-11-06T12:04:00Z");
    const later=w.outcome(id,order,"refunded",1000);
    Object.assign(w.outcomes.get(later) as object,{occurredAt:"2026-11-06T12:03:00Z"});
    w.repo.recordOutcome(id,later,"later");
    const earlier=w.outcome(id,order,"refunded",2000);
    Object.assign(w.outcomes.get(earlier) as object,{occurredAt:"2026-11-06T12:01:00Z"});
    w.repo.recordOutcome(id,earlier,"earlier");
    const delivered=w.outcome(id,order,"delivered");
    Object.assign(w.outcomes.get(delivered) as object,{occurredAt:"2026-11-06T12:02:00Z"});
    w.repo.recordOutcome(id,delivered,"delivery");
    const cash={scope,...defaultProvider,providerOrderRef:order,transactionRef:p.receipts.transactionRef,paidMinor:26900,refundedMinor:3000,currency:"USD"};
    w.cash.set("cash-too-early",{...cash,sourceRef:"cash-too-early",postedAt:"2026-11-06T12:02:00Z"});
    expect(()=>w.repo.reconcile(id,"cash-too-early","early-cash")).toThrow("RECEIPT_OUT_OF_ORDER");
    w.cash.set("cash-current",{...cash,sourceRef:"cash-current",postedAt:"2026-11-06T12:03:00Z"});
    expect(w.repo.reconcile(id,"cash-current","current-cash").money.settledCostMinor).toBe(23900);
    expect(w.repo.recordOutcome(id,earlier,"earlier-replay").money.refundedMinor).toBe(3000);
    expect(w.repo.read(id)!.receipts.outcomeRefs).toHaveLength(3);
  });
  it("still refuses physical time regression, state regression, pre-purchase refunds and future refunds",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    at("2026-11-06T12:04:00Z");
    w.repo.recordOutcome(id,w.outcome(id,order,"shipped"),"ship");
    const old=w.outcome(id,order,"delivered");
    Object.assign(w.outcomes.get(old) as object,{occurredAt:"2026-11-06T12:03:00Z"});
    expect(()=>w.repo.recordOutcome(id,old,"old-delivery")).toThrow("RECEIPT_OUT_OF_ORDER");
    w.repo.recordOutcome(id,w.outcome(id,order,"delivered"),"deliver");
    at("2026-11-06T12:05:00Z");
    expect(()=>w.repo.recordOutcome(id,w.outcome(id,order,"shipped"),"regression")).toThrow("OUTCOME_OUT_OF_ORDER");
    for (const [when,error] of [["2026-11-06T11:59:59Z","RECEIPT_OUT_OF_ORDER"],["2026-11-06T12:05:01Z","FUTURE_TIMESTAMP"]]) {
      const bad=w.outcome(id,order,"refunded",100);
      Object.assign(w.outcomes.get(bad) as object,{occurredAt:when});
      expect(()=>w.repo.recordOutcome(id,bad,"invalid-"+when)).toThrow(error);
    }
    expect(w.repo.read(id)!.money.refundedMinor).toBe(0);
    expect(w.repo.read(id)!.receipts.outcomeRefs).toHaveLength(2);
  });
  it("holds missing legacy physical clocks without rewriting history or blocking independently valid refund evidence",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    w.repo.recordOutcome(id,w.outcome(id,order,"shipped"),"ship");
    const history=w.repo.read(id)!.history;
    w.store.database.prepare("UPDATE reward_redemptions SET body=json_remove(body,'$.physicalAt','$.physicalState') WHERE redemption_id=?").run(id);
    expect(()=>w.repo.recordOutcome(id,w.outcome(id,order,"delivered"),"unknown-clock")).toThrow("PHYSICAL_TIME_UNVERIFIED");
    expect(w.repo.read(id)!.history).toEqual(history);
    expect(w.repo.recordOutcome(id,w.outcome(id,order,"refunded",100),"valid-refund").money.refundedMinor).toBe(100);
    w.store.database.prepare("UPDATE reward_redemptions SET body=json_remove(body,'$.purchasedAt') WHERE redemption_id=?").run(id);
    expect(()=>w.repo.recordOutcome(id,w.outcome(id,order,"refunded",100),"unknown-purchase")).toThrow("PURCHASE_TIME_UNVERIFIED");
    expect(w.repo.read(id)!.money.refundedMinor).toBe(100);
  });
});

describe("provider and bound-account receipt namespaces",()=>{
  async function buyPair(kind:"different-provider"|"different-account"|"same-account") {
    const w=world();
    w.authority.executor={read:w.executor.read.bind(w.executor),purchase:async(key,raw)=>{
      const manifest=raw as {providerRef:string;providerBindingRef:string};
      const receipt={purchaseKey:key,...manifest,providerOrderRef:"local-order-1",transactionRef:"local-transaction-1",chargedMinor:26900,currency:"USD" as const,purchasedAt:clock.toISOString()};
      // A provider receipt only contains the verified provider identity, never the arbitrary executor manifest fields.
      const result={purchaseKey:key,providerRef:receipt.providerRef,providerBindingRef:receipt.providerBindingRef,
        providerOrderRef:receipt.providerOrderRef,transactionRef:receipt.transactionRef,chargedMinor:receipt.chargedMinor,currency:receipt.currency,purchasedAt:receipt.purchasedAt};
      w.purchases.set(key,result);return result;
    }};
    const first=await purchased(w);
    const differentProvider=kind==="different-provider", providerRef=differentProvider?"provider:travel":"provider:retail";
    if (kind==="different-account") w.providers.set(providerRef,{state:"Ready",fundingVerified:true,ownerRef:"owner:ops",bindingRef:"binding:2"});
    const optionId=differentProvider?"trip":"tech-earbuds";
    w.entitle({entitlementRef:"entitlement:second",sourceRef:"j11:second",creatorId:"creator-second",milestone:differentProvider?"vacation":"tech"});
    w.quote({quoteRef:"quote:second",providerRef,optionId});
    const prepared=w.repo.prepare(w.request({entitlementRef:"entitlement:second",quoteRef:"quote:second",optionId,recipientRef:"recipient:second"}),"prepare-second");
    w.repo.decide(prepared.redemptionId,w.approve(prepared.redemptionId,prepared.revision,prepared.requestHash),"approve-second");
    const second=await w.repo.purchase(prepared.redemptionId,"purchase-second");
    return {w,first,second};
  }
  it.each(["different-provider","different-account"] as const)("accepts identical native IDs across %s through purchase, outcome and cash",async kind=>{
    const {w,first,second}=await buyPair(kind);
    expect([first.state,second.state]).toEqual(["purchased","purchased"]);
    expect(first.receipts.providerOrderRef).toBe(second.receipts.providerOrderRef);
    const source=new Map<string,unknown>(),key=(ref:string,identity:RewardProviderIdentity)=>JSON.stringify([ref,identity.providerRef,identity.providerBindingRef]);
    w.authority.outcome=(ref,_scope,identity)=>source.get(key(ref,identity));
    w.authority.cashMovement=(ref,_scope,identity)=>source.get(key(ref,identity));
    for (const p of [first,second]) {
      const identity={providerRef:p.receipts.providerRef!,providerBindingRef:p.receipts.providerBindingRef!};
      source.set(key("native-outcome-1",identity),{scope,...identity,sourceRef:"native-outcome-1",redemptionId:p.redemptionId,providerOrderRef:p.receipts.providerOrderRef,
        kind:"delivered",refundMinor:0,occurredAt:clock.toISOString()});
      expect(w.repo.recordOutcome(p.redemptionId,"native-outcome-1","delivery-"+p.redemptionId).state).toBe("delivered");
      source.set(key("native-cash-1",identity),{scope,...identity,sourceRef:"native-cash-1",providerOrderRef:p.receipts.providerOrderRef,transactionRef:p.receipts.transactionRef,
        paidMinor:26900,refundedMinor:0,currency:"USD",postedAt:clock.toISOString()});
      expect(w.repo.reconcile(p.redemptionId,"native-cash-1","cash-"+p.redemptionId).money.settledCostMinor).toBe(26900);
    }
    const claims=w.store.database.prepare("SELECT COUNT(*) AS n FROM reward_receipts WHERE kind IN ('purchase','outcome','cash')").get();
    expect(claims!.n).toBe(6);
    expect(w.repo.recordOutcome(first.redemptionId,"native-outcome-1","replay-outcome").receipts.outcomeRefs).toEqual(["native-outcome-1"]);
    expect(w.repo.reconcile(second.redemptionId,"native-cash-1","replay-cash").receipts.cashRefs).toEqual(["native-cash-1"]);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM reward_receipts WHERE kind IN ('purchase','outcome','cash')").get()!.n).toBe(6);
  });
  it("holds reuse of an order or transaction inside the same provider account",async()=>{
    const {w,first,second}=await buyPair("same-account");
    expect(first.state).toBe("purchased");
    expect(second).toMatchObject({state:"uncertain",heldReasons:["PURCHASE_RECEIPT_REUSED"]});
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM reward_receipts WHERE kind='purchase'").get()!.n).toBe(1);
  });
  it.each(["providerRef","providerBindingRef"] as const)("refuses mismatched %s in outcome and cash receipts, including source replay",async field=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    const deliver=w.outcome(id,order,"delivered");
    const original={...w.outcomes.get(deliver) as object};
    w.outcomes.set(deliver,{...original,[field]:"wrong-provider-or-account"});
    expect(()=>w.repo.recordOutcome(id,deliver,"wrong-outcome")).toThrow("OUTCOME_UNVERIFIED");
    w.outcomes.set(deliver,original);
    w.repo.recordOutcome(id,deliver,"delivery");
    w.outcomes.set(deliver,{...original,[field]:"wrong-provider-or-account"});
    expect(()=>w.repo.recordOutcome(id,deliver,"wrong-replay")).toThrow("OUTCOME_UNVERIFIED");
    const cash={scope,...defaultProvider,sourceRef:"native-cash",providerOrderRef:order,transactionRef:p.receipts.transactionRef,
      paidMinor:26900,refundedMinor:0,currency:"USD",postedAt:clock.toISOString()};
    w.cash.set("native-cash",{...cash,[field]:"wrong-provider-or-account"});
    expect(()=>w.repo.reconcile(id,"native-cash","wrong-cash")).toThrow("CASH_MOVEMENT_UNVERIFIED");
    w.cash.set("native-cash",cash);w.repo.reconcile(id,"native-cash","cash");
    w.cash.set("native-cash",{...cash,[field]:"wrong-provider-or-account"});
    expect(()=>w.repo.reconcile(id,"native-cash","wrong-cash-replay")).toThrow("CASH_MOVEMENT_UNVERIFIED");
    expect(w.repo.read(id)!.money.settledCostMinor).toBe(26900);
  });
  it.each(["providerRef","providerBindingRef"] as const)("requires the same %s in purchase receipts and negative recovery proof",async field=>{
    const w=world(),id=approved(w),purchase=w.executor.purchase.bind(w.executor);
    w.authority.executor={read:w.executor.read.bind(w.executor),purchase:async(key,manifest)=>({...await purchase(key,manifest as Parameters<typeof purchase>[1]),[field]:"wrong-provider-or-account"})};
    expect((await w.repo.purchase(id,"wrong-purchase")).state).toBe("uncertain");
    w.purchases.clear();
    w.authority.executor={purchase,read:(key,identity)=>({state:"notFound",purchaseKey:key,...identity,[field]:"wrong-provider-or-account",sourceRef:"absence",checkedAt:clock.toISOString()})};
    expect((await w.repo.purchase(id,"wrong-absence")).heldReasons).toContain("PURCHASE_READBACK_UNVERIFIED");
    expect(w.executor.calls).toBe(1);
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM reward_receipts WHERE kind='purchase'").get()!.n).toBe(0);
  });
});

describe("immutable legacy reward receipt claims",()=>{
  it("validates an enriched replay against the original legacy hash without duplicating or rewriting the receipt",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    const outcome=w.outcome(id,order,"refunded",100);
    w.repo.recordOutcome(id,outcome,"refund");
    const current=w.outcomes.get(outcome) as Record<string,unknown>,legacy={...current};
    delete legacy.providerRef;delete legacy.providerBindingRef;
    const row=w.store.database.prepare("SELECT source_ref FROM reward_receipts WHERE redemption_id=? AND kind='outcome'").get(id)!;
    w.store.database.prepare("UPDATE reward_receipts SET source_ref=? WHERE source_ref=?").run(outcome,String(row.source_ref));
    w.store.database.prepare("UPDATE reward_receipt_bases SET source_ref=?,receipt_hash=? WHERE source_ref=?").run(outcome,digest(legacy),String(row.source_ref));
    const before=w.repo.read(id)!.history;
    expect(w.repo.recordOutcome(id,outcome,"legacy-new-key").money.refundedMinor).toBe(100);
    expect(w.repo.read(id)!.history).toEqual(before);
    expect(w.store.database.prepare("SELECT * FROM reward_receipt_bases WHERE source_ref=?").get(outcome)!.receipt_hash).toBe(digest(legacy));
    expect(w.store.database.prepare("SELECT COUNT(*) AS n FROM reward_receipts WHERE kind='outcome'").get()!.n).toBe(1);
    w.outcomes.set(outcome,{...current,refundMinor:200});
    expect(()=>w.repo.recordOutcome(id,outcome,"legacy-changed")).toThrow("RECEIPT_BASIS_CHANGED");
    expect(w.repo.read(id)!.money.refundedMinor).toBe(100);
  });
  it("retains exact command replays and readable history when legacy provider binding is unknown, but holds new receipt validation",async()=>{
    const w=world(),p=await purchased(w),id=p.redemptionId,order=p.receipts.providerOrderRef!;
    const outcome=w.outcome(id,order,"delivered");w.repo.recordOutcome(id,outcome,"delivered");
    w.store.database.prepare("UPDATE reward_redemptions SET body=json_remove(body,'$.providerBindingRef') WHERE redemption_id=?").run(id);
    const historical=w.repo.read(id)!;
    expect(historical.receipts.providerBindingRef).toBeNull();
    expect(w.repo.recordOutcome(id,outcome,"delivered").history).toEqual(historical.history);
    expect(()=>w.repo.recordOutcome(id,outcome,"new-key")).toThrow("PROVIDER_RECEIPT_NAMESPACE_UNVERIFIED");
    expect(w.repo.read(id)!.history).toEqual(historical.history);
  });
});
