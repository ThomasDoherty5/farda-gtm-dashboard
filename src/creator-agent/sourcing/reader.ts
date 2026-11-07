import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { SOURCING_PLAN_VIEW, sourcingPlanFilters, sourcingPlanSchema, type SourcingPlan, type SourcingPlanBody } from "./contract.ts";
import { SourcingError, sourcingSnapshotSchema, type SourcingPlanSourceReader, type SourcingSnapshot } from "./source.ts";

export { SourcingError } from "./source.ts";
type Role = "reader" | "reviewer";
type Options = { db: DatabaseSync; scope: OperationsScope; secret: string; source?: SourcingPlanSourceReader; now?: () => number; sourceTimeoutMs?: number };
type SourceRead = { snapshot: SourcingSnapshot | null; state: SourcingPlan["sourceState"]; reason: string | null };
type Capability = { actionKind: string; state: "available" | "held" | "denied"; reasonCodes: string[] };
export type SourcingPlanReadResult = {
  data: SourcingPlan; version: string; dataState: "ready" | "partial" | "stale" | "unavailable";
  /** Counts are null, not zero, when no plan was read: nothing is known about what was expected. */
  coverage: { expectedCount: number | null; observedCount: number | null; missingCount: number | null; complete: boolean; reasonCodes: string[] };
  capabilities: Capability[];
};
const fail = (code: string, status: number): never => { throw new SourcingError(code, status); };
const unknownCount = (missingReason: string) => ({ value: null, missingReason });

/**
 * Read-only daily sourcing plan (THO-287). It projects the injected J19 source; with no source it answers an honest
 * unconfigured state. It never substitutes demo data, never turns an unknown into zero, and has no write path.
 */
