import { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ReadRequest, type SaveResourceRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { FLOW_KEYS, TIMING_OPTIONS, type ActivationData, type ConsentData, type EmailFlowData, type LifecycleData } from "@/fixtures/lifecycle";
import {
  FLOW_KEY_VALUES,
  activationRetentionSchema,
  consentEligibilitySchema,
  emailFlowSchema,
  flowDraftPayloadSchema,
  flowDraftRecordSchema,
  lifecycleActionSchemas,
  lifecycleOverviewSchema,
  lifecycleViewSchemas,
} from "./lifecycle";

// A parsed response document, read loosely so each negative case can overwrite one field. Its shape is checked by the schema under test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;

const readRequest = (viewKey: string, filters: unknown = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: scope,
  filters,
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: `r-${++seq}`,
});

const saveRequest = (flow: string, expectedVersion: string, payload: unknown): SaveResourceRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "saveResource",
  requestedScope: scope,
  resourceKind: "configurationDraft",
  resourceRef: `flow-${flow}`,
  expectedVersion,
  idempotencyKey: `key-${++seq}`,
  requestId: `save-${++seq}`,
  payload,
});

type Adapter = ReturnType<typeof createDemoAdapter>;
const clone = <T>(v: T): T => structuredClone(v);
/** A copy of the object without one key: how the "missing required field" cases are built. */
const omit = <T extends object>(value: T, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const rejects = (key: string, data: unknown) => expect(lifecycleViewSchemas[key]!.safeParse(data).success).toBe(false);

async function expectParses(adapter: Adapter, viewKey: string, filters?: unknown) {
  const res = await adapter.readView(readRequest(viewKey, filters));
  const parsed = readResponseSchema(lifecycleViewSchemas[viewKey]!).safeParse(res);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 1)).toBe(true);
  return { res, data: res.data as Doc };
}

describe("the registry", () => {
  it("has exactly these view keys and the one action, and the flow keys match the fixtures", () => {
    expect(Object.keys(lifecycleViewSchemas).sort()).toEqual(["activationRetention", "consentEligibility", "emailFlow", "lifecycleOverview"]);
    expect(Object.keys(lifecycleActionSchemas)).toEqual(["saveFlowDraft"]);
    expect([...FLOW_KEY_VALUES]).toEqual([...FLOW_KEYS]);
  });
});

describe("lifecycleOverview", () => {
  it("parses the demo response", async () => {
    const { data } = await expectParses(createDemoAdapter(), "lifecycleOverview");
    expect(data.flows.map((f: { key: string }) => f.key).sort()).toEqual([...FLOW_KEYS].sort());
  });

  describe("rejects", () => {
    const base = async () => clone((await expectParses(createDemoAdapter(), "lifecycleOverview")).data);
    it("a missing required field", async () => {
      const rest = omit(await base(), "metrics");
      rejects("lifecycleOverview", rest);
    });
    it("a wrong type", async () => rejects("lifecycleOverview", { ...(await base()), returnsAwaitingInspection: "2" }));
    it("a null count, so a missing figure can't be a zero", async () => {
      const d = await base();
      rejects("lifecycleOverview", { ...d, returnsAwaitingInspection: null });
      rejects("lifecycleOverview", { ...d, metrics: [{ ...d.metrics[0], value: null }] });
      rejects("lifecycleOverview", { ...d, activation: { ...d.activation, paired: null } });
    });
    it("a negative or fractional count", async () => {
      const d = await base();
      rejects("lifecycleOverview", { ...d, metrics: [{ ...d.metrics[0], value: -1 }] });
      rejects("lifecycleOverview", { ...d, metrics: [{ ...d.metrics[0], value: 4.5 }] });
    });
    it("an unknown flow key", async () => {
      const d = await base();
      rejects("lifecycleOverview", { ...d, flows: [{ ...d.flows[0], key: "winback" }] });
    });
    it("more week-one activations than paired devices", async () => {
      const d = await base();
      rejects("lifecycleOverview", { ...d, activation: { paired: 10, weekOne: 11 } });
    });
    it("contact data under any key", async () => {
      const d = await base();
      rejects("lifecycleOverview", { ...d, subscribers: [{ email: "a@example.test" }] });
    });
  });
});

