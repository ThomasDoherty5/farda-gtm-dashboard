import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ActionRequest } from "./contract";
import { createDemoAdapter } from "./demoAdapter";
import { createDemoPolicy } from "./demoPolicy";
import { BASE_POLICY, evaluateTerms, guardTermsOf, MAX_PER_SALE_FIXED_MINOR, type AcquisitionTerms } from "./commissionPolicy";
import { AdapterError } from "./errors";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;
const act = (actionKind: string, payload: unknown, over: Partial<ActionRequest<unknown>> = {}): ActionRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: actionKind as never, requestedScope: scope, actionKind, entityRefs: [], expectedVersion: "v1",
  approvalRef: null, manifestRef: null, idempotencyKey: `k-${++seq}`, payload, requestId: `r-${seq}`, ...over,
});
const rejected = (p: Promise<unknown> | (() => unknown)) =>
  Promise.resolve().then(typeof p === "function" ? p : () => p).then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);

const good: AcquisitionTerms = { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: 15, perSaleFixedMinor: 0, sampleCostMinor: 2500 };
const founder = () => createDemoAdapter({ actorRole: "founder" });
const approve = (a: ReturnType<typeof createDemoAdapter>) => a.submitAction(act("decideApproval", { decision: "approved" }, { approvalRef: "demo-approval-exact" }));
const dispatch = (a: ReturnType<typeof createDemoAdapter>, key?: string) =>
  a.submitAction(act("dispatchApprovedAction", {}, { approvalRef: "demo-approval-exact", ...(key ? { idempotencyKey: key } : {}) }));
const changePolicy = (a: ReturnType<typeof createDemoAdapter>, payload: unknown) => a.submitAction(act("changeAcquisitionPolicy", payload));

describe("finding 1: a replayed successful dispatch returns its original receipt", () => {
  it("answers the same key after a conflicting policy change with the stored result, not 'Nothing was sent'", async () => {
    const a = founder();
    await approve(a);
    const first = await dispatch(a, "dispatch-key");
    expect(first.state).toBe("succeeded");
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 });
    const replay = await dispatch(a, "dispatch-key");
    expect(replay).toEqual(first);
  });
  it("answers a new key for an approval that already executed with the stored execution", async () => {
    const a = founder();
    await approve(a);
    const first = await dispatch(a, "dispatch-key-1");
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 });
    const again = await dispatch(a, "dispatch-key-2");
    expect(again.receiptRefs).toEqual(first.receiptRefs);
    expect(again.state).toBe("succeeded");
  });
  it("still refuses a first dispatch after a conflicting change", async () => {
    const a = founder();
    await approve(a);
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 });
    const err = await rejected(dispatch(a));
    expect(err.body.code).toBe("MANIFEST_CHANGED");
    expect(err.body.executionCertainty).toBe("notApplied");
  });
});

describe("finding 2: eligibility is an allowlist", () => {
  it.each(["retainer", "", "COMMISSIONONLY", "ambassador", undefined, null, 7])("blocks relationship %j", (relationship) => {
    const e = evaluateTerms({ ...good, relationship } as never);
    expect(e.eligible).toBe(false);
    expect(e.blockers.map((b) => b.field)).toContain("relationship");
  });
  it("still passes commissionOnly", () => expect(evaluateTerms(good).eligible).toBe(true));
  it("refuses a retainer through createOffer", async () => {
    const err = await rejected(founder().submitAction(act("createOffer", { offerId: "o1", terms: { ...good, relationship: "retainer" } })));
    expect(err.body.code).toBe("POLICY_VIOLATION");
    expect(err.body.fieldErrors).toHaveProperty("relationship");
  });
});

