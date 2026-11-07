// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import type { CampaignView, Manifest, MutationView, NativeSettings } from "../media/contract";
import { MediaWriteUncertain, PaidMediaRepository, type MediaAuthority } from "../media/repository";
import type { StageInput, StageView } from "./contract";
import { MediaControlUncertain, MediaReleaseController, type MediaControlAuthority } from "./repository";
import { handleMediaControlRoute } from "./routes";

// Synthetic accounts, campaigns, orders, parameters and treasury figures only. Nothing here is a real advertiser, shop, order or balance.
const scope = { workspaceId: "fictional-workspace", accountId: "fictional-account" };
const H = (c: string) => c.repeat(64);
let clock = new Date("2026-11-06T12:00:00Z");
const at = (iso: string) => { clock = new Date(iso); };
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString();
const ahead = (minutes: number) => new Date(clock.getTime() + minutes * 60_000).toISOString();
const META = "adaccount:synthetic-meta", TIKTOK = "adaccount:synthetic-tiktok";
const A = <T>(value: T) => ({ value, state: "adopted", adoptionRef: "decision:owner-economics-v1", adoptedAt: "2026-11-01T00:00:00Z" });
const P = <T>(value: T) => ({ value, state: "proposed", adoptionRef: null, adoptedAt: null });

function settingsFrom(m: Manifest, nativeCampaignId: string): NativeSettings {
  return { nativeCampaignId, provider: m.provider, providerAccountRef: m.account.providerAccountRef, environment: m.environment, identityRef: m.account.identityRef, nativeAdIds: [`native:ad-${nativeCampaignId}`],
    previewRef: `preview:${nativeCampaignId}`, status: "PAUSED", objective: m.objective, optimizationEvent: m.optimizationEvent, currency: m.currency,
    dailyBudgetMinor: m.caps.dailyBudgetMinor, lifetimeBudgetMinor: m.caps.lifetimeBudgetMinor, startAt: m.schedule.startAt, endAt: m.schedule.endAt,
    attributionSetting: m.attributionSetting, destinationRef: m.destinationRef, creativeHashes: m.creatives.map((c) => c.contentHash), markets: m.targeting.markets,
    ageMin: m.targeting.ageMin, ageMax: m.targeting.ageMax, placements: m.targeting.placements, bidStrategy: m.bid.strategy, costCapMinor: m.bid.costCapMinor,
    targetRoasBps: m.bid.targetRoasBps, extraDeliveryBudget: false, maxDelivery: false, autoRecharge: false, placementExpansion: false, receiptOrigin: "synthetic",
    observedAt: clock.toISOString() };
}

