import { describe, expect, it } from "vitest";
import { accountFixture, onboardingFixture, onboardingScope } from "./fixtures.testkit.ts";
import { parseRate, runPreflight, screenAcquisition } from "./preflight.ts";

const codes = (record: { blockers: { code: string }[] }) => record.blockers.map(b => b.code);

describe("J10-01 preflight against an injected synthetic account and capability record", () => {
  it("records merchant and creator eligibility, plan, action permissions and quota unit and reset", () => {
    const f = onboardingFixture();
    const record = runPreflight(f.input(), f.authority, onboardingScope, f.now());
    expect(record.blockers).toEqual([]);
    expect(record.state).toBe("ready");
    expect(record.origin).toBe("synthetic");
    expect(record.plan?.name).toBe("synthetic-plan");
    expect(record.merchantEligibility?.state).toBe("eligible");
    expect(record.creatorEligibility?.state).toBe("eligible");
    expect(record.quota).toMatchObject({ state: "known", unit: "invitation", remaining: 12, resetAt: expect.any(String) });
    expect(record.permissions).toEqual([{ action: "invite", provider: "granted", capability: "Ready", capabilityReceiptRef: "receipt:synthetic-capability", ready: true }]);
    expect(record.commission).toEqual({ rateType: "percent", basisPoints: 2000, fixedMinor: null });
    expect(Date.parse(record.validUntil!)).toBeLessThanOrEqual(f.now() + 15 * 60_000);
    const activation = runPreflight(f.input(), f.authority, onboardingScope, f.now(), "activation");
    expect(activation.permissions.map(p => p.action)).toEqual(["observeAcceptance", "observeLinkCode", "sandboxCheckout", "activate"]);
  });

  it("an unsupported, unverified, denied, expired or malformed capability route cannot report ready", () => {
    const f = onboardingFixture();
    for (const [value, code] of [
      [f.readiness({ allowed: false, state: "Unsupported", reasonCodes: ["ROUTE_UNSUPPORTED"] }), "INVITE_CAPABILITY_UNSUPPORTED"],
      [f.readiness({ allowed: false, state: "Unverified" }), "INVITE_CAPABILITY_UNVERIFIED"],
      [f.readiness({ allowed: false, state: "Denied" }), "INVITE_CAPABILITY_DENIED"],
      [f.readiness({ expiresAt: new Date(f.now() - 1).toISOString() }), "INVITE_CAPABILITY_EXPIRED"],
      [{ allowed: true, state: "Ready" }, "INVITE_CAPABILITY_UNVERIFIED"],
    ] as const) {
      f.state.capability.set("invite", value);
      const record = runPreflight(f.input(), f.authority, onboardingScope, f.now());
      expect(record.state).toBe("blocked");
      expect(codes(record)).toContain(code);
      expect(record.permissions[0]!.ready).toBe(false);
    }
  });

  it("an unknown plan, eligibility, permission or quota blocks, and unknown quota is never read as zero or capacity", () => {
    const f = onboardingFixture();
    f.state.account = accountFixture(f.now(), {
      plan: { name: null, sourceRef: null, unknownReason: "Plan not exposed by the synthetic source" },
      creatorEligibility: { state: "unknown", sourceRef: null, unknownReason: "Not yet observed" },
      merchantEligibility: { state: "ineligible", sourceRef: "synthetic-merchant-eligibility", unknownReason: null },
      permissions: [{ action: "invite", state: "denied", sourceRef: "synthetic-permission" }],
      quota: { state: "unknown", unknownReason: "Quota not exposed" },
    });
    const record = runPreflight(f.input(), f.authority, onboardingScope, f.now());
    expect(record.state).toBe("blocked");
    expect(codes(record)).toEqual(expect.arrayContaining(["ACCOUNT_PLAN_UNKNOWN", "CREATOR_ELIGIBILITY_UNKNOWN", "MERCHANT_INELIGIBLE", "INVITE_PERMISSION_DENIED", "QUOTA_UNKNOWN"]));
    expect(record.quota).toEqual({ state: "unknown", unknownReason: "Quota not exposed" });
    expect(record.blockers.find(b => b.code === "MERCHANT_INELIGIBLE")).toMatchObject({ owner: "merchant", sourceRef: { sourceId: "synthetic-merchant-eligibility" } });

    f.state.account = accountFixture(f.now(), { quota: { state: "known", unit: "invitation", limit: 50, remaining: 0, resetAt: new Date(f.now() + 1000).toISOString(), sourceRef: "q" } });
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toEqual(["QUOTA_EXHAUSTED"]);
  });

  it("a missing, stale, malformed or cross-account record is never ready", () => {
    const f = onboardingFixture();
    f.state.account = null;
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toContain("PROVIDER_ACCOUNT_UNVERIFIED");
    f.state.account = { ...accountFixture(f.now()), extra: true };
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toContain("PROVIDER_ACCOUNT_UNVERIFIED");
    f.state.account = accountFixture(f.now() - 7_200_000);
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toContain("PROVIDER_ACCOUNT_STALE");
    f.state.account = accountFixture(f.now(), { merchantRef: { provider: "shopify-collabs", accountId: "another-synthetic-merchant", sourceId: "x", url: null } });
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toContain("ACCOUNT_SCOPE_MISMATCH");
  });
});