describe("emailFlow", () => {
  it.each([...FLOW_KEYS])("parses the demo response for flow %s", async (flow) => {
    const { data } = await expectParses(createDemoAdapter(), "emailFlow", { flow });
    expect(data.key).toBe(flow);
    expect(TIMING_OPTIONS[flow as keyof typeof TIMING_OPTIONS]).toContain(data.draft.timing);
  });

  it("an unknown flow is a not-found error, not data", async () => {
    const e = await createDemoAdapter().readView(readRequest("emailFlow", { flow: "winback" })).then(() => null, (x: unknown) => x as AdapterError);
    expect(e).toBeInstanceOf(AdapterError);
    expect(e!.body.code).toBe("RECORD_NOT_FOUND");
  });

  it.each([...FLOW_KEYS])("parses flow %s after a draft is saved (new version, same record shape)", async (flow) => {
    const adapter = createDemoAdapter();
    const before = (await expectParses(adapter, "emailFlow", { flow })).data;
    const timing = [...TIMING_OPTIONS[flow]].reverse()[0]!;
    const response = await adapter.saveResource(saveRequest(flow, before.draftVersion, { timing, template: "Revised template" }));
    expect(flowDraftRecordSchema.safeParse(response.record).success).toBe(true);
    const after = (await expectParses(adapter, "emailFlow", { flow })).data;
    expect(after.draft).toEqual({ timing, template: "Revised template" });
    expect(after.draftVersion).toBe("v2");
  });

  describe("rejects", () => {
    const base = async (flow = "setup") => clone((await expectParses(createDemoAdapter(), "emailFlow", { flow })).data);
    it("a missing required field", async () => {
      const rest = omit(await base(), "draftVersion");
      rejects("emailFlow", rest);
    });
    it("a wrong type", async () => rejects("emailFlow", { ...(await base()), steps: "six" }));
    it("an unknown flow key", async () => rejects("emailFlow", { ...(await base()), key: "winback" }));
    it("a draft version that isn't a version", async () => {
      rejects("emailFlow", { ...(await base()), draftVersion: "latest" });
      rejects("emailFlow", { ...(await base()), draftVersion: "v1.5" });
    });
    it("a flow with no steps or a pair of next outcomes that isn't a pair", async () => {
      const d = await base();
      rejects("emailFlow", { ...d, steps: [] });
      rejects("emailFlow", { ...d, nextOutcomes: [["Eligible"]] });
    });
    it("a null draft timing", async () => {
      const d = await base();
      rejects("emailFlow", { ...d, draft: { ...d.draft, timing: null } });
    });
  });
});

describe("consentEligibility", () => {
  it("parses the demo response, and the categories add up", async () => {
    const { data } = await expectParses(createDemoAdapter(), "consentEligibility");
    expect(data.eligible + data.withdrawn + data.suppressed + data.unknown).toBe(data.total);
  });

  describe("rejects", () => {
    const base = async () => clone((await expectParses(createDemoAdapter(), "consentEligibility")).data);
    it("a missing required field", async () => {
      const rest = omit(await base(), "total");
      rejects("consentEligibility", rest);
    });
    it("a wrong type", async () => rejects("consentEligibility", { ...(await base()), eligible: "740" }));
    it("a null count, so unknown consent can't be dropped or zeroed", async () => {
      rejects("consentEligibility", { ...(await base()), unknown: null });
      const rest = omit(await base(), "unknown");
      rejects("consentEligibility", rest);
    });
    it("negative or fractional counts", async () => {
      rejects("consentEligibility", { ...(await base()), withdrawn: -130 });
      rejects("consentEligibility", { ...(await base()), suppressed: 60.5 });
    });
    it("categories that don't add up to the total (unknown counted as opted in)", async () => {
      const d = await base();
      rejects("consentEligibility", { ...d, eligible: d.eligible + d.unknown, unknown: 0, total: d.total + 1 });
      rejects("consentEligibility", { ...d, eligible: d.eligible + d.unknown });
    });
    it("contact records under any key", async () => {
      rejects("consentEligibility", { ...(await base()), contacts: [{ email: "a@example.test", consent: "yes" }] });
    });
  });
});

