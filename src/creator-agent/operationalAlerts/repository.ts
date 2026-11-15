import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { digestScopeSchema, type DigestScope } from "../dailyDigest/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { alertCatalog, alertKinds, alertPolicySchema, alertSweepSchema, type AlertRule } from "./contract.ts";
import { evaluateThreshold, type AlertEvaluation } from "./evaluate.ts";

type AlertState = {
  ref: string;
  rule: AlertRule;
  ruleDigest: string;
  periodRef: string;
  active: boolean;
  generation: number;
  acknowledged: boolean;
  lastClear: string | null;
  evidenceDigest: string;
  lastSuccessfulSource: { version: string; materialDigest: string; asOf: string } | null;
  sourceVersion: string | null;
  sourceAsOf: string | null;
  evaluatedAt: string;
  evaluation: AlertEvaluation;
};
export type AlertTransition = {
  ref: string;
  transition: "breach" | "clear";
  at: string;
  sourceReceipt: string;
  state: AlertState;
};
export type AlertRun = {
  runRef: string; runtimeRunRef: string; policyVersion: string; observedAt: string; sourceReceipt: string;
  unconfigured: AlertRule["kind"][]; recoveryOwnerRef: string;
  incompleteFamilies: Array<typeof alertCatalog[AlertRule["kind"]][0]>;
  states: AlertState[]; transitions: string[]; olderObservations: number; unchangedObservations: number;
};
const subjectKey = (value: { family: string; entityRef: string; periodRef: string }) => digest([value.family, value.entityRef, value.periodRef]);

/** A small state journal. The existing report repository still owns delivery, rate limits and original receipts. */
export class OperationalAlertRepository {
  private readonly scopeKey: string;
  private readonly db: DatabaseSync;
  private readonly secret: string;
  private readonly now: () => number;

  constructor(db: DatabaseSync, scope: DigestScope, secret: string, now = Date.now) {
    this.db = db;
    this.secret = secret;
    this.now = now;
    this.scopeKey = digest(digestScopeSchema.parse(scope));
    if (secret.length < 32) throw new Error("ALERT_REFERENCE_KEY_INVALID");
    db.exec(`
      CREATE TABLE IF NOT EXISTS operational_alert_policies (
        scope_key TEXT NOT NULL, version TEXT NOT NULL, body_hash TEXT NOT NULL,
        PRIMARY KEY(scope_key,version)
      );
      CREATE TABLE IF NOT EXISTS operational_alert_runs (
        scope_key TEXT NOT NULL, run_ref TEXT NOT NULL, source_receipt TEXT NOT NULL, input_hash TEXT NOT NULL,
        runtime_run_ref TEXT NOT NULL, observed_at INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(scope_key,run_ref), UNIQUE(scope_key,source_receipt)
      );
      CREATE INDEX IF NOT EXISTS operational_alert_runtime_run ON operational_alert_runs(scope_key,runtime_run_ref);
      CREATE TABLE IF NOT EXISTS operational_alert_states (
        scope_key TEXT NOT NULL, alert_ref TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope_key,alert_ref)
      );
      CREATE TABLE IF NOT EXISTS operational_alert_transitions (
        scope_key TEXT NOT NULL, event_ref TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope_key,event_ref)
      );
      CREATE TABLE IF NOT EXISTS operational_alert_acknowledgements (
        scope_key TEXT NOT NULL, alert_ref TEXT NOT NULL, generation INTEGER NOT NULL,
        actor_ref TEXT NOT NULL, receipt_ref TEXT NOT NULL, observed_at TEXT NOT NULL,
        PRIMARY KEY(scope_key,alert_ref,generation)
      );
    `);
  }

