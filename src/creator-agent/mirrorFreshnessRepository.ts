import type { DatabaseSync } from "node:sqlite";
import { digest } from "./config.ts";
import type { OperationsScope } from "./operations.ts";
import {
  MIRROR_IDS, evidenceFrom, mirrorIncidentPayloadSchema, mirrorRunSchema, planMirrorIncidents, resolveMirrorPolicies, summarizeMirrorFreshness,
  type MirrorFreshnessSummary, type MirrorId, type MirrorIncidentPayload, type MirrorIncidentState, type MirrorPolicy, type MirrorPolicyOverrides,
  type MirrorRun, type OpenMirrorIncident,
} from "./mirrorFreshness.ts";

export class MirrorFreshnessError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

export type MirrorFreshnessOptions = { policies?: MirrorPolicyOverrides; now?: () => number };
export type MirrorSweep = { checkedAt: string; summaries: MirrorFreshnessSummary[]; skipped: MirrorId[];
  incidents: { opened: MirrorIncidentPayload[]; suppressed: MirrorIncidentPayload[]; cleared: MirrorIncidentPayload[] } };

type IncidentRow = { incident_id: string; mirror_id: string; state: string; opened_at: string; last_seen_at: string; cleared_at: string | null;
  occurrences: number; opened_after_sequence: number; latest_run_id: string | null; cleared_by_run_id: string | null; body: string };

/**
 * Run records and incident suppression on the shared agent database, in `mirror_freshness_*` tables. Each write is one
 * `BEGIN IMMEDIATE` transaction and reads the injected clock inside it, after the lock is held.
 */