describe("activationRetention", () => {
  it("parses the demo response", async () => {
    const { res } = await expectParses(createDemoAdapter(), "activationRetention");
    expect(res.dataState).toBe("partial");
  });

  describe("rejects", () => {
    const base = async () => clone((await expectParses(createDemoAdapter(), "activationRetention")).data);
    it("a missing required field", async () => {
      const rest = omit(await base(), "cohort");
      rejects("activationRetention", rest);
    });
    it("a wrong type", async () => {
      const d = await base();
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, paired: "86" } });
    });
    it("a null or negative cohort count", async () => {
      const d = await base();
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, pairingFailureEvents: null } });
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, pairingFailureEvents: -1 } });
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, weekOne: 63.5 } });
    });
    it("an unknown horizon state", async () => {
      const d = await base();
      rejects("activationRetention", { ...d, horizons: [{ ...d.horizons[0], state: "Measured" }] });
    });
    it("a funnel that grows: paired above delivered, week one above paired", async () => {
      const d = await base();
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, paired: 101 } });
      rejects("activationRetention", { ...d, cohort: { ...d.cohort, weekOne: 87 } });
    });
    it("per-device or health data under any key", async () => {
      rejects("activationRetention", { ...(await base()), devices: [{ id: "x", heartRate: 60 }] });
    });
  });
});

describe("saveFlowDraft (a saveResource, never a dispatch)", () => {
  const draft = lifecycleActionSchemas.saveFlowDraft!.payload;
  const ok = (p: unknown) => expect(draft.safeParse(p).success).toBe(true);
  const bad = (p: unknown) => expect(draft.safeParse(p).success).toBe(false);

  it("accepts a real payload the demo accepts, and the demo's saved record", async () => {
    const payload = { timing: "48 hours after delivery", template: "Setup help v2" };
    ok(payload);
    const response = await createDemoAdapter().saveResource(saveRequest("setup", "v1", payload));
    expect(flowDraftPayloadSchema.safeParse(response.record).success).toBe(true);
    expect(response.reasonCodes).toEqual([]);
  });

  it("accepts a payload that changes nothing, and the demo answers NO_CHANGE", async () => {
    const adapter = createDemoAdapter();
    const current = (await expectParses(adapter, "emailFlow", { flow: "setup" })).data;
    ok(current.draft);
    const response = await adapter.saveResource(saveRequest("setup", "v1", current.draft));
    expect(response.reasonCodes).toEqual(["NO_CHANGE"]);
    expect(response.resourceVersion).toBe("v1");
  });

  it("rejects a missing field and a wrong type", () => {
    bad({ timing: "24 hours after delivery" });
    bad({ template: "Setup help" });
    bad({ timing: 24, template: "Setup help" });
    bad({ timing: "24 hours after delivery", template: null });
  });
  it("rejects a template the demo server refuses: too short, too long, markup or variables", () => {
    bad({ timing: "t", template: "ab" });
    bad({ timing: "t", template: "x".repeat(81) });
    bad({ timing: "t", template: "<b>Setup</b>" });
    bad({ timing: "t", template: "Hi {{first_name}}" });
  });
  it("rejects a blank timing", () => bad({ timing: "  ", template: "Setup help" }));
  it("rejects an extra key, such as an enabled flag, so a save can't smuggle in a publish", () => {
    bad({ timing: "24 hours after delivery", template: "Setup help", enabled: true });
    bad({ timing: "24 hours after delivery", template: "Setup help", recipients: ["a@example.test"] });
  });
  it("agrees with the demo server: every payload the schema rejects for the template is also refused by the server", async () => {
    const adapter = createDemoAdapter();
    for (const template of ["ab", "<b>Setup</b>", "Hi {{x}}", "x".repeat(81)]) {
      const payload = { timing: "24 hours after delivery", template };
      bad(payload);
      const e = await adapter.saveResource(saveRequest("setup", "v1", payload)).then(() => null, (x: unknown) => x as AdapterError);
      expect(e?.body.code).toBe("VALIDATION_FAILED");
    }
  });
});

// Compile-time check: the fixture types are accepted by the inferred schema types.
const _accepts = [
  {} as LifecycleData satisfies z.infer<typeof lifecycleOverviewSchema>,
  {} as EmailFlowData satisfies z.infer<typeof emailFlowSchema>,
  {} as ConsentData satisfies z.infer<typeof consentEligibilitySchema>,
  {} as ActivationData satisfies z.infer<typeof activationRetentionSchema>,
];
void _accepts;
