// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store";
import { createAgentServer } from "../server";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures";
import type { CampaignView, ExecRoute, Manifest, MutationView, NativeSettings, PrepareInput } from "./contract";
import { PaidMediaRepository, type MediaAuthority } from "./repository";
import { handleMediaRoute } from "./routes";
import { canonicalMediaFixture } from "./canonicalFixture.testkit.ts";
import { routeForCheckout } from "./repository.ts";

// Synthetic accounts, checkouts, assets, decisions and provider receipts only. Nothing here is a real advertiser, shop or campaign.
const scope = { workspaceId: "fictional-workspace", accountId: "fictional-account" };
const H = (c: string) => c.repeat(64);
let clock = new Date("2026-11-06T12:00:00Z");
/** An attempted provider write whose outcome is unknown is reported as uncertain, never as a result. */
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
  const closedKeys = new Set<string>();
  const policies = new Map<string, unknown>([["policy:auto-pause", { scope, policyRef: "policy:auto-pause", state: "current", allows: ["pause"],
    accounts: [{ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }], validUntil: "2026-12-31T00:00:00Z" }]]);
  const executor = {
    calls: { createDraft: 0, publish: 0, mutate: 0 }, routes: [] as ExecRoute[], preset: {} as Partial<NativeSettings>, origin: "synthetic" as "synthetic" | "account",
    fail: null as null | "before" | "after", outcome: "ACTIVE" as "ACTIVE" | "REJECTED", handoff: null as null | "mfa" | "captcha" | "ui-drift",
    during: null as null | (() => Promise<void>), draftHandoff: null as null | "mfa" | "captcha" | "ui-drift", draftFail: false,
    createDraft(key: string, payload: { manifest: Manifest; nativeCampaignId: string | null; status: string }, route: ExecRoute) {
      this.calls.createDraft++; this.routes.push(route);
      if (this.draftHandoff) {closedKeys.add(key);return { key, handoff: this.draftHandoff };}
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
      if (this.fail === "before") { closedKeys.add(key); this.fail = null; throw new Error("connection reset before the provider answered"); }
      native.get(payload.nativeCampaignId)!.status = this.outcome;
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: this.origin, providerStatus: this.outcome,
        rejectionCode: this.outcome === "REJECTED" ? "policy:synthetic-claim" : null };
      writes.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout after the provider accepted"); }
      return receipt;
    },
    mutate(key: string, payload: { nativeCampaignId: string; action: string; dailyBudgetMinor: number | null }, route: ExecRoute) {
      this.calls.mutate++; this.routes.push(route);
      if (this.fail === "before") { closedKeys.add(key); this.fail = null; throw new Error("connection reset"); }
      const n = native.get(payload.nativeCampaignId)!;
      if (payload.action === "pause") n.status = "PAUSED"; else n.dailyBudgetMinor = payload.dailyBudgetMinor;
      const receipt = { key, nativeCampaignId: payload.nativeCampaignId, receiptRef: `receipt:${key}`, receiptOrigin: this.origin, outcome: "applied", rejectionCode: null };
      writes.set(key, receipt);
      if (this.fail === "after") { this.fail = null; throw new Error("timeout"); }
      return receipt;
    },
    read(key: string) { return writes.get(key) ?? null; },
    readClosure(attempt: import("../media/contract").MediaAttempt) { return closedKeys.has(attempt.key) ? {state:"notApplied",attempt,complete:true,originalAttemptClosed:true,receiptRef:`closure:${attempt.key}`,receiptOrigin:"synthetic",observedAt:clock.toISOString(),validUntil:new Date(clock.getTime()+60000).toISOString()} : null; },
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
  return { closedKeys, policies, repo, store, seed, account, checkout, offer, asset, request, approve, approveMutation, decisions, gates, capabilities, native, writes, executor };
}

