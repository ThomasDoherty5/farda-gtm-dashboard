import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ActionRequest, type SaveResourceRequest } from "./contract";
import { createDemoAdapter } from "./demoAdapter";
import { assessHistorical, canCreateHistoricalFeeCommitment, evaluateTerms, routeCreatorReply, type AcquisitionTerms } from "./commissionPolicy";
import { AdapterError } from "./errors";
import { checkAffiliateTerms } from "@/features/recruitment/recruitmentRules";
import { DEMO_OFFER_DRAFT_ID, offerDraftSeed, type OfferDraftPayload } from "@/fixtures/scorecards";
import { discoveryDemo } from "@/fixtures/discovery";
import { DISCOVERY_VERSION, type BatchApprovalPayload } from "./demoDiscovery";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;
const act = (actionKind: string, payload: unknown, over: Partial<ActionRequest<unknown>> = {}): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: actionKind as never, requestedScope: scope, actionKind, entityRefs: [], expectedVersion: "v1",
  approvalRef: null, manifestRef: null, idempotencyKey: `k-${++seq}`, payload, requestId: `r-${seq}`, ...over,
});
const rejected = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);

const good: AcquisitionTerms = { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: 15, perSaleFixedMinor: 0, sampleCostMinor: 2500 };
const codes = (t: Partial<AcquisitionTerms>) => evaluateTerms({ ...good, ...t }).blockers.map((b) => b.code);

describe("one eligibility rule (CP-08 cases)", () => {
  it("passes zero fee with a commission and an approved sample", () => {
    expect(evaluateTerms(good)).toMatchObject({ eligible: true, blockers: [] });
  });
  it.each([
    ["upfront fee", { upfrontFeeMinor: 5000 }, "UPFRONT_FEE_PROHIBITED"],
    ["minimum guaranteed fee", { guaranteedFeeMinor: 1 }, "GUARANTEED_FEE_PROHIBITED"],
    ["paid component", { paidComponentMinor: 100 }, "PAID_COMPONENT_PROHIBITED"],
    ["paid relationship", { relationship: "paid" as const }, "PAID_OR_HYBRID_PROHIBITED"],
    ["hybrid relationship", { relationship: "hybrid" as const }, "PAID_OR_HYBRID_PROHIBITED"],
    ["gifted only", { relationship: "gifted" as const, commissionPct: 0 }, "GIFTED_ONLY_PROHIBITED"],
    ["no commission", { commissionPct: 0 }, "COMMISSION_REQUIRED"],
    ["fractional amount", { upfrontFeeMinor: 0.5 }, "INVALID_AMOUNT"],
    ["sample above cap", { sampleCostMinor: 99_999 }, "SAMPLE_ABOVE_CAP"],
  ])("blocks %s", (_n, over, code) => expect(codes(over)).toContain(code));

  it("treats a fixed amount per eligible sale as commission, not a guaranteed fee", () => {
    expect(evaluateTerms({ ...good, commissionPct: 0, perSaleFixedMinor: 300 }).eligible).toBe(true);
    expect(codes({ commissionPct: 0, perSaleFixedMinor: 300, guaranteedFeeMinor: 300 })).toEqual(["GUARANTEED_FEE_PROHIBITED"]);
  });

  it.each([NaN, Infinity, -1])("rejects malformed percentage %s even when a valid fixed commission is present", commissionPct => {
    expect(codes({ commissionPct, perSaleFixedMinor: 300 })).toContain("INVALID_COMMISSION_RATE");
  });

  it("rejects an unsafe integer amount rather than admitting an imprecise commitment", () => {
    expect(codes({ perSaleFixedMinor: Number.MAX_SAFE_INTEGER + 1 })).toContain("INVALID_AMOUNT");
  });
});

