import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { ReportError, type ReportCommand, type ReportGrant, type ReportOutcome, type ReportScope, type ReportSnapshot } from "./contract.ts";

export type StoredReport = { reportRef: string; snapshot: ReportSnapshot; body: string; bodyHash: string; parentRef: string | null; runRef: string; createdAt: number };
export type StoredAttempt = { command: ReportCommand; grant: ReportGrant; startedAt: number };
type TerminalOutcome = Exclude<ReportOutcome, { state: "uncertain" }>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

/** Immutable report/source metadata only. JobRepository owns every work state, lease, retry and effect fence. */
export class ReportMetadata {
  private db: DatabaseSync; private scope: ReportScope; private secret: string;
  constructor(db: DatabaseSync, scope: ReportScope, secret: string) {
    this.db = db; this.scope = scope; this.secret = secret;
    const owner = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (!owner || owner.workspace_id !== scope.workspaceId || owner.account_id !== scope.accountId || scope.environment !== "sandbox" || secret.length < 32) throw new ReportError("REPORT_SCOPE_MISMATCH", 403);
    db.exec(`CREATE TABLE IF NOT EXISTS report_configuration(id INTEGER PRIMARY KEY CHECK(id=1),scope_hash TEXT NOT NULL,key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_records(report_ref TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_source_events(producer_ref TEXT NOT NULL,event_ref TEXT NOT NULL,event_version TEXT NOT NULL,event_hash TEXT NOT NULL,report_ref TEXT NOT NULL,PRIMARY KEY(producer_ref,event_ref,event_version));
      CREATE TABLE IF NOT EXISTS report_admissions(request_ref TEXT PRIMARY KEY,body_hash TEXT NOT NULL,report_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_attempts(report_ref TEXT NOT NULL,attempt_number INTEGER NOT NULL,attempt_ref TEXT NOT NULL UNIQUE,body TEXT NOT NULL,PRIMARY KEY(report_ref,attempt_number));
      CREATE TABLE IF NOT EXISTS report_outcomes(attempt_ref TEXT PRIMARY KEY,body TEXT NOT NULL,body_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_native_receipts(native_key TEXT PRIMARY KEY,report_ref TEXT NOT NULL,attempt_ref TEXT NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO report_configuration VALUES(1,?,?)").run(digest(scope), digest(secret));
    const config = db.prepare("SELECT scope_hash,key_hash FROM report_configuration WHERE id=1").get();
    if (config?.scope_hash !== digest(scope) || config.key_hash !== digest(secret)) throw new ReportError("REPORT_DURABLE_IDENTITY_MISMATCH", 503);
  }
  alias(kind: string, value: unknown): string { return `${kind}:${createHmac("sha256", this.secret).update(JSON.stringify([this.scope, kind, value])).digest("hex")}`; }
  identity(snapshot: ReportSnapshot): string {
    const event = snapshot.event, identity = event.identity;
    if (event.dailyDigest) {
      return this.alias("report", ["daily-exceptions", snapshot.destination.workspaceId, snapshot.destination.channelId, event.dailyDigest.window.reportDate]);
    }
    return this.alias("report", [event.producerRef, identity.kind === "incident" ? [identity.conditionRef, identity.generation, identity.transition] : [identity.windowRef, identity.cadence]]);
  }
  get(reportRef: string): StoredReport | null { const row = this.db.prepare("SELECT body FROM report_records WHERE report_ref=?").get(reportRef); return row ? parse<StoredReport>(row.body) : null; }
  getByRun(runRef: string): StoredReport | null {
    const row = this.db.prepare("SELECT body FROM report_records WHERE json_extract(body,'$.runRef')=?").get(runRef); return row ? parse<StoredReport>(row.body) : null;
  }
  admission(requestRef: string, bodyHash: string): StoredReport | null {
    const row = this.db.prepare("SELECT * FROM report_admissions WHERE request_ref=?").get(requestRef);
    if (!row) return null; if (row.body_hash !== bodyHash) throw new ReportError("REPORT_REQUEST_KEY_REUSED"); return this.get(String(row.report_ref));
  }
  validateEvent(snapshot: ReportSnapshot): void {
    const event = snapshot.event;
    const row = this.db.prepare("SELECT event_hash FROM report_source_events WHERE producer_ref=? AND event_ref=? AND event_version=?").get(event.producerRef, event.eventRef, event.eventVersion);
    if (row && row.event_hash !== digest(event)) throw new ReportError("REPORT_EVENT_VERSION_REUSED");
  }
  parent(snapshot: ReportSnapshot): StoredReport | null {
    const identity = snapshot.event.identity;
    if (identity.kind !== "incident") return null;
    if (identity.transition === "clear") {
      const ref = this.alias("report", [snapshot.event.producerRef, [identity.conditionRef, identity.generation, "breach"]]);
      const parent = this.get(ref);
      if (!parent || !this.applied(ref)) throw new ReportError("REPORT_ORIGINAL_THREAD_UNVERIFIED");
      const original = parent.snapshot.event.identity;
      if (original.kind !== "incident" || identity.sequence <= original.sequence || Date.parse(snapshot.event.occurredAt) <= Date.parse(parent.snapshot.event.occurredAt)) throw new ReportError("REPORT_TRANSITION_OUT_OF_ORDER");
      return parent;
    }
    if (identity.generation === 1) {
      if (identity.previousClearEventRef !== null) throw new ReportError("REPORT_REARM_UNVERIFIED"); return null;
    }
    const clearRef = this.alias("report", [snapshot.event.producerRef, [identity.conditionRef, identity.generation - 1, "clear"]]);
    const clear = this.get(clearRef);
    if (!clear || !this.applied(clearRef) || identity.previousClearEventRef !== clear.snapshot.event.eventRef) throw new ReportError("REPORT_REARM_UNVERIFIED");
    const previous = clear.snapshot.event.identity;
    if (previous.kind !== "incident" || identity.sequence <= previous.sequence || Date.parse(snapshot.event.occurredAt) <= Date.parse(clear.snapshot.event.occurredAt)) throw new ReportError("REPORT_TRANSITION_OUT_OF_ORDER");
    return null;
  }
  /** Called exclusively inside JobRepository.ingest's transaction. */
  admit(record: StoredReport, event: ReportSnapshot, requestRef: string, requestHash: string): void {
    this.admission(requestRef, requestHash); this.validateEvent(event); this.parent(event);
    const sourceEvent = this.db.prepare("SELECT report_ref FROM report_source_events WHERE producer_ref=? AND event_ref=? AND event_version=?").get(event.event.producerRef, event.event.eventRef, event.event.eventVersion);
    if (sourceEvent && sourceEvent.report_ref !== record.reportRef) throw new ReportError("REPORT_SOURCE_IDENTITY_CONFLICT");
    const existing = this.get(record.reportRef);
    if (existing && existing.runRef !== record.runRef) throw new ReportError("REPORT_RUN_IDENTITY_CONFLICT");
    if (!existing) this.db.prepare("INSERT INTO report_records VALUES(?,?)").run(record.reportRef, JSON.stringify(record));
    this.db.prepare("INSERT OR IGNORE INTO report_source_events VALUES(?,?,?,?,?)").run(event.event.producerRef, event.event.eventRef, event.event.eventVersion, digest(event.event), record.reportRef);
    this.db.prepare("INSERT OR IGNORE INTO report_admissions VALUES(?,?,?)").run(requestRef, requestHash, record.reportRef);
  }
  latest(reportRef: string): StoredAttempt | null { const row = this.db.prepare("SELECT body FROM report_attempts WHERE report_ref=? ORDER BY attempt_number DESC LIMIT 1").get(reportRef); return row ? parse<StoredAttempt>(row.body) : null; }
  outcome(attemptRef: string): TerminalOutcome | null { const row = this.db.prepare("SELECT body FROM report_outcomes WHERE attempt_ref=?").get(attemptRef); return row ? parse<TerminalOutcome>(row.body) : null; }
  applied(reportRef: string): Extract<ReportOutcome, { state: "applied" }> | null {
    const row = this.db.prepare("SELECT o.body FROM report_outcomes o JOIN report_attempts a ON a.attempt_ref=o.attempt_ref WHERE a.report_ref=? AND json_extract(o.body,'$.state')='applied' ORDER BY a.attempt_number LIMIT 1").get(reportRef);
    return row ? parse<Extract<ReportOutcome, { state: "applied" }>>(row.body) : null;
  }
  /** Called in the existing start transaction, before the first possible native effect. */
  start(attempt: StoredAttempt): void {
    if (this.applied(attempt.command.reportRef)) throw new ReportError("REPORT_ALREADY_DELIVERED");
    const prior = this.latest(attempt.command.reportRef);
    if (prior && (!this.outcome(prior.command.attemptRef) || prior.command.attemptNumber >= attempt.command.attemptNumber)) throw new ReportError("REPORT_ORIGINAL_ATTEMPT_UNRESOLVED", 409, "uncertain");
    this.db.prepare("INSERT INTO report_attempts VALUES(?,?,?,?)").run(attempt.command.reportRef, attempt.command.attemptNumber, attempt.command.attemptRef, JSON.stringify(attempt));
  }
  /** Native facts are immutable and serialized with the existing job receipt/closure. */
  settle(command: ReportCommand, outcome: TerminalOutcome): void {
    const row = this.db.prepare("SELECT body FROM report_attempts WHERE attempt_ref=?").get(command.attemptRef);
    if (!row || digest(parse<StoredAttempt>(row.body).command) !== digest(command)) throw new ReportError("REPORT_ATTEMPT_MISMATCH");
    const existing = this.outcome(command.attemptRef);
    if (existing) { if (digest(existing) !== digest(outcome)) throw new ReportError("REPORT_TERMINAL_RECEIPT_CONFLICT", 409, existing.state === "applied" ? "applied" : "notApplied"); return; }
    const latest = this.latest(command.reportRef);
    if (latest?.command.attemptRef !== command.attemptRef) throw new ReportError("REPORT_CLOSURE_ATTEMPT_MISMATCH", 409, this.applied(command.reportRef) ? "applied" : "uncertain");
    if (outcome.state === "applied") {
      const r = outcome.receipt, nativeKey = digest([r.workspaceId, r.channelId, r.messageTs]);
      const claim = this.db.prepare("SELECT report_ref,attempt_ref FROM report_native_receipts WHERE native_key=?").get(nativeKey);
      if (claim && (claim.report_ref !== command.reportRef || claim.attempt_ref !== command.attemptRef)) throw new ReportError("REPORT_NATIVE_RECEIPT_OWNED", 409, "uncertain");
      this.db.prepare("INSERT OR IGNORE INTO report_native_receipts VALUES(?,?,?)").run(nativeKey, command.reportRef, command.attemptRef);
    }
    this.db.prepare("INSERT INTO report_outcomes VALUES(?,?,?)").run(command.attemptRef, JSON.stringify(outcome), digest(outcome));
  }
  certainty(reportRef: string): "notApplied" | "uncertain" | "applied" {
    if (this.applied(reportRef)) return "applied";
    const latest = this.latest(reportRef); return !latest || this.outcome(latest.command.attemptRef)?.state === "notApplied" ? "notApplied" : "uncertain";
  }
}