describe("retained media inventory and pure draft contracts",()=>{
let app:ReturnType<typeof createAgentServer>|undefined;afterEach(async()=>{if(app)await app.close();app=undefined;});
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
it("S8 keeps inventories apart by environment", () => {
    const w = world();
    w.seed();
    const sandbox = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "sandbox" }, "i1");
    at("2026-11-06T12:01:00Z");
    const production = w.repo.recordInventory({ provider: "meta", providerAccountRef: "adaccount:synthetic-1", environment: "production" }, "i2");
    expect(w.repo.latestInventory("meta", "sandbox", "adaccount:synthetic-1")?.inventoryId).toBe(sandbox.inventoryId);
    expect(w.repo.latestInventory("meta", "production", "adaccount:synthetic-1")?.inventoryId).toBe(production.inventoryId);
  });
it("does not mount retired direct media release routes behind a generic reviewer credential", async () => {
    app = createAgentServer({databasePath:":memory:",readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,...scope});
    await new Promise<void>(resolve=>app!.server.listen(0,"127.0.0.1",resolve));
    const address=app.server.address();if(!address||typeof address==="string")throw new Error("Expected TCP address.");
    for(const path of ["/v1/media/campaigns","/v1/media/campaigns/synthetic/publish","/v1/media/campaigns/synthetic/decisions"]){
      const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:"POST",headers:{authorization:`Bearer ${SYNTHETIC_REVIEW_TOKEN}`,"content-type":"application/json","idempotency-key":"retired-native-path"},body:"{}"});
      expect(response.status).toBe(404);
    }
  });
});

