import { digest } from "../config.ts";
import type { DigestScope, DigestWindow } from "../dailyDigest/contract.ts";
import { ReportError, reportEventSchema, type ReportEvent, type ReportLocator, type ReportSnapshot,
  type ReportSourceRead, type ReportingSource } from "../slackReporting/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { thresholdDigestSchema, thresholdReportContextSchema } from "./presentation.ts";
import type { AlertRun, AlertTransition, OperationalAlertRepository } from "./repository.ts";

export type OperationalAlertReportBinding = {
  event: Pick<ReportEvent, "producerRef" | "link">;
  maxSweepAgeMs: number;
  readDelivery(event: ReportEvent, transition: AlertTransition, context: ReportSourceRead): Promise<Omit<ReportSnapshot, "event">>;
  assertTransitionCurrent(transition: AlertTransition, purpose: ReportSourceRead["purpose"], now: number): void;
  assertRunCurrent(run: AlertRun, now: number): void;
  assertDigestCurrent(run: AlertRun | null, window: DigestWindow, now: number): void;
};
function details(state: AlertTransition["state"]) {
  return thresholdReportContextSchema.parse({
    kind: state.rule.kind, observed: state.evaluation.observed, threshold: state.rule.threshold, unit: state.rule.unit,
    currency: state.rule.currency, decimals: state.rule.decimals, sourceAsOf: state.sourceAsOf, state: state.evaluation.state,
  });
}

export function operationalThresholdEvent(transition: AlertTransition, binding: OperationalAlertReportBinding["event"]) {
  const { state } = transition;
  const clear = transition.transition === "clear";
  const digestRecovery = state.rule.severity === "orange";
  if (digestRecovery && !clear) throw new ReportError("ALERT_ORANGE_DIGEST_ONLY");
  return reportEventSchema.parse({
    ...binding, eventRef: transition.ref, eventVersion: "alert-source-" + digest([state.ruleDigest, transition.sourceReceipt, state.evidenceDigest]),
    occurredAt: transition.at, severity: clear ? "info" : "red",
    identity: { kind: "incident", conditionRef: state.ref, generation: state.generation, transition: transition.transition,
      sequence: state.generation * 2 - Number(!clear), previousClearEventRef: state.lastClear },
    subject: { kind: "aggregate", category: "automation" },
    facts: [{ label: "incidentStatus", value: clear ? "cleared" : "breached" }],
    nextAction: clear ? "continueMonitoring" : "reviewSource", thresholdAlert: details(state),
    ...(digestRecovery ? { thresholdDigestRecovery: true } : {}),
  });
}

export function bindOperationalAlertReporting(repository: OperationalAlertRepository, scope: DigestScope,
  binding: OperationalAlertReportBinding, delegate: ReportingSource, now = Date.now) {
  if (!Number.isSafeInteger(binding.maxSweepAgeMs) || binding.maxSweepAgeMs <= 0 || binding.maxSweepAgeMs > 86_400_000) {
    throw new ReportError("ALERT_SWEEP_AGE_UNAPPROVED", 422);
  }
  const owns = (locator: ReportLocator) => /^threshold-[a-f0-9]{32}-[1-9]\d*-(breach|clear)$/.test(locator.eventRef);
  const load = (locator: ReportLocator) => {
    const transition = repository.transition(locator.eventRef);
    if (!transition) throw new ReportError("ALERT_TRANSITION_MISSING", 404);
    const event = operationalThresholdEvent(transition, binding.event);
    if (event.eventVersion !== locator.eventVersion) throw new ReportError("ALERT_TRANSITION_VERSION_CHANGED");
    return { transition, event };
  };
  const reportingSource: ReportingSource = {
    async readEvent(locator, context) {
      if (!owns(locator)) return delegate.readEvent(locator, context);
      if (!context) throw new ReportError("ALERT_MACHINE_REQUIRED", 403);
      context.assertCurrent();
      const { transition, event } = load(locator);
      const snapshot = await binding.readDelivery(structuredClone(event), structuredClone(transition), context);
      context.assertCurrent();
      if (digest(snapshot.scope) !== digest(scope)) throw new ReportError("REPORT_SCOPE_MISMATCH", 403);
      return { ...snapshot, event };
    },
    assertCurrent(snapshot, purpose, timestamp) {
      if (owns(snapshot.event)) {
        const { transition, event } = load(snapshot.event);
        if (digest(event) !== digest(snapshot.event)) throw new ReportError("ALERT_TRANSITION_CHANGED");
        assertSynchronousVoid(() => binding.assertTransitionCurrent(structuredClone(transition), purpose, timestamp));
      }
      assertSynchronousVoid(() => delegate.assertCurrent(snapshot, purpose, timestamp));
    },
    authorizeAttempt: (snapshot, command) => delegate.authorizeAttempt(snapshot, command),
    assertGrant: (grant, command, timestamp) => delegate.assertGrant(grant, command, timestamp),
    deliver: (command, context) => delegate.deliver(command, context),
    lookup: (command, context) => delegate.lookup(command, context),
  };
  const link = binding.event.link;
  const sourceLink = `https://linear.app/${link.workspaceSlug}/issue/${link.issueIdentifier}`;
  const loadRun = (window: DigestWindow) => repository.latestRun(Date.parse(window.scheduledAt));
  function digestFor(window: DigestWindow) {
    const run = loadRun(window);
    assertSynchronousVoid(() => binding.assertDigestCurrent(run ? structuredClone(run) : null, structuredClone(window), now()));
    if (!run || Date.parse(window.scheduledAt) - Date.parse(run.observedAt) > binding.maxSweepAgeMs) {
      return thresholdDigestSchema.parse({
        sourceLink, state: "unavailable", active: 0, activeRed: 0, incomplete: 1, conditions: [], details: [],
      });
    }
    const orange = run.states.filter(state => state.active && state.rule.severity === "orange");
    const incomplete = run.unconfigured.length + run.incompleteFamilies.length + run.olderObservations +
      run.states.filter(state => state.evaluation.state === "incomplete").length;
    return thresholdDigestSchema.parse({
      sourceLink, state: incomplete ? "partial" : "complete", active: orange.length,
      activeRed: run.states.filter(state => state.active && state.rule.severity === "red").length, incomplete,
      conditions: orange.map(state => `${state.ref}-${state.generation}`).sort(),
      details: orange.slice(0, 8).map(details),
    });
  }
  function deliveriesFor(runtimeRunRef: string) {
    const runs = repository.runsForRuntime(runtimeRunRef);
    const latest = runs.at(-1);
    if (!latest) throw new ReportError("ALERT_SWEEP_NOT_FOUND", 404);
    assertSynchronousVoid(() => binding.assertRunCurrent(structuredClone(latest), now()));
    const refs = new Set(runs.flatMap(run => run.transitions));
    return [...refs].flatMap(ref => {
      const transition = repository.transition(ref);
      if (!transition) throw new ReportError("ALERT_TRANSITION_MISSING", 409);
      if (transition.state.rule.severity === "orange" && transition.transition === "breach") return [];
      assertSynchronousVoid(() => binding.assertTransitionCurrent(structuredClone(transition), "admit", now()));
      const { eventRef, eventVersion } = operationalThresholdEvent(transition, binding.event);
      return [{ locator: { eventRef, eventVersion }, idempotencyKey: eventRef }];
    });
  }
  return { reportingSource, digestFor, deliveriesFor };
}