  private transaction<T>(apply: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = apply();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private state(ref: string): AlertState | null {
    const row = this.db.prepare("SELECT body FROM operational_alert_states WHERE scope_key=? AND alert_ref=?").get(this.scopeKey, ref);
    return row ? JSON.parse(String(row.body)) as AlertState : null;
  }

  transition(ref: string): AlertTransition | null {
    const row = this.db.prepare("SELECT body FROM operational_alert_transitions WHERE scope_key=? AND event_ref=?").get(this.scopeKey, ref);
    return row ? JSON.parse(String(row.body)) as AlertTransition : null;
  }

  run(runRef: string): AlertRun | null {
    const row = this.db.prepare("SELECT body FROM operational_alert_runs WHERE scope_key=? AND run_ref=?").get(this.scopeKey, runRef);
    return row ? JSON.parse(String(row.body)) as AlertRun : null;
  }
  runsForRuntime(runtimeRunRef: string): AlertRun[] {
    return this.db.prepare("SELECT body FROM operational_alert_runs WHERE scope_key=? AND runtime_run_ref=? ORDER BY rowid")
      .all(this.scopeKey, runtimeRunRef).map(row => JSON.parse(String(row.body)) as AlertRun);
  }

  latestRun(before: number) {
    const row = this.db.prepare(`
      SELECT body FROM operational_alert_runs WHERE scope_key=? AND observed_at<=? ORDER BY observed_at DESC,rowid DESC LIMIT 1
    `).get(this.scopeKey, before);
    return row ? JSON.parse(String(row.body)) as AlertRun : null;
  }

  record(rawPolicy: unknown, rawSweep: unknown, assertCurrent: () => void, runtimeRunRef?: string) {
    const policy = alertPolicySchema.parse(rawPolicy), sweep = alertSweepSchema.parse(rawSweep);
    const runtimeRef = runtimeRunRef ?? sweep.runRef;
    const policyHash = digest(policy), inputHash = digest([policyHash, sweep, runtimeRef]);
    if (digest(policy.scope) !== this.scopeKey || digest(sweep.scope) !== this.scopeKey ||
        sweep.policyVersion !== policy.version || Date.parse(sweep.observedAt) > this.now()) throw new Error("ALERT_SWEEP_SCOPE_INVALID");
    const expected = new Map(sweep.expected.map(value => [subjectKey(value), value]));
    const observations = new Map(sweep.observations.map(value => [subjectKey(value), value]));
    const complete = new Set(sweep.completeFamilies);
    if (expected.size !== sweep.expected.length || observations.size !== sweep.observations.length ||
        complete.size !== sweep.completeFamilies.length || [...observations.keys()].some(key => !expected.has(key))) {
      throw new Error("ALERT_SOURCE_COVERAGE_AMBIGUOUS");
    }

    return this.transaction(() => {
      assertSynchronousVoid(assertCurrent);
      const stored = this.db.prepare("SELECT body_hash FROM operational_alert_policies WHERE scope_key=? AND version=?")
        .get(this.scopeKey, policy.version);
      if (stored && stored.body_hash !== policyHash) throw new Error("ALERT_POLICY_VERSION_REUSED");
      const priorRun = this.db.prepare("SELECT input_hash,body FROM operational_alert_runs WHERE scope_key=? AND (run_ref=? OR source_receipt=?)")
        .all(this.scopeKey, sweep.runRef, sweep.sourceReceipt);
      if (priorRun.length) {
        if (priorRun.length !== 1 || priorRun[0]!.input_hash !== inputHash) throw new Error("ALERT_SOURCE_RECEIPT_REUSED");
        return { run: JSON.parse(String(priorRun[0]!.body)) as AlertRun, duplicate: true };
      }
      this.db.prepare("INSERT OR IGNORE INTO operational_alert_policies VALUES(?,?,?)").run(this.scopeKey, policy.version, policyHash);
      const run: AlertRun = {
        runRef: sweep.runRef, runtimeRunRef: runtimeRef, policyVersion: policy.version, observedAt: sweep.observedAt, sourceReceipt: sweep.sourceReceipt,
        unconfigured: alertKinds.filter(kind => !policy.rules.some(rule => rule.kind === kind)),
        recoveryOwnerRef: policy.recoveryOwnerRef, incompleteFamilies: [...new Set(policy.rules.map(rule => alertCatalog[rule.kind][0]))]
          .filter(family => !complete.has(family)),
        states: [], transitions: [], olderObservations: 0, unchangedObservations: 0,
      };
      const setState = this.db.prepare("INSERT OR REPLACE INTO operational_alert_states VALUES(?,?,?)");
      const appendEvent = this.db.prepare("INSERT INTO operational_alert_transitions VALUES(?,?,?)");
      for (const [key, subject] of expected) {
        for (const rule of policy.rules.filter(rule => alertCatalog[rule.kind][0] === subject.family)) {
          const observation = observations.get(key);
          const ref = "threshold-" + createHmac("sha256", this.secret).update(digest([this.scopeKey, rule.kind, rule.version, key])).digest("hex").slice(0, 32);
          const previous = this.state(ref);
          const ruleDigest = digest(rule);
          if (previous && previous.ruleDigest !== ruleDigest) throw new Error("ALERT_RULE_VERSION_REUSED");
          let result = evaluateThreshold(rule, complete.has(subject.family) ? observation : undefined, sweep.observedAt);
          const material = observation
            ? digest({ ...observation, asOf: undefined, coverage: undefined, sourceVersion: undefined }) : null;
          const priorSource = previous?.lastSuccessfulSource;
          const sourceOrder = observation && priorSource ? Date.parse(observation.asOf) - Date.parse(priorSource.asOf) : Infinity;
          if (observation && priorSource && (sourceOrder === 0 || priorSource.version === observation.sourceVersion) &&
              priorSource.materialDigest !== material) {
            result = { state: "incomplete", observed: null, reason: "sourceMismatch" };
          }
          const evidenceDigest = digest([observation ?? null, result]);
          const difference = previous ? Date.parse(sweep.observedAt) - Date.parse(previous.evaluatedAt) : Infinity;
          if (previous && (difference <= 0 || sourceOrder < 0)) {
            if (difference === 0 && previous.evidenceDigest !== evidenceDigest) throw new Error("ALERT_SOURCE_EVIDENCE_CONFLICT");
            if (difference === 0) run.unchangedObservations++;
            else run.olderObservations++;
            run.states.push(previous);
            continue;
          }
          const active = result.state === "incomplete" ? previous?.active ?? false : result.state === "breached";
          const started = active && !previous?.active, cleared = !active && previous?.active === true;
          const generation = (previous?.generation ?? 0) + Number(started);
          const state: AlertState = {
            ref, rule, ruleDigest, periodRef: subject.periodRef, active, generation,
            acknowledged: active && !started && previous?.acknowledged === true,
            lastClear: previous?.lastClear ?? null, evidenceDigest,
            lastSuccessfulSource: result.state === "incomplete" ? previous?.lastSuccessfulSource ?? null
              : { version: observation!.sourceVersion, materialDigest: material!, asOf: observation!.asOf },
            sourceVersion: observation?.sourceVersion ?? null, sourceAsOf: observation?.asOf ?? null,
            evaluatedAt: sweep.observedAt, evaluation: result,
          };
          if (started || cleared) {
            const eventRef = `${ref}-${generation}-${cleared ? "clear" : "breach"}`;
            const event: AlertTransition = { ref: eventRef, transition: cleared ? "clear" : "breach", at: sweep.observedAt,
              sourceReceipt: sweep.sourceReceipt, state: structuredClone(state) };
            appendEvent.run(this.scopeKey, eventRef, JSON.stringify(event));
            if (cleared) state.lastClear = eventRef;
            run.transitions.push(eventRef);
          }
          setState.run(this.scopeKey, ref, JSON.stringify(state));
          run.states.push(state);
        }
      }
      assertSynchronousVoid(assertCurrent);
      this.db.prepare("INSERT INTO operational_alert_runs VALUES(?,?,?,?,?,?,?)")
        .run(this.scopeKey, sweep.runRef, sweep.sourceReceipt, inputHash, runtimeRef, Date.parse(sweep.observedAt), JSON.stringify(run));
      return { run, duplicate: false };
    });
  }

  acknowledge(ref: string, generation: number, actorRef: string, receiptRef: string, assertCurrent: () => void) {
    return this.transaction(() => {
      assertSynchronousVoid(assertCurrent);
      const state = this.state(ref);
      if (!state?.active || state.generation !== generation) throw new Error("ALERT_GENERATION_CHANGED");
      if (state.acknowledged) {
        const receipt = this.db.prepare("SELECT actor_ref,receipt_ref FROM operational_alert_acknowledgements WHERE scope_key=? AND alert_ref=? AND generation=?")
          .get(this.scopeKey, ref, generation);
        if (receipt?.actor_ref !== actorRef || receipt.receipt_ref !== receiptRef) throw new Error("ALERT_ACKNOWLEDGEMENT_CHANGED");
        return state;
      }
      state.acknowledged = true;
      this.db.prepare("INSERT INTO operational_alert_acknowledgements VALUES(?,?,?,?,?,?)")
        .run(this.scopeKey, ref, generation, actorRef, receiptRef, new Date(this.now()).toISOString());
      this.db.prepare("UPDATE operational_alert_states SET body=? WHERE scope_key=? AND alert_ref=?")
        .run(JSON.stringify(state), this.scopeKey, ref);
      return state;
    });
  }
}
