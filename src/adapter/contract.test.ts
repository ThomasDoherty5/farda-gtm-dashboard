import { z } from "zod";
import { moneySchema, provenanceValueSchema, readResponseSchema } from "./contract";

const base = { reasonCode: null, evidenceRefs: [], sourceRef: null, occurredAt: null, sourceUpdatedAt: null, observedAt: "2026-11-02T17:00:00.000Z" };
const schema = provenanceValueSchema(z.number());

describe("provenanceValueSchema", () => {
  it("accepts a known zero", () => {
    expect(schema.safeParse({ ...base, state: "known", value: 0 }).success).toBe(true);
  });

  it("rejects a known null", () => {
    expect(schema.safeParse({ ...base, state: "known", value: null }).success).toBe(false);
  });

  it.each(["unknown", "notApplicable"])("requires %s to carry null and a reason", (state) => {
    expect(schema.safeParse({ ...base, state, value: null, reasonCode: "SOURCE_PRIVATE" }).success).toBe(true);
    expect(schema.safeParse({ ...base, state, value: null }).success).toBe(false);
    expect(schema.safeParse({ ...base, state, value: 0, reasonCode: "SOURCE_PRIVATE" }).success).toBe(false);
  });
});

describe("moneySchema", () => {
  it("requires integer minor units and a three-letter currency", () => {
    expect(moneySchema.safeParse({ minorUnits: 1_259_600, currency: "USD" }).success).toBe(true);
    expect(moneySchema.safeParse({ minorUnits: 12_596.5, currency: "USD" }).success).toBe(false);
    expect(moneySchema.safeParse({ minorUnits: 100, currency: "US" }).success).toBe(false);
  });
});

describe("readResponseSchema", () => {
  it("rejects an unknown data state", () => {
    const res = {
      schemaVersion: "x",
      requestId: "r",
      scope: { workspaceId: "w", accountIds: [], environment: "demo", authorizationScopeVersion: "1" },
      dataVersion: "d",
      dataState: "ready",
      data: null,
      sourceFreshness: [],
      coverage: { expectedCount: null, observedCount: null, missingCount: null, complete: null, reasonCodes: [] },
      capabilities: [],
      page: { nextCursor: null, hasMore: false },
      refresh: { nextPollAfterMs: null },
    };
    const parse = readResponseSchema(z.unknown());
    expect(parse.safeParse(res).success).toBe(true);
    expect(parse.safeParse({ ...res, dataState: "allGood" }).success).toBe(false);
  });
});