function world() {
  clock = new Date("2026-11-06T12:00:00Z");
  // ---- THO-346 synthetic sources ----
  const decisions = new Map<string, unknown>();
  const gates = new Map<string, Record<string, unknown> | null>();
  const native = new Map<string, NativeSettings>();
  const writes = new Map<string, unknown>();
  const executor = {
    calls: { publish: 0, mutate: 0 }, fail: null as null | "before" | "after", mutateFail: null as null | "before" | "after",
    during: null as null | (() => Promise<void>), readHook: null as null | (() => Promise<void>), readBackDown: false,
    mutateHook: null as null | (() => void),
    createDraft(key: string, payload: { manifest: Manifest; nativeCampaignId: string | null }) {
      if (writes.has(key)) return writes.get(key);
      const id = payload.nativeCampaignId ?? `native:campaign-${native.size + 1}`;
      native.set(id, settingsFrom(payload.manifest, id));
      const receipt = { key, nativeCampaignId: id, nativeAdIds: [`native:ad-${id}`], previewRef: `preview:${id}`, receiptRef: `receipt:${key}`, receiptOrigin: "synthetic" };
      writes.set(key, receipt);
      return receipt;
    },
    async publish(key: string, payload: { nativeCampaignId: string }) {
      this.calls.publish++;
      if (this.during) { const f = this.during; this.during = null; await f(); }
      if (this.fail === "before") { this.fail = null; throw new Error("connection reset"); }
      native.get(payload.nativeCampaignId)!.status = "ACTIVE";
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: "synthetic", providerStatus: "ACTIVE", rejectionCode: null };
      writes.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout after the provider accepted"); }
      return receipt;
    },
    mutate(key: string, payload: { nativeCampaignId: string; action: string; dailyBudgetMinor: number | null }) {
      this.calls.mutate++;
      if (this.mutateHook) { const f = this.mutateHook; this.mutateHook = null; f(); }
      if (this.mutateFail === "before") { this.mutateFail = null; throw new Error("connection reset"); }
      const n = native.get(payload.nativeCampaignId)!;
      if (payload.action === "pause") n.status = "PAUSED"; else n.dailyBudgetMinor = payload.dailyBudgetMinor;
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: "synthetic", outcome: "applied", rejectionCode: null };
      writes.set(key, receipt);
      if (this.mutateFail === "after") { this.mutateFail = null; throw new Error("timeout"); }
      return receipt;
    },
    read(key: string) { return writes.get(key) ?? null; },
    readBack(id: string): unknown {
      const current = () => { const n = native.get(id); return n && !this.readBackDown ? { ...n, observedAt: clock.toISOString() } : null; };
      if (this.readHook) { const f = this.readHook; this.readHook = null; return f().then(current); }
      return current();
    },
  };
  const account = (provider: string, providerAccountRef: string) => ({ scope, provider, providerAccountRef, environment: "sandbox", kind: "advertiser",
    businessRef: "business:synthetic", market: "US", currency: "USD", timezone: "America/New_York", identityRef: "identity:synthetic-brand", identityApproved: true,
    sourceRef: "source:account-probe", receiptOrigin: "synthetic", observedAt: "2026-11-06T11:00:00Z" });
  const mediaAuthority: MediaAuthority = {
    account: (p, r) => account(p, r),
    capability: (b) => ({ scope, provider: b.provider, providerAccountRef: b.providerAccountRef, environment: b.environment, operation: b.operation, route: b.route,
      state: b.route === "api" ? "Ready" : "Unsupported", evidence: b.route === "api" ? "account-test" : "documentation", sourceRef: "source:probe",
      toolVersion: "tool:synthetic-1", receiptRef: `receipt:${b.operation}-${b.route}`, receiptOrigin: "synthetic", checkedAt: ago(1), expiresAt: ahead(60 * 24 * 60) }),
    checkout: () => ({ scope, checkoutRef: "checkout:site", kind: "website", skuRef: "sku:duo", destinationRef: "destination:pdp-duo", purchaseEventsVerified: true,
      shopAuthorizationVerified: false, sourceRef: "source:checkout-test", validUntil: "2026-12-31T00:00:00Z" }),
    offer: () => ({ scope, offerRef: "offer:duo", version: "offer-v1", skuRef: "sku:duo", claimsVersion: "claims-v1", state: "approved", validUntil: "2026-12-31T00:00:00Z" }),
    asset: () => ({ scope, assetRef: "asset:clip-1", contentHash: H("a"), claimsVersion: "claims-v1", reviewed: true,
      rights: { rightsRef: "rights:clip-1", rightsHash: H("b"), paidUsage: true, nativePermission: true, expiresAt: "2026-12-31T00:00:00Z" } }),
    gate: (gate, subject) => {
      const over = gates.get(gate);
      if (over === null) return null;
      return { scope, gate, sourceRef: `gate:${gate}:${subject.campaignId}`, campaignId: subject.campaignId, manifestHash: subject.manifestHash, state: "verified",
        verifiedAt: "2026-11-06T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", receiptOrigin: "synthetic", ...over };
    },
    decision: (r) => decisions.get(r) ?? null,
    safetyPolicy: (r) => r === "policy:auto-pause" ? { scope, policyRef: r, state: "current", allows: ["pause"],
      accounts: [{ provider: "meta", providerAccountRef: META, environment: "sandbox" }, { provider: "tiktok", providerAccountRef: TIKTOK, environment: "sandbox" }],
      validUntil: "2026-12-31T00:00:00Z" } : null,
    executor,
  };

  // ---- THO-347 synthetic sources ----
  const params = {
    scope, version: "economics-v1", observedAt: "2026-11-05T00:00:00Z",
    contribution: {
      landedCogsPerUnit: A([{ component: "unit-cost", amountMinor: 4000 }, { component: "tariff", amountMinor: 500 }]) as unknown, fulfillmentPerOrderMinor: A(800),
      paymentFeeBps: A(300), marketplaceFeeBps: A(600), affiliateCommissionBps: P(2000) as unknown, returnAllowanceBps: P(500) as unknown, otherVariablePerOrderMinor: A(100),
    },
    diagnostic: { maxTestLossMinor: A(100_000) as unknown, maxCpaMinor: A(6000) as unknown },
    attributionWindow: A("attribution:7d-click") as unknown,
    minimumEvidence: A({ orders: 3, spendMinor: 10_000, days: 3 }) as unknown,
    reviewCadence: A({ anchorAt: "2026-11-06T12:00:00Z", intervalHours: 24, windowMinutes: 120, learningWindowHours: 72, safetyIntervalMinutes: 15 }) as unknown,
    freshnessMaxAgeMinutes: A(360) as unknown,
    stagePolicy: A([{ ordinal: 1, capMinor: 150_000, maxHeadroomBps: 1000 }, { ordinal: 2, capMinor: 150_000, maxHeadroomBps: 1000 },
      { ordinal: 3, capMinor: 300_000, maxHeadroomBps: 1000 }]) as unknown,
    founderCashCeilingMinor: A(4_000_000) as unknown,
  };
  const stageDecisions = new Map<string, unknown>();
  const spend = new Map<string, number | null>();
  const conversions = new Map<string, unknown[]>();
  const reportOver = new Map<string, Record<string, unknown>>();
  const rowOver = new Map<string, Record<string, unknown>>();
  const health: Record<string, Record<string, unknown>> = {};
  const orders: Record<string, unknown>[] = [];
  const feed = { complete: true, available: true };
  const treasury: Record<string, unknown> = { founderInvestedMinor: 2_500_000, actualCashMinor: 500_000, workingFloatMinor: 100_000, commitmentsMinor: 1_000_000,
    mediaChargedMinor: 0, scheduledPayouts: [], revenueForecastMinor: null };
  const calls = { spendReport: 0 };
  const authority: MediaControlAuthority = {
    parameters: () => params,
    stageDecision: (r) => stageDecisions.get(r) ?? null,
    spendReport: (b) => {
      calls.spendReport++;
      const rows = [...native.values()].filter((n) => n.providerAccountRef === b.providerAccountRef).map((n) => ({
        nativeCampaignId: n.nativeCampaignId, status: n.status, spendMinor: spend.has(n.nativeCampaignId) ? spend.get(n.nativeCampaignId)! : 0,
        lifetimeBudgetMinor: n.lifetimeBudgetMinor, dailyBudgetMinor: n.dailyBudgetMinor, endAt: n.endAt, maxDelivery: n.maxDelivery, autoRecharge: n.autoRecharge,
        extraDeliveryBudget: n.extraDeliveryBudget, includesOrganicAffiliate: false, attributionWindow: "attribution:7d-click",
        conversions: conversions.get(n.nativeCampaignId) ?? [], ...rowOver.get(n.nativeCampaignId) }));
      return { scope, provider: b.provider, providerAccountRef: b.providerAccountRef, environment: b.environment, sourceRef: `report:${b.providerAccountRef}`,
        currency: "USD", sourceUpdatedAt: ago(30), observedAt: ago(20), accountSpendMinor: null, accountSpendLimitMinor: null, campaigns: rows,
        ...reportOver.get(b.providerAccountRef) };
    },
    orders: () => feed.available ? { scope, sourceRef: "orders:canonical", observedAt: ago(10), complete: feed.complete, orders } : null,
    health: (stageRef) => ({ scope, stageRef, sourceRef: "health:synthetic", checks: Object.fromEntries(["stock", "checkout", "rights", "permission", "measurement"]
      .map((c) => [c, { state: "ok", code: null, observedAt: ago(5), validUntil: ahead(24 * 60), ...health[c] }])) }),
    treasury: () => ({ scope, sourceRef: "treasury:synthetic", observedAt: ago(60), ...treasury }),
  };
  const store = new AgentStore(":memory:", scope);
  const media = new PaidMediaRepository(store.database, scope, mediaAuthority, () => clock);
  const control = new MediaReleaseController(store.database, scope, authority, media, () => clock);

  const terms = (over: Partial<StageInput> = {}): StageInput => ({ stageRef: "stage:initial", ordinal: 1, capMinor: 150_000, headroomBps: 1000,
    startAt: "2026-11-06T00:00:00Z", endAt: "2026-12-01T00:00:00Z",
    allocations: [{ provider: "meta", providerAccountRef: META, environment: "sandbox", capMinor: 75_000 },
      { provider: "tiktok", providerAccountRef: TIKTOK, environment: "sandbox", capMinor: 75_000 }], ...over });
  const approveStage = (v: StageView, over: Record<string, unknown> = {}) => {
    const sourceRef = `j04:${v.stageRef}:r${v.revision}:${stageDecisions.size}`;
    stageDecisions.set(sourceRef, { scope, sourceRef, system: "linear", stageRef: v.stageRef, revision: v.revision, action: "release-stage", subjectHash: v.subjectHash,
      decision: "approved", state: "current", decidedAt: clock.toISOString(), validUntil: "2026-12-01T00:00:00Z", ...over });
    return sourceRef;
  };
  const approveMedia = (c: CampaignView, over: Record<string, unknown> = {}) => {
    const sourceRef = `j04:${c.campaignId}:${decisions.size}`;
    decisions.set(sourceRef, { scope, sourceRef, system: "linear", campaignId: c.campaignId, revision: c.revision, action: "publish", manifestHash: c.manifestHash,
      subjectHash: c.releaseHash, decision: "approved", state: "current",
      financialScope: { providerAccountRef: c.manifest!.account.providerAccountRef, campaignRoute: c.campaignRoute, currency: "USD", maxDailyBudgetMinor: 5000,
        maxLifetimeBudgetMinor: 100_000, placements: ["placement:feed"] },
      decidedAt: clock.toISOString(), validUntil: "2026-12-01T00:00:00Z", ...over });
    return sourceRef;
  };
  const approveMutation = (c: CampaignView, m: MutationView) => approveMedia(c, { action: m.action, subjectHash: m.requestHash });
  /** A THO-346 campaign with its own J04 publish approval; it is not yet published. */
  let n = 0;
  const campaign = async (provider: "meta" | "tiktok" = "meta", lifetime = 60_000) => {
    n++;
    const v = media.prepare({ campaignRef: `plan:${provider}-${n}`, provider, providerAccountRef: provider === "meta" ? META : TIKTOK, environment: "sandbox",
      campaignRoute: provider === "meta" ? "meta-sales-purchase" : "tiktok-smart-plus-web-sales", checkoutRef: "checkout:site", offerRef: "offer:duo",
      creativeRefs: ["asset:clip-1"], destinationRef: "destination:pdp-duo", attributionSetting: "attribution:7d-click",
      schedule: { startAt: "2026-11-10T00:00:00Z", endAt: "2026-11-30T00:00:00Z" }, currency: "USD",
      targeting: { markets: ["US"], ageMin: 21, ageMax: 54, placements: ["placement:feed"] }, bid: { strategy: "lowest-cost", costCapMinor: null, targetRoasBps: null },
      caps: { dailyBudgetMinor: 2000, lifetimeBudgetMinor: lifetime }, expiresAt: "2026-11-20T00:00:00Z" }, `prepare-${n}`);
    const d = await media.createDraft(v.campaignId, `draft-${n}`);
    expect(d.releaseRequested).toBe(true);
    return media.decide(d.campaignId, approveMedia(d), `media-decide-${n}`);
  };
  const released = (over: Partial<StageInput> = {}) => {
    const p = control.proposeStage(terms(over), `stage-${over.stageRef ?? "initial"}`);
    control.decideStage(p.stageRef, approveStage(p), `decide-${p.stageRef}`);
    return control.releaseStage(p.stageRef, `release-${p.stageRef}`);
  };
  const order = (i: number, nativeCampaignId: string, over: Record<string, unknown> = {}) => ({ source: "shop:synthetic", orderRef: `order-${i}`, channel: "website",
    placedAt: ago(60 * 24), updatedAt: ago(60 * 24), units: 1, returnedUnits: 0, merchandiseMinor: 12_000, shippingCollectedMinor: 800, refundedMerchandiseMinor: 0,
    refundedShippingMinor: 0, returnWindowClosed: true, affiliateAttributed: false, commissionAccruedMinor: null,
    paidMediaMatch: { provider: "meta", providerAccountRef: META, nativeCampaignId }, ...over });
  return { control, media, store, params, stageDecisions, spend, conversions, reportOver, rowOver, health, orders, feed, treasury, native, gates, executor,
    terms, approveStage, approveMutation, campaign, released, order, calls };
}
type World = ReturnType<typeof world>;
/** The initial stage released and one Meta campaign launched into it. */
async function launched(w: World) {
  w.released();
  const c = await w.campaign("meta");
  const l = await w.control.launch("stage:initial", { campaignId: c.campaignId }, "launch-1");
  expect(l).toMatchObject({ reservation: "committed", executionCertainty: "applied" });
  return { c: w.media.read(c.campaignId)!, nativeId: w.media.read(c.campaignId)!.native.nativeCampaignId! };
}
/** Profitable evidence four days after launch, inside the next review window. */
async function profitable(w: World) {
  const { c, nativeId } = await launched(w);
  at("2026-11-10T12:30:00Z");
  w.spend.set(nativeId, 15_000);
  for (let i = 1; i <= 3; i++) w.orders.push(w.order(i, nativeId));
  return { c, nativeId };
}

