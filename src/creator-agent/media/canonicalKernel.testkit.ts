import type {DatabaseSync} from "node:sqlite";
import type {Manifest,NativeSettings,MediaScope,PrepareInput} from "./contract.ts";
import {PaidMediaRepository,type MediaAuthority} from "./repository.ts";
import {MediaReleaseController,type MediaControlAuthority} from "../mediaControl/repository.ts";
import type {StageInput} from "../mediaControl/contract.ts";
const H=(c:string)=>c.repeat(64);
export const META="adaccount:synthetic-meta",TIKTOK="adaccount:synthetic-tiktok";
const A=<T>(value:T)=>({value,state:"adopted",adoptionRef:"decision:owner-economics-v1",adoptedAt:"2026-11-01T00:00:00Z"});
const P=<T>(value:T)=>({value,state:"proposed",adoptionRef:null,adoptedAt:null});
export function syntheticMediaSettings(m: Manifest, nativeCampaignId: string, now:()=>Date): NativeSettings {
  return { nativeCampaignId, provider: m.provider, providerAccountRef: m.account.providerAccountRef, environment: m.environment, identityRef: m.account.identityRef, nativeAdIds: [`native:ad-${nativeCampaignId}`],
    previewRef: `preview:${nativeCampaignId}`, status: "PAUSED", objective: m.objective, optimizationEvent: m.optimizationEvent, currency: m.currency,
    dailyBudgetMinor: m.caps.dailyBudgetMinor, lifetimeBudgetMinor: m.caps.lifetimeBudgetMinor, startAt: m.schedule.startAt, endAt: m.schedule.endAt,
    attributionSetting: m.attributionSetting, destinationRef: m.destinationRef, creativeHashes: m.creatives.map((c) => c.contentHash), markets: m.targeting.markets,
    ageMin: m.targeting.ageMin, ageMax: m.targeting.ageMax, placements: m.targeting.placements, bidStrategy: m.bid.strategy, costCapMinor: m.bid.costCapMinor,
    targetRoasBps: m.bid.targetRoasBps, extraDeliveryBudget: false, maxDelivery: false, autoRecharge: false, placementExpansion: false, receiptOrigin: "synthetic",
    observedAt: now().toISOString() };
}

export function mediaKernelFixture(db:DatabaseSync,scope:MediaScope,now:()=>Date){
  const ago=(minutes:number)=>new Date(now().getTime()-minutes*60000).toISOString();
  const ahead=(minutes:number)=>new Date(now().getTime()+minutes*60000).toISOString();
  // ---- THO-346 synthetic sources ----
  const decisions = new Map<string, unknown>();
  const gates = new Map<string, Record<string, unknown> | null>();
  const native = new Map<string, NativeSettings>();
  const writes = new Map<string, unknown>();
  const executor = {
    calls: { publish: 0, mutate: 0 }, fail: null as null | "before" | "after", mutateFail: null as null | "before" | "after",
    during: null as null | (() => Promise<void>), readHook: null as null | (() => Promise<void>), readBackDown: false,
    mutateHook: null as null | (() => void), reads: 0, lagAt: 0,
    createDraft(key: string, payload: { manifest: Manifest; nativeCampaignId: string | null }) {
      if (writes.has(key)) return writes.get(key);
      const id = payload.nativeCampaignId ?? `native:campaign-${native.size + 1}`;
      native.set(id, syntheticMediaSettings(payload.manifest, id, now));
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
      // lagAt makes the nth read-back from now still report the campaign live, as a lagging provider read would.
      const lag = this.lagAt > 0 && ++this.reads === this.lagAt;
      const current = () => { const n = native.get(id); return n && !this.readBackDown ? { ...n, ...(lag ? { status: "ACTIVE" as const } : {}), observedAt: now().toISOString() } : null; };
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
  const store = {database:db};
  const media = new PaidMediaRepository(store.database, scope, mediaAuthority, now);
  const control = new MediaReleaseController(store.database, scope, authority, media, now);

  const terms = (over: Partial<StageInput> = {}): StageInput => ({ stageRef: "stage:initial", ordinal: 1, capMinor: 150_000, headroomBps: 1000,
    startAt: "2026-11-06T00:00:00Z", endAt: "2026-12-01T00:00:00Z",
    allocations: [{ provider: "meta", providerAccountRef: META, environment: "sandbox", capMinor: 75_000 },
      { provider: "tiktok", providerAccountRef: TIKTOK, environment: "sandbox", capMinor: 75_000 }], ...over });
  let sequence=0;
  function prepare(provider:"meta"|"tiktok"="meta",lifetime=60000){sequence++;
    const input:PrepareInput={campaignRef:`plan:${provider}-${sequence}`,provider,providerAccountRef:provider==="meta"?META:TIKTOK,environment:"sandbox",
      campaignRoute:provider==="meta"?"meta-sales-purchase":"tiktok-smart-plus-web-sales",checkoutRef:"checkout:site",offerRef:"offer:duo",creativeRefs:["asset:clip-1"],
      destinationRef:"destination:pdp-duo",attributionSetting:"attribution:7d-click",schedule:{startAt:"2026-11-10T00:00:00Z",endAt:"2026-11-30T00:00:00Z"},currency:"USD",
      targeting:{markets:["US"],ageMin:21,ageMax:54,placements:["placement:feed"]},bid:{strategy:"lowest-cost",costCapMinor:null,targetRoasBps:null},
      caps:{dailyBudgetMinor:2000,lifetimeBudgetMinor:lifetime},expiresAt:"2026-11-20T00:00:00Z"};return media.prepare(input,`prepare-${sequence}`);}
  return{media,control,mediaAuthority,authority,native,gates,executor,params,reportOver,rowOver,health,treasury,terms,prepare,orders,spend,conversions,feed,stageDecisions,decisions,calls};
}
