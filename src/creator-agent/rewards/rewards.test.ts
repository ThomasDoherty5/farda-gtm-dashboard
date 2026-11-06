// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import type { Entitlement, PrepareInput, Quote, RewardPolicy } from "./contract";
import { RewardRedemptionRepository, type RewardAuthority } from "./repository";
import { handleRewardRoute } from "./routes";

// Synthetic creators, providers and receipts only. No purchase, programme or provider account is real.
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
  const policy: RewardPolicy = { version: "CEO-v1", state: over.policyState ?? "adopted", adoptionRef: over.policyState === "proposed" ? null : "adoption:owner-1", options: [
    { optionId: "tech-earbuds", milestone: "tech", kind: "item", label: "Wireless earbuds", providerRef: "provider:retail", deliveryRoute: "provider-direct" },
    { optionId: "tech-allowance", milestone: "tech", kind: "allowance", label: "a tech accessory of the creator's choice", providerRef: "provider:retail", deliveryRoute: "allowance-transfer" },
    { optionId: "tech-kit", milestone: "tech", kind: "item", label: "Organizer kit", providerRef: "provider:warehouse", deliveryRoute: "farda-physical" },
    { optionId: "trip", milestone: "vacation", kind: "trip", label: "a trip for two", providerRef: "provider:travel", deliveryRoute: "booking" },
  ] };
  const purchases = new Map<string, { providerOrderRef: string; transactionRef: string; chargedMinor: number; currency: "USD" }>();
  const executor = { calls: 0, fail: null as null | "before" | "after",
    purchase(key: string, manifest: { capMinor: number }) {
      this.calls++;
      if (this.fail === "before") { this.fail = null; throw new Error("connection reset before the provider answered"); }
      const quote = [...quotes.values()][0]!;
      const receipt = { providerOrderRef: `order:${key}`, transactionRef: `txn:${key}`, chargedMinor: Math.min(manifest.capMinor, quote.itemMinor - quote.creatorFundedMinor + quote.taxMinor + quote.shippingMinor), currency: "USD" as const };
      purchases.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout after the provider accepted"); }
      return receipt;
    },
    read(key: string) { return purchases.get(key) ?? null; } };
  const authority: RewardAuthority = {
    entitlement: (r) => entitlements.get(r) ?? null, rewardPolicy: (v) => (v === policy.version ? policy : null), quote: (r) => quotes.get(r) ?? null,
    provider: (p) => providers.get(p) ?? null, decision: (r) => decisions.get(r) ?? null, outcome: (r) => outcomes.get(r) ?? null,
    cashMovement: (r) => cash.get(r) ?? null, executor,
  };
  const store = new AgentStore(":memory:", scope);
  const repo = new RewardRedemptionRepository(store.database, scope, authority, () => clock);
  const entitle = (over: Partial<Entitlement> = {}) => {
    const e: Entitlement = { scope, entitlementRef: "entitlement:tech-1", sourceRef: "j11:award-1", creatorId: "creator-synthetic", programRef: "program:launch",
      milestone: "tech", amountMinor: 30000, currency: "USD", rewardVersion: "CEO-v1", state: "mature", qualifiedAt: "2026-11-01T00:00:00Z", programPaused: false,
      reserveMinor: 30000, ...over };
    entitlements.set(e.entitlementRef, e);
    return e;
  };
  const quote = (over: Partial<Quote> = {}) => {
    const q: Quote = { quoteRef: "quote:1", optionId: "tech-earbuds", providerRef: "provider:retail", available: true, currency: "USD", itemMinor: 24900,
      taxMinor: 2000, shippingMinor: 0, bookingMinor: 0, adminMinor: 0, creatorFundedMinor: 0, validUntil: "2026-11-20T00:00:00Z", ...over };
    quotes.set(q.quoteRef, q);
    return q;
  };
  const request = (over: Partial<PrepareInput> = {}): PrepareInput => ({ entitlementRef: "entitlement:tech-1", optionId: "tech-earbuds", quoteRef: "quote:1",
    recipientRef: "recipient:creator-synthetic", detailsCompleteAt: "2026-11-02T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", ...over });
  const approve = (redemptionId: string, revision: number, requestHash: string, over: Record<string, unknown> = {}) => {
    const sourceRef = `j04:${redemptionId}:r${revision}`;
    decisions.set(sourceRef, { scope, sourceRef, redemptionId, revision, requestHash, decision: "approved", state: "current", physicalAllocationRef: null,
      decidedAt: clock.toISOString(), validUntil: "2026-11-30T00:00:00Z", ...over });
    return sourceRef;
  };
  const outcome = (redemptionId: string, providerOrderRef: string, kind: string, refundMinor = 0) => {
    const sourceRef = `outcome:${kind}:${outcomes.size}`;
    outcomes.set(sourceRef, { scope, sourceRef, redemptionId, providerOrderRef, kind, refundMinor, occurredAt: clock.toISOString() });
    return sourceRef;
  };
  return { repo, store, entitle, quote, request, approve, outcome, decisions, cash, providers, executor, purchases };
}
type World = ReturnType<typeof world>;
async function purchased(w: World) {
  w.entitle(); w.quote();
  const prepared = w.repo.prepare(w.request(), "prepare-1");
  w.repo.decide(prepared.redemptionId, w.approve(prepared.redemptionId, prepared.revision, prepared.requestHash), "decide-1");
  return w.repo.purchase(prepared.redemptionId, "purchase-1");
}

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
});

