import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { AgentStore } from "../store.ts";
import { videoEvidenceRecordSchema, type AccessFailure, type VideoEvidenceRecord } from "./schema.ts";

export class VideoEvidenceError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status = 409) { super(code); this.name = "VideoEvidenceError"; this.code = code; this.status = status; }
}
export type LedgerReceipt = { recordKey: string; version: number; evidenceRef: string; contentHash: string; recordedAt: string; reused: boolean };
export type AccessEvent = { eventKey: string; recordKey: string; state: AccessFailure["state"] | "removed" | "changed"; sourceRef: string; observedAt: string; recordedAt: string; reasonCode: string; runKey: string };
type Scope = { workspaceId: string; accountId: string };

/** Fields that change on every retrieval but are not new observations. Everything else is content. */
function contentHash(record: VideoEvidenceRecord) {
  return digest({ ...record, prior_version: null, keys: { ...record.keys, evidence_version: 0, review_job_id: "" },
    source: { ...record.source, retrieved_at: "", permission_checked_at: "" } });
}

/**
 * Append-only J20 evidence ledger in the shared agent SQLite file, in its own `video_evidence_*` tables.
 * Every write runs under BEGIN IMMEDIATE and reads the clock inside that lock. Rows are never updated or deleted.
 */
export class VideoEvidenceLedger {
  readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(store: AgentStore, scope: Scope, options: { now?: () => number } = {}) {
    this.db = store.database;
    this.now = options.now ?? Date.now;
    const bound = this.db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (bound?.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId) throw new VideoEvidenceError("DATABASE_SCOPE_MISMATCH", 403);
    this.db.exec(`CREATE TABLE IF NOT EXISTS video_evidence_meta(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO video_evidence_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS video_evidence_records(record_key TEXT NOT NULL,version INTEGER NOT NULL,platform TEXT NOT NULL,
        creator_source_id TEXT NOT NULL,content_hash TEXT NOT NULL,recorded_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(record_key,version));
      CREATE INDEX IF NOT EXISTS video_evidence_records_creator ON video_evidence_records(platform,creator_source_id);
      CREATE TABLE IF NOT EXISTS video_evidence_requests(request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_evidence_access_events(event_key TEXT PRIMARY KEY,record_key TEXT NOT NULL,recorded_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS video_evidence_access_record ON video_evidence_access_events(record_key,recorded_at);
      CREATE TABLE IF NOT EXISTS video_evidence_stages(stage_key TEXT PRIMARY KEY,record_key TEXT NOT NULL,recorded_at TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS video_evidence_records_no_update BEFORE UPDATE ON video_evidence_records BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS video_evidence_records_no_delete BEFORE DELETE ON video_evidence_records BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS video_evidence_access_no_update BEFORE UPDATE ON video_evidence_access_events BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS video_evidence_access_no_delete BEFORE DELETE ON video_evidence_access_events BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS video_evidence_stages_no_update BEFORE UPDATE ON video_evidence_stages BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;
      CREATE TRIGGER IF NOT EXISTS video_evidence_stages_no_delete BEFORE DELETE ON video_evidence_stages BEGIN SELECT RAISE(ABORT,'VIDEO_EVIDENCE_IMMUTABLE'); END;`);
    if (this.db.prepare("SELECT version FROM video_evidence_meta WHERE id=1").get()?.version !== 1) throw new VideoEvidenceError("UNSUPPORTED_VIDEO_EVIDENCE_SCHEMA", 500);
  }

  private timestamp() {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new VideoEvidenceError("INVALID_CLOCK", 500);
    return new Date(value).toISOString();
  }
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private readLatest(recordKey: string): VideoEvidenceRecord | null {
    const row = this.db.prepare("SELECT body FROM video_evidence_records WHERE record_key=? ORDER BY version DESC LIMIT 1").get(recordKey);
    return row ? videoEvidenceRecordSchema.parse(JSON.parse(String(row.body))) : null;
  }