describe("observe → propose → exact approve → bounded execute → reconcile, with every stage held by default", () => {
  it("holds a proposed stage until its own exact Linear decision and release; nothing launches into a held stage", async () => {
    const w = world();
    const p = w.control.proposeStage(w.terms(), "s1");
    expect(p).toMatchObject({ state: "awaiting-approval", dispatch: "held", approval: { decision: "none" } });
    expect(w.control.proposeStage(w.terms({ stageRef: "stage:wrong", ordinal: 2, capMinor: 140_000, allocations: [w.terms().allocations[0]!] }), "s2"))
      .toMatchObject({ state: "held", heldReasons: ["STAGE_CAP_NOT_ADOPTED"] });
    const c = await w.campaign();
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l1")).rejects.toThrow("STAGE_NOT_RELEASED");
    expect(() => w.control.releaseStage("stage:initial", "r1")).toThrow("J04_APPROVAL_REQUIRED");
    const slack = w.approveStage(p, { system: "slack" });
    expect(() => w.control.decideStage("stage:initial", slack, "d1")).toThrow("J04_LINEAR_DECISION_REQUIRED");
    const approved = w.control.decideStage("stage:initial", w.approveStage(p), "d2");
    expect(approved).toMatchObject({ state: "approved", dispatch: "held" });
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l2")).rejects.toThrow("STAGE_NOT_RELEASED");
    expect(w.executor.calls.publish).toBe(0);
    expect(w.control.releaseStage("stage:initial", "r2")).toMatchObject({ state: "released", dispatch: "open" });
  });

  it("launches the proposed $750 Instagram / $750 TikTok split only through THO-346 with all five gates verified", async () => {
    const w = world();
    w.released();
    const meta = await w.campaign("meta"), tiktok = await w.campaign("tiktok");
    const a = await w.control.launch("stage:initial", { campaignId: meta.campaignId }, "l-meta");
    const b = await w.control.launch("stage:initial", { campaignId: tiktok.campaignId }, "l-tiktok");
    expect([a.plannedMaxMinor, b.plannedMaxMinor]).toEqual([66_000, 66_000]);
    const stage = w.control.read("stage:initial")!;
    expect(stage.reservations.map((r) => [r.provider, r.state])).toEqual([["meta", "committed"], ["tiktok", "committed"]]);
    for (const r of stage.reservations) expect(r.gates.map((g) => g.state)).toEqual(["verified", "verified", "verified", "verified", "verified"]);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure).toMatchObject({ demonstrated: true, capMinor: 150_000, spendMinor: 0, plannedMaxMinor: 132_000, remainingMinor: 18_000 });
    expect(w.native.get(w.media.read(meta.campaignId)!.native.nativeCampaignId!)).toMatchObject({ maxDelivery: false, autoRecharge: false, extraDeliveryBudget: false });
  });

  it("frees the reservation when THO-346 refuses publish because a gate is missing", async () => {
    const w = world();
    w.released();
    const c = await w.campaign();
    w.gates.set("fulfillment-support-cash", null);
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l1")).rejects.toThrow("MEDIA_GATES_NOT_VERIFIED");
    expect(w.control.read("stage:initial")!.reservations.map((r) => r.state)).toEqual(["released"]);
    expect(w.control.observe("stage:initial", "o1").exposure.plannedMaxMinor).toBe(0);
  });

  it("keeps an uncertain launch reserved and reconciles it from the media record without re-sending", async () => {
    const w = world();
    w.released();
    const c = await w.campaign();
    w.executor.fail = "after";
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l1")).rejects.toBeInstanceOf(MediaControlUncertain);
    expect(w.control.read("stage:initial")!.reservations[0]!.state).toBe("pending");
    expect(w.media.read(c.campaignId)!.state).toBe("uncertain");
    expect(w.control.observe("stage:initial", "o1").exposure.pendingMinor).toBe(0);
    expect(w.control.read("stage:initial")!.reservations[0]!.state).toBe("committed");
    expect((await w.control.launch("stage:initial", { campaignId: c.campaignId }, "l2")).reservation).toBe("committed");
    expect(w.executor.calls.publish).toBe(1);
  });
});

describe("THO-346 uncertainty and pause supersession", () => {
  it("closes a pending launch superseded by a confirmed pause without publishing, and keeps its possible spend counted", async () => {
    const w = world();
    w.released();
    const c = await w.campaign();
    w.executor.fail = "before";
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l1")).rejects.toBeInstanceOf(MediaControlUncertain);
    const nativeId = w.media.read(c.campaignId)!.native.nativeCampaignId!;
    w.native.get(nativeId)!.status = "ACTIVE";
    w.reportOver.set(META, { scope: { workspaceId: "other-workspace", accountId: "other-account" } });
    w.health.stock = { state: "failed", code: "stock:short" };
    expect((await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1")).campaigns).toEqual([expect.objectContaining({ outcome: "paused" })]);
    expect(w.control.read("stage:initial")!.reservations[0]!.state).toBe("pending");
    w.reportOver.delete(META);
    delete w.health.stock;
    const closed = await w.control.launch("stage:initial", { campaignId: c.campaignId }, "l2");
    // The campaign was live before the pause, so its reservation stays committed (paused) instead of freeing authorization.
    expect(closed).toMatchObject({ reservation: "committed", executionCertainty: "notApplied", campaignState: "draft",
      heldReasons: ["NEW_DECISION_REQUIRED", "SUPERSEDED_BY_PAUSE"] });
    expect(w.executor.calls.publish).toBe(1);
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
    expect(await w.control.launch("stage:initial", { campaignId: c.campaignId }, "l3")).toMatchObject({ reservation: "committed", executionCertainty: "notApplied" });
    expect(w.executor.calls.publish).toBe(1);
    expect(w.control.observe("stage:initial", "o1").exposure.plannedMaxMinor).toBe(66_000);
  });

  it("reports a change whose media write is uncertain as uncertain, then reconciles it by its key", async () => {
    const w = world();
    const { c } = await profitable(w);
    const red = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "reduce-budget", dailyBudgetMinor: 1000, rationale: "Slow down." }, "ch1");
    const decisionRef = w.approveMutation(w.media.read(c.campaignId)!, w.media.readMutation(c.campaignId, red.mutationId!)!);
    w.executor.mutateFail = "after";
    await expect(w.control.applyChange(red.changeId, { decisionRef }, "ap1")).rejects.toBeInstanceOf(MediaControlUncertain);
    expect(w.control.readChange(red.changeId)!.state).toBe("uncertain");
    expect(await w.control.applyChange(red.changeId, { decisionRef }, "ap2")).toMatchObject({ state: "confirmed", effect: { after: { dailyBudgetMinor: 1000 } } });
    expect(w.executor.calls.mutate).toBe(1);
  });
});