describe("finding 3: offer actions validate shape and version", () => {
  it.each(["createOffer", "editOffer", "dispatchOffer"])("%s answers VALIDATION_FAILED, not a TypeError, for a bad shape", async (kind) => {
    const a = founder();
    for (const payload of [{}, { offerId: "o1" }, { offerId: "o1", terms: "x" }, { offerId: "o1", terms: null }, null, undefined, { offerId: "o1", terms: { ...good, commissionPct: "15" } }, { offerId: "o1", terms: { relationship: "commissionOnly" } }]) {
      const err = await rejected(a.submitAction(act(kind, payload)));
      expect(err).toBeInstanceOf(AdapterError);
      expect(err.body.code).toBe("VALIDATION_FAILED");
      expect(err.body.executionCertainty).toBe("notApplied");
    }
  });
  it("importOffers answers VALIDATION_FAILED for a bad shape", async () => {
    const err = await rejected(founder().submitAction(act("importOffers", { offers: [{ terms: good }, {}] })));
    expect(err.body.code).toBe("VALIDATION_FAILED");
  });
  it.each(["createOffer", "editOffer", "dispatchOffer"])("%s refuses a stale expectedVersion and names the current one", async (kind) => {
    const err = await rejected(founder().submitAction(act(kind, { offerId: "o1", terms: good }, { expectedVersion: "v9" })));
    expect(err.body.code).toBe("STALE_VERSION");
    expect(err.body.currentVersion).toBe("v1");
    expect(err.body.executionCertainty).toBe("notApplied");
  });
  it("an edit moves the offer's version, so the next edit with the old version is stale", async () => {
    const a = founder();
    await a.submitAction(act("editOffer", { offerId: "o1", terms: good }, { expectedVersion: "v1" }));
    const err = await rejected(a.submitAction(act("editOffer", { offerId: "o1", terms: good }, { expectedVersion: "v1" })));
    expect(err.body).toMatchObject({ code: "STALE_VERSION", currentVersion: "v2" });
    expect((await a.submitAction(act("dispatchOffer", { offerId: "o1", terms: good }, { expectedVersion: "v2" }))).state).toBe("succeeded");
  });
  it("checks the version before the terms, as offer save does", async () => {
    const err = await rejected(founder().submitAction(act("editOffer", { offerId: "o1", terms: { ...good, upfrontFeeMinor: 1 } }, { expectedVersion: "v9" })));
    expect(err.body.code).toBe("STALE_VERSION");
  });
});

describe("finding 4: idempotency hashes the payload", () => {
  it.each([
    ["createOffer", { offerId: "o1", terms: good }, { offerId: "o1", terms: { ...good, commissionPct: 12 } }],
    ["importOffers", { offers: [{ terms: good }] }, { offers: [{ terms: { ...good, commissionPct: 12 } }] }],
    ["recordCreatorReply", { creatorRef: "c", sourceRef: "s", text: "ok" }, { creatorRef: "c", sourceRef: "s", text: "different" }],
    ["changeAcquisitionPolicy", { version: "commission-only@demo-2", maxCommissionPct: 10 }, { version: "commission-only@demo-2", maxCommissionPct: 90 }],
  ])("%s: the same key with a changed payload is MANIFEST_CHANGED", async (kind, first, second) => {
    const a = founder();
    await a.submitAction(act(kind, first, { idempotencyKey: "shared" }));
    const err = await rejected(a.submitAction(act(kind, second, { idempotencyKey: "shared" })));
    expect(err.body.code).toBe("MANIFEST_CHANGED");
  });
  it("the same key with the same payload returns the first response", async () => {
    const a = founder();
    const first = await a.submitAction(act("dispatchOffer", { offerId: "o1", terms: good }, { idempotencyKey: "same" }));
    expect(await a.submitAction(act("dispatchOffer", { offerId: "o1", terms: good }, { idempotencyKey: "same" }))).toEqual(first);
  });
  it("a changed policy payload under a used key does not change the policy", async () => {
    const a = founder();
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 });
    const same = act("changeAcquisitionPolicy", { version: "commission-only@demo-3", maxCommissionPct: 5 }, { idempotencyKey: "p" });
    await a.submitAction(same);
    await rejected(a.submitAction({ ...same, payload: { version: "commission-only@demo-3", maxCommissionPct: 90 } }));
    const err = await rejected(a.submitAction(act("createOffer", { offerId: "o2", terms: { ...good, commissionPct: 6 } })));
    expect(err.body.fieldErrors).toHaveProperty("commission");
  });
});

