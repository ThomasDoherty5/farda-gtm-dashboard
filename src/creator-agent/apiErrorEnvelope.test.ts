// @vitest-environment node
import { describe, expect, it } from "vitest";
import { apiErrorEnvelope } from "./apiErrorEnvelope.ts";

describe("public HTTP errors", () => {
  it("retains a real applied outcome on denial without revealing source data or version hints", () => {
    const error = apiErrorEnvelope(403, { code: "AUTHORITY_REQUIRED", executionCertainty: "applied", message: "private source response",
      currentVersion: "private-page-version", fieldErrors: { owner: "private identity" }, reasonCodes: ["PRIVATE_REASON"], rowIndex: 3,
      payload: "private message", authorization: "private credential" }, "safe-request-id");
    expect(error).toMatchObject({ code: "AUTHORITY_REQUIRED", requestId: "safe-request-id", executionCertainty: "applied", retryable: false, retryAfterMs: null });
    expect(error.correlationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(JSON.stringify(error)).not.toContain("private");
    expect(error).not.toHaveProperty("currentVersion"); expect(error).not.toHaveProperty("fieldErrors");
    expect(error).not.toHaveProperty("reasonCodes"); expect(error).not.toHaveProperty("rowIndex");
  });
  it("returns bounded policy/import hints without copying rejected values", () => {
    const error = apiErrorEnvelope(422, { code: "POLICY_VIOLATION", reasonCodes: ["GUARANTEED_FEE_FORBIDDEN", "private rejected text", 8],
      rowIndex: 99, payload: { guaranteedFee: 100 }, executionCertainty: "notApplied" }, "policy-request");
    expect(error).toMatchObject({ code: "POLICY_VIOLATION", reasonCodes: ["GUARANTEED_FEE_FORBIDDEN"], rowIndex: 99, executionCertainty: "notApplied" });
    expect(error).not.toHaveProperty("payload");
    expect(apiErrorEnvelope(422, { rowIndex: 100 }, null)).not.toHaveProperty("rowIndex");
    expect(apiErrorEnvelope(422, { rowIndex: null, reasonCodes: Array.from({ length: 101 }, () => "POLICY_HELD") }, null).reasonCodes).toHaveLength(100);
  });
  it("never describes an unknown outcome as safe to retry with a new key", () => {
    const error = apiErrorEnvelope(502, { code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain", retryable: true }, null);
    expect(error.retryable).toBe(false); expect(error.executionCertainty).toBe("uncertain");
    expect(error.message).toContain("same request");
  });
});
