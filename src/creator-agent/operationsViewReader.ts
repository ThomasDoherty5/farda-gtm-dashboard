import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";
import type { CapabilityLedger } from "./connections/ledger.ts";
import type { CapabilityView } from "./connections/schema.ts";
import type { HealthSummary } from "./providerHealthSchema.ts";
import type { JobRepository } from "./jobs/repository.ts";
import type { OperationsScope } from "./operations.ts";
import type { SavedBinding, SavedBindings, SavedRuns } from "./operationsView.ts";

export const operationsViewKeys = ["connectionsOverview", "channelCapabilities", "automationRuns"] as const;
export type OperationsViewKey = (typeof operationsViewKeys)[number];
export const operationsViewFiltersSchema = z.object({
  tab: z.enum(["runs", "zaps", "reporting", "capabilities", "access", "exceptions", "attribution"]).optional(),
  q: z.string().max(120).optional(), state: z.string().max(50).optional(),
}).strict();
export type OperationsViewFilters = z.infer<typeof operationsViewFiltersSchema>;
const integer = z.number().int().min(0).safe();
const pageCursorSchema = z.object({ view: z.enum(operationsViewKeys), authorization: z.string(), filters: operationsViewFiltersSchema,
  limit: integer, offset: integer, expires: integer, marks: z.object({ bindings: integer, jobs: integer, runs: integer }).strict() }).strict();

export class OperationsCursorError extends Error {
  readonly code: "INVALID_OPERATIONS_CURSOR" | "OPERATIONS_CURSOR_EXPIRED";
  constructor(code: "INVALID_OPERATIONS_CURSOR" | "OPERATIONS_CURSOR_EXPIRED") { super(code); this.code = code; }
}
type Input = { viewKey: OperationsViewKey; db: DatabaseSync; ledger: CapabilityLedger; jobs: JobRepository; scope: OperationsScope;
  authorizationContext: string; filters?: OperationsViewFilters; secret: string; limit: number; cursor: string | null; now?: () => number; health?: { get(id: string): HealthSummary | null } };
const publicProviders = new Set(["zapier", "notion", "linear", "tiktok", "tiktok-shop", "social-cat", "shippo", "slack", "google-sheets", "shopify", "meta", "intercom"]);
const publicActions = new Map([["readPolicy", "Read policy"], ["readCapabilities", "Read capabilities"], ["checkHealth", "Check health"],
  ["readHealth", "Read health"], ["readOrders", "Read orders"], ["readMetrics", "Read metrics"], ["readPosts", "Read posts"]]);
const publicReasons = new Set(["NOT_VERIFIED", "BINDING_CHANGED", "ACTION_VERIFIED", "ACTION_NOT_READY", "REVOKED", "REQUIRED_SCOPE_MISSING",
  "VERIFICATION_EXPIRED", "VERIFICATION_STALE", "VERIFIER_NOT_CONFIGURED", "VERIFIER_UNAVAILABLE", "RECEIPT_NOT_FOUND", "AUTHENTICATION_UNVERIFIED",
  "JOB_DISABLED_OR_STALE", "JOB_PAUSED", "CAPABILITY_DENIED", "CAPABILITY_UNVERIFIED", "SOURCE_UNAVAILABLE", "INVALID_VERIFICATION_RECEIPT"]);
