import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
// Vite 5 does not list this newer Node builtin; load it natively, never through the browser bundler.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { randomUUID } from "node:crypto";
import type { EvidencePacket } from "./evidence.ts";
import type { CreatorAssessment } from "./assessmentSchema.ts";
import { digest } from "./config.ts";

export class AgentConflict extends Error {}
export type StoredAssessment = { runId: string; revision: number; recordedAt: string; packetHash: string; packet: EvidencePacket; assessment: CreatorAssessment };
export type SourcingSnapshot = { rowId: number; anchorRunId: string | null };
export type SourcingPosition = { recordedAt: string; runId: string };

/** Append-only evidence and assessment revisions. A retry returns its original receipt; history is never overwritten. */
export class AgentStore {
  private db: DatabaseType;
  constructor(path: string, scope: { workspaceId: string; accountId: string }) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO agent_meta VALUES(1,1);
      CREATE TABLE IF NOT EXISTS assessments (
        creator_id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE,
        recorded_at TEXT NOT NULL, packet_hash TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(creator_id, revision));
      CREATE TABLE IF NOT EXISTS requests (
        key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, response TEXT NOT NULL);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS agent_scope (id INTEGER PRIMARY KEY CHECK(id=1), workspace_id TEXT NOT NULL, account_id TEXT NOT NULL)");
    this.db.prepare("INSERT OR IGNORE INTO agent_scope VALUES(1,?,?)").run(scope.workspaceId, scope.accountId);
    const persistedScope = this.db.prepare("SELECT workspace_id, account_id FROM agent_scope WHERE id=1").get();
    if (persistedScope?.workspace_id !== scope.workspaceId || persistedScope.account_id !== scope.accountId) {
      this.db.close();
      throw new Error("DATABASE_SCOPE_MISMATCH");
    }
    const meta = this.db.prepare("SELECT version FROM agent_meta WHERE id=1").get();
    if (meta?.version !== 1) throw new Error("UNSUPPORTED_STORAGE_SCHEMA");
  }
  latest(creatorId: string): StoredAssessment | null {
    const row = this.db.prepare("SELECT body FROM assessments WHERE creator_id=? ORDER BY revision DESC LIMIT 1").get(creatorId);
    return row ? JSON.parse(String(row.body)) as StoredAssessment : null;
  }
  findRun(creatorId: string, runId: string): StoredAssessment | null {
    const row = this.db.prepare("SELECT body FROM assessments WHERE creator_id=? AND run_id=?").get(creatorId, runId);
    return row ? JSON.parse(String(row.body)) as StoredAssessment : null;
  }
  /** A bounded list of actual latest records, never a count of discovered profiles or provider capacity. */
  listLatest(limit = 100): { records: StoredAssessment[]; total: number; partial: boolean } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_LIST_LIMIT");
    const total = Number(this.db.prepare("SELECT COUNT(DISTINCT creator_id) AS total FROM assessments").get()?.total ?? 0);
    const rows = this.db.prepare(`SELECT a.body FROM assessments a
      INNER JOIN (SELECT creator_id,MAX(revision) AS revision FROM assessments GROUP BY creator_id) latest
        ON a.creator_id=latest.creator_id AND a.revision=latest.revision
      ORDER BY a.recorded_at DESC,a.run_id DESC LIMIT ?`).all(limit);
    const records = rows.map((row) => JSON.parse(String(row.body)) as StoredAssessment);
    return { records, total, partial: total > records.length };
  }
  /** Fixed append-only watermark/keyset membership; current supersession is observed separately. */
  listLatestPage({ limit, snapshot, after }: { limit: number; snapshot?: SourcingSnapshot; after?: SourcingPosition }): {
    records: (StoredAssessment & { superseded: boolean })[]; total: number; snapshot: SourcingSnapshot; hasMore: boolean; lastPosition: SourcingPosition | null;
  } {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_LIST_LIMIT");
    this.db.exec("BEGIN");
    try {
      const maxRowId = Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) AS watermark FROM assessments").get()?.watermark ?? 0);
      const rowId = snapshot?.rowId ?? maxRowId;
      if (!Number.isSafeInteger(rowId) || rowId < 0 || rowId > maxRowId) throw new AgentConflict("CURSOR_SNAPSHOT_UNAVAILABLE");
      const anchorRunId = rowId ? String(this.db.prepare("SELECT run_id FROM assessments WHERE rowid=?").get(rowId)?.run_id ?? "") : null;
      if ((rowId > 0 && !anchorRunId) || (snapshot && snapshot.anchorRunId !== anchorRunId)) throw new AgentConflict("CURSOR_SNAPSHOT_UNAVAILABLE");
      const total = Number(this.db.prepare("SELECT COUNT(DISTINCT creator_id) AS total FROM assessments WHERE rowid<=?").get(rowId)?.total ?? 0);
      const positionClause = after ? "WHERE (a.recorded_at < ? OR (a.recorded_at = ? AND a.run_id < ?))" : "";
      const values: (number | string)[] = [rowId];
      if (after) values.push(after.recordedAt, after.recordedAt, after.runId);
      values.push(limit + 1);
      const rows = this.db.prepare(`WITH latest AS (
        SELECT creator_id,MAX(revision) AS revision FROM assessments WHERE rowid<=? GROUP BY creator_id
      ) SELECT a.body,EXISTS(SELECT 1 FROM assessments newer WHERE newer.creator_id=a.creator_id AND newer.revision>a.revision) AS superseded
        FROM assessments a INNER JOIN latest ON a.creator_id=latest.creator_id AND a.revision=latest.revision
        ${positionClause} ORDER BY a.recorded_at DESC,a.run_id DESC LIMIT ?`).all(...values);
      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit).map((row) => ({ ...JSON.parse(String(row.body)) as StoredAssessment, superseded: Boolean(row.superseded) }));
      const last = records.at(-1);
      this.db.exec("COMMIT");
      return { records, total, snapshot: { rowId, anchorRunId }, hasMore, lastPosition: last ? { recordedAt: last.recordedAt, runId: last.runId } : null };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  history(creatorId: string): StoredAssessment[] {
    return this.db.prepare("SELECT body FROM assessments WHERE creator_id=? ORDER BY revision").all(creatorId).map((row) => JSON.parse(String(row.body)) as StoredAssessment);
  }
  save(packet: EvidencePacket, assessment: CreatorAssessment, expectedVersion: number, idempotencyKey: string,
    normalizePacket: (packet: EvidencePacket) => EvidencePacket = value => value): StoredAssessment {
    packet = normalizePacket(packet);
    const requestHash = digest({ packet, expectedVersion, policyVersion: assessment.policyVersion, configHash: assessment.config.hash });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT request_hash, response FROM requests WHERE key=?").get(idempotencyKey);
      if (prior) {
        const original = JSON.parse(String(prior.response)) as StoredAssessment;
        // Legacy receipts retain their original bytes. Compare canonical identities so a
        // privacy migration cannot turn an unchanged retry into another source write.
        const canonicalPriorHash = digest({ packet: normalizePacket(original.packet), expectedVersion: original.revision - 1,
          policyVersion: original.assessment.policyVersion, configHash: original.assessment.config.hash });
        if (prior.request_hash !== requestHash && canonicalPriorHash !== requestHash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
        this.db.exec("COMMIT");
        return original;
      }
      const latest = this.latest(packet.creatorId);
      if ((latest?.revision ?? 0) !== expectedVersion) throw new AgentConflict("VERSION_CONFLICT");
      // A revision label cannot be reused to conceal materially changed evidence or terms.
      if (latest) {
        const evidenceDomain = (p: EvidencePacket) => ({ creatorId: p.creatorId, briefId: p.briefId, checkoutRoute: p.checkoutRoute, posts: p.posts, recentPosts: p.recentPosts, ratings: p.ratings, criterionRatings: p.criterionRatings, criterionEvidenceRefs: p.criterionEvidenceRefs, invitationGates: p.invitationGates });
        const termsDomain = (p: EvidencePacket) => p.activationGates;
        if (digest(evidenceDomain(normalizePacket(latest.packet))) !== digest(evidenceDomain(packet)) && latest.packet.evidenceRevision === packet.evidenceRevision)
          throw new AgentConflict("EVIDENCE_REVISION_REUSED");
        if (digest(termsDomain(latest.packet)) !== digest(termsDomain(packet)) && latest.packet.termsRevision === packet.termsRevision)
          throw new AgentConflict("TERMS_REVISION_REUSED");
      }
      const record: StoredAssessment = { runId: randomUUID(), revision: expectedVersion + 1, recordedAt: new Date().toISOString(), packetHash: digest(packet), packet, assessment };
      const body = JSON.stringify(record);
      this.db.prepare("INSERT INTO assessments VALUES(?,?,?,?,?,?)").run(packet.creatorId, record.revision, record.runId, record.recordedAt, record.packetHash, body);
      this.db.prepare("INSERT INTO requests VALUES(?,?,?)").run(idempotencyKey, requestHash, body);
      this.db.exec("COMMIT");
      return record;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Domain repositories share this scoped connection; only AgentStore closes it. */
  get database(): DatabaseType { return this.db; }
  close() { this.db.close(); }
}
