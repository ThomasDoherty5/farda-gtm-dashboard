// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import type { CampaignView, ExecRoute, Manifest, MutationView, NativeSettings, PrepareInput } from "./contract";
import { MediaSourceUnavailable, MediaWriteUncertain, PaidMediaRepository, type MediaAuthority } from "./repository";
import { handleMediaRoute } from "./routes";

// Synthetic accounts, checkouts, assets, decisions and provider receipts only. Nothing here is a real advertiser, shop or campaign.
const scope = { workspaceId: "fictional-workspace", accountId: "fictional-account" };
const H = (c: string) => c.repeat(64);
let clock = new Date("2026-11-06T12:00:00Z");
/** An attempted provider write whose outcome is unknown is reported as uncertain, never as a result. */
const settle = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(MediaWriteUncertain);
const at = (iso: string) => { clock = new Date(iso); };

function settingsFrom(m: Manifest, nativeCampaignId: string): NativeSettings {
  return { nativeCampaignId, provider: m.provider, providerAccountRef: m.account.providerAccountRef, environment: m.environment, identityRef: m.account.identityRef,
    nativeAdIds: [`native:ad-${nativeCampaignId.slice(-1)}`], previewRef: `preview:${nativeCampaignId}`, status: "PAUSED", objective: m.objective, optimizationEvent: m.optimizationEvent,
    currency: m.currency, dailyBudgetMinor: m.caps.dailyBudgetMinor, lifetimeBudgetMinor: m.caps.lifetimeBudgetMinor, startAt: m.schedule.startAt,
    endAt: m.schedule.endAt, attributionSetting: m.attributionSetting, destinationRef: m.destinationRef, creativeHashes: m.creatives.map((c) => c.contentHash),
    markets: m.targeting.markets, ageMin: m.targeting.ageMin, ageMax: m.targeting.ageMax, placements: m.targeting.placements, bidStrategy: m.bid.strategy,
    costCapMinor: m.bid.costCapMinor, targetRoasBps: m.bid.targetRoasBps, extraDeliveryBudget: false, maxDelivery: false, autoRecharge: false,
    placementExpansion: false, receiptOrigin: "synthetic", observedAt: clock.toISOString() };
}

function world() {
  clock = new Date("2026-11-06T12:00:00Z");
  const accounts = new Map<string, unknown>();
  const capabilities = new Map<string, Record<string, unknown>>();
  const checkouts = new Map<string, unknown>();
  const offers = new Map<string, unknown>();
  const assets = new Map<string, unknown>();
  const decisions = new Map<string, unknown>();
  const gates = new Map<string, Record<string, unknown> | null>();
  const native = new Map<string, NativeSettings>();
  const writes = new Map<string, unknown>();
  const policies = new Map<string, unknown>([["policy:auto-pause", { scope, policyRef: "policy:auto-pause", state: "current", allows: ["pause"],
    accounts: [{ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }], validUntil: "2026-12-31T00:00:00Z" }]]);
  const executor = {
    calls: { createDraft: 0, publish: 0, mutate: 0 }, routes: [] as ExecRoute[], preset: {} as Partial<NativeSettings>, origin: "synthetic" as "synthetic" | "account",
    fail: null as null | "before" | "after", outcome: "ACTIVE" as "ACTIVE" | "REJECTED", handoff: null as null | "mfa" | "captcha" | "ui-drift",
    during: null as null | (() => Promise<void>), draftHandoff: null as null | "mfa" | "captcha" | "ui-drift", draftFail: false,
    createDraft(key: string, payload: { manifest: Manifest; nativeCampaignId: string | null; status: string }, route: ExecRoute) {
      this.calls.createDraft++; this.routes.push(route);
      if (this.draftHandoff) return { key, handoff: this.draftHandoff };
      if (writes.has(key)) return writes.get(key);
      const id = payload.nativeCampaignId ?? `native:campaign-${native.size + 1}`;
      expect(payload.status).toBe("PAUSED");
      native.set(id, { ...settingsFrom(payload.manifest, id), ...this.preset, receiptOrigin: this.origin });
      const receipt = { key, nativeCampaignId: id, nativeAdIds: [`native:ad-${id.slice(-1)}`], previewRef: `preview:${id}`, receiptRef: `receipt:${key}`, receiptOrigin: this.origin };
      writes.set(key, receipt);
      if (this.draftFail) { this.draftFail = false; throw new Error("timeout after the draft was created"); }
      return receipt;
    },
    async publish(key: string, payload: { nativeCampaignId: string }, route: ExecRoute) {
      this.calls.publish++; this.routes.push(route);
      if (this.during) { const f = this.during; this.during = null; await f(); }
      if (this.handoff) return { key, handoff: this.handoff };
      if (this.fail === "before") { this.fail = null; throw new Error("connection reset before the provider answered"); }
      native.get(payload.nativeCampaignId)!.status = this.outcome;
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: this.origin, providerStatus: this.outcome,
        rejectionCode: this.outcome === "REJECTED" ? "policy:synthetic-claim" : null };
      writes.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout after the provider accepted"); }
      return receipt;
    },
    mutate(key: string, payload: { nativeCampaignId: string; action: string; dailyBudgetMinor: number | null }, route: ExecRoute) {
      this.calls.mutate++; this.routes.push(route);
      if (this.fail === "before") { this.fail = null; throw new Error("connection reset"); }
      const n = native.get(payload.nativeCampaignId)!;
      if (payload.action === "pause") n.status = "PAUSED"; else n.dailyBudgetMinor = payload.dailyBudgetMinor;
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: this.origin, outcome: "applied", rejectionCode: null };
      writes.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout"); }
      return receipt;
    },
    read(key: string) { return writes.get(key) ?? null; },
    readBack(id: string) { const n = native.get(id); return n ? { ...n, observedAt: clock.toISOString() } : null; },
  };
  const authority: MediaAuthority = {
    account: (_p, r) => accounts.get(r) ?? null,
    capability: (b) => {
      const defaults = b.route === "api" ? { state: "Ready", evidence: "account-test" } : b.route === "mcp" ? { state: "Ready", evidence: "mcp-discovery" }
        : { state: "Unsupported", evidence: "documentation" };
      return { scope, provider: b.provider, providerAccountRef: b.providerAccountRef, environment: b.environment, operation: b.operation, route: b.route,
        sourceRef: `source:${b.route}-probe`, toolVersion: "tool:synthetic-1", receiptRef: `receipt:${b.operation}-${b.route}`, receiptOrigin: "synthetic",
        checkedAt: new Date(clock.getTime() - 60_000).toISOString(), expiresAt: new Date(clock.getTime() + 600_000).toISOString(),
        ...defaults, ...capabilities.get(`${b.operation}/${b.route}`) };
    },
    checkout: (r) => checkouts.get(r) ?? null, offer: (r) => offers.get(r) ?? null, asset: (r) => assets.get(r) ?? null,
    gate: (gate, subject) => {
      const over = gates.get(gate);
      if (over === null) return null;
      return { scope, gate, sourceRef: `gate:${gate}`, campaignId: subject.campaignId, manifestHash: subject.manifestHash, state: "verified",
        verifiedAt: "2026-11-06T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z", receiptOrigin: "synthetic", ...over };
    },
    decision: (r) => decisions.get(r) ?? null, safetyPolicy: (r) => policies.get(r) ?? null, executor,
  };
  const store = new AgentStore(":memory:", scope);
  const repo = new PaidMediaRepository(store.database, scope, authority, () => clock);
  const account = (over: Record<string, unknown> = {}) => {
    const a = { scope, provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox", kind: "advertiser", businessRef: "business:synthetic",
      market: "US", currency: "USD", timezone: "America/New_York", identityRef: "identity:synthetic-brand", identityApproved: true, sourceRef: "source:account-probe",
      receiptOrigin: "synthetic", observedAt: "2026-11-06T11:00:00Z", ...over };
    accounts.set(a.providerAccountRef as string, a);
  };
  const checkout = (over: Record<string, unknown> = {}) => {
    const c = { scope, checkoutRef: "checkout:site", kind: "website", skuRef: "sku:duo", destinationRef: "destination:pdp-duo", purchaseEventsVerified: true,
      shopAuthorizationVerified: false, sourceRef: "source:checkout-test", validUntil: "2026-12-31T00:00:00Z", ...over };
    checkouts.set(c.checkoutRef as string, c);
  };
  const offer = (over: Record<string, unknown> = {}) => {
    const o = { scope, offerRef: "offer:duo", version: "offer-v1", skuRef: "sku:duo", claimsVersion: "claims-v1", state: "approved", validUntil: "2026-12-31T00:00:00Z", ...over };
    offers.set(o.offerRef as string, o);
  };
  const asset = (over: Record<string, unknown> = {}, rights: Record<string, unknown> = {}) => {
    const a = { scope, assetRef: "asset:clip-1", contentHash: H("a"), claimsVersion: "claims-v1", reviewed: true,
      rights: { rightsRef: "rights:clip-1", rightsHash: H("b"), paidUsage: true, nativePermission: true, expiresAt: "2026-12-31T00:00:00Z", ...rights }, ...over };
    assets.set(a.assetRef as string, a);
  };
  const seed = () => { account(); checkout(); offer(); asset(); };
  const request = (over: Partial<PrepareInput> = {}): PrepareInput => ({
    campaignRef: "plan:launch-duo", provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox", campaignRoute: "meta-sales-purchase",
    checkoutRef: "checkout:site", offerRef: "offer:duo", creativeRefs: ["asset:clip-1"], destinationRef: "destination:pdp-duo", attributionSetting: "attribution:7d-click",
    schedule: { startAt: "2026-11-10T00:00:00Z", endAt: "2026-11-30T00:00:00Z" }, currency: "USD",
    targeting: { markets: ["US"], ageMin: 21, ageMax: 54, placements: ["placement:feed", "placement:reels"] },
    bid: { strategy: "lowest-cost", costCapMinor: null, targetRoasBps: null }, caps: { dailyBudgetMinor: 5000, lifetimeBudgetMinor: 50000 },
    expiresAt: "2026-11-20T00:00:00Z", ...over });
  const approve = (v: CampaignView, over: Record<string, unknown> = {}) => {
    const sourceRef = `j04:${v.campaignId}:r${v.revision}:${decisions.size}`;
    decisions.set(sourceRef, { scope, sourceRef, system: "linear", campaignId: v.campaignId, revision: v.revision, action: "publish", manifestHash: v.manifestHash,
      subjectHash: v.releaseHash, decision: "approved", state: "current",
      financialScope: { providerAccountRef: "adaccount:synthetic-1", campaignRoute: v.campaignRoute, currency: "USD", maxDailyBudgetMinor: 5000,
        maxLifetimeBudgetMinor: 100000, placements: ["placement:feed", "placement:reels"] },
      decidedAt: clock.toISOString(), validUntil: "2026-11-09T00:00:00Z", ...over });
    return sourceRef;
  };
  const approveMutation = (c: CampaignView, m: MutationView, over: Record<string, unknown> = {}) =>
    approve(c, { action: m.action, subjectHash: m.requestHash, ...over });
  return { policies, repo, store, seed, account, checkout, offer, asset, request, approve, approveMutation, decisions, gates, capabilities, native, writes, executor };
}
type World = ReturnType<typeof world>;
async function drafted(w: World, over: Partial<PrepareInput> = {}) {
  w.seed();
  const v = w.repo.prepare(w.request(over), "prepare-1");
  return w.repo.createDraft(v.campaignId, "draft-1");
}
async function approved(w: World) {
  const d = await drafted(w);
  return w.repo.decide(d.campaignId, w.approve(d), "decide-1");
}
async function released(w: World) {
  const a = await approved(w);
  return w.repo.publish(a.campaignId, "publish-1");
}

