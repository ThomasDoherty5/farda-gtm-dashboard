import { describe, expect, it } from "vitest";
import { sourceSnapshotSchema } from "../routeEvidence.ts";
import { evaluateAttributionMatrix, type MatrixContext } from "./attributionMatrix.ts";
import { accountFixture, onboardingFixture, providerRef } from "./fixtures.testkit.ts";

function context(over: Partial<MatrixContext> = {}): MatrixContext {
  return { relationshipSourceId: "synthetic-relationship", storefrontRoute: { checkoutOwner: "synthetic-merchant", storefrontType: "shopify-online-store", url: "https://synthetic-store.example/" },
    linkCodeRefs: [{ kind: "link", ref: providerRef("synthetic-link") }, { kind: "code", ref: providerRef("SYNTHETICCODE") }],
    precedence: "link-over-code", definitions: accountFixture().definitions, ...over };
}

describe("J10-07 sandbox checkout attribution matrix", () => {
  it("passes link-only, code-only, conflicting, untracked, actual storefront route and refund cases", () => {
    const f = onboardingFixture();
    const result = evaluateAttributionMatrix(f.passingOrders(), context());
    expect(result.cases).toEqual({ linkOnly: "pass", codeOnly: "pass", conflicting: "pass", untracked: "pass", storefrontRoute: "pass", refund: "pass" });
    expect(result.overall).toBe("passed");
    expect(result.rows.find(r => r.case === "untracked")!.creatorEligibleRevenue).toBeNull();
    expect(result.rows.find(r => r.case === "refund")!.creatorEligibleRevenue).toEqual({ minorUnits: 0, currency: "USD" });
    // The matrix emits the existing route-evidence website commerce and attribution test shapes.
    expect(result.websiteCommerce).toEqual({ kind: "website", linkOrCodeRef: "synthetic-link", attributionPrecedence: "link-over-code",
      test: { expectedProviderCredit: true, orderId: "synthetic-order-refund", refundOfOrderId: "synthetic-order-refund", refundApplied: true, sourceRef: "synthetic-sandbox-refund" } });
    const website = sourceSnapshotSchema.innerType().shape.commerce.options[0];
    expect(website.safeParse(result.websiteCommerce).success).toBe(true);
    expect(result.attributionTests).toHaveLength(6);
  });

  it("makes ambiguous attribution an exception, never fabricated creator revenue", () => {
    const f = onboardingFixture();
    const unknownPrecedence = evaluateAttributionMatrix(f.passingOrders(), context({ precedence: "unknown" }));
    const conflicting = unknownPrecedence.rows.find(r => r.case === "conflicting")!;
    expect(conflicting).toMatchObject({ state: "exception", reasonCodes: ["ATTRIBUTION_PRECEDENCE_AMBIGUOUS"], creatorEligibleRevenue: null, test: null });
    expect(unknownPrecedence.overall).toBe("exception");
    expect(unknownPrecedence.exceptions).toHaveLength(1);
    expect(unknownPrecedence.websiteCommerce.test).toBeNull();

    // The provider credited the code owner although its documented precedence is link first.
    const wrongWinner = f.order("conflicting", { providerCredit: { state: "credited", relationshipSourceId: "other-synthetic-relationship", via: "code" } });
    const unresolved = evaluateAttributionMatrix([wrongWinner], context());
    expect(unresolved.rows[0]).toMatchObject({ state: "exception", reasonCodes: ["ATTRIBUTION_CONFLICT_UNRESOLVED"], creatorEligibleRevenue: null });
    const unknownCredit = evaluateAttributionMatrix([f.order("conflicting", { providerCredit: { state: "unknown", relationshipSourceId: null, via: null } })], context());
    expect(unknownCredit.rows[0]).toMatchObject({ state: "exception", creatorEligibleRevenue: null });
  });

  it("fails credited untracked traffic, a different storefront route and a missing case", () => {
    const f = onboardingFixture();
    const credited = f.order("untracked", { providerCredit: { state: "credited", relationshipSourceId: "synthetic-relationship", via: "link" } });
    expect(evaluateAttributionMatrix([credited], context()).rows[0]).toMatchObject({ state: "fail", reasonCodes: ["UNTRACKED_ORDER_CREDITED"] });
    const otherRoute = f.order("storefrontRoute", { storefront: { checkoutOwner: "synthetic-merchant", storefrontType: "shopify-headless", url: "https://synthetic-store.example/" } });
    expect(evaluateAttributionMatrix([otherRoute], context()).rows[0]).toMatchObject({ state: "fail", reasonCodes: ["STOREFRONT_ROUTE_MISMATCH"] });
    const partial = evaluateAttributionMatrix(f.passingOrders().filter(o => o.case !== "codeOnly"), context());
    expect(partial.cases.codeOnly).toBe("missing");
    expect(partial.overall).toBe("incomplete");
    expect(() => evaluateAttributionMatrix([{ ...f.order("linkOnly"), environment: "production" }], context())).toThrow();
  });

  it("preserves unknown refund representation as unknown, not zero", () => {
    const f = onboardingFixture();
    const refund = f.order("refund", { refund: { state: "unknown", unknownReason: "Refund not yet visible in the sandbox export" } });
    const result = evaluateAttributionMatrix([refund], context());
    expect(result.rows[0]).toMatchObject({ state: "unknown", reasonCodes: ["REFUND_REPRESENTATION_UNKNOWN"], creatorEligibleRevenue: null });
    const noAmount = f.order("refund", { refund: { state: "applied", refundOfOrderSourceId: "synthetic-order-refund", amount: null, eligibleAfter: null } });
    expect(evaluateAttributionMatrix([noAmount], context()).rows[0]).toMatchObject({ state: "unknown", reasonCodes: ["REFUND_AMOUNT_UNKNOWN"] });
  });
});

describe("J10-08 provider definitions and native TikTok mirrors", () => {
  it("keeps provider-native gross, eligible, refund and hold definitions visible and versioned", () => {
    const f = onboardingFixture();
    const result = evaluateAttributionMatrix(f.passingOrders(), context());
    expect(result.definitionsVersion).toBe("synthetic-definitions-v1");
    expect(result.definitions).toMatchObject({ gross: expect.any(String), eligible: expect.any(String), refund: expect.any(String), hold: expect.any(String), holdDays: 30 });
    const changed = evaluateAttributionMatrix([f.order("linkOnly", { definitionsVersion: "synthetic-definitions-v2" })], context());
    expect(changed.rows[0]).toMatchObject({ state: "unknown", reasonCodes: ["DEFINITIONS_VERSION_CHANGED"], creatorEligibleRevenue: null });
  });

  it("excludes Shopify mirrors of native TikTok checkout from website-affiliate entitlement", () => {
    const f = onboardingFixture();
    const mirror = f.order("linkOnly", { orderRef: providerRef("synthetic-mirrored-order"), salesChannel: "tiktok-shop-native-mirror" });
    const result = evaluateAttributionMatrix([mirror], context());
    expect(result.rows[0]).toMatchObject({ state: "excluded", reasonCodes: ["NATIVE_TIKTOK_MIRROR_EXCLUDED"], creatorEligibleRevenue: null, test: null });
    expect(result.cases.linkOnly).toBe("missing");
    const withMirror = evaluateAttributionMatrix([...f.passingOrders(), mirror], context());
    expect(withMirror.overall).toBe("passed");
    expect(withMirror.rows.filter(r => r.creatorEligibleRevenue !== null).map(r => r.orderSourceId)).not.toContain("synthetic-mirrored-order");
  });
});
