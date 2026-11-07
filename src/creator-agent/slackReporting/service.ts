import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { ReportError, reportCommandSchema, reportLocatorSchema, reportOutcomeSchema, reportReadSchema, reportReference, type ReportCommand, type ReportJobPort, type ReportLocator, type ReportMachine, type ReportOutcome, type ReportRead, type ReportScope, type ReportSnapshot, type ReportingSource } from "./contract.ts";
import { formatReport } from "./format.ts";
import { ReportMetadata, type StoredAttempt, type StoredReport } from "./repository.ts";
import { assertSnapshot, loadSnapshot, reportMaterial, validateGrant } from "./source.ts";

export type { ReportRead } from "./contract.ts";
export type ReportingOptions = { db: DatabaseSync; scope: ReportScope; secret: string; jobs: ReportJobPort; source?: ReportingSource; now?: () => number };

export function createSlackReporting(options: ReportingOptions) {
  const { jobs, scope, source } = options, now = options.now ?? Date.now;
  const metadata = new ReportMetadata(options.db, scope, options.secret);
  const locate = (record: StoredReport): ReportLocator => ({ eventRef: record.snapshot.event.eventRef, eventVersion: record.snapshot.event.eventVersion });
  function normalize(error: unknown, reportRef?: string): ReportError {
    const certainty = reportRef ? metadata.certainty(reportRef) : "notApplied";
    if (error instanceof ReportError) return new ReportError(error.code, error.status, certainty === "notApplied" ? error.executionCertainty : certainty, error.retryAfterMs);
    const status = typeof error === "object" && error !== null && "status" in error && [401, 403].includes(Number(error.status)) ? Number(error.status) : 503;
    return new ReportError(status === 401 || status === 403 ? "REPORT_PERMISSION_DENIED" : "REPORT_SOURCE_UNAVAILABLE", status, certainty);
  }
  function requireRecord(reportRef: string): StoredReport { reportReference.parse(reportRef); const record = metadata.get(reportRef); if (!record) throw new ReportError("REPORT_NOT_FOUND", 404); return record; }
  function assertMaterial(record: StoredReport, snapshot: ReportSnapshot) {
    if (digest(reportMaterial(record.snapshot)) !== digest(reportMaterial(snapshot))) throw new ReportError("REPORT_FROZEN_SOURCE_CHANGED");
  }
  function assertReadTarget(record: StoredReport, snapshot: ReportSnapshot) {
    const expected = record.snapshot.destination, actual = snapshot.destination;
    for (const key of ["targetRef", "version", "workspaceId", "channelId", "botId"] as const) if (expected[key] !== actual[key]) throw new ReportError("REPORT_TARGET_READ_DENIED", 403);
  }
  async function read(reportRef: string, machine: ReportMachine): Promise<ReportRead> {
    try {
      const record = requireRecord(reportRef), snapshot = await loadSnapshot(source, locate(record), scope, "read", now, machine);
      assertReadTarget(record, snapshot);
      const applied = metadata.applied(reportRef), run = jobs.getRun(record.runRef), reasonCodes: string[] = [];
      try { assertMaterial(record, snapshot); assertSnapshot(source!, snapshot, scope, "send", now(), machine); } catch (error) { if (error instanceof ReportError && error.status !== 401 && error.status !== 403) reasonCodes.push(error.code); else if (snapshot.authority.send === "denied" && snapshot.authority.read === "allowed") reasonCodes.push("REPORT_SEND_DENIED"); else throw error; }
      if (applied) reasonCodes.push("REPORT_ALREADY_DELIVERED");
      else if (run.control !== "active") reasonCodes.push("REPORT_RUN_INACTIVE");
      else if (run.items.some(value => value.state === "leased" || value.state === "reconcile")) reasonCodes.push("REPORT_ORIGINAL_ATTEMPT_UNRESOLVED");
      else if (run.items.some(value => Date.parse(value.dueAt) > now())) reasonCodes.push("REPORT_RETRY_NOT_DUE");
      assertSnapshot(source!, snapshot, scope, "read", now(), machine);
      const certainty = metadata.certainty(reportRef);
      return reportReadSchema.parse({ schemaVersion: "farda.report.v1", reportRef, runRef: record.runRef, state: run.state, executionCertainty: certainty, sourceEffect: certainty === "applied" ? "internalReport" : certainty === "uncertain" ? "unknown" : "none", observedAt: new Date(now()).toISOString(), current: { sendEligible: reasonCodes.length === 0 ? null : false, reasonCodes: reasonCodes.length ? reasonCodes : ["REPORT_ATTEMPT_GRANT_NOT_EVALUATED"] }, receipt: applied ? { receiptRef: metadata.alias("report-receipt", applied.receipt.receiptRef), threadRef: metadata.alias("report-thread", [applied.receipt.workspaceId, applied.receipt.channelId, applied.receipt.threadTs ?? applied.receipt.messageTs]), bodyHash: applied.receipt.bodyHash, observedAt: applied.receipt.observedAt } : null, usage: { zapierTasks: "unknown", cost: "unknown" }, grantsBusinessAuthority: false });
    } catch (error) { throw normalize(error, reportRef); }
  }
  async function accept(input: ReportLocator, requestKey: string, machine: ReportMachine): Promise<ReportRead> {
    const locator = reportLocatorSchema.parse(input); reportReference.parse(requestKey); reportReference.parse(machine.workerRef);
    let reportRef: string | undefined;
    try {
      const snapshot = await loadSnapshot(source, locator, scope, "admit", now, machine);
      reportRef = metadata.identity(snapshot); metadata.validateEvent(snapshot);
      const requestRef = metadata.alias("report-request", [machine.workerRef, requestKey]), requestHash = digest(locator);
      const requested = metadata.admission(requestRef, requestHash), prior = metadata.get(reportRef);
      if (requested && requested.reportRef !== reportRef) throw new ReportError("REPORT_REQUEST_KEY_REUSED");
      const parent = metadata.parent(snapshot);
      const rendered = prior ? { body: prior.body, bodyHash: prior.bodyHash } : formatReport(snapshot);
      const frozen = prior?.snapshot ?? snapshot, jobId = metadata.alias("report-job", reportRef), itemKey = reportRef;
      const definition = { jobId, version: 1, ownerRef: metadata.alias("report-owner", [frozen.destination.targetRef, frozen.destination.owner.mappingVersion]), mode: "executeApproved", handler: "deliver-report.v1", eventType: "report-source-event", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-report-result.v1", policyVersion: metadata.alias("report-policy", [frozen.programme.programmeRef, frozen.programme.version]), modelVersion: null, offerVersion: null, capabilityBinding: frozen.delivery.binding, budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 3, maxRunMs: 900_000, leaseMs: 30_000, maxConcurrency: 1, retryBaseMs: 1000 } };
      jobs.register(definition, 0);
      jobs.ingest({ schemaVersion: "job-reference-batch.v1", jobId, jobVersion: 1, eventId: reportRef, eventType: "report-source-event", eventAt: frozen.event.occurredAt, items: [{ itemKey, subjectRef: reportRef, evidenceRef: metadata.alias("report-evidence", [frozen.event.eventRef, frozen.event.eventVersion]) }] }, requestRef, runRef => {
        assertSnapshot(source!, snapshot, scope, "admit", now(), machine);
        metadata.admit(prior ?? { reportRef: reportRef!, snapshot, ...rendered, parentRef: parent?.reportRef ?? null, runRef, createdAt: now() }, snapshot, requestRef, requestHash);
      });
      return await read(reportRef, machine);
    } catch (error) { throw normalize(error, reportRef); }
  }
  function commandFor(record: StoredReport, attemptNumber: number): ReportCommand {
    const snapshot = record.snapshot, parent = record.parentRef ? metadata.applied(record.parentRef) : null;
    if (record.parentRef && !parent) throw new ReportError("REPORT_ORIGINAL_THREAD_UNVERIFIED");
    if (parent && (parent.receipt.workspaceId !== snapshot.destination.workspaceId || parent.receipt.channelId !== snapshot.destination.channelId)) throw new ReportError("REPORT_RECOVERY_TARGET_CHANGED");
    return reportCommandSchema.parse({ scope, reportRef: record.reportRef, ...locate(record), programmeRef: snapshot.programme.programmeRef, programmeVersion: snapshot.programme.version, targetRef: snapshot.destination.targetRef, targetVersion: snapshot.destination.version, workspaceId: snapshot.destination.workspaceId, channelId: snapshot.destination.channelId, botId: snapshot.destination.botId, threadTs: parent?.receipt.messageTs ?? null, body: record.body, bodyHash: record.bodyHash, attemptRef: metadata.alias("report-attempt", [record.reportRef, attemptNumber]), attemptNumber, requestKey: metadata.alias("report-operation", [record.reportRef, attemptNumber]) });
  }
  function validateOutcome(attempt: StoredAttempt, raw: unknown): ReportOutcome {
    const parsed = reportOutcomeSchema.safeParse(raw); if (!parsed.success) return { state: "uncertain", reasonCode: "MALFORMED_READBACK" };
    const outcome = parsed.data, command = attempt.command;
    if (outcome.state === "uncertain") return outcome;
    const value = outcome.state === "applied" ? outcome.receipt : outcome.proof;
    if (digest(value.scope) !== digest(scope) || value.requestKey !== command.requestKey || value.attemptRef !== command.attemptRef || value.attemptNumber !== command.attemptNumber || value.targetVersion !== command.targetVersion || Date.parse(value.observedAt) > now() || Date.parse(value.observedAt) < attempt.startedAt) return { state: "uncertain", reasonCode: "MALFORMED_READBACK" };
    if (outcome.state === "notApplied") return outcome.proof.commandHash === digest(command) ? outcome : { state: "uncertain", reasonCode: "MALFORMED_READBACK" };
    const receipt = outcome.receipt;
    for (const key of ["reportRef", "eventRef", "eventVersion", "targetRef", "workspaceId", "channelId", "botId", "threadTs", "bodyHash"] as const) if (receipt[key] !== command[key]) return { state: "uncertain", reasonCode: "MALFORMED_READBACK" };
    if (Number(receipt.messageTs) * 1000 > now() || Number(receipt.messageTs) * 1000 < attempt.startedAt - 1000 || receipt.messageTs === receipt.threadTs) return { state: "uncertain", reasonCode: "MALFORMED_READBACK" };
    return outcome;
  }
  function settle(record: StoredReport, attempt: StoredAttempt, outcome: ReportOutcome) {
    const assertAttempt = (currentAttemptNumber: number) => {
      if (currentAttemptNumber !== attempt.command.attemptNumber || metadata.latest(record.reportRef)?.command.attemptRef !== attempt.command.attemptRef) throw new ReportError("REPORT_CLOSURE_ATTEMPT_MISMATCH", 409, metadata.certainty(record.reportRef));
    };
    if (outcome.state === "applied") {
      jobs.finishReport(record.runRef, record.reportRef, { schemaVersion: "job-report-result.v1", kind: "report-receipt", receiptRef: metadata.alias("report-receipt", outcome.receipt.receiptRef), requestKey: attempt.command.requestKey, payloadHash: attempt.command.bodyHash, sourceEffect: "internalReport", observedAt: outcome.receipt.observedAt }, currentAttemptNumber => { assertAttempt(currentAttemptNumber); metadata.settle(attempt.command, outcome); });
    } else {
      jobs.finishReport(record.runRef, record.reportRef, null, assertAttempt, outcome.state === "uncertain" ? `REPORT_${outcome.reasonCode}` : "REPORT_TERMINAL_CLOSURE_PENDING");
      if (outcome.state === "notApplied") jobs.closeReportAttempt(record.runRef, record.reportRef, attempt.command.attemptNumber, () => metadata.settle(attempt.command, outcome), outcome.proof.retryAfterMs);
    }
  }
  async function work(reportRef: string, machine: ReportMachine): Promise<ReportRead> {
    let started = false;
    try {
      const record = requireRecord(reportRef);
      if (metadata.applied(reportRef)) return await read(reportRef, machine);
      const original = metadata.latest(reportRef);
      if (original && !metadata.outcome(original.command.attemptRef)) return await reconcile(reportRef, machine);
      const snapshot = await loadSnapshot(source, locate(record), scope, "send", now, machine); assertMaterial(record, snapshot);
      const run = jobs.getRun(record.runRef), item = run.items.find(value => value.itemKey === reportRef);
      if (!item) throw new ReportError("REPORT_JOB_MISMATCH");
      if (run.control !== "active" || Date.parse(item.dueAt) > now() || !["queued", "held", "retryWait"].includes(item.state)) return await read(reportRef, machine);
      const command = commandFor(record, item.attempts + 1);
      const grant = validateGrant(source!, await source!.authorizeAttempt(snapshot, command), snapshot, command, now());
      const assertCurrent = () => { assertMaterial(record, snapshot); assertSnapshot(source!, snapshot, scope, "send", now(), machine); validateGrant(source!, grant, snapshot, command, now()); };
      assertCurrent(); jobs.activateReport(run.jobId, run.definition.version, grant.grantRef, assertCurrent);
      const claim = jobs.claimReport(record.runRef, machine.workerRef, reportRef, snapshot.delivery.binding, assertCurrent);
      if (!claim) return await read(reportRef, machine);
      const attempt: StoredAttempt = { command, grant, startedAt: now() };
      jobs.startReport(claim.item.itemId, claim.leaseToken, () => { assertCurrent(); if (claim.item.attempts !== command.attemptNumber) throw new ReportError("REPORT_ATTEMPT_MISMATCH"); metadata.start(attempt); }); started = true;
      const assertEffect = () => { assertCurrent(); jobs.assertReportLease(claim.item.itemId, claim.leaseToken, snapshot.delivery.binding); };
      assertEffect(); let raw: unknown;
      try { raw = await source!.deliver(command, { assertCurrent: assertEffect }); }
      catch { raw = { state: "uncertain", reasonCode: "OUTCOME_UNKNOWN" }; }
      settle(record, attempt, validateOutcome(attempt, raw));
      return await read(reportRef, machine);
    } catch (error) {
      if (started && metadata.certainty(reportRef) === "uncertain") {
        const record = metadata.get(reportRef), attempt = metadata.latest(reportRef);
        if (record && attempt) { try { settle(record, attempt, { state: "uncertain", reasonCode: "OUTCOME_UNKNOWN" }); } catch { /* Original durable started fence survives a concurrent completion or lost lease. */ } }
      }
      throw normalize(error, reportRef);
    }
  }
  async function reconcile(reportRef: string, machine: ReportMachine): Promise<ReportRead> {
    try {
      const record = requireRecord(reportRef), attempt = metadata.latest(reportRef);
      if (!attempt || metadata.outcome(attempt.command.attemptRef)) return await read(reportRef, machine);
      // A second observer cannot cancel a still-running native call merely because its readback is absent.
      jobs.recoverExpired();
      if (jobs.getRun(record.runRef).items.some(item => item.itemKey === reportRef && item.state === "leased")) return await read(reportRef, machine);
      const snapshot = await loadSnapshot(source, locate(record), scope, "read", now, machine);
      assertReadTarget(record, snapshot);
      const assertCurrent = () => { assertReadTarget(record, snapshot); assertSnapshot(source!, snapshot, scope, "read", now(), machine); };
      let raw: unknown;
      try { raw = await source!.lookup(attempt.command, { assertCurrent }); } catch { raw = { state: "uncertain", reasonCode: "OUTCOME_UNKNOWN" }; }
      assertCurrent(); settle(record, attempt, validateOutcome(attempt, raw)); return await read(reportRef, machine);
    } catch (error) { throw normalize(error, reportRef); }
  }
  return { accept, work, reconcile, read };
}
export type SlackReportingService = ReturnType<typeof createSlackReporting>;
