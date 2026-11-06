/**
 * Runtime schemas for the settings view data: connectionsOverview, teamPermissions, automationRuns, scheduleDetail,
 * channelCapabilities. They validate `ReadResponse.data` only; the envelope is `readResponseSchema(...)` in contract.ts.
 *
 * Choices:
 * - `.strict()` is used where an unknown key would be a real risk: connection rows and the browser-tool rows
 *   (`connectionsOverview`) and the recorded permission evidence (`channelCapabilities.recorded`). Those describe
 *   provider access, and they say credentials stay in the provider. A backend that adds a token, URL or secret there
 *   should fail loudly, not have the key silently stripped. Everything else is a plain display model and strips extras.
 * - A connection's `lastSuccess.known` flag is kept as is: `known: false` is an unknown, never a recent success or zero.
 * - Capability states are closed lists: nothing is permitted until a state says so, and an unknown value is rejected.
 * - These views hold no money, so the minor-unit rules do not apply; counts reject negatives and fractions.
 */
import { z } from "zod";
import { nativeScheduleDetailSchema } from "@/creator-agent/scheduleCadence";
import { savedBindingsSchema, savedRunsSchema } from "@/creator-agent/operationsView";

const count = z.number().int().nonnegative();
const tone = z.enum(["neutral", "violet", "success", "warning", "danger"]);
const chip = z.object({ label: z.string(), tone });
const step = z.object({ n: z.string(), tone, title: z.string(), note: z.string() });
const pair = z.tuple([z.string(), z.string()]);

const connectionKind = z.enum(["validated", "setupRequired", "missingPermission", "expiredLogin", "unsupportedApi", "outage", "unknown", "toChoose"]);

export const connectionsOverviewSchema = z.object({
  systems: z.array(
    z
      .object({
        id: z.string(),
        system: z.string(),
        kind: connectionKind,
        state: chip,
        lastSuccess: z.object({ known: z.boolean(), label: z.string() }).strict(),
        action: z.enum(["openSource", "openSetup", "viewDecision"]),
        detail: z.string(),
        owner: z.string(),
      })
      .strict(),
  ),
  freshness: z.array(z.object({ label: z.string(), value: z.string(), known: z.boolean() })),
  attention: chip,
  freshnessNote: z.string(),
  browser: z.array(z.object({ id: z.string(), tool: z.string(), workflow: z.string(), status: chip, kind: connectionKind, fallback: z.string() }).strict()),
  gates: z.array(z.object({ chip: z.string(), tone, title: z.string(), note: z.string() })),
  observedLabel: z.string(),
});

export const teamPermissionsSchema = z.object({
  matrix: z.array(z.object({ capability: z.string(), founder: z.string(), operator: z.string(), viewer: z.string() })),
  owners: z.array(pair),
  gaps: count,
  steps: z.array(step),
  launch: z.array(pair),
  sourceRoles: z.array(z.object({ source: z.string(), providerRole: z.string() })),
});

const runNext = z.object({ label: z.string(), variant: z.enum(["primary", "secondary", "ghost"]), to: z.string().optional(), dialog: z.string().optional() });

export const automationRunsSchema = z.object({
  kpis: z.array(z.object({ label: z.string(), value: z.string(), context: z.string() })),
  runs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      executor: z.string(),
      platform: z.string(),
      state: z.string(),
      chip,
      updated: z.string(),
      assignedToMe: z.boolean(),
      next: runNext,
    }),
  ),
  contract: z.array(pair),
  recovery: z.array(z.object({ state: z.string(), next: z.string() })),
  jobTypes: z.array(z.object({ value: z.string(), label: z.string(), plan: z.array(z.string()) })),
  accounts: z.array(z.object({ value: z.string(), label: z.string() })),
  zaps: z.array(z.object({ id: z.string(), name: z.string(), trigger: z.string(), state: chip, provider: z.string(), scheduleTo: z.string().nullable() })),
  reports: z.array(z.object({ name: z.string(), timing: z.string(), enablement: z.string() })),
});