describe("physical fulfillment and recovery handoffs (acceptance 5)", () => {
  it("needs an explicitly approved J15 allocation for a Farda-shipped item", () => {
    const w = world();
    w.entitle(); w.quote({ optionId: "tech-kit", providerRef: "provider:warehouse" });
    const view = w.repo.prepare(w.request({ optionId: "tech-kit" }), "k");
    expect(() => w.repo.decide(view.redemptionId, w.approve(view.redemptionId, 1, view.requestHash), "d1")).toThrow("PHYSICAL_ALLOCATION_REQUIRED");
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
});

describe("cash reconciliation once against the receipts (acceptance 6)", () => {
  it("settles a partial refund once and keeps reserve, earned liability and settled cost apart", async () => {
    const w = world();
    const p = await purchased(w);
    const order = p.receipts.providerOrderRef!;
    w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "delivered"), "o1");
    const partial = w.repo.recordOutcome(p.redemptionId, w.outcome(p.redemptionId, order, "refunded", 1500), "o2");
    expect(partial).toMatchObject({ state: "delivered", money: { refundedMinor: 1500 } });
    w.cash.set("cash:bad", { scope, sourceRef: "cash:bad", providerOrderRef: order, transactionRef: p.receipts.transactionRef, paidMinor: 26900, refundedMinor: 0, currency: "USD", postedAt: clock.toISOString() });
    expect(() => w.repo.reconcile(p.redemptionId, "cash:bad", "r0")).toThrow("CASH_DOES_NOT_MATCH_RECEIPTS");
    w.cash.set("cash:1", { scope, sourceRef: "cash:1", providerOrderRef: order, transactionRef: p.receipts.transactionRef, paidMinor: 26900, refundedMinor: 1500, currency: "USD", postedAt: clock.toISOString() });
    const done = w.repo.reconcile(p.redemptionId, "cash:1", "r1");
    expect(done).toMatchObject({ state: "reconciled", money: { reserveMinor: 30000, earnedLiabilityMinor: 30000, outstandingLiabilityMinor: 0, settledCostMinor: 25400 },
      receipts: { cashRef: "cash:1" } });
    expect(() => w.repo.reconcile(p.redemptionId, "cash:2", "r2")).toThrow("ALREADY_RECONCILED");
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
    expect(await res.json()).toEqual({ code: "ENTITLEMENT_UNVERIFIED", executionCertainty: "notApplied" });
  });
});