describe("account and per-operation capability inventory (acceptance 1 and 2)", () => {
  it("records the account and every operation on every route with source, tool version and receipt, labeled synthetic", () => {
    const w = world();
    w.seed();
    w.capabilities.set("publish/api", { state: "Denied", evidence: "account-test" });
    const inv = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "inv-1");
    expect(inv.account).toMatchObject({ market: "US", currency: "USD", timezone: "America/New_York", identityRef: "identity:synthetic-brand" });
    expect(inv.capabilities).toHaveLength(8 * 3);
    expect(new Set(inv.capabilities.map((c) => c.operation))).toEqual(new Set(["read-reports", "upload-creative", "preview-creative", "create-draft", "publish",
      "edit-budget", "pause", "retrieve-outcome"]));
    expect(inv.capabilities.find((c) => c.operation === "create-draft" && c.route === "api")).toMatchObject({ state: "Ready", sourceRef: "source:api-probe",
      toolVersion: "tool:synthetic-1", receiptRef: "receipt:create-draft-api" });
    expect(inv.capabilities.find((c) => c.operation === "publish" && c.route === "api")?.state).toBe("Denied");
    expect(inv.capabilities.find((c) => c.operation === "pause" && c.route === "browser")?.state).toBe("Unsupported");
    expect(inv.evidenceLabel).toBe("synthetic");
    expect(w.repo.latestInventory("meta", "sandbox", "adaccount:synthetic-1")?.inventoryId).toBe(inv.inventoryId);
  });
  it("treats MCP discovery, documentation, a missing receipt and an expired test as Unverified, never Ready", () => {
    const w = world();
    w.seed();
    w.capabilities.set("read-reports/api", { evidence: "documentation" });
    w.capabilities.set("pause/api", { receiptRef: null });
    w.capabilities.set("edit-budget/api", { expiresAt: "2026-11-06T11:59:00Z" });
    const inv = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "inv-1");
    const find = (op: string, route: string) => inv.capabilities.find((c) => c.operation === op && c.route === route)!;
    expect(find("publish", "mcp")).toMatchObject({ observedState: "Ready", state: "Unverified", reasons: ["MCP_DISCOVERY_IS_NOT_AUTHORIZATION"] });
    expect(find("read-reports", "api")).toMatchObject({ state: "Unverified", reasons: ["DOCUMENTATION_IS_NOT_AUTHORIZATION"] });
    expect(find("pause", "api")).toMatchObject({ state: "Unverified", reasons: ["TEST_RECEIPT_MISSING"] });
    expect(find("edit-budget", "api")).toMatchObject({ state: "Unverified", reasons: ["CAPABILITY_EXPIRED"] });
  });
  it("keeps an unknown market or timezone null and flags a wrong account without showing it", () => {
    const w = world();
    w.account({ market: null, timezone: null, identityApproved: false });
    const inv = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "inv-1");
    expect(inv.account).toMatchObject({ market: null, timezone: null });
    expect(inv.accountReasons).toEqual(["ACCOUNT_MARKET_UNKNOWN", "ACCOUNT_TIMEZONE_UNKNOWN", "IDENTITY_NOT_APPROVED"]);
    w.account({ providerAccountRef: "adaccount:synthetic-2", provider: "tiktok" });
    const wrong = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-2", environment: "sandbox" }, "inv-2");
    expect(wrong).toMatchObject({ account: null, accountReasons: ["ACCOUNT_MISMATCH"] });
  });
});

