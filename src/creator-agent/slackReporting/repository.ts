import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { ReportError, type ReportCommand, type ReportGrant, type ReportOutcome, type ReportScope, type ReportSnapshot } from "./contract.ts";
import type { CreatorHandoff } from "../creatorHandoff/contract.ts";

export type StoredReport = { reportRef: string; snapshot: ReportSnapshot; body: string; bodyHash: string; parentRef: string | null; runRef: string; createdAt: number };
export type StoredAttempt = { command: ReportCommand; grant: ReportGrant; startedAt: number };
type TerminalOutcome = Exclude<ReportOutcome, { state: "uncertain" }>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;

function handoffSubject(event: CreatorHandoff): readonly string[] {
  switch (event.kind) {
    case "agreement": return [event.kind];
    case "sampleReserved": return [event.kind, event.reservationId];
    case "sampleShipped":
    case "sampleDelivered": return [event.kind, event.shipmentId];
    case "sampleException": return [event.kind, event.shipmentId, event.status];
    case "noPostReview": return [event.kind, event.clock.receiptRef];
    case "postLive": return [event.kind, event.network, event.postId];
  }
}

function matchesHandoffBasis(event: Exclude<CreatorHandoff, { kind: "agreement" }>, basis: CreatorHandoff, occurredAt: number) {
  switch (event.kind) {
    case "sampleReserved":
    case "postLive": return basis.kind === "agreement";
    case "sampleShipped": return basis.kind === "sampleReserved";
    case "sampleDelivered": return basis.kind === "sampleShipped" && basis.shipmentId === event.shipmentId;
    case "sampleException":
      return (basis.kind === "sampleShipped" || basis.kind === "sampleDelivered") && basis.shipmentId === event.shipmentId;
    case "noPostReview":
      return basis.kind === "sampleDelivered" && basis.clock?.receiptRef === event.clock.receiptRef &&
        basis.clock.reviewAfter === event.clock.reviewAfter && occurredAt >= Date.parse(event.clock.reviewAfter);
  }
}

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
      CREATE TABLE IF NOT EXISTS report_creator_handoffs(collaboration_id TEXT NOT NULL,sequence INTEGER NOT NULL,receipt_ref TEXT NOT NULL UNIQUE,
        subject_hash TEXT NOT NULL,kind TEXT NOT NULL,report_ref TEXT NOT NULL UNIQUE,PRIMARY KEY(collaboration_id,sequence),UNIQUE(collaboration_id,subject_hash));
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
    if (identity.kind === "creatorHandoff") return this.creatorReportRef(identity.collaborationId, identity.sequence);
    if (event.creatorWeekly) return this.alias("report", ["creator-weekly", event.creatorWeekly.window.reportDate]);
    return this.alias("report", [event.producerRef, identity.kind === "incident" ? [identity.conditionRef, identity.generation, identity.transition] : [identity.windowRef, identity.cadence]]);
  }
  private creatorReportRef(collaborationId: string, sequence: number) {
    return this.alias("report", ["creator-handoff", collaborationId, sequence]);
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
    if (event.identity.kind === "creatorHandoff" && event.creatorHandoff) {
      const { collaborationId, sequence } = event.identity, ref = this.creatorReportRef(collaborationId, sequence);
      const earlier = this.get(ref);
      if (earlier && digest(earlier.snapshot.event) !== digest(event)) throw new ReportError("REPORT_HANDOFF_VERSION_CHANGED");
      const identity = this.db.prepare(`
        SELECT report_ref FROM report_creator_handoffs WHERE receipt_ref=? OR (collaboration_id=? AND subject_hash=?)
      `).all(event.creatorHandoff.receiptRef, collaborationId, digest(handoffSubject(event.creatorHandoff)));
      if (identity.some(item => item.report_ref !== ref)) throw new ReportError("REPORT_HANDOFF_ALREADY_RECORDED");
    }
  }
  private thresholdDigestParent(snapshot: ReportSnapshot, conditionKey: string): StoredReport {
    const { targetRef, workspaceId, channelId, botId } = snapshot.destination;
    const row = this.db.prepare(`
      SELECT r.body FROM report_records r
      JOIN json_each(r.body,'$.snapshot.event.dailyDigest.thresholdAlerts.conditions') c ON c.value=?
      WHERE json_extract(r.body,'$.snapshot.destination.targetRef')=?
        AND json_extract(r.body,'$.snapshot.destination.workspaceId')=?
        AND json_extract(r.body,'$.snapshot.destination.channelId')=?
        AND json_extract(r.body,'$.snapshot.destination.botId')=?
        AND json_extract(r.body,'$.createdAt')<?
      ORDER BY r.rowid LIMIT 1
    `).get(conditionKey, targetRef, workspaceId, channelId, botId, Date.parse(snapshot.event.occurredAt));
    const parent = row ? parse<StoredReport>(row.body) : null;
    if (!parent || !this.applied(parent.reportRef)) throw new ReportError("REPORT_ORIGINAL_DIGEST_THREAD_UNVERIFIED");
    const prior = parent.snapshot;
    if (prior.destination.version !== snapshot.destination.version ||
        prior.programme.programmeRef !== snapshot.programme.programmeRef ||
        prior.programme.version !== snapshot.programme.version || prior.programme.adoptionRef !== snapshot.programme.adoptionRef) {
      throw new ReportError("REPORT_RECOVERY_TARGET_CHANGED");
    }
    return parent;
  }
  private creatorParent(snapshot: ReportSnapshot): StoredReport | null {
    const { identity, creatorHandoff: handoff, producerRef } = snapshot.event;
    if (identity.kind !== "creatorHandoff" || !handoff) throw new ReportError("REPORT_HANDOFF_UNVERIFIED");
    if (handoff.kind === "agreement") return null;
    const { collaborationId, sequence, previousEventRef } = identity;
    const root = this.get(this.creatorReportRef(collaborationId, 1));
    const previous = this.get(this.creatorReportRef(collaborationId, sequence - 1));
    if (!root || !previous || previous.snapshot.event.eventRef !== previousEventRef ||
        !this.applied(root.reportRef) || !this.applied(previous.reportRef)) throw new ReportError("REPORT_HANDOFF_PREDECESSOR_PENDING");
    const destinationKeys = ["workspaceId", "channelId", "botId", "targetRef", "version"] as const;
    const programmeKeys = ["programmeRef", "version", "adoptionRef"] as const;
    const agreement = root.snapshot.event.creatorHandoff;
    if (root.snapshot.event.producerRef !== producerRef || agreement?.kind !== "agreement" ||
        agreement.creatorId !== handoff.creatorId ||
        destinationKeys.some(key => root.snapshot.destination[key] !== snapshot.destination[key]) ||
        programmeKeys.some(key => root.snapshot.programme[key] !== snapshot.programme[key]) ||
        digest(root.snapshot.testProvenance ?? null) !== digest(snapshot.testProvenance ?? null)) {
      throw new ReportError("REPORT_HANDOFF_THREAD_SCOPE_CHANGED");
    }
    const basisRow = this.db.prepare(`
      SELECT report_ref FROM report_creator_handoffs WHERE collaboration_id=? AND receipt_ref=? AND sequence<?
    `).get(collaborationId, handoff.basisReceiptRef, sequence);
    const basis = basisRow ? this.get(String(basisRow.report_ref)) : null;
    const fact = basis?.snapshot.event.creatorHandoff;
    const occurredAt = Date.parse(snapshot.event.occurredAt);
    if (!basis || !fact || !this.applied(basis.reportRef) || Date.parse(basis.snapshot.event.occurredAt) > occurredAt) {
      throw new ReportError("REPORT_HANDOFF_BASIS_PENDING");
    }
    if (!matchesHandoffBasis(handoff, fact, occurredAt)) throw new ReportError("REPORT_HANDOFF_BASIS_MISMATCH");
    if (handoff.kind === "sampleDelivered" && handoff.clock && agreement.postingTerms !== "committed") {
      throw new ReportError("REPORT_HANDOFF_POSTING_TERMS_UNVERIFIED");
    }
    if (handoff.kind === "noPostReview" && fact.kind === "sampleDelivered") {
      const intervening = this.db.prepare(`
        SELECT r.body FROM report_creator_handoffs h JOIN report_records r ON r.report_ref=h.report_ref
        WHERE h.collaboration_id=? AND h.kind IN ('postLive','sampleException') AND h.sequence<?
      `).all(collaborationId, sequence);
      for (const item of intervening) {
        const event = parse<StoredReport>(item.body).snapshot.event, prior = event.creatorHandoff;
        if (Date.parse(event.occurredAt) > occurredAt) continue;
        if (prior?.kind === "postLive") throw new ReportError("REPORT_HANDOFF_POST_ALREADY_CONFIRMED");
        if (prior?.kind === "sampleException" && prior.shipmentId === fact.shipmentId &&
            Date.parse(event.occurredAt) >= Date.parse(basis.snapshot.event.occurredAt)) {
          throw new ReportError("REPORT_HANDOFF_DELIVERY_EXCEPTION");
        }
      }
    }
    return root;
  }
  parent(snapshot: ReportSnapshot): StoredReport | null {
    const identity = snapshot.event.identity;
    if (identity.kind === "creatorHandoff") return this.creatorParent(snapshot);
    if (identity.kind !== "incident") return null;
    if (identity.transition === "clear") {
      if (snapshot.event.thresholdDigestRecovery) {
        return this.thresholdDigestParent(snapshot, `${identity.conditionRef}-${identity.generation}`);
      }
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
    this.admission(requestRef, requestHash); this.validateEvent(event);
    if (record.parentRef !== (this.parent(event)?.reportRef ?? null)) throw new ReportError("REPORT_RECOVERY_TARGET_CHANGED");
    const sourceEvent = this.db.prepare("SELECT report_ref FROM report_source_events WHERE producer_ref=? AND event_ref=? AND event_version=?").get(event.event.producerRef, event.event.eventRef, event.event.eventVersion);
    if (sourceEvent && sourceEvent.report_ref !== record.reportRef) throw new ReportError("REPORT_SOURCE_IDENTITY_CONFLICT");
    const existing = this.get(record.reportRef);
    if (existing && existing.runRef !== record.runRef) throw new ReportError("REPORT_RUN_IDENTITY_CONFLICT");
    if (!existing) {
      this.db.prepare("INSERT INTO report_records VALUES(?,?)").run(record.reportRef, JSON.stringify(record));
      const { identity, creatorHandoff: handoff } = record.snapshot.event;
      if (identity.kind === "creatorHandoff" && handoff) {
        this.db.prepare("INSERT INTO report_creator_handoffs VALUES(?,?,?,?,?,?)").run(
          identity.collaborationId, identity.sequence, handoff.receiptRef, digest(handoffSubject(handoff)), handoff.kind, record.reportRef);
      }
    }
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
