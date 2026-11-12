// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import { dailyDigestWindow } from "../dailyDigest/schedule.ts";
import { JobRuntime } from "../jobs/runtime.ts";
import { createRuntimeTestkit, runtimeSyntheticScope, syntheticRuntimeRegistration } from "../jobs/runtime.testkit.ts";
import { ReportError, type ReportEvent } from "../slackReporting/contract.ts";
import { createReportingTestkit, reportFixture, reportingScope } from "../slackReporting/fixtures.testkit.ts";
import { createSlackReporting } from "../slackReporting/service.ts";
import { AgentStore } from "../store.ts";
import { alertFamilies, alertObservationSchema, alertPolicySchema, type AlertKind, type AlertObservation, type AlertRule } from "./contract.ts";
import { evaluateThreshold } from "./evaluate.ts";
import { bindOperationalAlertReporting, operationalThresholdEvent } from "./report.ts";
import { OperationalAlertRepository } from "./repository.ts";
import { bindOperationalAlertSweep } from "./runtime.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const secret = "synthetic-operational-threshold-key-000000000000";
const now = Date.parse("2026-11-07T12:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const hour = 3_600_000;
const settings: Record<AlertKind, [AlertRule["unit"], AlertRule["comparison"], number, AlertRule["severity"]]> = {
  mediaNearCap: ["basisPoints", "atOrAbove", 9000, "orange"], mediaAtCap: ["basisPoints", "atOrAbove", 10_000, "red"],
  budgetOverrun: ["minorUnits", "above", 3_000_000, "orange"], budgetCeiling: ["minorUnits", "atOrAbove", 4_000_000, "red"],
  lowStock: ["units", "atOrBelow", 50, "orange"], zeroStock: ["units", "atOrBelow", 0, "red"],
  sampleReserve: ["units", "atOrBelow", 0, "red"], shipmentStale: ["hours", "above", 48, "orange"],
  shipmentException: ["count", "atOrAbove", 1, "orange"], supportAge: ["hours", "above", 48, "orange"],
  lowRating: ["stars", "atOrBelow", 2, "orange"], orderChecks: ["count", "atOrAbove", 1, "orange"],
};
function policy(scope = reportingScope) {
  return alertPolicySchema.parse({
    scope, version: "synthetic-policy-v1", timezone: "America/Los_Angeles", recoveryOwnerRef: "synthetic-recovery",
    rules: Object.entries(settings).map(([kind, [unit, comparison, threshold, severity]]) => ({
      kind, version: "synthetic-rule-v1", ownerRef: "synthetic-owner", approvalRef: "synthetic-approved-limit", sourceRef: "synthetic-canonical-source",
      effectiveAt: iso(now - 24 * hour), endAt: null, maxAgeMs: hour, severity, comparison, unit, threshold,
      currency: unit === "minorUnits" ? "USD" : null, decimals: unit === "minorUnits" ? 2 : null,
    })),
  });
}
const rule = (kind: AlertKind) => policy().rules.find(value => value.kind === kind)!;
function observation(family: AlertObservation["family"], fields: object): AlertObservation {
  return alertObservationSchema.parse({
    family, entityRef: "synthetic-entity", sourceRef: "synthetic-canonical-source",
    sourceVersion: "synthetic-observation-v1", asOf: iso(now), coverage: "complete", periodRef: "synthetic-bounded-period",
    ...fields,
  });
}
const stock = (fields: object) => observation("inventory", { onHand: 40, activeReservations: 40, sampleAvailable: 0,
  waitingCollaborations: 0, retainedUnitsPerDay: 8, ...fields });
const spend = (spent: number) => observation("media", { currency: "USD", spent, stageCap: 75_000, capApprovalRef: "synthetic-cap-approval" });
const budget = (total: number, fields: object = {}) => observation("budget", {
  currency: "USD", decimals: 2, actual: total - 500, committed: 250, remainingForecast: 250,
  unpricedCategories: 0, disjointBasisRef: "synthetic-disjoint-basis", ...fields,
});
const at = (kind: AlertKind, row: AlertObservation) => evaluateThreshold(rule(kind), row, iso(now));
const conditionSamples: Record<AlertKind, (breached: boolean, time: number) => AlertObservation> = {
  mediaNearCap: breached => spend(breached ? 67_500 : 67_499),
  mediaAtCap: breached => spend(breached ? 75_000 : 74_999),
  budgetOverrun: breached => budget(breached ? 3_000_001 : 3_000_000),
  budgetCeiling: breached => budget(breached ? 4_000_000 : 3_999_999),
  lowStock: breached => stock({ onHand: breached ? 90 : 91 }),
  zeroStock: breached => stock({ onHand: breached ? 40 : 41 }),
  sampleReserve: breached => stock({ waitingCollaborations: 1, sampleAvailable: breached ? 0 : 1 }),
  shipmentStale: (breached, time) => observation("shipment", { tracking: "active",
    lastTrackingAt: iso(time - (breached ? 49 : 48) * hour), deliveryException: false }),
  shipmentException: breached => observation("shipment", { tracking: "active", lastTrackingAt: iso(now), deliveryException: breached }),
  supportAge: (breached, time) => observation("support", { open: true, openedAt: iso(time - (breached ? 49 : 48) * hour) }),
  lowRating: breached => observation("review", { stars: breached ? 2 : 3 }),
  orderChecks: breached => observation("orders", { failedOrderCount: breached ? 1 : 0 }),
};
function sweep(id: string, time: number, rows: AlertObservation[], scope = reportingScope) {
  return {
    scope, policyVersion: "synthetic-policy-v1", runRef: id, sourceReceipt: "synthetic-receipt-" + id, observedAt: iso(time),
    completeFamilies: [...alertFamilies], observations: rows,
    expected: rows.map(({ family, entityRef, periodRef }) => ({ family, entityRef, periodRef })),
  };
}

describe("the operational threshold catalog", () => {
  it("uses exact cap arithmetic and disjoint same-currency budget totals", () => {
    expect(at("mediaNearCap", spend(67_499)).state).toBe("clear");
    expect(at("mediaNearCap", spend(67_500))).toMatchObject({ state: "breached", observed: 9000 });
    expect(at("mediaAtCap", spend(74_999)).state).toBe("clear");
    expect(at("mediaAtCap", spend(75_000)).state).toBe("breached");
    expect(at("mediaAtCap", spend(76_000)).state).toBe("breached");
    expect(at("budgetOverrun", budget(3_000_000)).state).toBe("clear");
    expect(at("budgetOverrun", budget(3_000_001)).state).toBe("breached");
    expect(at("budgetCeiling", budget(4_000_000)).state).toBe("breached");
    expect(at("budgetCeiling", budget(4_000_000, { unpricedCategories: 8 }))).toMatchObject({ state: "incomplete", reason: "unpricedBudget" });
    expect(at("budgetCeiling", budget(4_000_000, { currency: "EUR" })).state).toBe("incomplete");
  });

  it("checks reservation, coverage, support, shipment, review and order boundaries without a false zero", () => {
    expect(at("lowStock", stock({ onHand: 60, activeReservations: 10 }))).toMatchObject({ state: "breached", observed: 50 });
    expect(at("lowStock", stock({ onHand: 61, activeReservations: 10 })).state).toBe("clear");
    expect(at("zeroStock", stock({}))).toMatchObject({ state: "breached", observed: 0 });
    expect(at("sampleReserve", stock({ waitingCollaborations: 1 })).state).toBe("breached");
    expect(at("sampleReserve", stock({ waitingCollaborations: 0 })).state).toBe("clear");
    expect(at("zeroStock", stock({ onHand: null })).state).toBe("incomplete");
    expect(evaluateThreshold({ ...rule("lowStock"), unit: "hours", threshold: 24 },
      stock({ onHand: 8, activeReservations: 0 }), iso(now))).toMatchObject({ state: "breached", observed: 24 });
    for (const offset of [0, 1]) {
      const expected = offset === 0 ? "clear" : "breached", then = iso(now - 48 * hour - offset);
      expect(at("shipmentStale", observation("shipment", { tracking: "active", lastTrackingAt: then, deliveryException: true })).state).toBe(expected);
      expect(at("supportAge", observation("support", { open: true, openedAt: then })).state).toBe(expected);
    }
    expect(at("shipmentException", observation("shipment", { tracking: "active", lastTrackingAt: null, deliveryException: true })).state).toBe("breached");
    expect(at("lowRating", observation("review", { stars: 2 })).state).toBe("breached");
    expect(at("lowRating", observation("review", { stars: 3 })).state).toBe("clear");
    expect(at("orderChecks", observation("orders", { failedOrderCount: 1 })).state).toBe("breached");
    expect(at("orderChecks", observation("orders", { failedOrderCount: 0, asOf: iso(now - hour - 1) })).state).toBe("incomplete");
  });
});

describe("operational thresholds through the existing runtime and shared reporter", () => {
  it.each(Object.keys(conditionSamples) as AlertKind[])("%s stores one breach, one clear and one later rebreach", kind => {
    const db = new DatabaseSync(":memory:");
    let time = now;
    try {
      const repository = new OperationalAlertRepository(db, reportingScope, secret, () => time);
      const configured = policy();
      const record = (key: string, breached: boolean) => {
        const row = { ...conditionSamples[kind](breached, time), sourceVersion: key, asOf: iso(time) };
        const saved = repository.record(configured, sweep(key, time, [row]), () => {});
        const state = saved.run.states.find(value => value.rule.kind === kind)!;
        return { state, events: saved.run.transitions.filter(event => event.startsWith(state.ref + "-")) };
      };
      const initiallyBreached = record("synthetic-initial", true);
      const { ref } = initiallyBreached.state;
      expect(initiallyBreached.events).toEqual([ref + "-1-breach"]);
      time += 1000;
      expect(record("synthetic-unchanged", true).events).toEqual([]);
      time += 1000;
      expect(record("synthetic-clear", false).events).toEqual([ref + "-1-clear"]);
      time += 1000;
      expect(record("synthetic-later", true)).toMatchObject({
        state: { ref, active: true, generation: 2, lastClear: ref + "-1-clear" },
        events: [ref + "-2-breach"],
      });
    } finally { db.close(); }
  });

  it("does not resend unchanged conditions, take an older clear, or reuse changed evidence versions", () => {
    const db = new DatabaseSync(":memory:");
    let time = now;
    const repository = new OperationalAlertRepository(db, reportingScope, secret, () => time);
    const configured = policy(), initial = stock({});
    const record = (id: string, row: AlertObservation) => repository.record(configured, sweep(id, time, [row]), () => {});
    const zero = (run: ReturnType<typeof record>["run"]) => run.states.find(state => state.rule.kind === "zeroStock");
    try {
      const opened = record("synthetic-first-breach", initial);
      expect(record("synthetic-first-breach", initial)).toEqual({ run: opened.run, duplicate: true });
      time += 1000;
      expect(record("synthetic-unchanged", initial).run.transitions).toEqual([]);
      time += 1000;
      const older = record("synthetic-older-clear", stock({
        sourceVersion: "synthetic-older-v0", asOf: iso(now - 1000), onHand: 200,
      }));
      expect(older.run.olderObservations).toBe(3);
      expect(older.run.transitions).toEqual([]);
      expect(zero(older.run)).toMatchObject({ active: true, generation: 1, evaluatedAt: iso(now + 1000) });
      time += 1000;
      const changed = record("synthetic-reused-version", stock({ asOf: iso(time), onHand: 200 }));
      expect(changed.run.transitions).toEqual([]);
      expect(zero(changed.run)).toMatchObject({ active: true, evaluation: { state: "incomplete", reason: "sourceMismatch" } });
      time += 1000;
      expect(() => repository.record({ ...configured, recoveryOwnerRef: "synthetic-changed-owner" },
        sweep("synthetic-reused-policy", time, [initial]), () => {})).toThrow("ALERT_POLICY_VERSION_REUSED");
      const newPeriod = record("synthetic-period-reset", stock({ periodRef: "synthetic-next-period", asOf: iso(time) }));
      expect(zero(newPeriod.run)).toMatchObject({ active: true, generation: 1, lastClear: null });
      expect(zero(newPeriod.run)?.ref).not.toBe(zero(opened.run)?.ref);
    } finally { db.close(); }
  });

  it("crosses the elapsed boundary on a new complete sweep with the same still-fresh source version", () => {
    const db = new DatabaseSync(":memory:");
    let time = now;
    try {
      const repository = new OperationalAlertRepository(db, reportingScope, secret, () => time);
      const row = observation("support", { open: true, openedAt: iso(now - 48 * hour) });
      const first = repository.record(policy(), sweep("synthetic-at-boundary", time, [row]), () => {});
      expect(first.run.states[0]?.evaluation.state).toBe("clear");
      time += 1000;
      const later = repository.record(policy(), sweep("synthetic-after-boundary", time, [row]), () => {});
      expect(later.run.states[0]).toMatchObject({ active: true, generation: 1, sourceAsOf: iso(now), evaluatedAt: iso(time) });
      expect(later.run.transitions).toHaveLength(1);
    } finally { db.close(); }
  });

  it("executes one leased registered sweep with a current source receipt and persists simultaneous blockers", async () => {
    const store = new AgentStore(":memory:", runtimeSyntheticScope);
    const db = store.database;
    try {
      const base = syntheticRuntimeRegistration();
      const registration = syntheticRuntimeRegistration({ family: "registered-business", browserBinding: null, browserExecutorRef: null,
        cadence: { kind: "event", eventType: "operational-threshold-sweep.v1" },
        definition: { ...base.definition, budgets: { ...base.definition.budgets, maxConcurrency: 1 } } });
      const f = createRuntimeTestkit(db, { registration });
      const repository = new OperationalAlertRepository(db, runtimeSyntheticScope, secret, f.now);
      const rows = [stock({ entityRef: "synthetic-home-a" }), stock({ entityRef: "synthetic-home-b", onHand: 50 }), budget(4_000_001)];
      let reads = 0;
      const registry = bindOperationalAlertSweep(repository, runtimeSyntheticScope,
        { registrations: f.registry.registrations, executors: new Map() }, {
          registrationRef: registration.registrationRef, subjectRef: "synthetic-subject-first-0",
          source: {
            async read(request) {
              reads++;
              return { requestDigest: digest(request), policy: policy(runtimeSyntheticScope),
                sweep: sweep("synthetic-registered-check", f.now(), rows, runtimeSyntheticScope), validUntil: iso(f.now() + 60_000) };
            },
            assertCurrent(snapshot, request) { if (snapshot.requestDigest !== digest(request)) throw new Error("Synthetic source basis changed"); },
          },
        }, f.now);
      const runtime = new JobRuntime(db, { ...f.options, registry });
      await f.verify("api");
      runtime.install(registration.registrationRef, 0, f.machine);
      const fire = () => runtime.fire({ registrationRef: registration.registrationRef, registrationVersion: 1,
        intendedAt: iso(f.now()), triggerEventRef: "synthetic-threshold-window" }, f.machine);
      const first = await fire();
      expect((await fire()).run.runId).toBe(first.run.runId);
      const result = await runtime.work({ runRef: first.run.runId, maxItems: 1 }, f.machine);
      expect(result.run.state).toBe("completed");
      expect(reads).toBe(1);
      const run = repository.run("synthetic-registered-check")!;
      expect(repository.runsForRuntime(first.run.runId)).toEqual([run]);
      expect(run.states.filter(state => state.active).map(state => state.rule.kind).sort())
        .toEqual(["budgetCeiling", "budgetOverrun", "lowStock", "lowStock", "zeroStock"]);
    } finally { store.close(); }
  });

  it("persists acknowledgments, one original recovery and an exact rearmed root while holding partial source reads", async () => {
    const kit = createReportingTestkit();
    try {
      const repository = new OperationalAlertRepository(kit.db, reportingScope, secret, () => kit.now);
      const expected = { family: "inventory" as const, entityRef: "synthetic-entity", periodRef: "synthetic-bounded-period" };
      const policyVersion = policy();
      const eventBinding: Pick<ReportEvent, "producerRef" | "link"> = {
        producerRef: "producer:synthetic-shipment", link: reportFixture(kit.now).event.link,
      };
      let current = true;
      const reports = bindOperationalAlertReporting(repository, reportingScope, {
        event: eventBinding, maxSweepAgeMs: hour,
        async readDelivery(event) {
          const snapshot = { ...reportFixture(kit.now), event };
          kit.add(snapshot);
          return snapshot;
        },
        assertTransitionCurrent() { if (!current) throw new ReportError("ALERT_SOURCE_DENIED", 403); },
        assertRunCurrent() { if (!current) throw new ReportError("ALERT_SOURCE_DENIED", 403); },
        assertDigestCurrent() { if (!current) throw new ReportError("ALERT_SOURCE_DENIED", 403); },
      }, kit.source, () => kit.now);
      const service = createSlackReporting({ db: kit.db, scope: reportingScope, secret: kit.secret, jobs: kit.jobs,
        source: reports.reportingSource, now: () => kit.now });
      const record = (id: string, row: AlertObservation) => repository.record(policyVersion, sweep(id, kit.now, [row]), () => {});
      const root = record("synthetic-open", stock({}));
      const ref = root.run.states.find(state => state.rule.kind === "zeroStock")!.ref;
      const locator = (value: string) => operationalThresholdEvent(repository.transition(value)!, eventBinding);
      const accept = (eventRef: string) => {
        const event = locator(eventRef);
        return service.accept({ eventRef: event.eventRef, eventVersion: event.eventVersion }, "synthetic-" + eventRef, kit.machine);
      };
      const deliveries = reports.deliveriesFor(root.run.runRef);
      expect(deliveries).toEqual([{ locator: { eventRef: ref + "-1-breach",
        eventVersion: locator(ref + "-1-breach").eventVersion }, idempotencyKey: ref + "-1-breach" }]);
      const opened = await service.accept(deliveries[0]!.locator, deliveries[0]!.idempotencyKey, kit.machine);
      expect(repository.acknowledge(ref, 1, "synthetic-actor", "synthetic-ack", () => {}).acknowledged).toBe(true);
      current = false;
      expect(() => reports.deliveriesFor(root.run.runRef)).toThrow("ALERT_SOURCE_DENIED");
      await expect(service.work(opened.reportRef, kit.machine)).rejects.toMatchObject({ code: "ALERT_SOURCE_DENIED" });
      current = true;
      kit.state.mode = "lostAck";
      expect((await service.work(opened.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
      expect((await service.reconcile(opened.reportRef, kit.machine)).executionCertainty).toBe("applied");
      const original = kit.outcomes.get(kit.state.calls[0]!.requestKey);
      expect(original?.state).toBe("applied");
      expect(kit.state.calls[0]!.body).toContain("No customer stock available · 0 units · threshold 0 units");
      expect((await accept(ref + "-1-breach")).reportRef).toBe(opened.reportRef);

      kit.advance(1000);
      const partial = repository.record(policyVersion, { ...sweep("synthetic-partial", kit.now, []), expected: [expected] }, () => {});
      expect(partial.run.transitions).toEqual([]);
      expect(partial.run.states.find(state => state.ref === ref)).toMatchObject({ active: true, evaluation: { state: "incomplete" } });
      kit.advance(1000);
      record("synthetic-verified-clear", stock({ onHand: 100, activeReservations: 0, sourceVersion: "synthetic-v2", asOf: iso(kit.now) }));
      const clear = await accept(ref + "-1-clear");
      kit.state.mode = "applied";
      expect((await service.work(clear.reportRef, kit.machine)).executionCertainty).toBe("applied");
      if (original?.state === "applied") expect(kit.state.calls[1]!.threadTs).toBe(original.receipt.messageTs);
      kit.advance(1000);
      record("synthetic-later-breach", stock({ sourceVersion: "synthetic-v3", asOf: iso(kit.now) }));
      const later = await accept(ref + "-2-breach");
      expect((await service.work(later.reportRef, kit.machine)).executionCertainty).toBe("applied");
      expect(kit.state.calls[2]!.threadTs).toBeNull();
      expect(kit.state.calls).toHaveLength(3);
      expect(() => locator(root.run.transitions.find(value => value !== ref + "-1-breach")!)).toThrow("ALERT_ORANGE_DIGEST_ONLY");
      const window = dailyDigestWindow("2026-11-09", null)!;
      expect(reports.digestFor(window)).toMatchObject({ state: "unavailable" });
      kit.advance(Date.parse(window.scheduledAt) - kit.now - 60_000);
      record("synthetic-before-digest", stock({ sourceVersion: "synthetic-v4", asOf: iso(kit.now) }));
      expect(reports.digestFor(window)).toMatchObject({ active: 1, activeRed: 1, incomplete: 0,
        details: [{ kind: "lowStock", state: "breached" }] });
    } finally { kit.close(); }
  });
});