describe("the offer screen and recruitment form agree with the policy", () => {
  const savePayload = (over: Partial<OfferDraftPayload>): SaveResourceRequest<OfferDraftPayload> => ({
    schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind: "actionDraft", resourceRef: DEMO_OFFER_DRAFT_ID,
    expectedVersion: offerDraftSeed.version, idempotencyKey: `s-${++seq}`, requestId: `sr-${seq}`, payload: { ...offerDraftSeed.payload, ...over },
  });
  it("offer save refuses a fee exactly when the policy does", async () => {
    const adapter = createDemoAdapter();
    expect(evaluateTerms({ ...good, upfrontFeeMinor: 5000 }).eligible).toBe(false);
    const err = await rejected(adapter.saveResource(savePayload({ upfrontFeeMinor: 5000 })));
    expect(err.body.code).toBe("POLICY_VIOLATION");
    expect(err.body.fieldErrors?.upfrontFee).toBeDefined();
    await expect(adapter.saveResource(savePayload({ upfrontFeeMinor: 0 }))).resolves.toBeDefined();
  });
  it("recruitment terms text refuses a fee exactly when the policy does", () => {
    expect(checkAffiliateTerms("15% per sale, $500 upfront", 20).ok).toBe(false);
    expect(checkAffiliateTerms("15% per sale, $0 upfront", 20).ok).toBe(true);
  });

  it.each(["guaranteedFeeMinor", "paidComponentMinor", "acceptedLiabilityMinor", "creatorAccepted"])("refuses an unrecognized %s before projecting a draft onto commission terms", async field => {
    const adapter = createDemoAdapter();
    const request = savePayload({});
    const err = await rejected(adapter.saveResource({ ...request, payload: { ...request.payload, [field]: 100 } }));
    expect(err.body).toMatchObject({ code: "VALIDATION_FAILED", executionCertainty: "notApplied" });
    await expect(adapter.saveResource(savePayload({}))).resolves.toMatchObject({ resourceVersion: offerDraftSeed.version });
  });

  it("keeps a valid prospective draft available without verified source acceptance or an activation", async () => {
    const adapter = createDemoAdapter();
    await expect(adapter.saveResource(savePayload({ baseVerified: false }))).resolves.toMatchObject({
      record: { payload: { baseVerified: false, upfrontFeeMinor: 0 } },
    });
    const offer = await adapter.readView({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "offerDraft",
      requestedScope: scope, filters: { offerId: DEMO_OFFER_DRAFT_ID }, page: { limit: 1, cursor: null }, sort: [], period: null, requestId: "draft-read" });
    expect(offer.capabilities).toContainEqual({ actionKind: "activateOffer", state: "unverified", reasonCodes: ["APPROVAL_REQUIRED", "PROVIDER_ACCESS_UNVERIFIED"] });
    const forged = await rejected(adapter.saveResource(savePayload({ baseVerified: true })));
    expect(forged.body).toMatchObject({ code: "VALIDATION_FAILED", fieldErrors: { baseVerified: expect.any(String) } });
    const incompatible = await rejected(adapter.saveResource(savePayload({ compensation: "fixedPerSale" })));
    expect(incompatible.body).toMatchObject({ code: "POLICY_VIOLATION", fieldErrors: { compensation: expect.any(String) } });
  });

  it("uses the current policy for both new discovery requests and offer drafts, while replaying an earlier preview only as pending", async () => {
    const adapter = createDemoAdapter({ actorRole: "founder" });
    const { batch, versions } = discoveryDemo;
    const manifest: BatchApprovalPayload = {
      batchId: batch.batchId, recipients: batch.eligible, rateLabel: batch.rateLabel, sampleUnits: batch.sampleUnits,
      sampleUnitCostMinor: batch.sampleUnitCost.minorUnits, upfrontFeeMinor: 0, policyVersion: versions.policyVersion,
    };
    const preview = (payload: BatchApprovalPayload, key: string) => adapter.submitAction(act("requestBatchApproval", payload, {
      operation: "requestApproval", idempotencyKey: key, expectedVersion: DISCOVERY_VERSION,
    }));
    const original = await preview(manifest, "before-policy-change");
    expect(original).toMatchObject({ state: "approvalPending", receiptRefs: [], policyVersion: versions.policyVersion });
    const policyVersion = "commission-only@stricter";
    await adapter.submitAction(act("changeAcquisitionPolicy", { version: policyVersion, maxCommissionPct: 10, sampleCapMinor: 1000 }));
    const plan = await adapter.readView({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "discoverySummary",
      requestedScope: scope, filters: {}, page: { limit: 1, cursor: null }, sort: [], period: null, requestId: "current-policy" });
    expect(plan.data).toMatchObject({ versions: { policyVersion } });
    expect(await preview(manifest, "before-policy-change")).toEqual(original);
    expect((await rejected(preview(manifest, "stale-version"))).body.code).toBe("STALE_VERSION");
    expect((await rejected(preview({ ...manifest, policyVersion }, "recheck-terms"))).body).toMatchObject({
      code: "POLICY_VIOLATION", fieldErrors: { rateLabel: expect.any(String), sampleUnitCostMinor: expect.any(String) },
    });
    expect((await rejected(adapter.saveResource(savePayload({})))).body).toMatchObject({
      code: "POLICY_VIOLATION", fieldErrors: { commission: expect.any(String), sample: expect.any(String) },
    });
    await expect(adapter.saveResource(savePayload({ commissionPct: 10, sampleShippingMinor: 1000 }))).resolves.toMatchObject({
      record: { payload: { commissionPct: 10, sampleShippingMinor: 1000, baseVerified: false } },
    });
  });
});

