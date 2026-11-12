import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { digestScopeSchema, type DigestScope } from "../dailyDigest/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { weeklyFactsSchema, type WeeklyFacts } from "./contract.ts";
import { weeklySnapshotWindow } from "./schedule.ts";

type WeeklySnapshot = { facts: WeeklyFacts; frozenAt: string; sourceDigest: string };
type StoredWeek = { body: string; frozen_at: string; source_digest: string };

export class WeeklySnapshotError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 409) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** Immutable source snapshots. Reporting delivery attempts stay in the existing reporting repository. */
export class WeeklySnapshotRepository {
  private readonly scopeKey: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, scope: DigestScope, now = Date.now) {
    this.db = db;
    this.now = now;
    this.scopeKey = digest(digestScopeSchema.parse(scope));
    db.exec(`
      CREATE TABLE IF NOT EXISTS weekly_kpi_snapshots (
        scope_key TEXT NOT NULL, report_date TEXT NOT NULL, revision INTEGER NOT NULL,
        source_digest TEXT NOT NULL, correction_receipt TEXT, frozen_at TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(scope_key, report_date, revision),
        UNIQUE(scope_key, correction_receipt)
      );
    `);
  }

  original(reportDate: string) {
    const row = this.db.prepare(`
      SELECT body, frozen_at, source_digest FROM weekly_kpi_snapshots
      WHERE scope_key=? AND report_date=? AND revision=1
    `).get(this.scopeKey, reportDate) as StoredWeek | undefined;
    return this.snapshot(row);
  }

  latest(reportDate: string) {
    const row = this.db.prepare(`
      SELECT body, frozen_at, source_digest FROM weekly_kpi_snapshots
      WHERE scope_key=? AND report_date=? ORDER BY revision DESC LIMIT 1
    `).get(this.scopeKey, reportDate) as StoredWeek | undefined;
    return this.snapshot(row);
  }

  record(raw: unknown, assertCurrent: () => void): WeeklySnapshot {
    const facts = weeklyFactsSchema.parse(raw);
    const timestamp = this.now();
    if (digest(facts.scope) !== this.scopeKey) throw new WeeklySnapshotError("WEEKLY_SOURCE_SCOPE_MISMATCH", 403);
    const window = weeklySnapshotWindow(facts.window.reportDate);
    if (!window || digest(window) !== digest(facts.window) || Date.parse(window.scheduledAt) > timestamp ||
        Date.parse(facts.capturedAt) > timestamp) throw new WeeklySnapshotError("WEEKLY_SOURCE_WINDOW_INVALID");
    const sourceDigest = digest(facts), revision = Number(facts.version.slice(1)), reportDate = window.reportDate;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertSynchronousVoid(assertCurrent);
      const prior = this.db.prepare(`
        SELECT body, frozen_at, source_digest FROM weekly_kpi_snapshots
        WHERE scope_key=? AND report_date=? AND revision=?
      `).get(this.scopeKey, reportDate, revision) as StoredWeek | undefined;
      if (prior) {
        if (prior.source_digest !== sourceDigest) throw new WeeklySnapshotError("WEEKLY_VERSION_REUSED");
        const existing = this.snapshot(prior)!;
        this.db.exec("COMMIT");
        return existing;
      }
      const current = this.latest(reportDate);
      if (!current) {
        if (revision !== 1 || facts.correction) throw new WeeklySnapshotError("WEEKLY_ORIGINAL_REQUIRED");
      } else {
        const correction = facts.correction;
        if (!correction || revision !== Number(current.facts.version.slice(1)) + 1 ||
            correction.priorVersion !== current.facts.version || correction.priorDigest !== current.sourceDigest ||
            Date.parse(facts.capturedAt) <= Date.parse(current.facts.capturedAt) || facts.sourceVersion === current.facts.sourceVersion) {
          throw new WeeklySnapshotError("WEEKLY_CORRECTION_UNVERIFIED");
        }
        const used = this.db.prepare("SELECT 1 FROM weekly_kpi_snapshots WHERE scope_key=? AND correction_receipt=?")
          .get(this.scopeKey, correction.receiptRef);
        if (used) throw new WeeklySnapshotError("WEEKLY_CORRECTION_RECEIPT_REUSED");
      }
      const frozenAt = new Date(timestamp).toISOString();
      this.db.prepare("INSERT INTO weekly_kpi_snapshots VALUES (?,?,?,?,?,?,?)").run(
        this.scopeKey, reportDate, revision, sourceDigest, facts.correction?.receiptRef ?? null, frozenAt, JSON.stringify(facts),
      );
      this.db.exec("COMMIT");
      return { facts, frozenAt, sourceDigest };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private snapshot(row: StoredWeek | undefined): WeeklySnapshot | null {
    return row ? { facts: weeklyFactsSchema.parse(JSON.parse(row.body)), frozenAt: row.frozen_at, sourceDigest: row.source_digest } : null;
  }
}
