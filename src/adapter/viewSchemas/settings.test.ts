/* eslint-disable @typescript-eslint/no-explicit-any -- the negative cases corrupt typed fixtures on purpose, so they edit them untyped */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ReadRequest, type SaveResourceRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { overviewFixtureKeys } from "@/fixtures/overview";
import { automationDemo, capabilityDemo, connectionsDemo, DEMO_JOB_ID, scheduleDemo, teamDemo, type AutomationData, type ConnectionsData, type ScheduleData, type TeamData } from "@/fixtures/settings";
import { automationRunsSchema, channelCapabilitiesSchema, connectionsOverviewSchema, scheduleDetailSchema, settingsViewSchemas, teamPermissionsSchema } from "./settings";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const request = (viewKey: string, filters: object = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r-1",
});
const save = (resourceKind: SaveResourceRequest<unknown>["resourceKind"], resourceRef: string, expectedVersion: string | null, payload: unknown): SaveResourceRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "saveResource", requestedScope: scope, resourceKind, resourceRef, expectedVersion, idempotencyKey: `k-${resourceRef}`, requestId: "s-1", payload,
});

/** The schema must not be looser than the fixture type: what it accepts is assignable to what the screens read. */
type Fits<Parsed, Screen> = Parsed extends Screen ? true : never;
const typeChecks: [
  Fits<z.infer<typeof connectionsOverviewSchema>, ConnectionsData>,
  Fits<z.infer<typeof teamPermissionsSchema>, TeamData>,
  Fits<z.infer<typeof automationRunsSchema>, AutomationData>,
  Fits<z.infer<typeof scheduleDetailSchema>, ScheduleData>,
] = [true, true, true, true];

// Settings reads ignore the Overview fixture switch, so every fixture key must give the same parseable answer.
const variants: { viewKey: string; filters: object; throws?: string }[] = [
  { viewKey: "connectionsOverview", filters: {} },
  { viewKey: "teamPermissions", filters: {} },
  { viewKey: "automationRuns", filters: {} },
  { viewKey: "scheduleDetail", filters: { jobId: DEMO_JOB_ID } },
  { viewKey: "scheduleDetail", filters: { jobId: "other" }, throws: "RECORD_NOT_FOUND" },
  { viewKey: "channelCapabilities", filters: {} },
];

describe("settings view schemas: every demo response parses", () => {
  it("covers the settings view keys", () => {
    expect(Object.keys(settingsViewSchemas).sort()).toEqual([...new Set(variants.map((v) => v.viewKey))].sort());
    expect(typeChecks).toHaveLength(4);
  });

  for (const v of variants) {
    for (const fixture of overviewFixtureKeys) {
      it(`${v.viewKey} ${JSON.stringify(v.filters)} · ${fixture}`, async () => {
        const read = createDemoAdapter({ fixture }).readView(request(v.viewKey, v.filters));
        if (v.throws) {
          await expect(read).rejects.toBeInstanceOf(AdapterError);
          await expect(read).rejects.toMatchObject({ body: { code: v.throws } });
          return;
        }
        const response = await read;
        const schema = settingsViewSchemas[v.viewKey]!;
        expect(() => readResponseSchema(schema).parse(response)).not.toThrow();
        expect(response.data).not.toBeNull();
        expect(() => schema.parse(response.data)).not.toThrow();
      });
    }
  }

  it("parses a schedule after a draft is saved", async () => {
    const adapter = createDemoAdapter();
    await adapter.saveResource(save("configurationDraft", `schedule-${DEMO_JOB_ID}`, "v1", { cadence: "daily", localTime: "09:15", timezone: "UTC", activeCohortOverride: false }));
    const parsed = scheduleDetailSchema.parse((await adapter.readView(request("scheduleDetail", { jobId: DEMO_JOB_ID }))).data);
    expect(parsed).toMatchObject({ draftVersion: "v2", state: "Paused", draft: { cadence: "daily", localTime: "09:15" } });
  });

  it("parses recorded permission evidence, whose record also carries rowId and savedAt", async () => {
    const adapter = createDemoAdapter();
    await adapter.saveResource(save("evidenceDraft", "permission-social-cat", null, { rowId: "social-cat", reviewer: "Reviewer One", evidence: "Provider page observed on screen", observedOn: "2026-11-01" }));
    const res = await adapter.readView(request("channelCapabilities"));
    const parsed = channelCapabilitiesSchema.parse(res.data);
    expect(Object.keys(parsed.recorded)).toEqual(["social-cat"]);
    // Recording evidence never turns a capability on.
    expect(parsed.rows[0]!.capabilities.every((c) => c.state !== ("available" as string))).toBe(true);
  });

  it("keeps the connection that was never tested as unknown, not as a success", () => {
    const parsed = connectionsOverviewSchema.parse(connectionsDemo);
    expect(parsed.systems.find((s) => s.id === "intercom")?.lastSuccess.known).toBe(false);
  });
});