describe("server-side refusal that ignores the UI payload (CP-01)", () => {
  const bad: [string, Partial<AcquisitionTerms>][] = [
    ["upfront fee", { upfrontFeeMinor: 5000 }], ["guaranteed fee", { guaranteedFeeMinor: 5000 }], ["paid hybrid", { relationship: "hybrid", paidComponentMinor: 1000 }], ["gifted only", { relationship: "gifted", commissionPct: 0 }],
  ];
  it.each(["createOffer", "editOffer", "dispatchOffer"])("%s refuses prohibited terms, even with a manipulated eligible flag", async (kind) => {
    const adapter = createDemoAdapter();
    for (const [, over] of bad) {
      const err = await rejected(adapter.submitAction(act(kind, { offerId: "o1", eligible: true, terms: { ...good, ...over } })));
      expect(err.body.code).toBe("POLICY_VIOLATION");
      expect(err.body.executionCertainty).toBe("notApplied");
    }
    expect((await adapter.submitAction(act(kind, { offerId: "o1", terms: good }))).reasonCodes).toEqual([]);
  });
  it("bulk import is all or nothing and names the offending row", async () => {
    const adapter = createDemoAdapter();
    const err = await rejected(adapter.submitAction(act("importOffers", { offers: [{ terms: good }, { terms: { ...good, upfrontFeeMinor: 100 } }] })));
    expect(err.body.fieldErrors).toHaveProperty(["offers.1.upfrontFee"]);
    expect(err.body.fieldErrors).not.toHaveProperty(["offers.0.upfrontFee"]);
  });
  it("a refused dispatch records no dispatch and no receipt", async () => {
    const adapter = createDemoAdapter();
    await rejected(adapter.submitAction(act("dispatchOffer", { offerId: "o1", terms: { ...good, upfrontFeeMinor: 1 } })));
    const ok = await adapter.submitAction(act("dispatchOffer", { offerId: "o1", terms: good }));
    expect(ok.receiptRefs).toHaveLength(1);
    expect(ok.policyVersion).toBe("commission-only@demo-1");
    expect(ok.modelVersion).not.toBeNull();
  });
});

