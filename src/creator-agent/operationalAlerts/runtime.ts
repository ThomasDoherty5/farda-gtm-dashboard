import { z } from "zod";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { digest } from "../config.ts";
import type { DigestScope } from "../dailyDigest/contract.ts";
import { RuntimeError, runtimeInstant, type RuntimeExecutionContext, type RuntimeExecutor, type RuntimeRegistry } from "../jobs/runtimeSchema.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { alertPolicySchema, alertSweepSchema } from "./contract.ts";
import type { OperationalAlertRepository } from "./repository.ts";

type Request = { scope: DigestScope; window: RuntimeExecutionContext["window"]; maxRecords: number };
const snapshotSchema = z.object({
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/), policy: alertPolicySchema, sweep: alertSweepSchema, validUntil: runtimeInstant,
}).strict();
type Snapshot = z.infer<typeof snapshotSchema>;

export type OperationalAlertSweepBinding = {
  registrationRef: string;
  subjectRef: string;
  source: {
    read(request: Request): Promise<unknown>;
    assertCurrent(snapshot: Snapshot, request: Request, now: number): void;
  };
};

/** The existing registered runtime owns cadence, job leases, quota and safe-read retries. */
export function bindOperationalAlertSweep(repository: OperationalAlertRepository, scope: DigestScope, registry: RuntimeRegistry,
  binding: OperationalAlertSweepBinding, now = Date.now): RuntimeRegistry {
  const registration = registry.registrations.get(binding.registrationRef);
  if (!registration || registration.family !== "registered-business" || registration.definition.mode !== "observe" ||
      registration.definition.budgets.maxConcurrency !== 1 ||
      registration.membership !== "source-partitions" || !registration.apiBinding || registration.browserBinding ||
      registration.apiChannel === "model" || registration.cadence.kind !== "event" ||
      registration.cadence.eventType !== "operational-threshold-sweep.v1" || registry.executors.has(registration.executorRef) ||
      [...registry.registrations.values()].some(other => other.registrationRef !== registration.registrationRef &&
        other.executorRef === registration.executorRef)) throw new RuntimeError("ALERT_SWEEP_REGISTRATION_INVALID", 422);
  const registrationHash = digest(registration);
  const executor: RuntimeExecutor = {
    mode: "observe",
    async execute(context) {
      if (digest(context.registration) !== registrationHash || digest(context.binding) !== digest(registration.apiBinding) ||
          context.subjectRef !== binding.subjectRef || context.cursor !== null || context.window.eventRef === null) {
        throw new RuntimeError("ALERT_SWEEP_WINDOW_MISMATCH", 409);
      }
      const request = { scope: { ...scope }, window: structuredClone(context.window), maxRecords: context.maxRecords };
      const response = await context.invoke(registration.apiChannel,
        () => boundedSourceRead(() => binding.source.read(structuredClone(request))))
        .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      context.assertCurrent();
      if (!response.ok) {
        if (response.error instanceof RuntimeError && ![429, 503, 504].includes(response.error.status)) throw response.error;
        return { state: "retry", reasonCode: "ALERT_SWEEP_READ_UNAVAILABLE", retryAfterMs: 1000 };
      }
      const parsed = snapshotSchema.safeParse(response.value);
      if (!parsed.success || parsed.data.requestDigest !== digest(request) ||
          parsed.data.sweep.expected.length > context.maxRecords ||
          Date.parse(parsed.data.sweep.observedAt) < Date.parse(context.window.intendedAt)) {
        throw new RuntimeError("ALERT_SWEEP_SOURCE_MISMATCH", 502);
      }
      const snapshot = parsed.data;
      const result = repository.record(snapshot.policy, snapshot.sweep, () => {
        context.assertCurrent();
        const at = now(), observed = Date.parse(snapshot.sweep.observedAt), expires = Date.parse(snapshot.validUntil);
        if (observed > at || expires <= at || expires - observed > 900_000) throw new RuntimeError("ALERT_SWEEP_SOURCE_EXPIRED", 409);
        assertSynchronousVoid(() => binding.source.assertCurrent(structuredClone(snapshot), structuredClone(request), at));
        context.assertCurrent();
      }, context.runRef);
      if (result.run.unconfigured.length) return { state: "held", reasonCode: "ALERT_THRESHOLD_UNCONFIGURED" };
      if (result.run.incompleteFamilies.length || result.run.olderObservations ||
          result.run.states.some(state => state.evaluation.state === "incomplete")) {
        return { state: "retry", reasonCode: "ALERT_SWEEP_INCOMPLETE", retryAfterMs: 1000 };
      }
      return { state: "completed", evidenceRefs: snapshot.sweep.expected.length ? [result.run.runRef] : [],
        recordCount: snapshot.sweep.expected.length, sourceReceiptRef: snapshot.sweep.sourceReceipt };
    },
  };
  return { registrations: registry.registrations, executors: new Map(registry.executors).set(registration.executorRef, executor) };
}