describe("cumulative exposure: spend, pending authorizations, native caps and approved headroom", () => {
  it("multiple campaigns consume the same allocation; a second Meta campaign beyond the $750 cap is refused before publish", async () => {
    const w = world();
    await launched(w);
    const second = await w.campaign("meta");
    await expect(w.control.launch("stage:initial", { campaignId: second.campaignId }, "l2")).rejects.toThrow("ALLOCATION_AUTHORIZATION_EXHAUSTED");
    expect(w.executor.calls.publish).toBe(1);
    const small = await w.campaign("meta", 8000);
    expect((await w.control.launch("stage:initial", { campaignId: small.campaignId }, "l3")).plannedMaxMinor).toBe(8800);
  });

  it("simultaneous launches cannot both consume the same remaining authorization", async () => {
    const w = world();
    w.released();
    const one = await w.campaign("meta"), two = await w.campaign("meta");
    let raced: unknown = null;
    w.executor.during = async () => {
      raced = await w.control.launch("stage:initial", { campaignId: two.campaignId }, "l2").catch((e: Error) => e.message);
    };
    const won = await w.control.launch("stage:initial", { campaignId: one.campaignId }, "l1");
    expect(won.reservation).toBe("committed");
    expect(raced).toBe("ALLOCATION_AUTHORIZATION_EXHAUSTED");
    const three = await w.campaign("meta"), four = await w.campaign("meta", 5000);
    const results = await Promise.allSettled([w.control.launch("stage:initial", { campaignId: three.campaignId }, "l3"),
      w.control.launch("stage:initial", { campaignId: four.campaignId }, "l4")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
    expect(w.control.observe("stage:initial", "o1").exposure.allocations[0]).toMatchObject({ plannedMaxMinor: 66_000 + 5500, capMinor: 75_000 });
  });

  it("treats spend within the approved overdelivery headroom as bounded, and beyond it as a safety trigger", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.spend.set(nativeId, 64_000);
    const within = w.control.observe("stage:initial", "o1");
    expect(within.safetyTriggers).toEqual([]);
    expect(within.exposure.campaigns[0]).toMatchObject({ lifetimeBudgetMinor: 60_000, boundMinor: 66_000, spendMinor: 64_000 });
    w.spend.set(nativeId, 67_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^OVERDELIVERY_BEYOND_HEADROOM/)]));
  });

  it("never treats a daily budget as a ceiling: an unknown native lifetime cap fails closed, and a raised one triggers safety", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: null });
    at("2026-11-06T19:00:00Z");
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure.demonstrated).toBe(false);
    expect(o.exposure.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^NATIVE_LIFETIME_CAP_UNAVAILABLE/)]));
    expect(o.holds).toContain("EXPOSURE_UNDEMONSTRATED");
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: 90_000 });
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^NATIVE_CAP_EXCEEDS_APPROVED/)]));
    w.rowOver.set(nativeId, { maxDelivery: true });
    expect(w.control.observe("stage:initial", "o3").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^ADDITIONAL_DELIVERY_ENABLED/)]));
  });

  it("uses an account spend limit as a native bound when the lifetime cap is missing", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: null });
    w.spend.set(nativeId, 10_000);
    w.reportOver.set(META, { accountSpendMinor: 10_000, accountSpendLimitMinor: 50_000 });
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure.allocations[0]).toMatchObject({ plannedMaxMinor: 40_000 + 10_000 + 4000, accountLimitMinor: 50_000 });
  });

  it("fails closed on stale, future-dated or mismatched spend, and never moves cumulative spend backwards", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.spend.set(nativeId, 20_000);
    w.control.observe("stage:initial", "o0");
    w.reportOver.set(META, { sourceUpdatedAt: ago(8 * 60), observedAt: ago(8 * 60) });
    const stale = w.control.observe("stage:initial", "o1");
    expect(stale.holds).toEqual(expect.arrayContaining([`SPEND_STALE:meta:${META}`, "EXPOSURE_UNDEMONSTRATED"]));
    expect(stale.corrections.map((c) => c.kind)).toContain("out-of-order-report-ignored");
    const tiktok = await w.campaign("tiktok");
    await expect(w.control.launch("stage:initial", { campaignId: tiktok.campaignId }, "l2")).rejects.toThrow(`SPEND_STALE:meta:${META}`);
    w.reportOver.set(META, { observedAt: ahead(10) });
    expect(w.control.observe("stage:initial", "o2").holds).toContain(`SPEND_REPORT_TIME_INVALID:meta:${META}`);
    w.reportOver.set(META, { sourceUpdatedAt: "2026-11-06T11:00:00+99:99" });
    expect(w.control.observe("stage:initial", "o2b").holds).toContain(`SPEND_REPORT_UNAVAILABLE:meta:${META}`);
    w.reportOver.set(META, { providerAccountRef: TIKTOK });
    expect(w.control.observe("stage:initial", "o3").holds).toContain(`SPEND_REPORT_MISMATCH:meta:${META}`);
    w.reportOver.delete(META);
    w.spend.set(nativeId, 18_000);
    const corrected = w.control.observe("stage:initial", "o4");
    expect(corrected.corrections).toEqual([expect.objectContaining({ kind: "spend-revised-down", detail: "20000 -> 18000" })]);
    w.spend.set(nativeId, null);
    expect(w.control.observe("stage:initial", "o5").exposure.spendMinor).toBeNull();
    expect(w.executor.calls.publish).toBe(1);
  });

  it("treats an untracked active campaign in a stage account as a safety trigger", async () => {
    const w = world();
    w.released();
    w.native.set("native:outside", { ...settingsFrom((await w.campaign()).manifest!, "native:outside"), status: "ACTIVE" });
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toContain(`UNTRACKED_ACTIVE_CAMPAIGN:meta:${META}:native:outside`);
  });
});