describe("finding 5: changeAcquisitionPolicy is validated and founder-only", () => {
  it("is FORBIDDEN, naming the role, for the demo reviewer", async () => {
    const a = createDemoAdapter();
    const err = await rejected(changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 }));
    expect(err.body.code).toBe("FORBIDDEN");
    expect(err.body.message).toContain("AUTHORITY_REQUIRED");
    expect(err.body.message).toContain("founder");
    expect(err.body.executionCertainty).toBe("notApplied");
  });
  it("does not change the policy when forbidden", async () => {
    const policy = createDemoPolicy({ actorRole: "reviewer" });
    await rejected(() => policy.submit(act("changeAcquisitionPolicy", { version: "x-2", maxCommissionPct: 90 })));
    expect(policy.policy).toEqual(BASE_POLICY);
  });
  it.each([
    ["NaN", { maxCommissionPct: NaN }], ["Infinity", { maxCommissionPct: Infinity }], ["1000", { maxCommissionPct: 1000 }], ["101", { maxCommissionPct: 101 }],
    ["0", { maxCommissionPct: 0 }], ["negative", { maxCommissionPct: -5 }], ["a string", { maxCommissionPct: "20" }], ["null", { maxCommissionPct: null }],
    ["sample cap NaN", { sampleCapMinor: NaN }], ["sample cap fractional", { sampleCapMinor: 10.5 }], ["sample cap huge", { sampleCapMinor: 1e12 }], ["sample cap zero", { sampleCapMinor: 0 }],
    ["an unknown key", { relationshipsAllowed: ["paid"] }],
  ])("refuses %s and leaves the policy as it was", async (_n, over) => {
    const policy = createDemoPolicy({ actorRole: "founder" });
    const err = await rejected(() => policy.submit(act("changeAcquisitionPolicy", { version: "commission-only@demo-2", ...over })));
    expect(err.body.code).toBe("VALIDATION_FAILED");
    expect(policy.policy).toEqual(BASE_POLICY);
  });
  it.each([{}, { version: "" }, { version: "  " }, { version: "commission-only@demo-1" }, { version: 2 }])("refuses version %j", async (payload) => {
    const policy = createDemoPolicy({ actorRole: "founder" });
    const err = await rejected(() => policy.submit(act("changeAcquisitionPolicy", { ...payload, maxCommissionPct: 10 })));
    expect(err.body.code).toBe("VALIDATION_FAILED");
    expect(policy.policy).toEqual(BASE_POLICY);
  });
  it("applies a valid change and the cap then holds", async () => {
    const a = founder();
    expect((await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 })).state).toBe("succeeded");
    const err = await rejected(a.submitAction(act("createOffer", { offerId: "o1", terms: { ...good, commissionPct: 12 } })));
    expect(err.body.code).toBe("POLICY_VIOLATION");
  });
  it("cannot be used to allow 900%", async () => {
    const a = founder();
    await rejected(changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 1000 }));
    const err = await rejected(a.submitAction(act("createOffer", { offerId: "o1", terms: { ...good, commissionPct: 900 } })));
    expect(err.body.fieldErrors).toHaveProperty("commission");
  });
});

describe("finding 6: approved-under tracking and the guard", () => {
  it("names the policy the approval was made under, not the starting one", async () => {
    const a = founder();
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 18 });
    await approve(a);
    await changePolicy(a, { version: "commission-only@demo-3", maxCommissionPct: 10 });
    await changePolicy(a, { version: "commission-only@demo-4", maxCommissionPct: 5 });
    const err = await rejected(dispatch(a));
    expect(err.body.code).toBe("MANIFEST_CHANGED");
    expect(err.body.message).toContain("Maximum commission 18% → 5%");
    expect(err.body.message).not.toContain("20%");
  });
  it("does not report a change when the approval was made under the policy still in force and it still passes", async () => {
    const a = founder();
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 15 });
    await approve(a);
    expect((await dispatch(a)).state).toBe("succeeded");
  });
  const violating: AcquisitionTerms = { ...good, upfrontFeeMinor: 5_000 };
  const request = (ref: string | null) => act("dispatchApprovedAction", {}, { approvalRef: ref });
  it("answers POLICY_VIOLATION, not 'the policy changed', when the terms never passed the policy in force", () => {
    const policy = createDemoPolicy({ actorRole: "founder", termsOf: () => violating });
    let err: unknown;
    try { policy.guardApprovedDispatch(request("ap-1")); } catch (e) { err = e; }
    expect((err as AdapterError).body.code).toBe("POLICY_VIOLATION");
    expect((err as AdapterError).body.message).not.toContain("policy changed");
    expect((err as AdapterError).body.executionCertainty).toBe("notApplied");
  });
  it("answers MANIFEST_CHANGED when the policy changed after approval", async () => {
    const policy = createDemoPolicy({ actorRole: "founder", termsOf: () => good });
    policy.recordApproval("ap-1");
    await policy.submit(act("changeAcquisitionPolicy", { version: "commission-only@demo-2", maxCommissionPct: 10 }));
    expect(() => policy.guardApprovedDispatch(request("ap-1"))).toThrowError(/policy changed/);
  });
  it("fails closed when the approval's terms cannot be read", () => {
    const policy = createDemoPolicy({ actorRole: "founder", termsOf: () => { throw new Error("boom"); } });
    let err: unknown;
    try { policy.guardApprovedDispatch(request("ap-1")); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).body.executionCertainty).toBe("notApplied");
  });
  it("fails closed when a dispatch names no approval", () => {
    const policy = createDemoPolicy({ actorRole: "founder", termsOf: () => good });
    expect(() => policy.guardApprovedDispatch(request(null))).toThrow(AdapterError);
  });
  it("fails closed when termsOf says nothing is known (undefined)", () => {
    const policy = createDemoPolicy({ actorRole: "founder", termsOf: () => undefined as never });
    expect(() => policy.guardApprovedDispatch(request("ap-1"))).toThrow(AdapterError);
  });
});

