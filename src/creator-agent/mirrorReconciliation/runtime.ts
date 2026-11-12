import { z } from "zod";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import { RuntimeError, runtimeInstant, runtimeRef, type RuntimeExecutionContext, type RuntimeExecutor, type RuntimeRegistration, type RuntimeRegistry } from "../jobs/runtimeSchema.ts";
import type { OperationsScope } from "../operations.ts";
import { OperationsControlError, type OperationsControlSource, type OperationsReadBinding, type OperationsSourceResult } from "../operationsControls.ts";
import { operationsControlSourceSchema } from "../operationsControlsSchema.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { checkInputSchema, checkScheduleSchema, type CheckSchedule } from "./contract.ts";
import type { MirrorReconciliationRepository } from "./repository.ts";
import { reconciliationReport, type ReconciliationReportBinding } from "./report.ts";
import { duePeriods } from "./schedule.ts";

type ReadRequest = {
  scope: OperationsScope;
  schedule: CheckSchedule;
  window: RuntimeExecutionContext["window"];
  periods: string[];
  maxRecords: number;
};
const snapshotSchema = z.object({
  receiptRef: runtimeRef,
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  observedAt: runtimeInstant,
  validUntil: runtimeInstant,
  coverage: checkInputSchema.innerType().shape.coverage,
  sourceRows: checkInputSchema.innerType().shape.sourceRows,
  mirrorRows: checkInputSchema.innerType().shape.mirrorRows,
}).strict();
type ReadSnapshot = z.infer<typeof snapshotSchema>;

export type ReconciliationReader = {
  read(request: ReadRequest): Promise<unknown>;
  assertCurrent(snapshot: ReadSnapshot, request: ReadRequest, now: number): void;
  assertReadable(binding: OperationsReadBinding): void;
};
export type MirrorReconciliationBinding = {
  registrationRef: string;
  schedule: CheckSchedule;
  source: ReconciliationReader;
};

const viewDigest = digest({ section: "reconciliation" });
const sourceFields = { roles: [], tasks: [], takeovers: [], permissions: [], reports: [], attribution: [], handoffs: [], runMembership: [] };

function assertRegistration(registration: RuntimeRegistration | undefined, schedule: CheckSchedule): asserts registration is RuntimeRegistration {
  const cadence = registration?.cadence;
  if (!registration || registration.definition.mode !== "observe" || registration.family !== "registered-business" ||
      registration.membership !== "source-partitions" || !registration.apiBinding || registration.browserBinding || registration.apiChannel === "model" ||
      cadence?.kind !== "calendar" || cadence.draft.cadence !== "daily" || cadence.draft.activeCohortOverride ||
      cadence.draft.timezone !== schedule.timezone || cadence.draft.localTime !== schedule.runAt) {
    throw new RuntimeError("MIRROR_CHECK_REGISTRATION_MISMATCH", 422);
  }
}