describe("route by actual checkout and native presets (acceptance 3)", () => {
  it("chooses Meta Sales, TikTok GMV Max with Shop authorization or Smart+ Web with purchase events", async () => {
    const w = world();
    expect((await drafted(w)).manifest).toMatchObject({ campaignRoute: "meta-sales-purchase", objective: "sales", optimizationEvent: "purchase" });
    w.account({ provider: "tiktok", providerAccountRef: "advertiser:synthetic-tt" });
    w.checkout({ checkoutRef: "checkout:shop", kind: "tiktok-shop", shopAuthorizationVerified: true, purchaseEventsVerified: false });
    const gmv = w.repo.prepare(w.request({ campaignRef: "plan:gmv", provider: "tiktok", providerAccountRef: "advertiser:synthetic-tt", campaignRoute: "tiktok-gmv-max-product",
      checkoutRef: "checkout:shop", bid: { strategy: "roas-target", costCapMinor: null, targetRoasBps: 25000 } }), "p-gmv");
    expect(gmv).toMatchObject({ state: "draft", manifest: { objective: "product-gmv-max" } });
    const web = w.repo.prepare(w.request({ campaignRef: "plan:web", provider: "tiktok", providerAccountRef: "advertiser:synthetic-tt",
      campaignRoute: "tiktok-smart-plus-web-sales" }), "p-web");
    expect(web).toMatchObject({ state: "draft", manifest: { objective: "web-sales", optimizationEvent: "purchase" } });
  });
  it("holds an unsupported route: the wrong checkout, unverified Shop authorization, missing purchase events or a mismatched choice", () => {
    const w = world();
    w.seed();
    w.checkout({ checkoutRef: "checkout:shop", kind: "tiktok-shop", shopAuthorizationVerified: false });
    expect(w.repo.prepare(w.request({ checkoutRef: "checkout:shop" }), "k1").heldReasons).toContain("ROUTE_UNSUPPORTED_FOR_CHECKOUT");
    w.account({ provider: "tiktok", providerAccountRef: "advertiser:synthetic-tt" });
    const tt = { provider: "tiktok" as const, providerAccountRef: "advertiser:synthetic-tt", campaignRoute: "tiktok-gmv-max-product" as const, checkoutRef: "checkout:shop",
      bid: { strategy: "roas-target" as const, costCapMinor: null, targetRoasBps: 25000 } };
    expect(w.repo.prepare(w.request({ campaignRef: "plan:tt", ...tt }), "k2").heldReasons).toContain("SHOP_AUTHORIZATION_UNVERIFIED");
    w.checkout({ purchaseEventsVerified: false });
    expect(w.repo.prepare(w.request({ campaignRef: "plan:site" }), "k3").heldReasons).toContain("PURCHASE_EVENTS_UNVERIFIED");
    w.checkout();
    const wrong = w.repo.prepare(w.request({ campaignRef: "plan:wrong", ...tt, checkoutRef: "checkout:site" }), "k4");
    expect(wrong.heldReasons).toContain("ROUTE_DOES_NOT_MATCH_CHECKOUT");
    expect(w.executor.calls.createDraft).toBe(0);
  });
  it("holds a draft whose native preset adds delivery budget, Max Delivery, auto-recharge or placement expansion", async () => {
    const w = world();
    w.executor.preset = { maxDelivery: true, extraDeliveryBudget: true, autoRecharge: true, placementExpansion: true, placements: ["placement:feed", "placement:reels", "placement:network"] };
    const view = await drafted(w);
    expect(view).toMatchObject({ state: "held", releaseRequested: false, releaseHash: null, sourceEffects: "draft-created" });
    expect(view.heldReasons).toEqual(expect.arrayContaining(["READBACK_MISMATCH:MAX_DELIVERY", "READBACK_MISMATCH:EXTRA_DELIVERY_BUDGET",
      "READBACK_MISMATCH:AUTO_RECHARGE", "READBACK_MISMATCH:PLACEMENT_EXPANSION", "READBACK_MISMATCH:PLACEMENTS"]));
    expect(() => w.repo.decide(view.campaignId, w.approve(view), "d")).toThrow("RELEASE_NOT_REQUESTED");
  });
});