export function createSourcingPlanReader(options: Options) {
  const { db, scope, secret, source } = options, now = options.now ?? Date.now, timeoutMs = options.sourceTimeoutMs ?? 10_000;
  const binding = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if (!binding || binding.workspace_id !== scope.workspaceId || binding.account_id !== scope.accountId || scope.environment !== "sandbox") fail("DATABASE_SCOPE_MISMATCH", 403);
  if (secret.length < 32) throw new Error("Sourcing reference key must be private and at least 32 characters.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["sourcing.v1", scope, kind, value])).digest("hex").slice(0, 32);
  db.exec(`CREATE TABLE IF NOT EXISTS sourcing_plan_source_versions(version TEXT PRIMARY KEY,facts_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sourcing_plan_source_head(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,observed_at TEXT NOT NULL);`);
  function tx<T>(fn: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }

  async function observe(): Promise<SourceRead> {
    if (!source) return { snapshot: null, state: "unconfigured", reason: "SOURCING_SOURCE_UNCONFIGURED" };
    let raw: unknown, timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([source({ ...scope }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("SOURCE_TIMEOUT")), timeoutMs); })]);
    } catch (error) {
      if (error instanceof SourcingError && (error.status === 401 || error.status === 403)) fail("SOURCE_AUTHORITY_DENIED", 403);
      return { snapshot: null, state: "unavailable", reason: "SOURCING_SOURCE_UNAVAILABLE" };
    } finally { clearTimeout(timer); }
    if (raw === null) return { snapshot: null, state: "unavailable", reason: "SOURCING_SOURCE_UNAVAILABLE" };
    // A malformed answer is a source failure, never an empty plan.
    const parsed = sourcingSnapshotSchema.safeParse(raw);
    if (!parsed.success) fail("SOURCE_RESPONSE_INVALID", 502);
    const s = parsed.data!;
    if (digest(s.scope) !== digest(scope)) fail("SOURCE_SCOPE_DENIED", 403);
    const current = now();
    if (!Number.isFinite(current) || Date.parse(s.observedAt) > current) fail("SOURCE_RESPONSE_INVALID", 502);
    const { observedAt, validUntil, ...facts } = s; void observedAt; void validUntil;
    const factsHash = digest(facts);
    tx(() => {
      const previous = db.prepare("SELECT facts_hash FROM sourcing_plan_source_versions WHERE version=?").get(s.version);
      if (previous && previous.facts_hash !== factsHash) fail("SOURCE_VERSION_CHANGED", 409);
      const head = db.prepare("SELECT version,observed_at FROM sourcing_plan_source_head WHERE id=1").get();
      if (head && Date.parse(String(head.observed_at)) > Date.parse(s.observedAt)) fail("SOURCE_VERSION_CHANGED", 409);
      if (head && head.version !== s.version && Date.parse(String(head.observed_at)) === Date.parse(s.observedAt)) fail("SOURCE_VERSION_CHANGED", 409);
      db.prepare("INSERT OR IGNORE INTO sourcing_plan_source_versions VALUES(?,?)").run(s.version, factsHash);
      db.prepare("INSERT INTO sourcing_plan_source_head VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,observed_at=excluded.observed_at").run(s.version, s.observedAt);
    });
    const expired = Date.parse(s.validUntil) <= current;
    return { snapshot: s, state: expired ? "expired" : s.coverage === "partial" ? "partial" : "current", reason: expired ? "SOURCE_STALE" : s.coverage === "partial" ? "SOURCE_COVERAGE_PARTIAL" : null };
  }

  function project(s: SourcingSnapshot, read: SourceRead, at: number): SourcingPlanBody {
    const holds: string[] = [];
    if (read.state !== "current") holds.push(read.reason!);
    if (s.schedule.cadence === null) holds.push("SCHEDULE_CADENCE_UNSET");
    if (s.schedule.timezone === null) holds.push("SCHEDULE_TIMEZONE_UNSET");
    if (s.schedule.nextRunAt === null) holds.push("SCHEDULE_NEXT_RUN_UNKNOWN");
    else if (Date.parse(s.schedule.nextRunAt) <= at) holds.push("SCHEDULE_NEXT_RUN_OVERDUE");
    for (const a of s.sources) {
      if (a.accountRef === null) holds.push(`SOURCE_ACCOUNT_UNKNOWN:${a.source}`);
      if (a.access !== "verified") holds.push(`SOURCE_ACCESS_${a.access.toUpperCase()}:${a.source}`);
      if (a.session !== "open") holds.push(`BROWSER_SESSION_${a.session.toUpperCase()}:${a.source}`);
    }
    // Unconfigured schedules and closed sessions never read as active, whatever the source claims.
    const effectiveState = s.schedule.state === "active" && holds.length > 0 ? "draft" : s.schedule.state;
    const reported = new Set(s.capacity.map((r) => `${r.source}:${r.kind}`));
    const missing = s.sources.filter((a) => !reported.has(`${a.source}:invitations`)).map((a) => ({
      source: a.source, kind: "invitations" as const, unit: "invitations" as const, currency: null,
      limit: unknownCount("CAPACITY_NOT_REPORTED"), used: unknownCount("CAPACITY_NOT_REPORTED"), remaining: unknownCount("CAPACITY_NOT_REPORTED"),
      resetAt: null, observedAt: null, validUntil: null, receipt: null,
    }));
    const capacity = [...s.capacity, ...missing].map((r) => {
      const leaseExpired = read.state === "expired" || r.validUntil !== null && Date.parse(r.validUntil) <= at;
      const resetPassed = r.resetAt !== null && Date.parse(r.resetAt) <= at && (r.observedAt === null || Date.parse(r.observedAt) < Date.parse(r.resetAt));
      const state = r.remaining.value === null ? "unknown" as const : leaseExpired || resetPassed ? "stale" as const : "current" as const;
      const blockReason = state === "unknown" ? r.remaining.missingReason === "CAPACITY_NOT_REPORTED" ? "CAPACITY_NOT_REPORTED" : "CAPACITY_UNKNOWN"
        : state === "stale" ? resetPassed ? "CAPACITY_RESET_STALE" : "CAPACITY_LEASE_EXPIRED" : r.remaining.value === 0 ? "CAPACITY_EXHAUSTED" : null;
      return { ...r, receipt: r.receipt ? alias("receipt", r.receipt) : null, state, dispatchBlocked: blockReason !== null, blockReason };
    });
    const capacityHolds = capacity.filter((r) => r.blockReason).map((r) => `${r.blockReason}:${r.source}:${r.kind}`);
    return {
      planRef: alias("plan", s.planRef), icpVersion: s.icpVersion, policyVersion: s.policyVersion,
      schedule: { declaredState: s.schedule.state, effectiveState, holdReasons: holds, cadence: s.schedule.cadence, timezone: s.schedule.timezone,
        lastRunAt: s.schedule.lastRunAt, nextRunAt: s.schedule.nextRunAt, scheduleRef: s.schedule.scheduleRef ? alias("schedule", s.schedule.scheduleRef) : null },
      sources: s.sources.map((a) => ({ ...a, accountRef: a.accountRef ? alias("account", a.accountRef) : null })),
      steps: s.steps.map((x) => ({ ...x, evidenceRefs: x.evidenceRefs.map((e) => alias("evidence", e)) })),
      capacity, identity: { ...s.identity, evidenceRefs: s.identity.evidenceRefs.map((e) => alias("evidence", e)) },
      latestRun: s.latestRun ? { ...s.latestRun, runRef: alias("run", s.latestRun.runRef), receiptRefs: s.latestRun.receiptRefs.map((e) => alias("receipt", e)) } : null,
      dispatchHoldReasons: [...new Set(["READ_ONLY_PLAN", "DISPATCH_NOT_CONNECTED", ...(effectiveState === "active" ? [] : holds), ...capacityHolds])],
    };
  }

  async function read(rawFilters: unknown, role: Role): Promise<SourcingPlanReadResult> {
    if (role !== "reader" && role !== "reviewer") fail("FORBIDDEN", 403);
    if (!sourcingPlanFilters.safeParse(rawFilters).success) fail("VALIDATION_FAILED", 400);
    const s = await observe(), at = now(), observedAt = new Date(at).toISOString();
    const plan = s.snapshot ? project(s.snapshot, s, at) : null;
    const data = sourcingPlanSchema.parse({
      kind: "agent-sourcing-plan", observedAt, sourceAsOf: s.snapshot?.observedAt ?? null, sourceVersion: s.snapshot ? alias("source", s.snapshot.version) : null,
      validUntil: s.snapshot?.validUntil ?? null, freshness: s.state === "expired" ? "stale" : s.snapshot ? "current" : "unknown",
      coverage: s.snapshot?.coverage ?? "unknown", sourceState: s.state, missingReason: s.reason, plan,
    });
    const steps = plan?.steps ?? [], capacity = plan?.capacity ?? [];
    const expectedCount = plan ? steps.length + capacity.length : 0;
    const observedCount = steps.filter((x) => x.count.value !== null).length + capacity.filter((r) => r.state === "current").length;
    const missingCount = expectedCount - observedCount;
    const dataState = !plan ? "unavailable" as const : s.state === "expired" ? "stale" as const : s.state === "partial" || missingCount > 0 ? "partial" as const : "ready" as const;
    const { observedAt: _readAt, ...stable } = data; void _readAt;
    return {
      data, version: "sp1-" + digest(stable), dataState,
      coverage: { expectedCount: plan ? expectedCount : null, observedCount: plan ? observedCount : null, missingCount: plan ? missingCount : null, complete: dataState === "ready",
        reasonCodes: [...new Set([...(s.reason ? [s.reason] : []), ...(missingCount > 0 ? ["PLAN_VALUES_UNKNOWN_OR_STALE"] : [])])] },
      capabilities: [
        { actionKind: "startLiveDiscovery", state: "held", reasonCodes: ["SOURCE_AUTOMATION_NOT_CONNECTED"] },
        role === "reviewer" ? { actionKind: "requestBatchApproval", state: "held", reasonCodes: ["APPROVAL_SERVICE_NOT_CONNECTED"] }
          : { actionKind: "requestBatchApproval", state: "denied", reasonCodes: ["REVIEWER_REQUIRED"] },
      ],
    };
  }

  /** Adapter envelope for `POST /v1/read`. Every refusal is a canonical D-14 error body; nothing reaches the source before scope and filters pass. */
  async function respond(raw: unknown, role: Role, schemaVersion: string): Promise<{ status: number; body: unknown }> {
    const requestId = typeof (raw as { requestId?: unknown })?.requestId === "string" ? String((raw as { requestId: string }).requestId).slice(0, 240) : null;
    const refuse = (status: number, code: string, message: string, fieldErrors?: Record<string, string>) => ({ status, body: {
      code, message, requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" as const, ...(fieldErrors ? { fieldErrors } : {}) } });
    const issues = (error: z.ZodError, prefix: string) => Object.fromEntries(error.issues.slice(0, 20).map((i) => [[prefix, ...i.path].filter(Boolean).join(".") || "request", i.message]));
    const envelope = envelopeSchema(schemaVersion).safeParse(raw);
    if (!envelope.success) return refuse(400, "VALIDATION_FAILED", "The daily sourcing plan request is not valid.", issues(envelope.error, ""));
    const input = envelope.data;
    const requested = input.requestedScope;
    if (requested.workspaceId !== scope.workspaceId || requested.environment !== scope.environment || requested.accountIds.length !== 1 || requested.accountIds[0] !== scope.accountId)
      return refuse(403, "FORBIDDEN", "This scope is not available.");
    if (input.page.cursor !== null) return refuse(400, "INVALID_CURSOR", "The daily sourcing plan has one page.");
    const filters = sourcingPlanFilters.safeParse(input.filters);
    if (!filters.success) return refuse(400, "VALIDATION_FAILED", "The daily sourcing plan accepts no filters.", issues(filters.error, "filters"));
    let result: SourcingPlanReadResult;
    try { result = await read(filters.data, role); }
    catch (error) {
      if (!(error instanceof SourcingError)) throw error;
      const message = error.status === 403 ? "This source is not available." : error.status === 409 ? "The sourcing source changed. Refresh to read the current plan." : "The sourcing source returned an unreadable plan.";
      return refuse(error.status, error.code, message);
    }
    const freshnessState = result.data.sourceState === "unconfigured" ? "neverSynced" : result.data.sourceState === "unavailable" || result.data.sourceState === "expired" ? "error"
      : result.data.sourceState === "partial" ? "partial" : "current";
    return { status: 200, body: {
      schemaVersion, requestId: input.requestId, scope: { ...requested, authorizationScopeVersion: "creator-agent.scope.v1" },
      dataVersion: result.version, dataState: result.dataState, data: result.data,
      sourceFreshness: [{ sourceRef: { source: "j19-daily-sourcing", accountId: scope.accountId, sourceId: null, canonicalId: result.data.plan?.planRef ?? null, url: null,
        identityState: result.data.plan ? "resolved" : "unresolved", provenanceRef: result.data.sourceVersion ?? result.data.missingReason ?? "SOURCING_SOURCE_UNCONFIGURED" },
      lastSourceSuccessAt: result.data.sourceAsOf, observedAt: result.data.observedAt, mirroredAt: null,
      staleReasonCode: freshnessState === "current" ? null : result.data.missingReason, freshnessState }],
      coverage: result.coverage, capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null },
    } };
  }
  return { read, respond };
}

const envelopeSchema = (schemaVersion: string) => z.object({
  schemaVersion: z.literal(schemaVersion), operation: z.literal("readView"), requestId: z.string().trim().min(1).max(240), viewKey: z.literal(SOURCING_PLAN_VIEW),
  requestedScope: z.object({ workspaceId: z.string().max(240), accountIds: z.array(z.string().max(240)).max(10), environment: z.string().max(40) }).strict(),
  filters: z.unknown(), period: z.null(), sort: z.array(z.never()).max(0), page: z.object({ cursor: z.string().max(4100).nullable(), limit: z.number().int().min(1).max(100) }).strict(),
}).strict();

/** True when a `/v1/read` body names the daily sourcing plan, so the server routes it here before the shared read union. */
export const isSourcingPlanRead = (raw: unknown) => typeof raw === "object" && raw !== null && (raw as { viewKey?: unknown }).viewKey === SOURCING_PLAN_VIEW;