describe("canonical migration of native media approval and recovery boundaries",()=>{
  it("keeps Meta purchase, TikTok Shop GMV Max and website Smart+ route selection tied to actual checkout evidence",()=>{
    const checkout={scope,checkoutRef:"synthetic-checkout",kind:"website" as const,skuRef:"synthetic-sku",destinationRef:"synthetic-destination",purchaseEventsVerified:true,shopAuthorizationVerified:false,sourceRef:"synthetic-source",validUntil:"2026-12-01T00:00:00Z"};
    expect(routeForCheckout("meta",checkout)).toEqual({route:"meta-sales-purchase"});expect(routeForCheckout("tiktok",checkout)).toEqual({route:"tiktok-smart-plus-web-sales"});
    expect(routeForCheckout("tiktok",{...checkout,kind:"tiktok-shop",shopAuthorizationVerified:true})).toEqual({route:"tiktok-gmv-max-product"});
    expect(routeForCheckout("tiktok",{...checkout,kind:"tiktok-shop"})).toEqual({reason:"SHOP_AUTHORIZATION_UNVERIFIED"});
  });
  it("compiles the immutable manifest and records one native PAUSED draft with its exact keyed receipt",async()=>{
    const f=await canonicalMediaFixture();try{const c=await f.draft();expect(c.manifest).toMatchObject({account:{market:"US",currency:"USD",timezone:"America/New_York"},checkout:{skuRef:"sku:duo"},offer:{version:"offer-v1",claimsVersion:"claims-v1"},deliveryExtras:{maxDelivery:false,autoRecharge:false,placementExpansion:false,extraDeliveryBudget:false}});
      expect(c.manifestHash).toMatch(/^[a-f0-9]{64}$/);expect(c.native).toMatchObject({status:"PAUSED"});expect(c.native.nativeCampaignId).toBeTruthy();expect(c.receipts).toHaveLength(1);expect(c.evidenceLabel).toBe("synthetic");expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}
  });
  it.each(["extraDeliveryBudget","maxDelivery","autoRecharge","placementExpansion"] as const)("holds publication when native %s is unexpectedly enabled",async field=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft();f.kernel.native.get(c.native.nativeCampaignId!)![field]=true;
      await expect(f.approve("media.publish",c.campaignId)).rejects.toThrow("READBACK_MISMATCH");expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}
  });
  it.each(["identityRef","objective","optimizationEvent","destinationRef","attributionSetting","currency"] as const)("holds native %s drift before any publish",async field=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft();f.kernel.native.get(c.native.nativeCampaignId!)![field]="changed:synthetic";
      await expect(f.approve("media.publish",c.campaignId)).rejects.toThrow("READBACK_MISMATCH");expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}
  });
  it("requires current offer/asset/rights/checkout material after approval without replacing the approved manifest",async()=>{
    for(const field of ["offer","asset","checkout"] as const){const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft(),a=await f.approve("media.publish",c.campaignId),run=await f.handoff(a),before=a.manifest.manifestHash;
      if(field==="offer"){const original=f.kernel.mediaAuthority.offer!;f.kernel.mediaAuthority.offer=(...args)=>({...original(...args) as object,state:"withdrawn"});}
      else if(field==="asset"){const original=f.kernel.mediaAuthority.asset!;f.kernel.mediaAuthority.asset=(...args)=>({...original(...args) as object,reviewed:false});}
      else{const original=f.kernel.mediaAuthority.checkout!;f.kernel.mediaAuthority.checkout=(...args)=>({...original(...args) as object,purchaseEventsVerified:false});}
      await expect(f.dispatch.execute(run.runRef)).rejects.toThrow();expect(f.approvals.readApproval(a.manifest.approvalRef)?.manifest.manifestHash).toBe(before);expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}}
  });
  it.each(["qualified-product-stock","reviewed-content-paid-rights","actual-offer-checkout","attribution-dedup-refunds","fulfillment-support-cash"])("requires the exact current %s gate",async gate=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft();f.kernel.gates.set(gate,null);await expect(f.approve("media.publish",c.campaignId)).rejects.toThrow();expect(f.state.calls).toBe(1);
    }finally{f.approval.db.close();}
  });
  it("does not permit a generic legacy decision or broad pause policy to execute a native effect",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare();await expect(f.kernel.media.createDraft(c.campaignId,"legacy-draft")).rejects.toThrow("CANONICAL_MEDIA_ACTION_REQUIRED");
      expect(()=>f.kernel.media.decide(c.campaignId,"raw-decision","legacy-decision")).toThrow("CANONICAL_MEDIA_ACTION_REQUIRED");
      await expect(f.kernel.media.publish(c.campaignId,"legacy-publish")).rejects.toThrow("CANONICAL_MEDIA_ACTION_REQUIRED");
      await expect(f.kernel.media.applyMutation(c.campaignId,"raw-mutation",{policyRef:"broad-policy"},"legacy-pause")).rejects.toThrow("CANONICAL_MEDIA_ACTION_REQUIRED");
      expect(f.state.calls).toBe(0);expect(f.kernel.native.size).toBe(0);
      expect(await handleMediaRoute({method:"POST",path:`/v1/media/campaigns/${c.campaignId}/publish`,role:"reviewer",body:{},idempotencyKey:"legacy-route"},f.kernel.media)).toMatchObject({status:409,body:{code:"CANONICAL_MEDIA_ACTION_REQUIRED",executionCertainty:"notApplied"}});
    }finally{f.approval.db.close();}
  });
  it("keeps provider rejection separate from founder approval and native activation",async()=>{
    const f=await canonicalMediaFixture();try{await f.releaseStage();const c=await f.draft(),a=await f.approve("media.publish",c.campaignId),run=await f.handoff(a);f.state.rejected=true;
      const rejected=await f.dispatch.execute(run.runRef);expect(rejected.executionCertainty).toBe("applied");expect(rejected.receipt?.providerOutcome).toEqual({state:"rejected",reasonCode:"PROVIDER_REJECTED"});
      expect(f.kernel.media.read(c.campaignId)).toMatchObject({state:"provider-rejected",providerReview:{state:"rejected",rejectionCode:"synthetic-rejection"}});
      expect((await f.dispatch.reconcile(run.runRef)).receipt).toEqual(rejected.receipt);
      expect(f.state.calls).toBe(2);expect(f.approvals.readApproval(a.manifest.approvalRef)?.decisionReceipt?.decision).toBe("approved");
    }finally{f.approval.db.close();}
  });
  it("retains historical source approval but refuses expired business intent even after lease refresh",async()=>{
    const f=await canonicalMediaFixture();try{const c=f.kernel.prepare(),a=await f.approve("media.createDraft",c.campaignId),run=await f.handoff(a),expiry=a.manifest.draft.expiresAt;
      f.advance("2026-11-21T20:00:00Z");await f.refreshCapabilities();await expect(f.dispatch.execute(run.runRef)).rejects.toThrow();expect(f.state.calls).toBe(0);
      expect(f.approvals.readApproval(a.manifest.approvalRef)?.manifest.draft.expiresAt).toBe(expiry);
    }finally{f.approval.db.close();}
  });
});