type Case = [name: string, mutate: (d: any) => void];
const clone = <T,>(v: T): T => structuredClone(v);

const negatives: { view: string; schema: z.ZodTypeAny; valid: unknown; cases: Case[] }[] = [
  {
    view: "connectionsOverview", schema: connectionsOverviewSchema, valid: connectionsDemo,
    cases: [
      ["missing required field", (d) => delete d.observedLabel],
      ["unknown connection kind", (d) => (d.systems[0].kind = "connected")],
      ["unknown row action", (d) => (d.systems[0].action = "connect")],
      ["unknown badge tone", (d) => (d.systems[0].state.tone = "green")],
      ["known flag as a string", (d) => (d.systems[0].lastSuccess.known = "true")],
      ["a credential key on a connection row", (d) => (d.systems[0].token = "secret")],
      ["a url key on a last-success receipt", (d) => (d.systems[0].lastSuccess.url = "https://example.invalid")],
      ["a secret key on a browser tool row", (d) => (d.browser[0].password = "x")],
      ["browser row with an unknown kind", (d) => (d.browser[0].kind = "ok")],
    ],
  },
  {
    view: "teamPermissions", schema: teamPermissionsSchema, valid: teamDemo,
    cases: [
      ["missing required field", (d) => delete d.matrix],
      ["owner pair with one element", (d) => (d.owners[0] = ["Creator desk"])],
      ["negative gap count", (d) => (d.gaps = -1)],
      ["fractional gap count", (d) => (d.gaps = 1.5)],
      ["gap count as a string", (d) => (d.gaps = "2")],
      ["unknown step tone", (d) => (d.steps[0].tone = "pink")],
    ],
  },
  {
    view: "automationRuns", schema: automationRunsSchema, valid: automationDemo,
    cases: [
      ["missing required field", (d) => delete d.runs],
      ["unknown next-action variant", (d) => (d.runs[0].next.variant = "danger")],
      ["assignment flag as a string", (d) => (d.runs[0].assignedToMe = "no")],
      ["unknown chip tone", (d) => (d.runs[0].chip.tone = "orange")],
      ["zap schedule link missing instead of null", (d) => delete d.zaps[0].scheduleTo],
      ["job type with no plan", (d) => delete d.jobTypes[0].plan],
    ],
  },
  {
    view: "scheduleDetail", schema: scheduleDetailSchema, valid: scheduleDemo,
    cases: [
      ["missing required field", (d) => delete d.draft],
      ["unknown cadence", (d) => (d.draft.cadence = "hourly")],
      ["local time not HH:MM", (d) => (d.draft.localTime = "8:30am")],
      ["local time out of range", (d) => (d.draft.localTime = "24:00")],
      ["empty timezone", (d) => (d.draft.timezone = "")],
      ["empty draft version", (d) => (d.draftVersion = "")],
      ["unknown schedule state", (d) => (d.state = "Running")],
      ["override flag as a string", (d) => (d.draft.activeCohortOverride = "false")],
    ],
  },
  {
    view: "channelCapabilities", schema: channelCapabilitiesSchema, valid: capabilityDemo,
    cases: [
      ["missing required field", (d) => delete d.accessEvidence],
      ["unknown capability state", (d) => (d.rows[0].capabilities[0].state = "available")],
      ["unknown row kind", (d) => (d.rows[0].kind = "connected")],
      ["unknown action type", (d) => (d.rows[0].action.type = "enable")],
      ["recorded evidence missing its reviewer", (d) => (d.recorded = { "social-cat": { evidence: "x", observedOn: "2026-11-01", version: "v1" } })],
      ["recorded evidence date not YYYY-MM-DD", (d) => (d.recorded = { "social-cat": { reviewer: "R", evidence: "x", observedOn: "1 Nov", version: "v1" } })],
      ["recorded evidence with a credential key", (d) => (d.recorded = { "social-cat": { reviewer: "R", evidence: "x", observedOn: "2026-11-01", version: "v1", apiKey: "k" } })],
    ],
  },
];

describe("settings view schemas: bad shapes are rejected", () => {
  for (const { view, schema, valid, cases } of negatives) {
    describe(view, () => {
      it("accepts the unmodified fixture", () => {
        expect(schema.safeParse(valid).success).toBe(true);
      });
      for (const [name, mutate] of cases) {
        it(`rejects: ${name}`, () => {
          const bad = clone(valid);
          mutate(bad);
          expect(schema.safeParse(bad).success).toBe(false);
        });
      }
    });
  }
});