describe("immutable manifest, native draft and read-back (acceptance 4)", () => {
  it("compiles the full manifest, stores native IDs and reads settings back before requesting release", async () => {
    const w = world();
    const view = await drafted(w);
    expect(view.manifest).toMatchObject({
      account: { providerAccountRef: "adaccount:synthetic-1", market: "US", currency: "USD", timezone: "America/New_York", identityRef: "identity:synthetic-brand" },
      checkout: { checkoutRef: "checkout:site", skuRef: "sku:duo" }, offer: { offerRef: "offer:duo", version: "offer-v1", claimsVersion: "claims-v1" },
      creatives: [{ assetRef: "asset:clip-1", contentHash: H("a"), rightsHash: H("b"), rightsExpiresAt: "2026-12-31T00:00:00Z" }],
      destinationRef: "destination:pdp-duo", attributionSetting: "attribution:7d-click", caps: { dailyBudgetMinor: 5000, lifetimeBudgetMinor: 50000 },
      deliveryExtras: { extraDeliveryBudget: false, maxDelivery: false, autoRecharge: false, placementExpansion: false },
    });
    expect(view).toMatchObject({ state: "draft", releaseRequested: true, native: { nativeCampaignId: "native:campaign-1", previewRef: "preview:native:campaign-1",
      status: "PAUSED" }, sourceEffects: "draft-created" });
    expect(view.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(view.receipts.map((r) => r.kind)).toEqual(["draft", "readback"]);
    expect(await w.repo.createDraft(view.campaignId, "draft-again")).toEqual(view);
    expect(w.executor.calls.createDraft).toBe(1);
  });
  it("makes a new revision and clears approval when an asset changes, and refuses publish on an offer changed under it", async () => {
    const w = world();
    const a = await approved(w);
    expect(a.approval.decision).toBe("approved");
    w.asset({ contentHash: H("c") });
    const r2 = w.repo.prepare(w.request(), "prepare-2");
    expect(r2).toMatchObject({ revision: 2, state: "draft", releaseRequested: false, approval: { decision: "none", decisionRef: null } });
    expect(r2.manifestHash).not.toBe(a.manifestHash);
    expect(w.repo.read(a.campaignId)!.native.nativeCampaignId).toBe("native:campaign-1");
    const d2 = await w.repo.createDraft(r2.campaignId, "draft-2");
    expect(d2.native.nativeCampaignId).toBe("native:campaign-1");
    w.repo.decide(d2.campaignId, w.approve(d2), "decide-2");
    w.offer({ version: "offer-v2" });
    await expect(w.repo.publish(d2.campaignId, "publish-1")).rejects.toThrow("MANIFEST_SOURCES_CHANGED");
    expect(w.executor.calls.publish).toBe(0);
  });
  it("holds expired rights or rights that end before the schedule, and refuses publish once rights have expired", async () => {
    const w = world();
    w.seed();
    w.asset({}, { expiresAt: "2026-11-01T00:00:00Z" });
    expect(w.repo.prepare(w.request(), "k1").heldReasons).toContain("RIGHTS_EXPIRED:asset:clip-1");
    w.asset({}, { expiresAt: "2026-11-20T00:00:00Z" });
    expect(w.repo.prepare(w.request(), "k2").heldReasons).toContain("RIGHTS_EXPIRE_BEFORE_SCHEDULE_END:asset:clip-1");
    w.asset({}, { expiresAt: "2026-11-30T00:00:00Z" });
    const ok = w.repo.prepare(w.request(), "k3");
    const d = await w.repo.createDraft(ok.campaignId, "draft");
    w.repo.decide(d.campaignId, w.approve(d, { validUntil: "2026-12-31T00:00:00Z" }), "decide");
    at("2026-11-30T00:00:01Z");
    await expect(w.repo.publish(d.campaignId, "publish")).rejects.toThrow("RIGHTS_EXPIRED");
    expect(w.executor.calls.publish).toBe(0);
  });
  it("holds a wrong account, and treats a read-back for another account as unreadable", async () => {
    const w = world();
    w.seed();
    w.account({ providerAccountRef: "adaccount:synthetic-1", environment: "production" });
    expect(w.repo.prepare(w.request(), "k1")).toMatchObject({ state: "held", manifest: null, heldReasons: ["ACCOUNT_MISMATCH"] });
    w.account();
    w.executor.preset = { providerAccountRef: "adaccount:synthetic-other" };
    const v = w.repo.prepare(w.request(), "k2");
    const held = await w.repo.createDraft(v.campaignId, "draft");
    expect(held).toMatchObject({ state: "held", heldReasons: ["READBACK_UNAVAILABLE"], releaseRequested: false });
  });
});

describe("dispatch only with J04 Linear approval and the five media gates (acceptance 5)", () => {
  it("never activates spend while drafting and refuses publish without approval", async () => {
    const w = world();
    const d = await drafted(w);
    expect(w.native.get(d.native.nativeCampaignId!)!.status).toBe("PAUSED");
    await expect(w.repo.publish(d.campaignId, "publish")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(w.executor.calls.publish).toBe(0);
    expect(w.repo.read(d.campaignId)!.sourceEffects).toBe("draft-created");
  });
  it("refuses a Slack or Notion decision alone", async () => {
    const w = world();
    const d = await drafted(w);
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { system: "slack" }), "d1")).toThrow("J04_LINEAR_DECISION_REQUIRED");
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { system: "notion" }), "d2")).toThrow("J04_LINEAR_DECISION_REQUIRED");
    expect(() => w.repo.decide(d.campaignId, "j04:unknown", "d3")).toThrow("J04_DECISION_UNVERIFIED");
  });
  it("refuses a stale approval: another revision, a revoked decision, one made before the request, or one that has lapsed", async () => {
    const w = world();
    const d1 = await drafted(w);
    const old = w.approve(d1);
    w.repo.prepare(w.request({ caps: { dailyBudgetMinor: 4000, lifetimeBudgetMinor: 50000 } }), "prepare-2");
    const d2 = await w.repo.createDraft(d1.campaignId, "draft-2");
    expect(() => w.repo.decide(d2.campaignId, old, "d1")).toThrow("J04_DECISION_FOR_ANOTHER_REQUEST");
    expect(() => w.repo.decide(d2.campaignId, w.approve(d2, { state: "revoked" }), "d2")).toThrow("J04_DECISION_NOT_CURRENT");
    expect(() => w.repo.decide(d2.campaignId, w.approve(d2, { decidedAt: "2026-11-01T00:00:00Z" }), "d3")).toThrow("J04_DECISION_PREDATES_REQUEST");
    const ok = w.approve(d2);
    w.repo.decide(d2.campaignId, ok, "d4");
    at("2026-11-09T00:00:01Z");
    await expect(w.repo.publish(d2.campaignId, "publish")).rejects.toThrow("J04_DECISION_NOT_CURRENT");
    expect(w.executor.calls.publish).toBe(0);
  });
  it("refuses a denied scope: a budget beyond the approved financial scope, or approval for another account or placement", async () => {
    const w = world();
    const d = await drafted(w);
    const fs = { providerAccountRef: "adaccount:synthetic-1", campaignRoute: "meta-sales-purchase", currency: "USD", maxDailyBudgetMinor: 4000,
      maxLifetimeBudgetMinor: 100000, placements: ["placement:feed", "placement:reels"] };
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { financialScope: fs }), "d1")).toThrow("FINANCIAL_SCOPE_EXCEEDED");
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { financialScope: { ...fs, maxDailyBudgetMinor: 5000, providerAccountRef: "adaccount:synthetic-other" } }), "d2"))
      .toThrow("APPROVED_SCOPE_MISMATCH");
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { financialScope: { ...fs, maxDailyBudgetMinor: 5000, placements: ["placement:feed"] } }), "d3"))
      .toThrow("APPROVED_SCOPE_MISMATCH");
    expect(w.repo.read(d.campaignId)!.state).toBe("draft");
  });
  it("needs all five gates verified and unexpired for this manifest, and shows which are not", async () => {
    const w = world();
    const a = await approved(w);
    w.gates.set("attribution-dedup-refunds", null);
    w.gates.set("fulfillment-support-cash", { expiresAt: "2026-11-06T00:00:00Z" });
    w.gates.set("qualified-product-stock", { manifestHash: H("f") });
    w.gates.set("reviewed-content-paid-rights", { state: "held" });
    await expect(w.repo.publish(a.campaignId, "publish")).rejects.toThrow("MEDIA_GATES_NOT_VERIFIED");
    expect(Object.fromEntries(w.repo.read(a.campaignId)!.gates.map((g) => [g.gate, g.state]))).toEqual({
      "qualified-product-stock": "mismatch", "reviewed-content-paid-rights": "held", "actual-offer-checkout": "verified",
      "attribution-dedup-refunds": "missing", "fulfillment-support-cash": "expired" });
    expect(w.executor.calls.publish).toBe(0);
    w.gates.clear();
    expect((await w.repo.publish(a.campaignId, "publish-2")).state).toBe("confirmed");
  });
  it("refuses a native draft edited outside Farda after approval, and holds the production environment", async () => {
    const w = world();
    const a = await approved(w);
    w.native.get(a.native.nativeCampaignId!)!.dailyBudgetMinor = 9000;
    const held = await w.repo.publish(a.campaignId, "publish");
    expect(held).toMatchObject({ state: "held", heldReasons: ["READBACK_MISMATCH:DAILY_BUDGET"], sourceEffects: "draft-created" });
    expect(w.executor.calls.publish).toBe(0);
    const p = world();
    p.seed(); p.account({ environment: "production" });
    const prod = p.repo.prepare(p.request({ environment: "production" }), "k");
    expect(prod).toMatchObject({ state: "held", heldReasons: ["PRODUCTION_HELD"] });
    await expect(p.repo.createDraft(prod.campaignId, "draft")).rejects.toThrow("CAMPAIGN_HELD");
    expect(p.executor.calls.createDraft).toBe(0);
  });
  it("holds the execution lease while a publish is applying", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.during = async () => {
      expect(w.repo.read(a.campaignId)!.state).toBe("applying");
      await expect(w.repo.publish(a.campaignId, "publish-concurrent")).rejects.toThrow("EXECUTION_IN_PROGRESS");
    };
    expect((await w.repo.publish(a.campaignId, "publish-1")).state).toBe("confirmed");
    expect(w.executor.calls.publish).toBe(1);
  });
});