const safeReasons = (values: string[]) => [...new Set(values.map(code => publicReasons.has(code) ? code : "OTHER_SAVED_REASON"))];
const coverage = (total: number, returned: number) => ({ total, returned, partial: total > returned });
function timestamp(value: string | null) {
  const ms = value === null ? NaN : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function readState(record: CapabilityView): SavedBinding["state"] {
  if (record.state === "Denied") return "Blocked";
  if (record.state === "Unsupported") return "Unsupported";
  if (record.state === "Ready" && record.fresh) return "Ready";
  if (record.reasonCodes.some(reason => ["VERIFICATION_EXPIRED", "VERIFICATION_STALE"].includes(reason)) || record.connectionHealth === "Expired") return "Expired";
  if (record.reasonCodes.some(reason => ["NOT_VERIFIED", "BINDING_CHANGED"].includes(reason))) return "Documented";
  if (!record.receiptRef) return "Missing evidence";
  return "Unverified";
}

/** Read only the scoped local store. Public aliases are deterministic across refreshes, without disclosing provider IDs or receipt locators. */
export function readOperationsView(input: Input) {
  z.number().int().min(1).max(100).parse(input.limit);
  const authorization = z.string().min(1).max(180).parse(input.authorizationContext);
  const filters = operationsViewFiltersSchema.parse(input.filters ?? {});
  const now = (input.now ?? Date.now)();
  let cursor: z.infer<typeof pageCursorSchema> | null = null;
  if (input.cursor !== null) {
    try { cursor = pageCursorSchema.parse(openOperationsToken(input.scope, input.secret, "cursor", input.cursor)); }
    catch { throw new OperationsCursorError("INVALID_OPERATIONS_CURSOR"); }
    if (cursor.view !== input.viewKey || cursor.authorization !== authorization || cursor.limit !== input.limit || JSON.stringify(cursor.filters) !== JSON.stringify(filters))
      throw new OperationsCursorError("INVALID_OPERATIONS_CURSOR");
    if (cursor.expires <= now) throw new OperationsCursorError("OPERATIONS_CURSOR_EXPIRED");
  }
  const scope = input.db.prepare("SELECT workspace_id, account_id FROM agent_scope WHERE id=1").get();
  if (input.scope.environment !== "sandbox" || scope?.workspace_id !== input.scope.workspaceId || scope.account_id !== input.scope.accountId)
    throw new Error("DATABASE_SCOPE_MISMATCH");
  const key = createHmac("sha256", input.secret).update(JSON.stringify(["operations-display.v1", input.scope.workspaceId, input.scope.accountId, input.scope.environment])).digest();
  const alias = (kind: string, raw: string) => kind + "-" + createHmac("sha256", key).update(kind + "\0" + raw).digest("hex").slice(0, 16);
  const observedAt = new Date(now).toISOString();
  const offset = cursor?.offset ?? 0;
  let nextCursor: string | null = null;
  let data: SavedBindings | SavedRuns;
  // One read snapshot ties the displayed totals to their rows even when another process writes the SQLite store.
  input.db.exec("BEGIN");
  try {
    // Membership and ordering are frozen at the first read. Permission, health and job state are recomputed on every page.
    const marks = cursor?.marks ?? {
      bindings: Number(input.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM capability_events").get()!.n),
      jobs: Number(input.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM job_heads").get()!.n),
      runs: Number(input.db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM job_runs").get()!.n),
    };
    if (input.viewKey === "automationRuns") {
      const rows = input.db.prepare("SELECT run_id FROM job_runs WHERE rowid<=? ORDER BY observed_at DESC,run_id DESC LIMIT ? OFFSET ?").all(marks.runs,input.limit,offset);
      const jobs = input.db.prepare("SELECT job_id FROM job_heads WHERE rowid<=? ORDER BY job_id LIMIT ? OFFSET ?").all(marks.jobs,input.limit,offset);
      const total = Number(input.db.prepare("SELECT COUNT(*) AS total FROM job_runs WHERE rowid<=?").get(marks.runs)!.total);
      const jobTotal = Number(input.db.prepare("SELECT COUNT(*) AS total FROM job_heads WHERE rowid<=?").get(marks.jobs)!.total);
      data = { kind: "saved-runs", source: "saved-operations", observedAt, coverage: coverage(total, Math.min(total, offset + rows.length)), jobCoverage: coverage(jobTotal, Math.min(jobTotal, offset + jobs.length)),
        jobs: jobs.map(row => {
          const job = input.jobs.getJob(String(row.job_id));
          return { id: alias("job", job.definition.jobId), scheduleRef: sealOperationsToken(input.scope, input.secret, "schedule-job", job.definition.jobId), version: job.definition.version, mode: job.definition.mode, enabled: job.enabled, paused: job.paused };
        }),
        records: rows.map(row => {
          const run = input.jobs.getRun(String(row.run_id));
          const results = run.items.flatMap(item => item.result
            ? [item.result.schemaVersion === "job-local-result.v1" ? item.result.artifactRef : item.result.receiptRef]
            : []);
          return { id: alias("run", run.runId), job: alias("job", run.jobId), correlation: alias("event", run.eventId), version: run.definition.version, mode: run.definition.mode,
            observedAt: run.observedAt, state: run.state, items: run.counts.total, completed: run.counts.completed, blockers: safeReasons(run.blockerCodes),
            receiptCount: results.length, receipt: results[0] ? alias("receipt", results[0]) : null };
        }) };
    } else {
      const total = Number(input.db.prepare("SELECT COUNT(DISTINCT capability_id) AS total FROM capability_events WHERE rowid<=?").get(marks.bindings)!.total);
      const page = input.db.prepare("SELECT DISTINCT capability_id FROM capability_events WHERE rowid<=? ORDER BY capability_id LIMIT ? OFFSET ?").all(marks.bindings, input.limit, offset);
      data = { kind: "saved-bindings", source: "saved-operations", observedAt, coverage: coverage(total, Math.min(total, offset + page.length)),
        records: page.map(row => {
          const record = input.ledger.get(String(row.capability_id))!;
          const binding = record.registration.binding;
          const health = input.health?.get(record.capabilityId);
          return { id: alias("binding", record.capabilityId), provider: publicProviders.has(binding.provider) ? binding.provider : "Registered provider",
            action: publicActions.get(binding.action) ?? alias("action", binding.action), account: alias("account", JSON.stringify([binding.provider, binding.providerAccountId])), owner: alias("owner", record.registration.ownerRef),
            mode: binding.mode, route: binding.route, state: readState(record), revision: record.revision, checkedAt: timestamp(record.checkedAt), expiresAt: timestamp(record.expiresAt),
            receipt: record.receiptRef ? alias("receipt", record.receiptRef) : null, observedAt: timestamp(record.sourceFreshness.observedAt),
            sourceUpdatedAt: timestamp(health?.checkedAt ? health.sourceUpdatedAt : record.sourceFreshness.sourceUpdatedAt), lastSuccessAt: timestamp(health?.sourceLastSuccess ?? null),
            sourceHealth: health ? { state: health.state, permission: health.permission, session: health.session, checkedAt: timestamp(health.checkedAt),
              mirrorUpdatedAt: timestamp(health.mirrorUpdatedAt), coverage: health.coverage } : null,
            freshness: health?.checkedAt ? health.freshness : record.sourceFreshness.state, blockers: safeReasons(record.reasonCodes) };
        }) };
    }
    const more = data.coverage.partial || (data.kind === "saved-runs" && data.jobCoverage.partial);
    if (more) nextCursor = sealOperationsToken(input.scope, input.secret, "cursor", {
      authorization, filters, view: input.viewKey, limit: input.limit, marks, offset: offset + input.limit, expires: cursor?.expires ?? now + 15 * 60_000,
    });
    input.db.exec("COMMIT");
  } catch (error) { input.db.exec("ROLLBACK"); throw error; }
  return { data, observedAt, nextCursor, hasMore: nextCursor !== null, returned: data.coverage.returned, total: data.coverage.total,
    partial: data.coverage.partial || (data.kind === "saved-runs" && data.jobCoverage.partial) };
}