export const scheduleDetailSchema = z.object({
  jobId: z.string(),
  title: z.string(),
  subtitle: z.string(),
  steps: z.array(step),
  draft: z.object({ cadence: z.enum(["weekdays", "daily", "weekly-monday"]), localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1), activeCohortOverride: z.boolean() }),
  draftVersion: z.string().min(1),
  destination: z.string(),
  owner: z.string(),
  state: z.enum(["Paused", "Enabled"]),
  digest: z.object({ count: z.string(), groups: z.array(z.object({ heading: z.string(), lines: z.array(z.string()) })), footnote: z.string() }),
  history: z.array(z.object({ run: z.string(), result: z.string(), receipt: z.string() })),
  historyNote: z.string(),
  others: z.array(z.object({ report: z.string(), timing: z.string(), enablement: z.string() })),
});

const capabilityState = z.enum(["unverified", "unsupported", "denied", "unknown"]);

export const channelCapabilitiesSchema = z.object({
  rows: z.array(
    z.object({
      id: z.string(),
      surface: z.string(),
      route: z.string(),
      evidence: z.string(),
      kind: connectionKind,
      action: z.object({ label: z.string(), type: z.enum(["record", "plan", "commitment", "inspect"]), plan: z.array(z.string()) }),
      capabilities: z.array(z.object({ action: z.string(), state: capabilityState, note: z.string() })),
    }),
  ),
  rowsNote: z.string(),
  tests: z.array(z.object({ chip: z.string(), title: z.string(), note: z.string(), expected: z.string() })),
  capacity: z.array(z.object({ label: z.string(), value: z.string(), context: z.string() })),
  capacityNote: z.string(),
  footnote: z.string(),
  accessEvidence: z.array(z.object({ source: z.string(), action: z.string(), state: z.string(), observed: z.string() })),
  exceptions: z.array(z.object({ id: z.string(), record: z.string(), reason: z.string() })),
  // The fixture type lists four keys, but the demo service returns the whole saved record, which also has `rowId` and
  // `savedAt`. Both are accepted as optional; any other key is still refused.
  recorded: z.record(z.object({ reviewer: z.string(), evidence: z.string(), observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), version: z.string(), rowId: z.string().optional(), savedAt: z.string().optional() }).strict()),
});

/** The nightly reconciliation: pairs compared, conflicts naming the authoritative side, and an append-only audit trail. */
export const nightlyReconciliationSchema = z.object({
  datasetKey: z.literal("reconciliation-nightly-demo"),
  version: z.string(),
  run: z.object({ startedAt: z.string(), finishedAt: z.string(), state: z.enum(["completed", "partial", "failed"]), schedule: z.string() }),
  pairs: z.array(z.object({ key: z.string(), label: z.string(), compared: z.number().int().nonnegative(), matched: z.number().int().nonnegative(), conflicts: z.number().int().nonnegative() })),
  conflicts: z.array(z.object({
    id: z.string(), pair: z.string(), record: z.string(), field: z.string(),
    left: z.object({ source: z.string(), value: z.string() }), right: z.object({ source: z.string(), value: z.string() }),
    detectedAt: z.string(), state: z.enum(["open", "repairRequested"]), authority: z.string().min(1), proposal: z.string(),
  })),
  audit: z.array(z.object({ id: z.string(), at: z.string(), actor: z.string(), action: z.string(), subject: z.string(), detail: z.string() })),
});

/** View key to the schema of `ReadResponse.data` for that view. */
export const settingsViewSchemas: Record<string, z.ZodTypeAny> = {
  connectionsOverview: z.union([savedBindingsSchema, connectionsOverviewSchema]),
  teamPermissions: teamPermissionsSchema,
  automationRuns: z.union([savedRunsSchema, automationRunsSchema]),
  scheduleDetail: z.union([nativeScheduleDetailSchema, scheduleDetailSchema]),
  channelCapabilities: z.union([savedBindingsSchema, channelCapabilitiesSchema]),
  nightlyReconciliation: nightlyReconciliationSchema,
};