describe("finding 6: the historical-liability exemption is narrow", () => {
  const pure = { policyVersion: "historical-liability@demo", requiredRole: "founder", terms: { commissionRatePct: 0, upfrontFee: { minorUnits: 25_000 }, sampleCost: null } };
  it("exempts exactly an accepted, founder-only, pure settlement", () => expect(guardTermsOf(pure)).toBeNull());
  it.each([
    ["a prefix lookalike", { policyVersion: "historical-liability-new-fee" }],
    ["a suffix lookalike", { policyVersion: "x-historical-liability@demo" }],
    ["another version of the same family", { policyVersion: "historical-liability@demo-2" }],
    ["a non-founder approval", { requiredRole: "reviewer" }],
    ["a record that also carries a commission", { terms: { ...pure.terms, commissionRatePct: 15 } }],
    ["a record that also carries a sample", { terms: { ...pure.terms, sampleCost: { minorUnits: 100 } } }],
  ])("does not exempt %s, so a new fee cannot ride on it", (_n, over) => {
    const terms = guardTermsOf({ ...pure, ...over });
    expect(terms).not.toBeNull();
    expect(evaluateTerms(terms!).blockers.map((b) => b.code)).toContain("UPFRONT_FEE_PROHIBITED");
  });
  it("leaves the seeded accepted liability payable, with the guard not intercepting it", async () => {
    const a = founder();
    await changePolicy(a, { version: "commission-only@demo-2", maxCommissionPct: 10 });
    const err = await rejected(a.submitAction(act("dispatchApprovedAction", {}, { approvalRef: "demo-approval-founder" })));
    expect(err.body.code).toBe("APPROVAL_REQUIRED");
  });
});

describe("finding 7: a fixed amount per sale is bounded", () => {
  it("passes at the bound", () => expect(evaluateTerms({ ...good, commissionPct: 0, perSaleFixedMinor: MAX_PER_SALE_FIXED_MINOR }).eligible).toBe(true));
  it.each([MAX_PER_SALE_FIXED_MINOR + 1, 1e9, Number.MAX_SAFE_INTEGER])("blocks %s", (perSaleFixedMinor) => {
    const e = evaluateTerms({ ...good, commissionPct: 0, perSaleFixedMinor });
    expect(e.eligible).toBe(false);
    expect(e.blockers.map((b) => b.code)).toContain("PER_SALE_FIXED_ABOVE_CAP");
  });
  it("refuses an oversized per-sale amount through dispatchOffer", async () => {
    const err = await rejected(founder().submitAction(act("dispatchOffer", { offerId: "o1", terms: { ...good, commissionPct: 0, perSaleFixedMinor: 5_000_000 } })));
    expect(err.body.code).toBe("POLICY_VIOLATION");
    expect(err.body.fieldErrors).toHaveProperty("commission");
  });
});