describe("J10-03 commission-only acquisition", () => {
  const terms = { rateType: "percent" as const, rateValue: "20" };
  const base = { relationship: "commission-only", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, productAllocation: null };

  it("rejects guaranteed or upfront content fees, paid-hybrid and gifted-only requests with the shared reason codes", () => {
    expect(screenAcquisition({ ...base, upfrontFeeMinor: 5000 }, terms, null).rejected).toEqual(["UPFRONT_FEE_PROHIBITED"]);
    expect(screenAcquisition({ ...base, guaranteedFeeMinor: 5000 }, terms, null).rejected).toEqual(["GUARANTEED_FEE_PROHIBITED"]);
    expect(screenAcquisition({ ...base, relationship: "paid-hybrid", paidComponentMinor: 100 }, terms, null).rejected)
      .toEqual(["PAID_COMPONENT_PROHIBITED", "PAID_OR_HYBRID_PROHIBITED"]);
    expect(screenAcquisition({ ...base, relationship: "gifted" }, { rateType: "percent", rateValue: "x" }, null).rejected)
      .toEqual(expect.arrayContaining(["GIFTED_ONLY_PROHIBITED", "COMMISSION_REQUIRED"]));
  });

  it("refuses a fee request server-side before anything is stored", () => {
    const f = onboardingFixture();
    const input = f.input({ acquisition: { ...f.input().acquisition, guaranteedFeeMinor: 25_000 } });
    expect(() => f.repo.open(input, "open-fee")).toThrow(expect.objectContaining({ code: "ACQUISITION_POLICY_VIOLATION", status: 422, reasonCodes: ["GUARANTEED_FEE_PROHIBITED"] }));
    expect(f.store.database.prepare("SELECT COUNT(*) AS n FROM affiliate_onboarding_records").get()!.n).toBe(0);
  });

  it("does not mistake a separately approved product and shipping allocation for a content fee", () => {
    const approved = screenAcquisition({ ...base, productAllocation: { merchandiseMinor: 1600, shippingMinor: 600,
      approvalRef: { provider: "farda-j04", accountId: "a", sourceId: "sample-approval", url: null } } }, terms, null);
    expect(approved).toEqual({ rejected: [], held: [], sampleCostMinor: 2200 });
    const unapproved = screenAcquisition({ ...base, productAllocation: { merchandiseMinor: 1600, shippingMinor: 600, approvalRef: null } }, terms, null);
    expect(unapproved.rejected).toEqual([]);
    expect(unapproved.held).toEqual(["PRODUCT_ALLOCATION_UNAPPROVED"]);
    const f = onboardingFixture();
    expect(f.repo.open(f.input(), "open-sample").record.state).toBe("readyToInvite");
  });
});

describe("J10-04 rate type, eligible base and currency", () => {
  it("an unsupported fixed-per-sale rate blocks the offer and is never converted to a percentage", () => {
    const f = onboardingFixture();
    const terms = f.offer.current!.terms;
    f.setOffer({ ...terms, commission: { ...terms.commission, type: "fixed-per-sale", standardRateBps: null, fixedMinor: 300 } });
    const input = f.input();
    input.approvedTerms = { ...input.approvedTerms, rateType: "fixed_per_sale", rateValue: "3.00" };
    const record = runPreflight(input, f.authority, onboardingScope, f.now());
    expect(record.state).toBe("blocked");
    expect(codes(record)).toEqual(expect.arrayContaining(["FIXED_PER_SALE_UNSUPPORTED", "COMMISSION_ROUTE_UNSUPPORTED"]));
    expect(record.commission).toEqual({ rateType: "fixed_per_sale", basisPoints: null, fixedMinor: 300 });
    f.state.account = accountFixture(f.now(), { commission: { ...accountFixture().commission, supportsFixedPerSale: null } });
    expect(codes(runPreflight(input, f.authority, onboardingScope, f.now()))).toContain("COMMISSION_SUPPORT_UNKNOWN");
  });

  it("ambiguous commission math, an unsupported eligible base or currency blocks", () => {
    expect(parseRate({ rateType: "percent", rateValue: "0.2" })).toBeNull();
    expect(parseRate({ rateType: "percent", rateValue: "20%" })).toBeNull();
    expect(parseRate({ rateType: "fixed_per_sale", rateValue: "3" })).toBeNull();
    expect(parseRate({ rateType: "percent", rateValue: "12.5" })).toEqual({ rateType: "percent", basisPoints: 1250, fixedMinor: null });
    const f = onboardingFixture();
    const input = f.input();
    input.approvedTerms = { ...input.approvedTerms, rateValue: "0.2" };
    expect(codes(runPreflight(input, f.authority, onboardingScope, f.now()))).toEqual(expect.arrayContaining(["COMMISSION_MATH_AMBIGUOUS"]));
    f.state.account = accountFixture(f.now(), { commission: { ...accountFixture().commission, eligibleBases: ["gross-sales"], currencies: ["EUR"] } });
    expect(codes(runPreflight(f.input(), f.authority, onboardingScope, f.now()))).toEqual(expect.arrayContaining(["ELIGIBLE_BASE_UNSUPPORTED", "CURRENCY_UNSUPPORTED"]));
    const mismatched = f.input();
    mismatched.approvedTerms = { ...mismatched.approvedTerms, rateValue: "15" };
    expect(codes(runPreflight(mismatched, f.authority, onboardingScope, f.now()))).toContain("RATE_VALUE_MISMATCH");
  });
});