describe("contribution, allowable acquisition cost and platform attribution", () => {
  it("profitable: computes contribution from adopted inputs only and allows an exactly approved increase on the review cadence", async () => {
    const w = world();
    const { c } = await profitable(w);
    const o = w.control.observe("stage:initial", "o1");
    // 12,000 + 800 − 4,500 landed COGS − 800 fulfillment − 384 payment fee − 100 other = 7,016 per order.
    expect(o.economics).toMatchObject({ canonical: { orders: 3, contributionMinor: 21_048, contributionPerOrderMinor: 7016 }, spendMinor: 15_000,
      canonicalCpaMinor: 5000, allowableAcquisitionCostMinor: 7016, diagnostic: { lossMinor: -6048, state: "within" }, scale: { state: "met", reasons: [] } });
    expect(o.recommendations).toEqual([{ action: "review", reason: "SCALE_CRITERIA_MET" }]);
    const change = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 3000,
      rationale: "Canonical CPA below allowable acquisition cost with minimum evidence met." }, "ch1");
    expect(change).toMatchObject({ state: "awaiting-approval", observationId: expect.any(String) });
    const m = w.media.readMutation(c.campaignId, change.mutationId!)!;
    const done = await w.control.applyChange(change.changeId, { decisionRef: w.approveMutation(w.media.read(c.campaignId)!, m) }, "ap1");
    expect(done).toMatchObject({ state: "confirmed", authorizedBy: "j04", effect: { before: { dailyBudgetMinor: 2000 }, after: { dailyBudgetMinor: 3000 } } });
    const again = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 4000, rationale: "Again." }, "ch2");
    expect(again.heldReasons).toContain("LEARNING_WINDOW_ACTIVE");
  });

  it("refuses an increase outside the review window, but a reduction runs at any time with its own decision", async () => {
    const w = world();
    const { c } = await profitable(w);
    at("2026-11-10T18:00:00Z");
    const inc = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 3000, rationale: "Scale." }, "ch1");
    expect(inc).toMatchObject({ state: "held", mutationId: null });
    expect(inc.heldReasons).toContain("REVIEW_WINDOW_CLOSED");
    const red = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "reduce-budget", dailyBudgetMinor: 1000, rationale: "Slow down." }, "ch2");
    expect(red.state).toBe("awaiting-approval");
    await expect(w.control.applyChange(red.changeId, { policyRef: "policy:auto-pause" }, "ap0")).rejects.toThrow("SAFETY_POLICY_ONLY_PAUSES");
    const m = w.media.readMutation(c.campaignId, red.mutationId!)!;
    expect(await w.control.applyChange(red.changeId, { decisionRef: w.approveMutation(w.media.read(c.campaignId)!, m) }, "ap1"))
      .toMatchObject({ state: "confirmed", effect: { after: { dailyBudgetMinor: 1000 } } });
  });

  it("unprofitable: CPA above allowable cost holds scale and recommends a reduction; a breached test loss is a safety trigger", async () => {
    const w = world();
    const { c, nativeId } = await profitable(w);
    w.spend.set(nativeId, 40_000);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.economics).toMatchObject({ canonicalCpaMinor: 13_334, scale: { state: "not-met", reasons: ["CPA_ABOVE_ALLOWABLE_ACQUISITION_COST"] },
      diagnostic: { lossMinor: 40_000 - 21_048, state: "within" } });
    expect(o.recommendations).toContainEqual({ action: "reduce-budget", reason: "CPA_ABOVE_ADOPTED_MAXIMUM" });
    const inc = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 3000, rationale: "ROAS looks good." }, "ch1");
    expect(inc.heldReasons).toEqual(expect.arrayContaining(["SCALE_CRITERIA_NOT_MET", "CPA_ABOVE_ALLOWABLE_ACQUISITION_COST"]));
    w.params.diagnostic.maxTestLossMinor = A(10_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toContain("MAX_TEST_LOSS_REACHED");
  });

  it("unknown: a proposed 20% commission, a cost counted twice or a missing order feed keeps contribution unknown, never zero", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.orders.push(w.order(4, nativeId, { affiliateAttributed: true }));
    const o = w.control.observe("stage:initial", "o1");
    expect(o.economics).toMatchObject({ canonical: { contributionMinor: null }, allowableAcquisitionCostMinor: null, scale: { state: "unknown" } });
    expect(o.economics.unknownInputs).toContain("PARAMETER_PROPOSED_NOT_ADOPTED:affiliateCommissionBps");
    w.orders.pop();
    w.orders.push(w.order(4, nativeId, { affiliateAttributed: true, commissionAccruedMinor: 1200 }));
    expect(w.control.observe("stage:initial", "o2").economics.canonical).toMatchObject({ contributionMinor: 21_048 + 7016 - 1200, commissionsAccruedMinor: 1200 });
    w.params.contribution.landedCogsPerUnit = A([{ component: "unit-cost", amountMinor: 4000 }, { component: "tariff", amountMinor: 500 }, { component: "tariff", amountMinor: 500 }]);
    expect(w.control.observe("stage:initial", "o3").economics.unknownInputs).toContain("COST_COUNTED_TWICE:tariff");
    w.feed.available = false;
    const missing = w.control.observe("stage:initial", "o4").economics;
    expect(missing.canonical).toMatchObject({ orders: null, contributionMinor: null, retainedMerchandiseMinor: null });
    expect(missing.unknownInputs).toContain("ORDERS_UNAVAILABLE");
    w.feed.available = true; w.feed.complete = false;
    expect(w.control.observe("stage:initial", "o5").economics.canonical.contributionMinor).toBeNull();
  });

  it("an open return window needs the adopted return allowance; the unapproved 5% proposal stays unknown", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.orders.push(w.order(4, nativeId, { returnWindowClosed: false }));
    expect(w.control.observe("stage:initial", "o1").economics.unknownInputs).toContain("PARAMETER_PROPOSED_NOT_ADOPTED:returnAllowanceBps");
    w.params.contribution.returnAllowanceBps = A(500);
    expect(w.control.observe("stage:initial", "o2").economics.canonical.contributionMinor).toBe(21_048 + 7016 - 600);
  });

  it("late refund: a refund reported later lowers retained contribution and is recorded as a correction", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.control.observe("stage:initial", "o1");
    w.orders[0] = w.order(1, nativeId, { refundedMerchandiseMinor: 12_000, refundedShippingMinor: 800, returnedUnits: 1, updatedAt: ago(1) });
    const o = w.control.observe("stage:initial", "o2");
    expect(o.corrections).toEqual([expect.objectContaining({ kind: "late-refund", key: "order|shop:synthetic|order-1", detail: "0 -> 12800" })]);
    // The refunded order keeps its fulfillment, fees and other costs: 0 + 0 − 0 COGS − 800 − 384 − 100 = −1,284.
    expect(o.economics.canonical).toMatchObject({ orders: 3, contributionMinor: 7016 * 2 - 1284, retainedMerchandiseMinor: 24_000 });
    w.orders[0] = w.order(1, nativeId);
    expect(w.control.observe("stage:initial", "o3").economics.canonical.retainedMerchandiseMinor).toBe(24_000);
  });

  it("duplicate conversion: native and mirror events for one order count once, and platform purchases never join canonical orders", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    const conv = (id: string, channel: string, orderRef: string | null, value = 12_800) => ({ conversionId: id, channel, orderSource: orderRef ? "shop:synthetic" : null,
      orderRef, convertedAt: ago(60 * 24), valueMinor: value });
    w.conversions.set(nativeId, [conv("c1", "native", "order-1"), conv("m1", "mirror", "order-1"), conv("c2", "native", null), conv("c3", "native", "order-2")]);
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.platform).toMatchObject({ purchases: 3, duplicatesRemoved: 1, valueMinor: 3 * 12_800, includesOrganicAffiliate: false, incrementalPaidRoas: null, comparable: true });
    expect(o.canonical.orders).toBe(3);
    w.params.attributionWindow = P("attribution:7d-click");
    expect(w.control.observe("stage:initial", "o1b").economics.platform).toMatchObject({ comparable: false, purchases: null, valueMinor: null });
    w.params.attributionWindow = A("attribution:7d-click");
    w.rowOver.set(nativeId, { attributionWindow: "attribution:1d-view" });
    expect(w.control.observe("stage:initial", "o2").economics.platform.excluded).toContain(`ATTRIBUTION_WINDOW_MISMATCH:${nativeId}`);
  });

  it("late conversion: a conversion that arrives after a later observation is counted once and recorded", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.control.observe("stage:initial", "o1");
    at("2026-11-10T13:00:00Z");
    w.conversions.set(nativeId, [{ conversionId: "late-1", channel: "native", orderSource: "shop:synthetic", orderRef: "order-3", convertedAt: "2026-11-10T09:00:00Z",
      valueMinor: 12_800 }]);
    const o = w.control.observe("stage:initial", "o2");
    expect(o.corrections).toContainEqual(expect.objectContaining({ kind: "late-conversion", key: "order|shop:synthetic|order-3" }));
    expect(o.economics.platform.purchases).toBe(1);
    expect(w.control.observe("stage:initial", "o3").economics.platform.purchases).toBe(1);
  });

  it("keeps diagnostic loss separate from scale: no adopted minimum evidence means scale stays unknown", async () => {
    const w = world();
    await profitable(w);
    w.params.minimumEvidence = P({ orders: 1, spendMinor: 1, days: 0 });
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.scale).toMatchObject({ state: "unknown", reasons: ["PARAMETER_PROPOSED_NOT_ADOPTED:minimumEvidence"] });
    expect(o.diagnostic.state).toBe("within");
  });
});