/** Bind one scheduled, read-only source to the existing registered job runtime. */
export function bindMirrorReconciliation(repo: MirrorReconciliationRepository, scope: OperationsScope,
  registry: RuntimeRegistry, config: MirrorReconciliationBinding) {
  const schedule = checkScheduleSchema.parse(config.schedule);
  const registration = registry.registrations.get(config.registrationRef);
  assertRegistration(registration, schedule);
  if (registry.executors.has(registration.executorRef) || [...registry.registrations.values()].some(other =>
    other.registrationRef !== registration.registrationRef && other.executorRef === registration.executorRef)) {
    throw new RuntimeError("MIRROR_CHECK_EXECUTOR_IN_USE", 409);
  }
  repo.saveSchedule(schedule);
  const registrationHash = digest(registration);
  const { ownerRef, version: registrationVersion } = registration;
  const scheduleHash = digest(schedule);
  const { source } = config;
  const executor: RuntimeExecutor = {
    mode: "observe",
    async execute(context) {
      if (digest(context.registration) !== registrationHash || digest(context.binding) !== digest(registration.apiBinding) ||
          context.subjectRef !== schedule.checkId || context.cursor !== null || digest(repo.schedule(schedule.checkId)) !== scheduleHash) {
        throw new RuntimeError("MIRROR_CHECK_WINDOW_MISMATCH", 409);
      }
      const periods = duePeriods(schedule, Date.parse(context.window.intendedAt));
      if (!periods.length) throw new RuntimeError("MIRROR_CHECK_NO_DUE_PERIOD", 409);
      const request: ReadRequest = { scope: { ...scope }, schedule: structuredClone(schedule), window: structuredClone(context.window),
        periods, maxRecords: context.maxRecords };
      const response = await context.invoke(registration.apiChannel, () => boundedSourceRead(() => source.read(structuredClone(request))))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      context.assertCurrent();
      if (!response.ok) {
        if (response.error instanceof RuntimeError && response.error.status !== 503 && response.error.status !== 504) throw response.error;
        return { state: "retry", reasonCode: "SOURCE_READ_UNAVAILABLE", retryAfterMs: 1000 };
      }
      const parsed = snapshotSchema.safeParse(response.value);
      if (!parsed.success || parsed.data.requestDigest !== digest(request)) throw new RuntimeError("MIRROR_CHECK_SOURCE_MISMATCH", 502);
      const snapshot = parsed.data;
      const recordCount = snapshot.sourceRows.length + snapshot.mirrorRows.length;
      if (recordCount > context.maxRecords) throw new RuntimeError("RUNTIME_SOURCE_BOUND_EXCEEDED", 502);
      const assertCurrent = () => {
        context.assertCurrent();
        const now = repo.now(), observed = Date.parse(snapshot.observedAt), expires = Date.parse(snapshot.validUntil);
        if (observed > now || expires <= now || expires - observed > 900_000 ||
            snapshot.coverage.some(read => Date.parse(read.readAt) > observed)) {
          throw new RuntimeError("MIRROR_CHECK_SOURCE_EXPIRED", 409);
        }
        assertSynchronousVoid(() => source.assertCurrent(structuredClone(snapshot), structuredClone(request), now));
        context.assertCurrent();
      };
      const runId = `mirror-check:${digest([scope, context.window.windowRef, snapshot.receiptRef])}`;
      const result = repo.recordCheck({ runId, checkId: schedule.checkId, scheduleVersion: schedule.version, periods,
        scheduledWindow: { start: context.window.windowStart, end: context.window.windowEnd, timezone: schedule.timezone },
        coverage: snapshot.coverage, sourceRows: snapshot.sourceRows, mirrorRows: snapshot.mirrorRows }, assertCurrent);
      if (result.run.outcome === "incomplete" || result.run.staleComparisons) {
        return { state: "retry", reasonCode: "RECONCILIATION_INCOMPLETE", retryAfterMs: 1000 };
      }
      return { state: "completed", evidenceRefs: [], recordCount, sourceReceiptRef: snapshot.receiptRef };
    },
  };

  function assertReadable(binding: OperationsReadBinding) {
    if (binding.operation !== "read" || binding.requestDigest !== viewDigest || digest(binding.scope) !== digest(scope)) {
      throw new OperationsControlError("SOURCE_SCOPE_DENIED", 403);
    }
    try { assertSynchronousVoid(() => source.assertReadable(structuredClone(binding))); }
    catch { throw new OperationsControlError("SOURCE_SCOPE_DENIED", 403); }
  }
  function projection() {
    if (digest(repo.schedule(schedule.checkId)) !== scheduleHash) return null;
    const slice = repo.latestSlice(schedule.checkId);
    if (!slice || slice.scheduleVersion !== schedule.version) return null;
    return operationsControlSourceSchema.parse({
      ...sourceFields, scope, revision: `reconciliation:${schedule.version}:${slice.sequence}`, observedAt: slice.observedAt,
      coverage: slice.coverage, comparisons: slice.comparisons,
      conflicts: slice.conflicts.map(conflict => ({ ...conflict, ownerRef })),
    });
  }
  const view: OperationsControlSource = {
    async read(binding): Promise<OperationsSourceResult> {
      assertReadable(binding);
      const snapshot = projection(), now = repo.now();
      return { snapshot, authority: { binding, sourceVersion: snapshot?.revision ?? null,
        permissionVersion: `reconciliation:${registrationVersion}`, observedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 60_000).toISOString() } };
    },
    assertCurrent(result, binding) {
      assertReadable(binding);
      if (digest(result.snapshot) !== digest(projection())) throw new OperationsControlError("SOURCE_CHANGED", 409);
    },
  };
  return { registry: { registrations: registry.registrations, executors: new Map(registry.executors).set(registration.executorRef, executor) }, view,
    report(runId: string, binding: ReconciliationReportBinding) { return reconciliationReport(repo, runId, binding); } };
}