  latest(recordKey: string): VideoEvidenceRecord | null { return this.readLatest(recordKey); }
  history(recordKey: string): VideoEvidenceRecord[] {
    return this.db.prepare("SELECT body FROM video_evidence_records WHERE record_key=? ORDER BY version").all(recordKey)
      .map((row) => videoEvidenceRecordSchema.parse(JSON.parse(String(row.body))));
  }
  accessEvents(recordKey: string): AccessEvent[] {
    return this.db.prepare("SELECT body FROM video_evidence_access_events WHERE record_key=? ORDER BY recorded_at,event_key").all(recordKey)
      .map((row) => JSON.parse(String(row.body)) as AccessEvent);
  }

  /**
   * Appends the next version built from the latest stored one. A retried request key returns its original receipt; a reused key
   * with different content is refused. Identical content to the latest version reuses it instead of adding a duplicate observation.
   */
  append(request: { requestKey: string; requestHash: string; recordKey: string; build: (prior: VideoEvidenceRecord | null, recordedAt: string) => VideoEvidenceRecord }): LedgerReceipt {
    return this.tx(() => {
      const previous = this.db.prepare("SELECT request_hash,receipt FROM video_evidence_requests WHERE request_key=?").get(request.requestKey);
      if (previous) {
        if (previous.request_hash !== request.requestHash) throw new VideoEvidenceError("IDEMPOTENCY_KEY_REUSED");
        return { ...(JSON.parse(String(previous.receipt)) as LedgerReceipt), reused: true };
      }
      const recordedAt = this.timestamp();
      const prior = this.readLatest(request.recordKey);
      const record = videoEvidenceRecordSchema.parse(request.build(prior, recordedAt));
      const version = (prior?.keys.evidence_version ?? 0) + 1;
      if (record.keys.evidence_version !== version || record.prior_version !== (prior?.keys.evidence_version ?? null)) throw new VideoEvidenceError("EVIDENCE_VERSION_CONFLICT");
      const hash = contentHash(record);
      let receipt: LedgerReceipt;
      if (prior && contentHash(prior) === hash) {
        receipt = { recordKey: request.recordKey, version: prior.keys.evidence_version, evidenceRef: `${prior.keys.canonical_post_key}:v${prior.keys.evidence_version}`, contentHash: hash, recordedAt, reused: true };
      } else {
        this.db.prepare("INSERT INTO video_evidence_records VALUES(?,?,?,?,?,?,?)")
          .run(request.recordKey, version, record.keys.platform, record.keys.creator_source_id, hash, recordedAt, JSON.stringify(record));
        receipt = { recordKey: request.recordKey, version, evidenceRef: `${record.keys.canonical_post_key}:v${version}`, contentHash: hash, recordedAt, reused: false };
      }
      this.db.prepare("INSERT INTO video_evidence_requests VALUES(?,?,?)").run(request.requestKey, request.requestHash, JSON.stringify(receipt));
      return receipt;
    });
  }

  /**
   * Stages gated post metadata between the metadata read and the playback review when they run as separate runtime steps.
   * A stage is run working state, not evidence: nothing reads it except the review step that names its exact key.
   */
  stage(stageKey: string, recordKey: string, body: unknown): void {
    this.tx(() => { this.db.prepare("INSERT OR IGNORE INTO video_evidence_stages VALUES(?,?,?,?)").run(stageKey, recordKey, this.timestamp(), JSON.stringify(body)); });
  }
  staged(stageKey: string): unknown {
    const row = this.db.prepare("SELECT body FROM video_evidence_stages WHERE stage_key=?").get(stageKey);
    return row ? JSON.parse(String(row.body)) as unknown : null;
  }

  /** Records a source failure beside the evidence. Prior evidence is untouched; an identical retry is not duplicated. */
  recordAccess(event: Omit<AccessEvent, "eventKey" | "recordedAt">): AccessEvent {
    return this.tx(() => {
      const eventKey = `j20-access-${digest([event.recordKey, event.state, event.sourceRef, event.observedAt, event.reasonCode, event.runKey]).slice(0, 40)}`;
      const existing = this.db.prepare("SELECT body FROM video_evidence_access_events WHERE event_key=?").get(eventKey);
      if (existing) return JSON.parse(String(existing.body)) as AccessEvent;
      const stored: AccessEvent = { ...event, eventKey, recordedAt: this.timestamp() };
      this.db.prepare("INSERT INTO video_evidence_access_events VALUES(?,?,?,?)").run(eventKey, event.recordKey, stored.recordedAt, JSON.stringify(stored));
      return stored;
    });
  }
}