describe("idempotent writes, mutations and reconciliation (acceptance 6)", () => {
  it("never duplicates a publish: a repeated event returns the same confirmed campaign", async () => {
    const w = world();
    const first = await released(w);
    expect(first).toMatchObject({ state: "confirmed", sourceEffects: "publish-attempted", providerReview: { state: "active" }, execution: { reconciledBy: "receipt" } });
    expect(await w.repo.publish(first.campaignId, "publish-2")).toEqual(first);
    expect(w.executor.calls.publish).toBe(1);
    expect(() => w.repo.prepare(w.request({ caps: { dailyBudgetMinor: 3000, lifetimeBudgetMinor: 50000 } }), "prepare-again")).toThrow("CAMPAIGN_ALREADY_RELEASED");
    expect(w.repo.prepare(w.request(), "prepare-1").campaignId).toBe(first.campaignId);
    expect(() => w.repo.prepare(w.request({ campaignRef: "plan:other" }), "prepare-1")).toThrow("IDEMPOTENCY_KEY_REUSED");
  });
  it("reads an uncertain publish back by its key before retrying, so an accepted publish is not repeated", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.fail = "after";
    await settle(w.repo.publish(a.campaignId, "publish-1"));
    expect(w.repo.read(a.campaignId)).toMatchObject({ state: "uncertain", sourceEffects: "publish-attempted", execution: { pending: true } });
    expect(() => w.repo.prepare(w.request({ caps: { dailyBudgetMinor: 3000, lifetimeBudgetMinor: 50000 } }), "p2")).toThrow("RECONCILE_FIRST");
    const resolved = await w.repo.publish(a.campaignId, "publish-again");
    expect(resolved).toMatchObject({ state: "confirmed", execution: { reconciledBy: "receipt" } });
    expect(w.executor.calls.publish).toBe(1);
  });
  it("reconciles by the native campaign when the keyed receipt is lost, and retries only when nothing happened and approval still holds", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.fail = "after";
    await settle(w.repo.publish(a.campaignId, "publish-1"));
    w.writes.delete(`publish:${a.campaignId}:r1`);
    expect(await w.repo.publish(a.campaignId, "publish-2")).toMatchObject({ state: "confirmed", execution: { reconciledBy: "native-readback" } });
    expect(w.executor.calls.publish).toBe(1);

    const v = world();
    const b = await approved(v);
    v.executor.fail = "before";
    await settle(v.repo.publish(b.campaignId, "publish-1"));
    expect(v.repo.read(b.campaignId)!.state).toBe("uncertain");
    expect((await v.repo.publish(b.campaignId, "publish-2")).state).toBe("confirmed");
    expect(v.executor.calls.publish).toBe(2);
    expect([...v.writes.keys()].filter((k) => k.startsWith("publish:"))).toEqual([`publish:${b.campaignId}:r1`]);
  });
  it("records before and after native state with the receipt for an approved budget edit, once", async () => {
    const w = world();
    const c = await released(w);
    const m = w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 4000 }, "m1");
    expect(m).toMatchObject({ state: "draft", sourceEffects: "none" });
    expect(w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 4000 }, "m1-repeat").mutationId).toBe(m.mutationId);
    await expect(w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: w.approve(c) }, "a0")).rejects.toThrow("J04_DECISION_FOR_ANOTHER_REQUEST");
    const ref = w.approveMutation(c, m);
    const done = await w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: ref }, "a1");
    expect(done).toMatchObject({ state: "confirmed", before: { dailyBudgetMinor: 5000 }, after: { dailyBudgetMinor: 4000 }, receiptRef: `receipt:edit-budget:${m.mutationId}`,
      sourceEffects: "mutation-attempted", evidenceLabel: "synthetic" });
    expect(done.history.map((h) => h.state)).toEqual(["draft", "approved", "applying", "confirmed"]);
    expect(await w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: ref }, "a2")).toEqual(done);
    expect(w.executor.calls.mutate).toBe(1);
    expect(w.repo.read(c.campaignId)!.mutations).toEqual([{ mutationId: m.mutationId, action: "edit-budget", state: "confirmed" }]);
  });
  it("holds a budget edit beyond the approved financial scope", async () => {
    const w = world();
    const c = await released(w);
    const m = w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 6000 }, "m1");
    expect(m).toMatchObject({ state: "held", heldReasons: ["FINANCIAL_SCOPE_EXCEEDED"] });
    await expect(w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: w.approveMutation(c, m) }, "a")).rejects.toThrow("MUTATION_HELD");
    expect(w.executor.calls.mutate).toBe(0);
  });
  it("reconciles an uncertain pause by its key before any retry", async () => {
    const w = world();
    const c = await released(w);
    const m = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    const ref = w.approveMutation(c, m);
    w.executor.fail = "after";
    await settle(w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: ref }, "a1"));
    expect(w.repo.readMutation(c.campaignId, m.mutationId)).toMatchObject({ state: "uncertain", sourceEffects: "mutation-attempted" });
    await expect(w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: w.approveMutation(c, m) }, "a2")).rejects.toThrow("MUTATION_BOUND_TO_ANOTHER_AUTHORIZATION");
    const done = await w.repo.applyMutation(c.campaignId, m.mutationId, { decisionRef: ref }, "a3");
    expect(done).toMatchObject({ state: "confirmed", reconciledBy: "receipt", before: { status: "ACTIVE" }, after: { status: "PAUSED" } });
    expect(w.executor.calls.mutate).toBe(1);
    expect(w.repo.read(c.campaignId)!.native.status).toBe("PAUSED");
  });
});

describe("no browser bypass of a denied API (acceptance 7)", () => {
  it("never uses a browser route when the API capability is Denied or merely Unverified", async () => {
    const w = world();
    const a = await approved(w);
    w.capabilities.set("publish/api", { state: "Denied" });
    w.capabilities.set("publish/browser", { state: "Ready", evidence: "account-test" });
    await expect(w.repo.publish(a.campaignId, "p1")).rejects.toThrow("PUBLISH_CAPABILITY_DENIED");
    w.capabilities.set("publish/api", { state: "Unverified" });
    await expect(w.repo.publish(a.campaignId, "p2")).rejects.toThrow("PUBLISH_CAPABILITY_UNVERIFIED");
    w.capabilities.set("publish/api", { state: "Unsupported" });
    w.capabilities.set("publish/mcp", { state: "Unsupported" });
    w.capabilities.set("publish/browser", { state: "Unsupported" });
    await expect(w.repo.publish(a.campaignId, "p3")).rejects.toThrow("PUBLISH_CAPABILITY_UNSUPPORTED");
    expect(w.executor.calls.publish).toBe(0);
    expect(w.repo.read(a.campaignId)!.state).toBe("approved");
  });
  it("uses an independently Ready browser route for a missing capability, hands MFA or CAPTCHA to a person and confirms by source read-back", async () => {
    const w = world();
    const a = await approved(w);
    w.capabilities.set("publish/api", { state: "Unsupported" });
    w.capabilities.set("publish/mcp", { state: "Unsupported" });
    w.capabilities.set("publish/browser", { state: "Ready", evidence: "account-test" });
    w.executor.handoff = "captcha";
    const held = await w.repo.publish(a.campaignId, "p1");
    expect(held).toMatchObject({ state: "held", heldReasons: ["BROWSER_HANDOFF_CAPTCHA"], execution: { route: "browser", pending: true } });
    expect(w.executor.routes.at(-1)).toBe("browser");
    // A person completes the step in the provider's interface. Farda confirms only from the source.
    w.executor.handoff = null;
    w.native.get(a.native.nativeCampaignId!)!.status = "ACTIVE";
    const confirmed = await w.repo.publish(a.campaignId, "p2");
    expect(confirmed).toMatchObject({ state: "confirmed", execution: { reconciledBy: "native-readback" }, native: { status: "ACTIVE" } });
    expect(w.executor.calls.publish).toBe(1);
  });
});

describe("visible states and labeled receipts (acceptance 8 and 9)", () => {
  it("keeps provider rejection distinct from Farda approval and Farda rejection", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.outcome = "REJECTED";
    const rejected = await w.repo.publish(a.campaignId, "p1");
    expect(rejected).toMatchObject({ state: "provider-rejected", approval: { decision: "approved" },
      providerReview: { state: "rejected", rejectionCode: "policy:synthetic-claim" } });
    expect(rejected.history.map((h) => h.state)).toEqual(["draft", "draft", "approved", "applying", "provider-rejected"]);
    await expect(w.repo.publish(a.campaignId, "p2")).rejects.toThrow("PROVIDER_REJECTED_REVISE_FIRST");

    const v = world();
    const d = await drafted(v);
    const farda = v.repo.decide(d.campaignId, v.approve(d, { decision: "rejected" }), "d");
    expect(farda).toMatchObject({ state: "rejected", approval: { decision: "rejected" }, providerReview: { state: "not-submitted" } });
    await expect(v.repo.publish(d.campaignId, "p")).rejects.toThrow("J04_APPROVAL_REQUIRED");
  });
  it("labels synthetic and account-backed receipts separately", async () => {
    const w = world();
    expect((await released(w)).evidenceLabel).toBe("synthetic");
    const v = world();
    v.executor.origin = "account";
    const mixed = await drafted(v);
    expect(mixed.receipts.map((r) => r.origin)).toEqual(["account", "account"]);
    expect(mixed.evidenceLabel).toBe("account-backed");
  });
});

