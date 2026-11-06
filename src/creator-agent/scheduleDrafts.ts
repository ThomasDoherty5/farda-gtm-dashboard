import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openOperationsToken } from "./operationsTokens.ts";
import { nextRun, scheduleDraftSchema, type NativeScheduleDetail, type NativeScheduleDraft } from "./scheduleCadence.ts";
import type { OperationsScope } from "./operations.ts";

export class ScheduleDraftError extends Error {
  readonly code: string; readonly status: number; readonly currentVersion?: string; readonly fieldErrors?: Record<string, string>;
  constructor(code: string, status: number, currentVersion?: string, fieldErrors?: Record<string,string>) {
    super(code); this.code = code; this.status = status; this.currentVersion = currentVersion; this.fieldErrors = fieldErrors;
  }
}
type Stored = { revision: number; job_version: number; updated_at: string; body: string };
type Receipt = { resourceRef: string; version: string; resource: NativeScheduleDraft; reasonCodes: string[]; updatedAt: string };

export class ScheduleDraftRepository {
  readonly db: DatabaseSync; readonly scope: OperationsScope; readonly secret: string; readonly now: () => number;
  constructor(db: DatabaseSync, scope: OperationsScope, secret: string, now: () => number = Date.now) {
    this.db = db; this.scope = scope; this.secret = secret; this.now = now;
    const bound = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
    if (!bound || scope.workspaceId !== bound.workspace_id || scope.accountId !== bound.account_id || scope.environment !== bound.environment)
      throw new ScheduleDraftError("DATABASE_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS schedule_draft_revisions(job_id TEXT NOT NULL,revision INTEGER NOT NULL,job_version INTEGER NOT NULL,body TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,revision));
      CREATE TABLE IF NOT EXISTS schedule_draft_receipts(request_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }

  private identify(ref: string): string | null {
    try { const id = openOperationsToken(this.scope, this.secret, "schedule-job", ref); return typeof id === "string" ? id : null; }
    catch { return null; }
  }
  private latest(jobId: string) {
    return this.db.prepare("SELECT revision,job_version,updated_at,body FROM schedule_draft_revisions WHERE job_id=? ORDER BY revision DESC LIMIT 1").get(jobId) as Stored | undefined;
  }
  read(ref: string): NativeScheduleDetail | null {
    const id = this.identify(ref);
    if (!id) return null;
    // One statement binds the latest immutable draft to the currently registered job definition.
    const row = this.db.prepare(`SELECT h.version, d.revision, d.job_version, d.updated_at, d.body FROM job_heads h
      LEFT JOIN schedule_draft_revisions d ON d.job_id=h.job_id AND d.revision=(SELECT MAX(revision) FROM schedule_draft_revisions WHERE job_id=h.job_id)
      WHERE h.job_id=?`).get(id);
    if (!row) return null;
    const observed = new Date(this.now()), observedAt = observed.toISOString();
    const draft = row.body ? scheduleDraftSchema.parse(JSON.parse(String(row.body))) : null;
    const next = draft ? nextRun(draft, observed) : null;
    return { kind: "saved-schedule-draft", source: "saved-operations", jobId: ref, jobVersion: Number(row.version),
      draftVersion: `j${row.version}-d${row.revision ?? 0}`, draft, savedForJobVersion: row.job_version === null ? null : Number(row.job_version),
      updatedAt: row.updated_at === null ? null : String(row.updated_at), observedAt, scheduleState: "disabled",
      preview: next ? { at: next.at.toISOString(), label: next.label, asOf: observedAt, basis: "proposed-local-time" } : null };
  }
  saveFromAdapter(resourceRef: string, expectedVersion: string | null, payload: unknown, idempotencyKey: string): Receipt {
    if (!resourceRef.startsWith("schedule-")) throw new ScheduleDraftError("RECORD_NOT_FOUND",404);
    const id = this.identify(resourceRef.slice("schedule-".length));
    if (!id) throw new ScheduleDraftError("RECORD_NOT_FOUND",404);
    if (!idempotencyKey.trim() || idempotencyKey.length > 240) throw new ScheduleDraftError("IDEMPOTENCY_KEY_REQUIRED",400);
    const parsed = scheduleDraftSchema.safeParse(payload);
    if (!parsed.success) throw new ScheduleDraftError("VALIDATION_FAILED",422,undefined,
      Object.fromEntries(parsed.error.issues.map(issue => [issue.path.join(".") || "draft", issue.message])));
    const draft = parsed.data;
    const digest = createHash("sha256").update(JSON.stringify([id,expectedVersion,draft])).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT request_digest,receipt FROM schedule_draft_receipts WHERE request_key=?").get(idempotencyKey);
      if (previous) {
        if (previous.request_digest !== digest) throw new ScheduleDraftError("IDEMPOTENCY_KEY_REUSED",409);
        this.db.exec("COMMIT"); return JSON.parse(String(previous.receipt)) as Receipt;
      }
      const job = this.db.prepare("SELECT version FROM job_heads WHERE job_id=?").get(id);
      if (!job) throw new ScheduleDraftError("RECORD_NOT_FOUND",404);
      const stored = this.latest(id);
      const current = `j${job.version}-d${stored?.revision ?? 0}`;
      if (expectedVersion !== current) throw new ScheduleDraftError("STALE_VERSION",409,current);
      const body = JSON.stringify(draft);
      const noChange = stored?.body === body && stored.job_version === Number(job.version);
      const revision = (stored?.revision ?? 0) + (noChange ? 0 : 1);
      const updatedAt = noChange ? stored.updated_at : new Date(this.now()).toISOString();
      if (!noChange) this.db.prepare("INSERT INTO schedule_draft_revisions(job_id,revision,job_version,body,updated_at) VALUES(?,?,?,?,?)").run(id,revision,job.version!,body,updatedAt);
      const receipt = { resourceRef, version: `j${job.version}-d${revision}`, resource: draft, reasonCodes: noChange ? ["NO_CHANGE"] : [], updatedAt };
      this.db.prepare("INSERT INTO schedule_draft_receipts VALUES(?,?,?)").run(idempotencyKey,digest,JSON.stringify(receipt));
      this.db.exec("COMMIT"); return receipt;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