describe("a creator asking for an upfront fee (CP-03)", () => {
  it.each(["Happy to join, but I need a $300 flat fee first.", "My rate card is per post, send an upfront payment", "Do you offer guaranteed payment?"])("routes %j to terms-mismatch review", (text) => {
    expect(routeCreatorReply(text, "src-1")).toMatchObject({ kind: "feeRequest", state: "termsMismatch", queue: "review", dispatchAllowed: false, autoCounterOffer: false, recontact: "heldForReview", evidence: { sourceRef: "src-1" } });
  });
  it("leaves a reply that declines a fee alone", () => {
    expect(routeCreatorReply("Sounds good, no fee needed from me.", "src-2").kind).toBe("noFeeRequest");
  });
  it("blocks the item in the adapter with the reason and evidence, and sends nothing", async () => {
    const adapter = createDemoAdapter();
    const res = await adapter.submitAction(act("recordCreatorReply", { creatorRef: "c1", sourceRef: "dm-1", text: "I charge a $500 flat fee" }));
    expect(res.state).toBe("blocked");
    expect(res.reasonCodes).toEqual(["TERMS_MISMATCH", "CREATOR_FEE_REQUEST"]);
    expect(res.receiptRefs).toEqual(["dm-1"]);
    expect(res.nextAction).toMatchObject({ kind: "reviewTermsMismatch" });
  });
});

describe("an approval made under an older policy (CP-06)", () => {
  const approveExact = async (adapter: ReturnType<typeof createDemoAdapter>) =>
    adapter.submitAction(act("decideApproval", { decision: "approved" }, { approvalRef: "demo-approval-exact", operation: "decideApproval" }));
  const send = (adapter: ReturnType<typeof createDemoAdapter>) =>
    adapter.submitAction(act("dispatchApprovedAction", {}, { approvalRef: "demo-approval-exact", operation: "dispatchApprovedAction" }));

  it("dispatches while the policy is unchanged", async () => {
    const adapter = createDemoAdapter({ actorRole: "founder" });
    await approveExact(adapter);
    expect((await send(adapter)).state).toBe("succeeded");
  });
  it("does not dispatch after a conflicting change, shows the changed terms and asks for a new preview", async () => {
    const adapter = createDemoAdapter({ actorRole: "founder" });
    await approveExact(adapter);
    await adapter.submitAction(act("changeAcquisitionPolicy", { version: "commission-only@demo-2", maxCommissionPct: 10 }));
    const err = await rejected(send(adapter));
    expect(err.body.code).toBe("MANIFEST_CHANGED");
    expect(err.body.message).toContain("Maximum commission 20% → 10%");
    expect(err.body.message).toContain("new preview");
    expect(err.body.executionCertainty).toBe("notApplied");
  });
  it("still dispatches after a policy change that does not conflict", async () => {
    const adapter = createDemoAdapter({ actorRole: "founder" });
    await approveExact(adapter);
    await adapter.submitAction(act("changeAcquisitionPolicy", { version: "commission-only@demo-2", maxCommissionPct: 30 }));
    expect((await send(adapter)).state).toBe("succeeded");
  });
});

describe("history stays readable and payable (CP-07)", () => {
  it("never re-evaluates an accepted liability as a new offer, and creates no new commitment", () => {
    expect(assessHistorical({ acceptedLiabilityMinor: 15_000 })).toMatchObject({ readable: true, reconcilable: true, payableMinor: 15_000, newCommitmentAllowed: false });
    expect(canCreateHistoricalFeeCommitment()).toBe(false);
  });
  it("the policy guard does not intercept an accepted historical liability after a policy change", async () => {
    // The reviewer role can't decide this founder approval, so dispatch fails on approval, never on policy.
    // The pay-out path itself is covered where a founder can decide (open work in the daily-plan change).
    const adapter = createDemoAdapter({ actorRole: "founder" });
    await adapter.submitAction(act("changeAcquisitionPolicy", { version: "commission-only@demo-2", maxCommissionPct: 10 }));
    const err = await rejected(adapter.submitAction(act("dispatchApprovedAction", {}, { approvalRef: "demo-approval-founder", operation: "dispatchApprovedAction" })));
    expect(err.body.code).toBe("APPROVAL_REQUIRED");
  });
  it("the same fee amount is a violation as new terms", () => {
    expect(codes({ upfrontFeeMinor: 25_000 })).toContain("UPFRONT_FEE_PROHIBITED");
  });
});