describe("review regressions", () => {
  it("R1 re-reads the native draft before a retried publish and holds an edited draft instead of publishing it", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.fail = "before";
    await settle(w.repo.publish(a.campaignId, "x1"));
    const n = w.native.get(a.native.nativeCampaignId!)!;
    n.dailyBudgetMinor = 90000; n.maxDelivery = true; n.autoRecharge = true;
    const held = await w.repo.publish(a.campaignId, "x2");
    expect(held).toMatchObject({ state: "held", execution: { pending: false } });
    expect(held.heldReasons).toEqual(expect.arrayContaining(["READBACK_MISMATCH:DAILY_BUDGET", "READBACK_MISMATCH:MAX_DELIVERY", "READBACK_MISMATCH:AUTO_RECHARGE"]));
    expect(w.executor.calls.publish).toBe(1);
    expect(n.status).toBe("PAUSED");
  });
  it("R1 holds a first publish when the identity, ads or preview changed on the native draft", async () => {
    const w = world();
    const a = await approved(w);
    w.native.get(a.native.nativeCampaignId!)!.identityRef = "identity:someone-else";
    expect((await w.repo.publish(a.campaignId, "p1")).heldReasons).toEqual(["READBACK_MISMATCH:IDENTITY"]);
    const v = world();
    const b = await approved(v);
    v.native.get(b.native.nativeCampaignId!)!.previewRef = "preview:swapped";
    expect((await v.repo.publish(b.campaignId, "p1")).heldReasons).toEqual(["READBACK_MISMATCH:NATIVE_ADS"]);
    expect(w.executor.calls.publish + v.executor.calls.publish).toBe(0);
  });
  it("R2 reconciles an uncertain publish after its decision lapses and returns it to draft for a new decision", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.fail = "before";
    await settle(w.repo.publish(a.campaignId, "x1"));
    at("2026-11-09T00:00:01Z");
    const back = await w.repo.publish(a.campaignId, "x2");
    expect(back).toMatchObject({ state: "draft", releaseRequested: true, approval: { decision: "none" }, execution: { pending: false } });
    expect(back.heldReasons).toEqual(["NEW_DECISION_REQUIRED", "J04_DECISION_NOT_CURRENT"]);
    expect(w.executor.calls.publish).toBe(1);
    w.repo.decide(back.campaignId, w.approve(back, { validUntil: "2026-11-09T12:00:00Z" }), "decide-2");
    expect((await w.repo.publish(a.campaignId, "x3")).state).toBe("confirmed");
  });
  it("R3 pauses under a safety policy while a budget edit is uncertain, then closes the lapsed edit as not applied", async () => {
    const w = world();
    const c = await released(w);
    const edit = w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 4000 }, "m1");
    const editRef = w.approveMutation(c, edit);
    w.executor.fail = "before";
    await settle(w.repo.applyMutation(c.campaignId, edit.mutationId, { decisionRef: editRef }, "a1"));
    at("2026-11-09T00:00:01Z");
    const pause = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m2");
    const paused = await w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a2");
    expect(paused).toMatchObject({ state: "confirmed", authorizedBy: "safety-policy", policyRef: "policy:auto-pause", before: { status: "ACTIVE" }, after: { status: "PAUSED" } });
    const closed = await w.repo.applyMutation(c.campaignId, edit.mutationId, { decisionRef: editRef }, "a3");
    expect(closed).toMatchObject({ state: "not-applied", heldReasons: ["J04_DECISION_NOT_CURRENT"] });
    expect(w.executor.calls.mutate).toBe(2);
  });
  it("R3 pauses a draft the provider activated, and limits a safety policy to pausing its own accounts", async () => {
    const w = world();
    w.executor.preset = { status: "ACTIVE" };
    const d = await drafted(w);
    expect(d.heldReasons).toContain("DRAFT_ACTIVE_ON_PROVIDER");
    const pause = w.repo.proposeMutation(d.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    w.policies.set("policy:revoked", { ...(w.policies.get("policy:auto-pause") as object), policyRef: "policy:revoked", state: "revoked" });
    w.policies.set("policy:other", { ...(w.policies.get("policy:auto-pause") as object), policyRef: "policy:other", accounts: [{ provider: "meta", providerAccountRef: "adaccount:synthetic-other", environment: "sandbox" }] });
    await expect(w.repo.applyMutation(d.campaignId, pause.mutationId, { policyRef: "policy:revoked" }, "a1")).rejects.toThrow("SAFETY_POLICY_NOT_CURRENT");
    await expect(w.repo.applyMutation(d.campaignId, pause.mutationId, { policyRef: "policy:other" }, "a2")).rejects.toThrow("SAFETY_POLICY_SCOPE_MISMATCH");
    await expect(w.repo.applyMutation(d.campaignId, pause.mutationId, { policyRef: "policy:unknown" }, "a3")).rejects.toThrow("SAFETY_POLICY_UNVERIFIED");
    expect(await w.repo.applyMutation(d.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a4")).toMatchObject({ state: "confirmed" });
    expect(w.native.get(d.native.nativeCampaignId!)!.status).toBe("PAUSED");
  });
  it("R3 refuses a safety policy for a budget edit", async () => {
    const w = world();
    const c = await released(w);
    const edit = w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 4000 }, "m1");
    await expect(w.repo.applyMutation(c.campaignId, edit.mutationId, { policyRef: "policy:auto-pause" }, "a1")).rejects.toThrow("SAFETY_POLICY_ONLY_PAUSES");
    expect(w.executor.calls.mutate).toBe(0);
  });
  it("R4 moves a native draft recovered after an uncertain write, or after a browser handoff, back to draft", async () => {
    const w = world();
    w.seed();
    const v = w.repo.prepare(w.request(), "p1");
    w.executor.draftFail = true;
    await settle(w.repo.createDraft(v.campaignId, "d1"));
    expect(w.repo.read(v.campaignId)!.state).toBe("uncertain");
    const recovered = await w.repo.createDraft(v.campaignId, "d2");
    expect(recovered).toMatchObject({ state: "draft", releaseRequested: true, execution: { pending: false } });
    expect(w.repo.decide(v.campaignId, w.approve(recovered), "dec").state).toBe("approved");

    const b = world();
    b.seed();
    for (const route of ["api", "mcp"]) b.capabilities.set(`create-draft/${route}`, { state: "Unsupported" });
    b.capabilities.set("create-draft/browser", { state: "Ready", evidence: "account-test" });
    const bv = b.repo.prepare(b.request(), "p1");
    b.executor.draftHandoff = "mfa";
    expect(await b.repo.createDraft(bv.campaignId, "d1")).toMatchObject({ state: "held", heldReasons: ["BROWSER_HANDOFF_MFA"] });
    b.executor.draftHandoff = null;
    expect(await b.repo.createDraft(bv.campaignId, "d2")).toMatchObject({ state: "draft", releaseRequested: true, heldReasons: [] });
  });
  it("R5 ignores a late result after another worker took over an expired lease", async () => {
    const w = world();
    const a = await approved(w);
    let inner: CampaignView | undefined;
    w.executor.during = async () => { at("2026-11-06T12:03:00Z"); inner = await w.repo.publish(a.campaignId, "B"); };
    const late = await w.repo.publish(a.campaignId, "A");
    expect(inner?.state).toBe("confirmed");
    expect(late).toEqual(w.repo.read(a.campaignId));
    expect(late.history.filter((h) => h.state === "confirmed")).toHaveLength(1);
    expect([...w.writes.keys()].filter((k) => k.startsWith("publish:"))).toEqual([`publish:${a.campaignId}:r1`]);
  });
  it("R7 refuses publish once the request has expired or the schedule start has passed", async () => {
    const w = world();
    const d = await drafted(w);
    w.repo.decide(d.campaignId, w.approve(d, { validUntil: "2026-12-31T00:00:00Z" }), "dec");
    at("2026-11-21T00:00:00Z");
    await expect(w.repo.publish(d.campaignId, "p1")).rejects.toThrow("REQUEST_EXPIRED");
    const v = world();
    const e = await drafted(v);
    v.repo.decide(e.campaignId, v.approve(e, { validUntil: "2026-12-31T00:00:00Z" }), "dec");
    at("2026-11-10T00:00:01Z");
    await expect(v.repo.publish(e.campaignId, "p1")).rejects.toThrow("SCHEDULE_START_PASSED");
    expect(w.executor.calls.publish + v.executor.calls.publish).toBe(0);
  });
  it("R8 binds each idempotency key to one action", async () => {
    const w = world();
    const a = await approved(w);
    await expect(w.repo.publish(a.campaignId, "draft-1")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    await expect(w.repo.publish(a.campaignId, "prepare-1")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    const c = await w.repo.publish(a.campaignId, "publish-1");
    const m = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    await expect(w.repo.applyMutation(c.campaignId, m.mutationId, { policyRef: "policy:auto-pause" }, "publish-1")).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");
    expect(w.executor.calls.mutate).toBe(0);
  });
  it("R9 rechecks the financial scope before re-sending a budget edit, and never needs a budget for a pause", async () => {
    const w = world();
    const c = await released(w);
    const edit = w.repo.proposeMutation(c.campaignId, { kind: "edit-budget", dailyBudgetMinor: 4000 }, "m1");
    const ref = w.approveMutation(c, edit);
    w.executor.fail = "before";
    await settle(w.repo.applyMutation(c.campaignId, edit.mutationId, { decisionRef: ref }, "a1"));
    const d = w.decisions.get(ref) as { financialScope: object };
    w.decisions.set(ref, { ...d, financialScope: { ...d.financialScope, maxDailyBudgetMinor: 3000 } });
    expect(await w.repo.applyMutation(c.campaignId, edit.mutationId, { decisionRef: ref }, "a2")).toMatchObject({ state: "not-applied",
      heldReasons: ["FINANCIAL_SCOPE_EXCEEDED"] });
    expect(w.executor.calls.mutate).toBe(1);
    const pause = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m2");
    const pref = w.approveMutation(c, pause, { financialScope: { ...d.financialScope, maxDailyBudgetMinor: 0 } });
    expect(await w.repo.applyMutation(c.campaignId, pause.mutationId, { decisionRef: pref }, "a3")).toMatchObject({ state: "confirmed", authorizedBy: "j04" });
  });
});

describe("second review regressions", () => {
  it("S1 never accepts an impossible timestamp offset, so decisions, policies, gates and capabilities still expire", async () => {
    const w = world();
    const d = await drafted(w);
    expect(() => w.repo.decide(d.campaignId, w.approve(d, { validUntil: "2026-11-07T00:00:00+99:99" }), "d1")).toThrow("J04_DECISION_UNVERIFIED");
    const a = w.repo.decide(d.campaignId, w.approve(d), "d2");
    w.gates.set("fulfillment-support-cash", { expiresAt: "2026-11-06T12:00:01+99:00" });
    await expect(w.repo.publish(a.campaignId, "p1")).rejects.toThrow("MEDIA_GATES_NOT_VERIFIED");
    expect(w.repo.read(a.campaignId)!.gates.find((g) => g.gate === "fulfillment-support-cash")!.state).toBe("missing");
    w.capabilities.set("pause/api", { expiresAt: "2026-11-06T12:10:00+24:00" });
    const inv = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "inv");
    expect(inv.capabilities.find((c) => c.operation === "pause" && c.route === "api")?.state).toBe("Unverified");
    const v = world();
    const c = await released(v);
    v.policies.set("policy:odd", { ...(v.policies.get("policy:auto-pause") as object), policyRef: "policy:odd", validUntil: "2026-11-06T12:00:01+24:00" });
    const pause = v.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    await expect(v.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:odd" }, "a1")).rejects.toThrow("SAFETY_POLICY_UNVERIFIED");
    expect(v.executor.calls.mutate).toBe(0);
  });
  it("S2 never lets a publish retry undo a confirmed pause, and needs a fresh decision to re-release", async () => {
    const w = world();
    const a = await approved(w);
    w.executor.fail = "before";
    await settle(w.repo.publish(a.campaignId, "publish-1"));
    const n = w.native.get(a.native.nativeCampaignId!)!;
    n.status = "ACTIVE";
    const pause = w.repo.proposeMutation(a.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    expect((await w.repo.applyMutation(a.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a1")).state).toBe("confirmed");
    const after = await w.repo.publish(a.campaignId, "publish-2");
    expect(after).toMatchObject({ state: "draft", releaseRequested: true, approval: { decision: "none" }, execution: { pending: false } });
    expect(after.heldReasons).toEqual(["NEW_DECISION_REQUIRED", "SUPERSEDED_BY_PAUSE"]);
    expect(w.executor.calls.publish).toBe(1);
    expect(n.status).toBe("PAUSED");

    const v = world();
    const b = await approved(v);
    v.native.get(b.native.nativeCampaignId!)!.status = "ACTIVE";
    const p2 = v.repo.proposeMutation(b.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    await v.repo.applyMutation(b.campaignId, p2.mutationId, { policyRef: "policy:auto-pause" }, "a1");
    expect(v.repo.read(b.campaignId)).toMatchObject({ state: "draft", approval: { decision: "none" } });
    await expect(v.repo.publish(b.campaignId, "publish-1")).rejects.toThrow("J04_APPROVAL_REQUIRED");
    expect(v.executor.calls.publish).toBe(0);
  });
  it("S3 treats a read-back for another campaign or account, or one observed out of time, as unreadable", async () => {
    const w = world();
    const c = await released(w);
    const id = c.native.nativeCampaignId!, real = w.native.get(id)!;
    const pause = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    w.executor.fail = "before";
    await settle(w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a1"));
    const readBack = w.executor.readBack;
    w.executor.readBack = () => ({ ...real, nativeCampaignId: "native:other", providerAccountRef: "adaccount:someone-else", status: "PAUSED", observedAt: "2026-11-01T00:00:00Z" });
    await settle(w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a2"));
    w.executor.readBack = () => ({ ...real, status: "PAUSED", observedAt: "2026-11-01T00:00:00Z" });
    await settle(w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a3"));
    expect(w.repo.readMutation(c.campaignId, pause.mutationId)!.state).toBe("uncertain");
    expect(real.status).toBe("ACTIVE");
    w.executor.readBack = readBack;
    expect(await w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:auto-pause" }, "a4")).toMatchObject({ state: "confirmed", after: { status: "PAUSED" } });

    const v = world();
    const b = await approved(v);
    v.executor.readBack = (nid: string) => ({ ...v.native.get(nid)!, observedAt: "2026-11-06T13:00:00Z" });
    await expect(v.repo.publish(b.campaignId, "p1")).rejects.toThrow("NATIVE_READBACK_UNAVAILABLE");
    expect(v.executor.calls.publish).toBe(0);
  });
  it("S4 namespaces receipts and records a receipt conflict after the send as uncertain, never stuck applying", async () => {
    const w = world();
    const a = await approved(w);
    w.store.database.prepare("INSERT INTO media_receipts VALUES(?,?,?)").run(`receipt:publish:${a.campaignId}:r1`, "media-tiktok-campaign", "publish:r1");
    expect((await w.repo.publish(a.campaignId, "p1")).state).toBe("confirmed");

    const publish = w.executor.publish;
    w.executor.publish = async function (this: typeof w.executor, key: string, payload: { nativeCampaignId: string }, route: ExecRoute) {
      const r = { ...(await publish.call(this, key, payload, route)), receiptRef: "receipt:shared" };
      w.writes.set(key, r);
      return r;
    };
    const first = w.repo.prepare(w.request({ campaignRef: "plan:first" }), "prep-first");
    const d1 = await w.repo.createDraft(first.campaignId, "draft-first");
    w.repo.decide(d1.campaignId, w.approve(d1), "decide-first");
    expect((await w.repo.publish(d1.campaignId, "publish-first")).state).toBe("confirmed");
    const second = w.repo.prepare(w.request({ campaignRef: "plan:second" }), "prep-second");
    const d2 = await w.repo.createDraft(second.campaignId, "draft-second");
    w.repo.decide(d2.campaignId, w.approve(d2), "decide-second");
    await expect(w.repo.publish(d2.campaignId, "publish-second")).rejects.toThrow("RECEIPT_CONFLICT_AFTER_SEND");
    expect(w.repo.read(d2.campaignId)).toMatchObject({ state: "uncertain", heldReasons: ["RECEIPT_CONFLICT_AFTER_SEND"], execution: { pending: true } });
  });
  it("S5 answers uncertain when the executor fails after the write, and leaves the record uncertain, not applying", async () => {
    const w = world();
    const a = await approved(w);
    const publish = w.executor.publish;
    w.executor.publish = async function (this: typeof w.executor, key: string, payload: { nativeCampaignId: string }, route: ExecRoute) {
      await publish.call(this, key, payload, route);
      throw new MediaSourceUnavailable("PROVIDER_TIMEOUT");
    };
    const res = await handleMediaRoute({ method: "POST", path: `/v1/media/campaigns/${a.campaignId}/publish`, role: "reviewer", body: {}, idempotencyKey: "pk1" }, w.repo);
    expect(res).toEqual({ status: 409, body: { code: "PUBLISH_OUTCOME_UNKNOWN", executionCertainty: "uncertain" } });
    expect(w.repo.read(a.campaignId)).toMatchObject({ state: "uncertain", execution: { pending: true } });
    w.executor.publish = publish;
    expect((await w.repo.publish(a.campaignId, "pk2")).state).toBe("confirmed");
    expect(w.executor.calls.publish).toBe(1);
  });
  it("S6 re-checks sources, rights and capabilities before re-sending a draft write", async () => {
    const w = world();
    w.seed();
    const v = w.repo.prepare(w.request(), "prepare-1");
    const createDraft = w.executor.createDraft;
    let first = true;
    w.executor.createDraft = function (this: typeof w.executor, key: string, payload: { manifest: Manifest; nativeCampaignId: string | null; status: string }, route: ExecRoute) {
      if (first) { first = false; throw new Error("reset before send"); }
      return createDraft.call(this, key, payload, route);
    };
    await settle(w.repo.createDraft(v.campaignId, "d1"));
    w.asset({}, { expiresAt: "2026-11-06T12:00:30Z", paidUsage: false });
    w.capabilities.set("create-draft/api", { state: "Denied" });
    at("2026-11-06T12:03:00Z");
    expect(await w.repo.createDraft(v.campaignId, "d2")).toMatchObject({ state: "held", heldReasons: ["MANIFEST_SOURCES_CHANGED"], execution: { pending: false } });
    expect(w.executor.calls.createDraft).toBe(0);
  });
  it("S7 matches a safety policy to the provider and environment, not just the account reference", async () => {
    const w = world();
    const c = await released(w);
    const base = w.policies.get("policy:auto-pause") as object;
    w.policies.set("policy:tiktok", { ...base, policyRef: "policy:tiktok", accounts: [{ provider: "tiktok", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }] });
    w.policies.set("policy:prod", { ...base, policyRef: "policy:prod", accounts: [{ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "production" }] });
    const pause = w.repo.proposeMutation(c.campaignId, { kind: "pause", dailyBudgetMinor: null }, "m1");
    await expect(w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:tiktok" }, "a1")).rejects.toThrow("SAFETY_POLICY_SCOPE_MISMATCH");
    await expect(w.repo.applyMutation(c.campaignId, pause.mutationId, { policyRef: "policy:prod" }, "a2")).rejects.toThrow("SAFETY_POLICY_SCOPE_MISMATCH");
    expect(w.executor.calls.mutate).toBe(0);
  });
  it("S8 keeps inventories apart by environment", () => {
    const w = world();
    w.seed();
    const sandbox = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "i1");
    at("2026-11-06T12:01:00Z");
    const production = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "production" }, "i2");
    expect(w.repo.latestInventory("meta", "sandbox", "adaccount:synthetic-1")?.inventoryId).toBe(sandbox.inventoryId);
    expect(w.repo.latestInventory("meta", "production", "adaccount:synthetic-1")?.inventoryId).toBe(production.inventoryId);
  });
});

describe("media routes and the authenticated service", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  afterEach(async () => { if (app) await app.close(); app = undefined; });
  it("maps errors to not-applied responses and needs the reviewer role and a key to write", async () => {
    const w = world();
    w.seed();
    const call = (path: string, body?: unknown, role: "reviewer" | "reader" = "reviewer", key: string | undefined = "k") =>
      handleMediaRoute({ method: body === undefined ? "GET" : "POST", path, role, body, idempotencyKey: key }, w.repo);
    expect(await call("/v1/media/campaigns", w.request(), "reader")).toMatchObject({ status: 403 });
    expect(await call("/v1/media/campaigns", w.request(), "reviewer", "")).toMatchObject({ status: 400, body: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(await call("/v1/media/campaigns", {})).toMatchObject({ status: 422, body: { executionCertainty: "notApplied" } });
    const created = await call("/v1/media/campaigns", w.request());
    expect(created).toMatchObject({ status: 200, body: { state: "draft" } });
    const id = (created!.body as CampaignView).campaignId;
    expect(await call(`/v1/media/campaigns/${id}/publish`, {}, "reviewer", "p")).toMatchObject({ status: 409, body: { code: "J04_APPROVAL_REQUIRED" } });
    expect(await call(`/v1/media/campaigns/${id}/native-draft`, {}, "reviewer", "n")).toMatchObject({ status: 200, body: { releaseRequested: true } });
    expect(await call(`/v1/media/campaigns/${id}/decisions`, { decisionRef: "j04:missing" }, "reviewer", "d")).toMatchObject({ status: 503 });
    expect(await call(`/v1/media/campaigns/${id}`)).toMatchObject({ status: 200 });
    expect(await call("/v1/media/inventories", { provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "reviewer", "i"))
      .toMatchObject({ status: 200 });
    expect(await call("/v1/media/inventories/meta/sandbox/adaccount:synthetic-1")).toMatchObject({ status: 200, body: { kind: "paid-media-inventory" } });
    expect(await call("/v1/media/campaigns/media-unknown")).toMatchObject({ status: 404 });
    expect(await handleMediaRoute({ method: "GET", path: "/v1/offers/x", role: "reader" }, w.repo)).toBeNull();
  });
  it("serves media routes through the HTTP service with the reviewer credential", async () => {
    const w = world();
    app = createAgentServer({ databasePath: ":memory:", readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, ...scope,
      mediaAuthority: { account: () => null } });
    await new Promise<void>((resolve) => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address.");
    const post = (token: string, path: string, body: unknown, key: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
    expect((await post(SYNTHETIC_READ_TOKEN, "/v1/media/campaigns", w.request(), "http-1")).status).toBe(403);
    const res = await post(SYNTHETIC_REVIEW_TOKEN, "/v1/media/campaigns", w.request(), "http-1");
    expect(res.status).toBe(200);
    const held = await res.json() as CampaignView;
    expect(held).toMatchObject({ state: "held", manifest: null });
    expect(held.heldReasons).toContain("ACCOUNT_UNVERIFIED");
    const draft = await post(SYNTHETIC_REVIEW_TOKEN, `/v1/media/campaigns/${held.campaignId}/native-draft`, {}, "http-2");
    expect(draft.status).toBe(503);
    expect(await draft.json()).toEqual({ code: "MEDIA_EXECUTOR_UNAVAILABLE", executionCertainty: "notApplied" });
  });
});