export class MirrorFreshnessRepository {
  readonly db: DatabaseSync; readonly policies: Record<MirrorId, MirrorPolicy>; readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, options: MirrorFreshnessOptions = {}) {
    this.db = db; this.now = options.now ?? Date.now;
    this.policies = resolveMirrorPolicies(options.policies ?? {}, true);
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || scope.workspaceId !== bound.workspace_id || scope.accountId !== bound.account_id || scope.environment !== bound.environment)
      throw new MirrorFreshnessError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS mirror_freshness_runs(sequence INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT UNIQUE NOT NULL,mirror_id TEXT NOT NULL,
        finished_at TEXT NOT NULL,outcome TEXT NOT NULL,watermark TEXT,body TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mirror_freshness_runs_latest ON mirror_freshness_runs(mirror_id,finished_at,sequence);
      CREATE TABLE IF NOT EXISTS mirror_freshness_checks(mirror_id TEXT PRIMARY KEY,checked_at TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mirror_freshness_incidents(incident_id TEXT PRIMARY KEY,mirror_id TEXT NOT NULL,state TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','cleared')),
        opened_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,cleared_at TEXT,occurrences INTEGER NOT NULL,opened_after_sequence INTEGER NOT NULL,
        latest_run_id TEXT,cleared_by_run_id TEXT,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS mirror_freshness_open_incident ON mirror_freshness_incidents(mirror_id,state) WHERE status='open';`);
  }

  private clock(): number {
    const at = this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new MirrorFreshnessError("INVALID_MIRROR_CLOCK", 500);
    return at;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = work(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private run(sql: string, ...args: (string | number)[]) {
    const row = this.db.prepare(sql).get(...args);
    return row ? { run: JSON.parse(String(row.body)) as MirrorRun, sequence: Number(row.sequence) } : null;
  }
  private latest(mirrorId: MirrorId) {
    return this.run("SELECT sequence,body FROM mirror_freshness_runs WHERE mirror_id=? ORDER BY finished_at DESC,sequence DESC LIMIT 1", mirrorId);
  }
  private lastComplete(mirrorId: MirrorId) {
    return this.run("SELECT sequence,body FROM mirror_freshness_runs WHERE mirror_id=? AND outcome='complete' ORDER BY finished_at DESC,sequence DESC LIMIT 1", mirrorId);
  }

  /** Records one finished run. Replaying the same run is a no-op; a different body under the same id, a future finish or a regressing watermark is refused. */
  recordRun(raw: unknown): { run: MirrorRun; duplicate: boolean } {
    const parsed = mirrorRunSchema.safeParse(raw);
    if (!parsed.success) throw new MirrorFreshnessError("INVALID_MIRROR_RUN", 422);
    const normal = (value: string) => new Date(value).toISOString();
    const run: MirrorRun = { ...parsed.data, startedAt: normal(parsed.data.startedAt), finishedAt: normal(parsed.data.finishedAt),
      coverageWatermark: parsed.data.coverageWatermark === null ? null : normal(parsed.data.coverageWatermark) };
    const body = JSON.stringify(run);
    return this.transaction(() => {
      const at = this.clock();
      const prior = this.db.prepare("SELECT body FROM mirror_freshness_runs WHERE run_id=?").get(run.runId);
      if (prior) {
        if (String(prior.body) !== body) throw new MirrorFreshnessError("MIRROR_RUN_ID_REUSED", 409);
        return { run, duplicate: true };
      }
      if (Date.parse(run.finishedAt) > at) throw new MirrorFreshnessError("MIRROR_RUN_IN_FUTURE", 422);
      if (run.coverageWatermark !== null) {
        // Watermarks only move forward in finish order, whatever order runs are recorded in.
        const conflict = this.db.prepare(`SELECT 1 FROM mirror_freshness_runs WHERE mirror_id=? AND outcome='complete' AND
          ((finished_at<=? AND watermark>?) OR (finished_at>=? AND watermark<?)) LIMIT 1`).get(run.mirrorId, run.finishedAt, run.coverageWatermark, run.finishedAt, run.coverageWatermark);
        if (conflict) throw new MirrorFreshnessError("MIRROR_WATERMARK_REGRESSED", 409);
      }
      this.db.prepare("INSERT INTO mirror_freshness_runs(run_id,mirror_id,finished_at,outcome,watermark,body,recorded_at) VALUES(?,?,?,?,?,?,?)")
        .run(run.runId, run.mirrorId, run.finishedAt, run.outcome, run.coverageWatermark, body, new Date(at).toISOString());
      return { run, duplicate: false };
    });
  }

  private summarize(mirrorId: MirrorId, at: number) {
    const latest = this.latest(mirrorId), complete = this.lastComplete(mirrorId);
    return { summary: summarizeMirrorFreshness(this.policies[mirrorId], evidenceFrom(latest?.run ?? null, complete?.run ?? null), at),
      completeSequence: complete?.sequence ?? null };
  }

  /** Read-only: classifies every mirror now. Writes nothing and raises no incident. */
  evaluate(): MirrorFreshnessSummary[] {
    const at = this.clock();
    return MIRROR_IDS.map(id => this.summarize(id, at).summary);
  }

  /**
   * The health sweep. Classifies each mirror whose check is due (or all, with `force`), then opens, suppresses or clears
   * incidents per `planMirrorIncidents`. Returns the alert payloads; delivering them is the caller's job.
   */
  sweep(options: { force?: boolean } = {}): MirrorSweep {
    return this.transaction(() => {
      const at = this.clock(), checkedAt = new Date(at).toISOString();
      const out: MirrorSweep = { checkedAt, summaries: [], skipped: [], incidents: { opened: [], suppressed: [], cleared: [] } };
      for (const mirrorId of MIRROR_IDS) {
        const policy = this.policies[mirrorId];
        const last = this.db.prepare("SELECT checked_at FROM mirror_freshness_checks WHERE mirror_id=?").get(mirrorId);
        if (!options.force && last && at - Date.parse(String(last.checked_at)) < policy.checkEveryMinutes * 60_000) { out.skipped.push(mirrorId); continue; }
        const { summary, completeSequence } = this.summarize(mirrorId, at);
        out.summaries.push(summary);
        this.db.prepare("INSERT INTO mirror_freshness_checks VALUES(?,?,?) ON CONFLICT(mirror_id) DO UPDATE SET checked_at=excluded.checked_at,state=excluded.state")
          .run(mirrorId, checkedAt, summary.state);
        const rows = this.db.prepare("SELECT * FROM mirror_freshness_incidents WHERE mirror_id=? AND status='open'").all(mirrorId) as unknown as IncidentRow[];
        const open: OpenMirrorIncident[] = rows.map(row => ({ incidentId: row.incident_id, mirrorId, state: row.state as MirrorIncidentState, openedAfterRunSequence: row.opened_after_sequence }));
        const plan = planMirrorIncidents(summary, open, completeSequence);
        const latestRunId = summary.evidence.latestRun?.runId ?? null;
        for (const row of rows) {
          if (plan.suppress.includes(row.incident_id)) {
            const payload = this.payload("suppressed", row, summary, { lastSeenAt: checkedAt, occurrences: row.occurrences + 1, latestRunId });
            this.db.prepare("UPDATE mirror_freshness_incidents SET last_seen_at=?,occurrences=?,latest_run_id=?,body=? WHERE incident_id=?")
              .run(checkedAt, row.occurrences + 1, latestRunId, JSON.stringify(payload), row.incident_id);
            out.incidents.suppressed.push(payload);
          } else if (plan.clear.includes(row.incident_id)) {
            const clearedByRunId = summary.evidence.lastComplete!.runId;
            const payload = this.payload("cleared", row, summary, { lastSeenAt: row.last_seen_at, occurrences: row.occurrences, latestRunId, clearedAt: checkedAt, clearedByRunId });
            this.db.prepare("UPDATE mirror_freshness_incidents SET status='cleared',cleared_at=?,cleared_by_run_id=?,latest_run_id=?,body=? WHERE incident_id=?")
              .run(checkedAt, clearedByRunId, latestRunId, JSON.stringify(payload), row.incident_id);
            out.incidents.cleared.push(payload);
          }
        }
        if (plan.open) {
          const maxSequence = Number(this.db.prepare("SELECT COALESCE(MAX(sequence),0) n FROM mirror_freshness_runs WHERE mirror_id=?").get(mirrorId)!.n);
          const incidentId = "mfi-" + digest({ mirrorId, state: plan.open, openedAt: checkedAt, after: maxSequence }).slice(0, 32);
          const row: IncidentRow = { incident_id: incidentId, mirror_id: mirrorId, state: plan.open, opened_at: checkedAt, last_seen_at: checkedAt, cleared_at: null,
            occurrences: 1, opened_after_sequence: maxSequence, latest_run_id: latestRunId, cleared_by_run_id: null, body: "" };
          const payload = this.payload("opened", row, summary, { lastSeenAt: checkedAt, occurrences: 1, latestRunId });
          this.db.prepare(`INSERT INTO mirror_freshness_incidents(incident_id,mirror_id,state,status,opened_at,last_seen_at,cleared_at,occurrences,opened_after_sequence,latest_run_id,cleared_by_run_id,body)
            VALUES(?,?,?,'open',?,?,NULL,1,?,?,NULL,?)`).run(incidentId, mirrorId, plan.open, checkedAt, checkedAt, maxSequence, latestRunId, JSON.stringify(payload));
          out.incidents.opened.push(payload);
        }
      }
      return out;
    });
  }

  /** Open incidents, newest first. */
  openIncidents(): MirrorIncidentPayload[] {
    return this.db.prepare("SELECT body FROM mirror_freshness_incidents WHERE status='open' ORDER BY opened_at DESC,incident_id")
      .all().map(row => mirrorIncidentPayloadSchema.parse(JSON.parse(String(row.body))));
  }

  private payload(event: MirrorIncidentPayload["event"], row: IncidentRow, summary: MirrorFreshnessSummary,
    change: { lastSeenAt: string; occurrences: number; latestRunId: string | null; clearedAt?: string; clearedByRunId?: string }): MirrorIncidentPayload {
    // Built field by field from enums, ids, times and counts, then checked by the strict schema.
    return mirrorIncidentPayloadSchema.parse({
      schemaVersion: "mirror-freshness-incident.v1", event, incidentId: row.incident_id, mirrorId: summary.mirrorId, provider: summary.provider,
      state: row.state, reasonCodes: summary.reasonCodes.slice(0, 12), openedAt: row.opened_at, lastSeenAt: change.lastSeenAt,
      clearedAt: change.clearedAt ?? null, occurrences: change.occurrences, latestRunId: change.latestRunId, clearedByRunId: change.clearedByRunId ?? null,
      ageMinutes: summary.ageMinutes, staleAfterMinutes: summary.policy.staleAfterMinutes,
      counts: summary.evidence.latestRun ? { ...summary.evidence.latestRun.counts } : null,
    });
  }
}

/** The server read's default when nothing is configured: every mirror is honestly unknown and nothing is read from storage. */
export function unconfiguredMirrorFreshness(at: number): MirrorFreshnessSummary[] {
  const policies = resolveMirrorPolicies({}, false);
  return MIRROR_IDS.map(id => summarizeMirrorFreshness(policies[id], { latestRun: null, lastComplete: null }, at));
}