describe("safety: pause or hold on exhausted cap, stock, checkout, rights, permission or measurement", () => {
  it("stock exhaustion: pauses every stage campaign under the pre-authorized policy and preserves incurred spend and commissions", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.orders.push(w.order(4, nativeId, { affiliateAttributed: true, commissionAccruedMinor: 1200 }));
    w.health.stock = { state: "failed", code: "stock:released-units-exhausted" };
    at("2026-11-10T18:00:00Z");
    const run = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    expect(run).toMatchObject({ triggers: ["QUALIFIED_STOCK_SHORTAGE"], campaigns: [{ outcome: "paused" }], executionCertainty: "applied" });
    expect(run.incidents[0]).toMatchObject({ code: "QUALIFIED_STOCK_SHORTAGE", decisionRef: expect.stringMatching(/^j04:stage:initial/) });
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
    const after = w.control.observe("stage:initial", "o1");
    expect(after.exposure.spendMinor).toBe(15_000);
    expect(after.economics.canonical.commissionsAccruedMinor).toBe(1200);
    expect(w.control.read("stage:initial")!.dispatch).toBe("held");
    delete w.health.stock;
    const cleared = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-2");
    expect(cleared).toMatchObject({ triggers: [], campaigns: [], executionCertainty: "notApplied" });
    expect(cleared.incidents[0]!.resolvedAt).not.toBeNull();
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
  });

  it("rights revoked, failed checkout, unavailable permission and untrustworthy measurement trigger; unknown health only holds", async () => {
    const w = world();
    await launched(w);
    w.health.rights = { state: "failed", code: "rights:revoked" };
    w.health.checkout = { state: "failed", code: "checkout:payment-failed" };
    w.health.permission = { state: "failed", code: "permission:revoked" };
    w.health.measurement = { state: "failed", code: "measurement:dedup-broken" };
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toEqual(["CHECKOUT_FAILED", "RIGHTS_REVOKED_OR_EXPIRED", "PERMISSION_UNAVAILABLE",
      "MEASUREMENT_UNTRUSTWORTHY"]);
    for (const k of ["rights", "checkout", "permission", "measurement"]) delete w.health[k];
    w.health.rights = { validUntil: ago(1) };
    const o = w.control.observe("stage:initial", "o2");
    expect(o).toMatchObject({ safetyTriggers: [], holds: ["HEALTH_UNKNOWN:rights"] });
  });

  it("rights expiry: an expired rights check pauses at once, outside the review window", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    at("2026-11-07T03:00:00Z");
    w.health.rights = { state: "failed", code: "rights:expired" };
    const run = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    expect(run.campaigns).toEqual([expect.objectContaining({ outcome: "paused" })]);
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
  });

  it("exhausted cap: spend at the allocation cap triggers a pause", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.spend.set(nativeId, 66_000);
    w.rowOver.set(nativeId, { lifetimeBudgetMinor: 75_000 });
    w.params.diagnostic.maxTestLossMinor = A(1_000_000);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.safetyTriggers).toEqual(expect.arrayContaining([`NATIVE_CAP_EXCEEDS_APPROVED:${w.media.read(w.control.read("stage:initial")!.reservations[0]!.campaignId)!.campaignId}`]));
    w.rowOver.delete(nativeId);
    w.spend.set(nativeId, 75_000);
    expect(w.control.observe("stage:initial", "o2").safetyTriggers).toEqual(expect.arrayContaining([`ALLOCATION_CAP_EXHAUSTED:meta:${META}`]));
  });

  it("pause failure: an uncertain pause opens an incident that holds dispatch until a later run confirms it", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.health.stock = { state: "failed", code: "stock:short" };
    w.executor.mutateFail = "before";
    const failed = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    expect(failed).toMatchObject({ campaigns: [{ outcome: "failed", code: "MUTATION_OUTCOME_UNKNOWN" }], executionCertainty: "uncertain" });
    expect(failed.incidents.map((i) => i.code)).toEqual(["QUALIFIED_STOCK_SHORTAGE", expect.stringMatching(/^PAUSE_FAILED:/)]);
    expect(w.native.get(nativeId)!.status).toBe("ACTIVE");
    delete w.health.stock;
    expect(w.control.observe("stage:initial", "o1").holds).toEqual(expect.arrayContaining([expect.stringMatching(/^INCIDENT_OPEN:PAUSE_FAILED/)]));
    const retried = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-2");
    expect(retried.campaigns).toEqual([expect.objectContaining({ outcome: "paused" })]);
    expect(retried.incidents.find((i) => i.code.startsWith("PAUSE_FAILED"))!.resolvedAt).not.toBeNull();
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
  });

  it("a confirmed pause supersedes an older increase, and a paused campaign is never re-published", async () => {
    const w = world();
    const { c } = await profitable(w);
    const inc = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "increase-budget", dailyBudgetMinor: 3000, rationale: "Scale." }, "ch1");
    const decisionRef = w.approveMutation(w.media.read(c.campaignId)!, w.media.readMutation(c.campaignId, inc.mutationId!)!);
    w.health.stock = { state: "failed", code: "stock:short" };
    await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    delete w.health.stock;
    expect(await w.control.applyChange(inc.changeId, { decisionRef }, "ap1")).toMatchObject({ state: "superseded", heldReasons: ["SUPERSEDED_BY_PAUSE"] });
    expect(w.native.get(c.native.nativeCampaignId!)!).toMatchObject({ status: "PAUSED", dailyBudgetMinor: 2000 });
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l9")).resolves.toMatchObject({ reservation: "committed" });
    expect(w.executor.calls.publish).toBe(1);
  });

  it("a revoked stage decision triggers safety and blocks launches; an expired one holds", async () => {
    const w = world();
    await launched(w);
    const ref = w.control.read("stage:initial")!.approval.decisionRef!;
    w.stageDecisions.set(ref, { ...(w.stageDecisions.get(ref) as object), state: "revoked" });
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toContain("STAGE_DECISION_REVOKED");
    const next = await w.campaign("tiktok");
    await expect(w.control.launch("stage:initial", { campaignId: next.campaignId }, "l2")).rejects.toThrow("J04_DECISION_NOT_CURRENT");
    w.stageDecisions.set(ref, { ...(w.stageDecisions.get(ref) as object), state: "current", validUntil: ago(1) });
    expect(w.control.observe("stage:initial", "o2").holds).toContain("STAGE_DECISION_EXPIRED");
  });
});

describe("stable cadence, treasury ceiling and no unauthorized stage escalation", () => {
  it("publication and stage release run only inside the adopted review window; safety runs any time", async () => {
    const w = world();
    at("2026-11-06T15:00:00Z");
    const p = w.control.proposeStage(w.terms(), "s1");
    w.control.decideStage(p.stageRef, w.approveStage(p), "d1");
    expect(() => w.control.releaseStage(p.stageRef, "r1")).toThrow("REVIEW_WINDOW_CLOSED");
    at("2026-11-07T12:10:00Z");
    expect(w.control.releaseStage(p.stageRef, "r2").state).toBe("released");
    expect(w.control.observe(p.stageRef, "o1").review).toMatchObject({ open: true, nextReviewAt: "2026-11-07T12:00:00.000Z", nextSafetyCheckAt: "2026-11-07T12:25:00.000Z" });
    w.params.reviewCadence = P({ anchorAt: "2026-11-06T12:00:00Z", intervalHours: 1, windowMinutes: 60, learningWindowHours: 0, safetyIntervalMinutes: 1 });
    const c = await w.campaign();
    await expect(w.control.launch(p.stageRef, { campaignId: c.campaignId }, "l1")).rejects.toThrow("PARAMETER_PROPOSED_NOT_ADOPTED:reviewCadence");
  });

  it("refuses release when founder cash would exceed the adopted $40,000 ceiling or cash is unknown; forecasts never count", () => {
    const w = world();
    const p = w.control.proposeStage(w.terms(), "s1");
    w.control.decideStage(p.stageRef, w.approveStage(p), "d1");
    Object.assign(w.treasury, { founderInvestedMinor: 3_500_000, revenueForecastMinor: 9_000_000, scheduledPayouts: [{ amountMinor: 2_000_000, expectedAt: ahead(60) }] });
    expect(() => w.control.releaseStage(p.stageRef, "r1")).toThrow("FOUNDER_CASH_CEILING_EXCEEDED");
    const t = w.control.read(p.stageRef)!.lastObservation!.treasury;
    expect(t).toMatchObject({ state: "exceeds", ceilingMinor: 4_000_000, spendableCashMinor: 400_000, mediaExposureMinor: 150_000,
      projectedFounderInvestedMinor: 3_500_000 + 1_000_000 + 150_000 - 400_000, excludedPayoutsMinor: 2_000_000, excludedForecastMinor: 9_000_000 });
    Object.assign(w.treasury, { founderInvestedMinor: null });
    expect(() => w.control.releaseStage(p.stageRef, "r2")).toThrow("TREASURY_UNKNOWN");
    Object.assign(w.treasury, { founderInvestedMinor: 2_500_000 });
    w.params.founderCashCeilingMinor = P(4_000_000);
    expect(() => w.control.releaseStage(p.stageRef, "r3")).toThrow("TREASURY_UNKNOWN");
    w.params.founderCashCeilingMinor = A(4_000_000);
    expect(w.control.releaseStage(p.stageRef, "r4").state).toBe("released");
  });

  it("no unauthorized stage escalation: later $1,500 and $3,000 stages stay held even with profitable evidence", async () => {
    const w = world();
    const c = await w.campaign("tiktok");
    await profitable(w);
    expect(w.control.observe("stage:initial", "o1").economics.scale.state).toBe("met");
    const second = w.control.proposeStage(w.terms({ stageRef: "stage:second", ordinal: 2 }), "s2");
    const third = w.control.proposeStage(w.terms({ stageRef: "stage:third", ordinal: 3, capMinor: 300_000 }), "s3");
    expect([second.state, third.state]).toEqual(["awaiting-approval", "awaiting-approval"]);
    expect(() => w.control.releaseStage("stage:second", "r2")).toThrow("J04_APPROVAL_REQUIRED");
    const firstRef = w.control.read("stage:initial")!.approval.decisionRef!;
    expect(() => w.control.decideStage("stage:second", firstRef, "d2")).toThrow("STAGE_DECISION_UNVERIFIED");
    const borrowed = w.approveStage(second, { subjectHash: w.control.read("stage:initial")!.subjectHash });
    expect(() => w.control.decideStage("stage:second", borrowed, "d3")).toThrow("J04_DECISION_FOR_ANOTHER_REQUEST");
    w.control.decideStage("stage:third", w.approveStage(third), "d4");
    expect(() => w.control.releaseStage("stage:third", "r3")).toThrow("EARLIER_STAGE_NOT_RELEASED");
    await expect(w.control.launch("stage:second", { campaignId: c.campaignId }, "l2")).rejects.toThrow("STAGE_NOT_RELEASED");
    const larger = w.control.proposeStage(w.terms({ stageRef: "stage:second", ordinal: 2, capMinor: 300_000 }), "s2b");
    expect(larger).toMatchObject({ state: "held", revision: 2, heldReasons: ["STAGE_CAP_NOT_ADOPTED"] });
    expect(w.control.read("stage:second")!.reservations).toEqual([]);
    expect(w.executor.calls.publish).toBe(1);
  });
});


