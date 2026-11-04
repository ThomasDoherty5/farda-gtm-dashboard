import { SCHEMA_VERSION, type ActionRequest } from "./contract";
import { createDemoDiscovery, DISCOVERY_VERSION, type BatchApprovalPayload } from "./demoDiscovery";
import type { AdapterError } from "./errors";
import { discoveryDemo } from "@/fixtures/discovery";

const { batch, versions } = discoveryDemo;
const valid: BatchApprovalPayload = {
  batchId: batch.batchId,
  recipients: batch.eligible,
  rateLabel: batch.rateLabel,
  sampleUnits: batch.sampleUnits,
  sampleUnitCostMinor: batch.sampleUnitCost.minorUnits,
  upfrontFeeMinor: 0,
  policyVersion: versions.policyVersion,
};
const act = (payload: Partial<BatchApprovalPayload> | Record<string, unknown>, key: string, expectedVersion = DISCOVERY_VERSION): ActionRequest<BatchApprovalPayload> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "requestApproval",
  requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" },
  actionKind: "requestBatchApproval",
  entityRefs: [],
  expectedVersion,
  approvalRef: null,
  manifestRef: null,
  idempotencyKey: key,
  payload: { ...valid, ...payload } as BatchApprovalPayload,
  requestId: `req-${key}`,
});
const rejection = (run: () => unknown): AdapterError => {
  try {
    run();
  } catch (e) {
    return e as AdapterError;
  }
  throw new Error("expected a rejection");
};

describe("requestBatchApproval validates every manifest field against the current policy", () => {
  it.each([
    ["an empty rate (no commission at all)", { rateLabel: "" }, "POLICY_VIOLATION", "rateLabel"],
    ["a flat fee per post", { rateLabel: "$500 flat per post" }, "POLICY_VIOLATION", "rateLabel"],
    ["a different commission than the plan", { rateLabel: "35% standard-rate" }, "POLICY_VIOLATION", "rateLabel"],
    ["thousands of sample units", { sampleUnits: 9999 }, "POLICY_VIOLATION", "sampleUnits"],
    ["a huge sample unit cost", { sampleUnitCostMinor: 99_999_999 }, "POLICY_VIOLATION", "sampleUnitCostMinor"],
    ["a fractional sample unit count", { sampleUnits: 1.5 }, "VALIDATION_FAILED", "sampleUnits"],
    ["a negative unit cost", { sampleUnitCostMinor: -1 }, "VALIDATION_FAILED", "sampleUnitCostMinor"],
    ["a text rate", { rateLabel: 12 }, "VALIDATION_FAILED", "rateLabel"],
    ["a missing rate", { rateLabel: undefined }, "VALIDATION_FAILED", "rateLabel"],
    ["a non-numeric upfront fee", { upfrontFeeMinor: "0" }, "VALIDATION_FAILED", "upfrontFee"],
    ["a missing policy version", { policyVersion: "" }, "VALIDATION_FAILED", "policyVersion"],
  ])("refuses %s", (_label, over, code, field) => {
    const service = createDemoDiscovery();
    const error = rejection(() => service.submit(act(over, `k-${field}-${code}`)));
    expect(error.body).toMatchObject({ code, executionCertainty: "notApplied" });
    expect(error.body.fieldErrors).toHaveProperty(field);
  });

  it("refuses a stale policy version and shows the current terms instead of echoing the old version", () => {
    const service = createDemoDiscovery();
    const error = rejection(() => service.submit(act({ policyVersion: "stale-2020" }, "k-stale")));
    expect(error.body.code).toBe("STALE_VERSION");
    expect(error.body.message).toContain(versions.policyVersion);
    expect(error.body.message).toContain(batch.rateLabel);
    expect(error.body.message).toContain("stale-2020");
    expect(error.body.fieldErrors).toMatchObject({ policyVersion: expect.stringContaining(versions.policyVersion) });
  });

  it("accepts the plan's own manifest and answers with the current policy version", () => {
    const response = createDemoDiscovery().submit(act({}, "k-ok"));
    expect(response).toMatchObject({ state: "approvalPending", receiptRefs: [], policyVersion: versions.policyVersion });
  });

  it("accepts a smaller finite sample than the plan, but never a larger one", () => {
    const service = createDemoDiscovery();
    expect(service.submit(act({ sampleUnits: 6 }, "k-small")).state).toBe("approvalPending");
    expect(rejection(() => service.submit(act({ sampleUnits: batch.sampleUnits + 1 }, "k-big"))).body.code).toBe("POLICY_VIOLATION");
  });
});

describe("the approval reference is derived from the request", () => {
  it("different recipients or terms give a different approval", () => {
    const service = createDemoDiscovery();
    const a = service.submit(act({}, "k1"));
    const b = service.submit(act({ recipients: 12 }, "k2"));
    const c = service.submit(act({ sampleUnits: 6 }, "k3"));
    expect(new Set([a.approvalRef, b.approvalRef, c.approvalRef]).size).toBe(3);
    expect(a.approvalRef).not.toBe("demo-approval-batch-024");
  });

  it("a repeat with a new key is a new approval, and the same key is the same one", () => {
    const service = createDemoDiscovery();
    const first = service.submit(act({}, "key-a"));
    const again = service.submit(act({}, "key-a"));
    const other = service.submit(act({}, "key-b"));
    expect(again).toBe(first);
    expect(other.approvalRef).not.toBe(first.approvalRef);
    expect(other.actionRef).not.toBe(first.actionRef);
  });

  it("the manifest reference follows the terms, so an identical manifest names the same manifest", () => {
    const service = createDemoDiscovery();
    const a = service.submit(act({}, "m1"));
    const b = service.submit(act({}, "m2"));
    const c = service.submit(act({ recipients: 12 }, "m3"));
    expect(a.manifestRef).toBe(b.manifestRef);
    expect(c.manifestRef).not.toBe(a.manifestRef);
  });

  it("a changed payload on the same key is MANIFEST_CHANGED", () => {
    const service = createDemoDiscovery();
    service.submit(act({}, "same"));
    expect(rejection(() => service.submit(act({ recipients: 20 }, "same"))).body.code).toBe("MANIFEST_CHANGED");
  });
});