describe("review regressions (THO-347)", () => {
  it("R1 a concurrent observe or launch inside the publish read-back window never frees an in-flight reservation", async () => {
    const w = world();
    w.released();
    const one = await w.campaign("meta"), two = await w.campaign("meta");
    let during: { observed: number; raced: unknown } | null = null;
    w.executor.readHook = async () => {
      const o = w.control.observe("stage:initial", "o-during");
      const raced = await w.control.launch("stage:initial", { campaignId: two.campaignId }, "l2").catch((e: Error) => e.message);
      const again = await w.control.launch("stage:initial", { campaignId: one.campaignId }, "l1-again").catch((e: Error) => e.message);
      during = { observed: o.exposure.pendingMinor, raced: [raced, again] };
    };
    const won = await w.control.launch("stage:initial", { campaignId: one.campaignId }, "l1");
    expect(during).toEqual({ observed: 66_000, raced: ["ALLOCATION_AUTHORIZATION_EXHAUSTED", "LAUNCH_IN_PROGRESS"] });
    expect(won).toMatchObject({ reservation: "committed", executionCertainty: "applied" });
    expect(w.executor.calls.publish).toBe(1);
    const o = w.control.observe("stage:initial", "o1");
    expect(o.exposure.allocations[0]).toMatchObject({ plannedMaxMinor: 66_000 });
    expect(o.safetyTriggers).toEqual([]);
  });

  it("R1 pauses an untracked active campaign Farda can name, after its launch reservation was freed", async () => {
    const w = world();
    w.released();
    const c = await w.campaign();
    w.gates.set("fulfillment-support-cash", null);
    await expect(w.control.launch("stage:initial", { campaignId: c.campaignId }, "l1")).rejects.toThrow("MEDIA_GATES_NOT_VERIFIED");
    w.gates.delete("fulfillment-support-cash");
    expect((await w.media.publish(c.campaignId, "direct-publish")).state).toBe("confirmed");
    const nativeId = w.media.read(c.campaignId)!.native.nativeCampaignId!;
    const run = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    expect(run.triggers).toContain(`UNTRACKED_ACTIVE_CAMPAIGN:meta:${META}:${nativeId}`);
    expect(run.campaigns).toEqual([expect.objectContaining({ campaignId: c.campaignId, outcome: "paused" })]);
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
  });

  it("R2 re-pauses a campaign re-activated outside Farda and resolves a failed pause only on a matched read-back", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.health.stock = { state: "failed", code: "stock:short" };
    await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-1");
    w.native.get(nativeId)!.status = "ACTIVE";
    const again = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-2");
    expect(again.campaigns).toEqual([expect.objectContaining({ outcome: "paused" })]);
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
    delete w.health.stock;
    w.native.get(nativeId)!.status = "ACTIVE";
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toEqual(expect.arrayContaining([expect.stringMatching(/^PAUSED_CAMPAIGN_REACTIVATED/)]));
    w.executor.mutateFail = "before";
    expect((await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-3")).campaigns[0]!.outcome).toBe("failed");
    w.executor.readBackDown = true;
    const blind = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-4");
    expect(blind.campaigns[0]!.outcome).toBe("failed");
    expect(blind.incidents.find((i) => i.code.startsWith("PAUSE_FAILED"))!.resolvedAt).toBeNull();
    w.executor.readBackDown = false;
    const fixed = await w.control.runSafety("stage:initial", { policyRef: "policy:auto-pause" }, "safe-5");
    expect(fixed.campaigns[0]!.outcome).toBe("paused");
    expect(fixed.incidents.find((i) => i.code.startsWith("PAUSE_FAILED"))!.resolvedAt).not.toBeNull();
    expect(w.native.get(nativeId)!.status).toBe("PAUSED");
  });

  it("R3 pauses when spend reaches the maximum test loss with unknown contribution, and fails closed on unadopted limits", async () => {
    const w = world();
    const { nativeId } = await launched(w);
    w.params.diagnostic.maxTestLossMinor = A(30_000);
    w.feed.available = false;
    w.spend.set(nativeId, 30_000);
    expect(w.control.observe("stage:initial", "o1").safetyTriggers).toContain("MAX_TEST_LOSS_UNDEMONSTRATED");
    w.params.attributionWindow = P("attribution:7d-click");
    w.params.diagnostic.maxTestLossMinor = A(100_000);
    const tiktok = await w.campaign("tiktok");
    await expect(w.control.launch("stage:initial", { campaignId: tiktok.campaignId }, "l2")).rejects.toThrow("PARAMETER_PROPOSED_NOT_ADOPTED:attributionWindow");
    const v = world();
    v.params.diagnostic.maxCpaMinor = P(6000);
    const p = v.control.proposeStage(v.terms(), "s1");
    v.control.decideStage(p.stageRef, v.approveStage(p), "d1");
    expect(() => v.control.releaseStage(p.stageRef, "r1")).toThrow("PARAMETER_PROPOSED_NOT_ADOPTED:maxCpaMinor");
    v.params.diagnostic.maxCpaMinor = A(6000);
    v.params.minimumEvidence = null;
    expect(() => v.control.releaseStage(p.stageRef, "r2")).toThrow("PARAMETER_NOT_ADOPTED:minimumEvidence");
  });

  it("R4 keeps GMV Max orders out of paid-incremental CPA unless incremental evidence is adopted", async () => {
    const w = world();
    const { nativeId } = await profitable(w);
    w.rowOver.set(nativeId, { includesOrganicAffiliate: true });
    const o = w.control.observe("stage:initial", "o1").economics;
    expect(o.canonical.orders).toBe(0);
    expect(o.canonicalCpaMinor).toBeNull();
    expect(o.scale.state).toBe("unknown");
    expect(o.scale.reasons).toContain(`NOT_INCREMENTAL_PAID:${nativeId}`);
    expect(o.platform).toMatchObject({ includesOrganicAffiliate: true, incrementalPaidRoas: null });
    (w.params as Record<string, unknown>).incrementalEvidence = A([{ provider: "meta", providerAccountRef: META, environment: "sandbox", nativeCampaignId: nativeId,
      evidenceRef: "lift:synthetic-holdout" }]);
    expect(w.control.observe("stage:initial", "o2").economics).toMatchObject({ canonical: { orders: 3 }, scale: { state: "met" } });
  });

  it("R5 counts media spend accrued but not yet charged against the founder cash ceiling, once", async () => {
    const w = world();
    await profitable(w);
    Object.assign(w.treasury, { founderInvestedMinor: 3_000_000, commitmentsMinor: 1_252_000 });
    const unbilled = w.control.observe("stage:initial", "o1").treasury;
    expect(unbilled).toMatchObject({ state: "exceeds", mediaExposureMinor: 150_000, mediaChargedMinor: 0, projectedFounderInvestedMinor: 4_002_000 });
    Object.assign(w.treasury, { mediaChargedMinor: 15_000 });
    expect(w.control.observe("stage:initial", "o2").treasury).toMatchObject({ state: "within", mediaExposureMinor: 135_000, projectedFounderInvestedMinor: 3_987_000 });
    Object.assign(w.treasury, { mediaChargedMinor: null });
    expect(w.control.observe("stage:initial", "o3").treasury.reasons).toContain("TREASURY_MEDIA_CHARGED_UNKNOWN");
  });

  it("R6 holds on null spend after an out-of-order report, and fails closed when the campaign record is unreadable", async () => {
    const w = world();
    const { c, nativeId } = await launched(w);
    w.spend.set(nativeId, 20_000);
    w.control.observe("stage:initial", "o0");
    w.reportOver.set(META, { sourceUpdatedAt: ago(60), observedAt: ago(50) });
    const o = w.control.observe("stage:initial", "o1");
    expect(o.holds).toContain(`SPEND_UNKNOWN:${c.campaignId}`);
    expect(o.exposure.reasons).toContain(`SPEND_STALE:${c.campaignId}`);
    w.reportOver.delete(META);
    w.store.database.prepare("UPDATE media_campaigns SET body=? WHERE campaign_id=?").run("{", c.campaignId);
    expect(w.control.observe("stage:initial", "o2").holds).toContain(`CAMPAIGN_RECORD_UNAVAILABLE:${c.campaignId}`);
  });

  it("R6 reports an unreadable mutation record after a possible effect as uncertain", async () => {
    const w = world();
    const { c } = await profitable(w);
    const red = w.control.proposeChange("stage:initial", { campaignId: c.campaignId, kind: "reduce-budget", dailyBudgetMinor: 1000, rationale: "Slow down." }, "ch1");
    const decisionRef = w.approveMutation(w.media.read(c.campaignId)!, w.media.readMutation(c.campaignId, red.mutationId!)!);
    w.executor.mutateHook = () => { w.store.database.prepare("UPDATE media_mutations SET body=? WHERE mutation_id=?").run("{", red.mutationId!); };
    await expect(w.control.applyChange(red.changeId, { decisionRef }, "ap1")).rejects.toBeInstanceOf(MediaControlUncertain);
  });

  it("R6 keeps the stage ordinal column in step with a re-proposal and never surfaces a raw UNIQUE error", () => {
    const w = world();
    w.control.proposeStage(w.terms({ stageRef: "stage:a", ordinal: 2 }), "s1");
    expect(w.control.proposeStage(w.terms({ stageRef: "stage:a", ordinal: 3, capMinor: 300_000 }), "s2")).toMatchObject({ ordinal: 3, revision: 2 });
    expect(w.control.proposeStage(w.terms({ stageRef: "stage:b", ordinal: 2 }), "s3")).toMatchObject({ ordinal: 2, state: "awaiting-approval" });
    expect(() => w.control.proposeStage(w.terms({ stageRef: "stage:c", ordinal: 3, capMinor: 300_000 }), "s4")).toThrow("STAGE_ORDINAL_TAKEN");
  });

  it("R6 resolves a gates-not-verified incident once the media record shows every gate verified", async () => {
    const w = world();
    const { c } = await launched(w);
    const db = w.store.database;
    const stage = JSON.parse(String(db.prepare("SELECT body FROM media_control_stages WHERE stage_ref=?").get("stage:initial")!.body));
    stage.incidents.push({ code: "GATES_NOT_VERIFIED_AT_PUBLISH", campaignId: c.campaignId, at: clock.toISOString(), decisionRef: stage.decisionRef, resolvedAt: null });
    db.prepare("UPDATE media_control_stages SET body=? WHERE stage_ref=?").run(JSON.stringify(stage), "stage:initial");
    const row = db.prepare("SELECT reservation_id, body FROM media_control_reservations WHERE campaign_id=?").get(c.campaignId)!;
    const r = JSON.parse(String(row.body));
    r.gates = [{ gate: "qualified-product-stock", state: "missing" }];
    db.prepare("UPDATE media_control_reservations SET body=? WHERE reservation_id=?").run(JSON.stringify(r), row.reservation_id as string);
    expect(w.control.observe("stage:initial", "o1").holds).not.toContain(`INCIDENT_OPEN:GATES_NOT_VERIFIED_AT_PUBLISH`);
    const after = w.control.read("stage:initial")!;
    expect(after.incidents[0]!.resolvedAt).not.toBeNull();
    expect(after.reservations[0]!.gates.every((g) => g.state === "verified")).toBe(true);
  });
});

describe("media-control routes and the authenticated service", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });
  it("needs the reviewer role and a bound key, and maps errors to canonical envelopes", async () => {
    const w = world();
    const call = (path: string, body?: unknown, role: "reviewer" | "reader" = "reviewer", key: string | undefined = "k") =>
      handleMediaControlRoute({ method: body === undefined ? "GET" : "POST", path, role, body, idempotencyKey: key }, w.control);
    expect(await call("/v1/media-control/stages", w.terms(), "reader")).toMatchObject({ status: 403, body: { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" } });
    expect(await call("/v1/media-control/stages", w.terms(), "reviewer", "")).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(await call("/v1/media-control/stages", { stageRef: "x" })).toMatchObject({ status: 422, body: { executionCertainty: "notApplied" } });
    expect(await call("/v1/media-control/stages", w.terms(), "reviewer", "k1")).toMatchObject({ status: 200, body: { state: "awaiting-approval" } });
    expect(await call("/v1/media-control/stages", w.terms({ capMinor: 140_000, allocations: [w.terms().allocations[0]!] }), "reviewer", "k1"))
      .toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await call("/v1/media-control/stages/stage:initial/release", {}, "reviewer", "k2")).toMatchObject({ status: 409, body: { code: "J04_APPROVAL_REQUIRED" } });
    expect(await call("/v1/media-control/stages/stage:initial/decisions", { decisionRef: "j04:missing" }, "reviewer", "k3")).toMatchObject({ status: 503 });
    expect(await call("/v1/media-control/stages/stage:initial")).toMatchObject({ status: 200, body: { kind: "media-release-stage" } });
    expect(await call("/v1/media-control/stages/stage:unknown")).toMatchObject({ status: 404 });
    expect(await call("/v1/media-control/stages/stage:initial?x=1")).toMatchObject({ status: 400 });
    expect(await handleMediaControlRoute({ method: "GET", path: "/v1/media/campaigns/x", role: "reader" }, w.control)).toBeNull();
    const uncertain = { launch: async () => { throw new MediaControlUncertain("MEDIA_PUBLISH_UNCERTAIN"); } } as unknown as MediaReleaseController;
    expect(await handleMediaControlRoute({ method: "POST", path: "/v1/media-control/stages/s/launches", role: "reviewer", body: { campaignId: "c" }, idempotencyKey: "u" },
      uncertain)).toEqual({ status: 409, body: { code: "MEDIA_PUBLISH_UNCERTAIN", executionCertainty: "uncertain" } });
    const raw = { runSafety: async () => { throw new MediaWriteUncertain("MUTATION_OUTCOME_UNKNOWN"); } } as unknown as MediaReleaseController;
    expect(await handleMediaControlRoute({ method: "POST", path: "/v1/media-control/stages/s/safety", role: "reviewer", body: { policyRef: "p" }, idempotencyKey: "v" },
      raw)).toEqual({ status: 409, body: { code: "MUTATION_OUTCOME_UNKNOWN", executionCertainty: "uncertain" } });
  });

  it("serves the controller through the HTTP service, holding every stage when nothing is connected", async () => {
    const w = world();
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...scope });
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const post = (token: string, path: string, body: unknown, key: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    expect((await post(SYNTHETIC_READ_TOKEN, "/v1/media-control/stages", w.terms(), "h1")).status).toBe(403);
    const res = await post(SYNTHETIC_REVIEW_TOKEN, "/v1/media-control/stages", w.terms(), "h1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: "held", heldReasons: ["PARAMETERS_UNAVAILABLE"] });
    const obs = await post(SYNTHETIC_REVIEW_TOKEN, "/v1/media-control/stages/stage:initial/observations", {}, "h2");
    const body = await obs.json() as { exposure: { demonstrated: boolean }; treasury: { state: string }; holds: string[] };
    expect(body.exposure.demonstrated).toBe(false);
    expect(body.treasury.state).toBe("unknown");
    expect(body.holds).toEqual(expect.arrayContaining(["PARAMETERS_UNAVAILABLE", "TREASURY_UNKNOWN"]));
  });
});
