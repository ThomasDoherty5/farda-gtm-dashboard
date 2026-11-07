// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { JobRepository } from "../jobs/repository.ts";
import { createSlackReporting } from "./service.ts";
import { createReportingTestkit, reportFixture } from "./fixtures.testkit.ts";
import { reportEventSchema, reportSnapshotSchema, type ReportOutcome } from "./contract.ts";
import { formatReport } from "./format.ts";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

describe("source-authorized report delivery on the existing SQLite job queue", () => {
  let kit: ReturnType<typeof createReportingTestkit>;
  beforeEach(() => { kit = createReportingTestkit(); });
  afterEach(() => kit.close());
  it("delivers one finite policy report with native receipt and no business authority", async () => {
    const queued = await kit.accept(); expect(queued.executionCertainty).toBe("notApplied"); expect(queued.state).toBe("held");
    const sent = await kit.service.work(queued.reportRef, kit.machine);
    expect(sent).toMatchObject({ state: "completed", executionCertainty: "applied", sourceEffect: "internalReport", grantsBusinessAuthority: false, usage: { zapierTasks: "unknown", cost: "unknown" } });
    expect(kit.state.calls).toHaveLength(1); expect(kit.state.calls[0]!.body).toContain("🔴 Act now\nOrder SYNTHETIC-001");
    expect(kit.state.calls[0]!.body).toContain("<@USYNTHETIC>"); expect(kit.state.calls[0]!.threadTs).toBeNull();
    expect(kit.jobs.getRun(sent.runRef).items[0]!.result).toMatchObject({ sourceEffect: "internalReport", kind: "report-receipt" });
    expect(JSON.stringify(sent)).not.toMatch(/CSYNTHETIC|USYNTHETIC|BSYNTHETIC|native-receipt|chat-write|route:synthetic/);
  });
  it("defaults to unbound and does not manufacture provider or programme authority", async () => {
    const service = createSlackReporting({ db: kit.db, scope: kit.scope, secret: "synthetic-reporting-private-test-key-000000000000", jobs: kit.jobs, now: () => kit.now });
    await expect(service.accept(kit.locator, "unbound", kit.machine)).rejects.toMatchObject({ code: "REPORT_SOURCE_UNBOUND", executionCertainty: "notApplied" });
    const snapshot = reportFixture(kit.now); snapshot.programme.state = "unverified"; kit.add(snapshot);
    await expect(kit.accept()).rejects.toMatchObject({ code: "REPORT_PROGRAMME_HELD" }); expect(kit.state.calls).toHaveLength(0);
  });
  it("deduplicates breach updates and transport keys; source-version or reused-body conflicts cannot rewrite receipts", async () => {
    const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    expect((await kit.accept(kit.locator, "another-key")).reportRef).toBe(first.reportRef);
    const update = reportFixture(kit.now); update.event.eventRef = "event:new-observation"; update.event.facts = [{ label: "shipments", value: 2, unit: "count", missingReason: null }]; const updated = kit.add(update);
    expect((await kit.accept(updated, "third-key")).reportRef).toBe(first.reportRef);
    await kit.service.work(first.reportRef, kit.machine); expect(kit.state.calls).toHaveLength(1);
    await expect(kit.accept(updated, "synthetic-request")).rejects.toMatchObject({ code: "REPORT_REQUEST_KEY_REUSED" });
    update.event.facts = [{ label: "shipments", value: 3, unit: "count", missingReason: null }]; kit.add(update);
    await expect(kit.accept(updated, "fourth-key")).rejects.toMatchObject({ code: "REPORT_EVENT_VERSION_REUSED" });
    expect(kit.db.prepare("SELECT COUNT(*) n FROM report_records").get()?.n).toBe(1);
  });
  it("reopens after a lost acknowledgment and reconciles the original operation without another send", async () => {
    const first = await kit.accept(); kit.state.mode = "lostAck";
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
    const key = kit.state.calls[0]!.requestKey; kit.reopen();
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("applied");
    expect(kit.state.lookups.map(value => value.requestKey)).toEqual([key]); expect(kit.state.calls).toHaveLength(1);
    await kit.service.reconcile(first.reportRef, kit.machine); expect(kit.state.lookups).toHaveLength(1);
  });
  it.each(["null", "wrongChannel", "wrongHash", "wrongThread", "wrongTarget", "future", "missingClosure"])("keeps %s evidence uncertain until exact original readback", async mode => {
    const first = await kit.accept(); kit.state.ackOverride = outcome => {
      if (mode === "null") return null;
      if (mode === "missingClosure") return { state: "notApplied", complete: true };
      if (outcome.state !== "applied") return outcome;
      const receipt = { ...outcome.receipt };
      if (mode === "wrongChannel") receipt.channelId = "COTHER";
      if (mode === "wrongHash") receipt.bodyHash = "a".repeat(64);
      if (mode === "wrongThread") receipt.threadTs = "1794052799.999999";
      if (mode === "wrongTarget") receipt.targetVersion = "changed-v2";
      if (mode === "future") receipt.observedAt = new Date(kit.now + 60_000).toISOString();
      return { state: "applied", receipt };
    };
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
    expect((await kit.service.reconcile(first.reportRef, kit.machine)).executionCertainty).toBe("applied"); expect(kit.state.calls).toHaveLength(1);
  });
  it("does not interpret absent lookup as terminal nonexecution or mint a replacement key", async () => {
    const first = await kit.accept(); kit.state.mode = "unknown"; await kit.service.work(first.reportRef, kit.machine);
    const command = kit.state.calls[0]!; kit.outcomes.delete(command.requestKey);
    for (let i = 0; i < 3; i++) expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
    expect(kit.state.calls).toHaveLength(1); expect(new Set(kit.state.lookups.map(value => value.requestKey))).toEqual(new Set([command.requestKey]));
  });
  it("throttles only after exact positive attempt closure and fresh authority; retries use a new closed-attempt generation", async () => {
    const first = await kit.accept(); kit.state.mode = "rate";
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("notApplied");
    const original = kit.state.calls[0]!; const grantsBefore = kit.state.grantCalls;
    await kit.service.work(first.reportRef, kit.machine); expect(kit.state.calls).toHaveLength(1); expect(kit.state.grantCalls).toBe(grantsBefore);
    kit.advance(5001); kit.state.mode = "applied"; kit.state.quotaAllowed = false;
    await expect(kit.service.work(first.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_GRANT_UNVERIFIED" }); expect(kit.state.calls).toHaveLength(1);
    kit.state.quotaAllowed = true;
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("applied");
    expect(kit.state.calls[1]!.attemptNumber).toBe(2); expect(kit.state.calls[1]!.requestKey).not.toBe(original.requestKey);
    expect(kit.db.prepare("SELECT COUNT(*) n FROM report_outcomes").get()?.n).toBe(2);
  });
  it("clears once in the original thread and rearms only after the exact source-confirmed clear", async () => {
    const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    const root = kit.state.calls[0]!, receipt = kit.outcomes.get(root.requestKey) as Extract<ReportOutcome, { state: "applied" }>;
    kit.advance(1000); const clear = reportFixture(kit.now); clear.event.eventRef = "event:clear"; clear.event.severity = "info"; clear.event.identity = { kind: "incident", conditionRef: "condition:one", generation: 1, transition: "clear", sequence: 2, previousClearEventRef: null }; clear.event.facts = [{ label: "incidentStatus", value: "cleared" }]; clear.event.nextAction = "continueMonitoring";
    const clearLocator = kit.add(clear), recovery = await kit.accept(clearLocator, "clear"); await kit.service.work(recovery.reportRef, kit.machine);
    expect(kit.state.calls[1]!.threadTs).toBe(receipt.receipt.messageTs);
    await kit.accept(clearLocator, "clear-duplicate"); await kit.service.work(recovery.reportRef, kit.machine); expect(kit.state.calls).toHaveLength(2);
    kit.advance(1000); const rearm = reportFixture(kit.now); rearm.event.eventRef = "event:rearm"; rearm.event.identity = { kind: "incident", conditionRef: "condition:one", generation: 2, transition: "breach", sequence: 3, previousClearEventRef: "event:clear" };
    const second = await kit.accept(kit.add(rearm), "rearm"); await kit.service.work(second.reportRef, kit.machine); expect(kit.state.calls).toHaveLength(3); expect(kit.state.calls[2]!.threadTs).toBeNull();
  });
  it("holds missing original thread, unconfirmed rearm and equivalent-time out-of-order clear", async () => {
    const clear = reportFixture(kit.now); clear.event.severity = "info"; clear.event.identity = { kind: "incident", conditionRef: "condition:one", generation: 1, transition: "clear", sequence: 2, previousClearEventRef: null };
    await expect(kit.accept(kit.add(clear))).rejects.toMatchObject({ code: "REPORT_ORIGINAL_THREAD_UNVERIFIED" });
    const rearm = reportFixture(kit.now); rearm.event.identity = { kind: "incident", conditionRef: "condition:one", generation: 2, transition: "breach", sequence: 3, previousClearEventRef: "event:unverified-clear" };
    await expect(kit.accept(kit.add(rearm), "rearm")).rejects.toMatchObject({ code: "REPORT_REARM_UNVERIFIED" });
    kit.add(reportFixture(kit.now)); const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    clear.event.eventRef = "event:clear"; clear.event.occurredAt = "2026-11-07T03:59:59-08:00";
    await expect(kit.accept(kit.add(clear), "clear")).rejects.toMatchObject({ code: "REPORT_TRANSITION_OUT_OF_ORDER" });
  });
  it.each(["missing", "deactivated"] as const)("uses explicit %s owner with no guessed mention or backup", async state => {
    const snapshot = reportFixture(kit.now); snapshot.destination.owner = { state, memberId: null, mappingVersion: "owner-v2" }; kit.add(snapshot);
    const report = await kit.accept(); await kit.service.work(report.reportRef, kit.machine);
    expect(kit.state.calls[0]!.body).toContain("Owner: unassigned"); expect(kit.state.calls[0]!.body).not.toContain("<@");
  });
  it.each(["permission", "programme", "member", "quota", "worker"])("fences %s withdrawal after awaited grant before native dispatch", async kind => {
    const first = await kit.accept(); kit.state.beforeGrant = () => {
      if (kind === "permission") kit.state.sendAllowed = false;
      if (kind === "worker") kit.state.actorAllowed = false;
      if (kind === "quota") kit.state.quotaAllowed = false;
      if (kind === "programme" || kind === "member") { const changed = reportFixture(kit.now); if (kind === "programme") changed.programme.state = "revoked"; else changed.destination.member = "denied"; kit.add(changed); }
    };
    await expect(kit.service.work(first.reportRef, kit.machine)).rejects.toBeDefined(); expect(kit.state.calls).toHaveLength(0);
    expect(kit.db.prepare("SELECT COUNT(*) n FROM report_attempts").get()?.n).toBe(0);
  });
  it("preserves applied proof but clears protected response after read permission is withdrawn", async () => {
    const first = await kit.accept(); kit.state.afterDeliver = () => { kit.state.readAllowed = false; };
    await expect(kit.service.work(first.reportRef, kit.machine)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    await expect(kit.service.read(first.reportRef, kit.machine)).rejects.toMatchObject({ status: 403, executionCertainty: "applied" });
    expect(kit.db.prepare("SELECT COUNT(*) n FROM report_outcomes").get()?.n).toBe(1); kit.state.readAllowed = true; kit.state.sendAllowed = false;
    expect((await kit.service.reconcile(first.reportRef, kit.machine))).toMatchObject({ executionCertainty: "applied", current: { sendEligible: false } }); expect(kit.state.calls).toHaveLength(1);
  });
  it("holds stale, partial and missing-link source evidence without a false all-clear", async () => {
    for (const field of ["freshness", "coverage", "linkAuthorized"] as const) {
      const snapshot = reportFixture(kit.now); if (field === "freshness") snapshot.evidence.freshness = "stale"; else if (field === "coverage") snapshot.evidence.coverage = "partial"; else snapshot.evidence.linkAuthorized = false; kit.add(snapshot);
      await expect(kit.accept()).rejects.toMatchObject({ code: "REPORT_EVIDENCE_HELD" });
    }
    expect(kit.state.calls).toHaveLength(0);
  });
  it("uses source-defined aggregate windows and not-before without another threshold or scheduler", async () => {
    const snapshot = reportFixture(kit.now); snapshot.event.severity = "orange"; snapshot.event.subject = { kind: "aggregate", category: "automation" }; snapshot.event.identity = { kind: "window", windowRef: "window:orange-one", start: new Date(kit.now - 3_600_000).toISOString(), end: new Date(kit.now).toISOString(), cadence: "orangeDigest", timezone: "America/Los_Angeles", launchWindowRef: null }; snapshot.delivery.notBefore = new Date(kit.now + 10_000).toISOString();
    const report = await kit.accept(kit.add(snapshot)); await expect(kit.service.work(report.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_NOT_DUE" }); expect(kit.state.calls).toHaveLength(0); kit.advance(10_000);
    expect((await kit.service.work(report.reportRef, kit.machine)).executionCertainty).toBe("applied"); expect(kit.state.calls[0]!.body).toContain("🟠 Act today"); expect(kit.state.calls[0]!.body).toContain("America/Los_Angeles");
  });
  it("serializes two real SQLite callers and recovers started leases without a duplicate", async () => {
    const first = await kit.accept(); const otherDb = new DatabaseSync(kit.path), otherJobs = new JobRepository(otherDb, { scope: kit.scope, now: () => kit.now });
    const other = createSlackReporting({ db: otherDb, scope: kit.scope, secret: "synthetic-reporting-private-test-key-000000000000", jobs: otherJobs, source: kit.source, now: () => kit.now });
    let release: (() => void) | undefined; const barrier = new Promise<void>(resolve => { release = resolve; }); kit.state.beforeDeliver = () => barrier;
    try {
      const pending = kit.service.work(first.reportRef, kit.machine); for (let i = 0; i < 10 && !kit.db.prepare("SELECT 1 FROM report_attempts").get(); i++) await new Promise(resolve => setTimeout(resolve, 0));
      expect((await other.work(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain"); expect(kit.state.calls).toHaveLength(0); expect(kit.state.lookups).toHaveLength(0);
      kit.advance(30_001); kit.jobs.recoverExpired(); release!(); expect((await pending).executionCertainty).toBe("uncertain"); expect(kit.state.calls).toHaveLength(0);
      expect(kit.jobs.getRun(first.runRef).state).toBe("reconcile");
    } finally { release?.(); otherDb.close(); }
  });
  it("rejects raw text, customer data, mention injection, invalid times and private-link parameters before formatting", () => {
    const base = reportFixture(kit.now); const invalid = [
      { ...base.event, customerEmail: "private@example.invalid" },
      { ...base.event, facts: [{ label: "error", value: "customer private message" }] },
      { ...base.event, subject: { kind: "creator", handle: "<!here>" } },
      { ...base.event, link: { ...base.event.link, url: "https://example.invalid/?token=private" } },
      { ...base.event, occurredAt: "2026-11-07T12:00:00+99:99" },
    ];
    for (const event of invalid) expect(reportEventSchema.safeParse(event).success).toBe(false);
    expect(reportSnapshotSchema.safeParse({ ...base, health: "private diagnosis" }).success).toBe(false);
    base.event.facts = [{ label: "shipments", value: null, unit: "count", missingReason: "notObserved" }]; const body = formatReport(base).body;
    expect(body).toContain("Shipments affected: unknown (not observed)"); expect(body).not.toContain("Shipments affected: 0"); expect(body).not.toContain("event:one");
  });
  it("does not let a concurrent reader cancel a live send when no receipt yet exists", async () => {
    const first = await kit.accept(); let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => { release = resolve; }); kit.state.beforeDeliver = () => barrier;
    const work = kit.service.work(first.reportRef, kit.machine);
    for (let i = 0; i < 10 && !kit.db.prepare("SELECT 1 FROM report_attempts").get(); i++) await new Promise(resolve => setTimeout(resolve, 0));
    const pending = await kit.service.reconcile(first.reportRef, kit.machine); expect(pending.executionCertainty).toBe("uncertain");
    expect(kit.jobs.getRun(first.runRef).items[0]!.state).toBe("leased"); expect(kit.state.lookups).toHaveLength(0);
    release!(); expect((await work).executionCertainty).toBe("applied"); expect(kit.state.calls).toHaveLength(1);
  });
  it("sends scheduled info only at the adopted weekday/Monday 08:30 Pacific slot", async () => {
    kit.advance(Date.parse("2026-11-09T16:30:00Z") - kit.now);
    const snapshot = reportFixture(kit.now); snapshot.event.severity = "info"; snapshot.event.subject = { kind: "aggregate", category: "creators" }; snapshot.event.identity = { kind: "window", windowRef: "window:weekly", start: new Date(kit.now - 86_400_000).toISOString(), end: new Date(kit.now).toISOString(), cadence: "mondayWeekly", timezone: "America/Los_Angeles", launchWindowRef: null }; snapshot.delivery.notBefore = new Date(kit.now).toISOString();
    const report = await kit.accept(kit.add(snapshot)); expect((await kit.service.work(report.reportRef, kit.machine)).executionCertainty).toBe("applied"); expect(kit.state.calls[0]!.body).toContain("🟢 Info");
    const bad = structuredClone(snapshot); bad.event.eventRef = "event:bad-schedule"; bad.event.identity = { ...snapshot.event.identity, windowRef: "window:bad" }; bad.delivery.notBefore = new Date(kit.now + 60_000).toISOString();
    await expect(kit.accept(kit.add(bad), "bad-schedule")).rejects.toMatchObject({ code: "REPORT_SCHEDULE_MISMATCH" });
    bad.delivery.notBefore = "2026-11-10T16:30:00Z"; await expect(kit.accept(kit.add(bad), "not-monday")).rejects.toMatchObject({ code: "REPORT_SCHEDULE_MISMATCH" });
  });
  it("will not close an uncertain attempt with another attempt's terminal proof", async () => {
    const first = await kit.accept(); kit.state.mode = "unknown"; await kit.service.work(first.reportRef, kit.machine);
    const command = kit.state.calls[0]!; kit.outcomes.set(command.requestKey, { state: "notApplied", proof: { scope: kit.scope, requestKey: command.requestKey, attemptRef: command.attemptRef, attemptNumber: 2, commandHash: "a".repeat(64), targetVersion: command.targetVersion, proofRef: "closure:wrong-attempt", observedAt: new Date(kit.now).toISOString(), complete: true, originalAttemptClosed: true, reasonCode: "NOT_APPLIED_CLOSED", retryAfterMs: 0 } });
    expect((await kit.service.reconcile(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain"); expect(kit.db.prepare("SELECT COUNT(*) n FROM report_outcomes").get()?.n).toBe(0); expect(kit.jobs.getRun(first.runRef).state).toBe("reconcile");
  });
  it("does not send after an awaited native adapter preflight observes pause or scope withdrawal", async () => {
    const first = await kit.accept(); kit.state.beforeDeliver = () => { kit.jobs.controlRun(first.runRef, "pause"); };
    expect((await kit.service.work(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain"); expect(kit.state.calls).toHaveLength(0);
    kit.state.sendAllowed = false; expect((await kit.service.reconcile(first.reportRef, kit.machine)).executionCertainty).toBe("uncertain"); expect(kit.state.calls).toHaveLength(0);
  });
  it("does not borrow read permission from a changed channel to expose or reconcile the original receipt", async () => {
    const first = await kit.accept(); kit.state.mode = "lostAck"; await kit.service.work(first.reportRef, kit.machine);
    const changed = reportFixture(kit.now); changed.destination.channelId = "COTHER"; changed.destination.version = "target-v2"; kit.add(changed);
    await expect(kit.service.reconcile(first.reportRef, kit.machine)).rejects.toMatchObject({ status: 403, executionCertainty: "uncertain", code: "REPORT_TARGET_READ_DENIED" });
    expect(kit.state.lookups).toHaveLength(0); expect(kit.state.calls).toHaveLength(1); expect(kit.db.prepare("SELECT COUNT(*) n FROM report_outcomes").get()?.n).toBe(0);
    kit.add(reportFixture(kit.now)); expect((await kit.service.reconcile(first.reportRef, kit.machine)).executionCertainty).toBe("applied");
  });
  it("requires synchronous final authority assertions instead of accepting an unawaited promise", async () => {
    const original = kit.source.assertCurrent; kit.source.assertCurrent = async () => undefined;
    await expect(kit.accept()).rejects.toMatchObject({ code: "REPORT_SYNCHRONOUS_FENCE_REQUIRED" }); expect(kit.state.calls).toHaveLength(0);
    kit.source.assertCurrent = original; const report = await kit.accept(); expect(report.current).toEqual({ sendEligible: null, reasonCodes: ["REPORT_ATTEMPT_GRANT_NOT_EVALUATED"] });
  });
  it.each(["false", "object", "reject"])("rejects a malformed %s source fence before any native attempt", async kind => {
    const report = await kit.accept();
    kit.source.assertCurrent = () => kind === "reject" ? Promise.reject(new Error("synthetic asynchronous denial")) : kind === "false" ? false : { allowed: false };
    await expect(kit.service.work(report.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_SYNCHRONOUS_FENCE_REQUIRED", executionCertainty: "notApplied" });
    expect(kit.state.calls).toHaveLength(0); expect(kit.db.prepare("SELECT COUNT(*) n FROM report_attempts").get()?.n).toBe(0);
  });
  it("does not accept a false quota fence as an exclusive source grant", async () => {
    const report = await kit.accept(); kit.source.assertGrant = () => false;
    await expect(kit.service.work(report.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_SYNCHRONOUS_FENCE_REQUIRED", executionCertainty: "notApplied" });
    expect(kit.state.calls).toHaveLength(0); expect(kit.db.prepare("SELECT COUNT(*) n FROM report_attempts").get()?.n).toBe(0);
  });
  it("rejects a receipt already owned by another report while preserving the exact recovery key", async () => {
    const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    const firstOutcome = kit.outcomes.get(kit.state.calls[0]!.requestKey) as Extract<ReportOutcome, { state: "applied" }>;
    const second = await kit.accept(kit.add(reportFixture(kit.now, "two")), "second-report");
    kit.state.ackOverride = outcome => outcome.state === "applied" ? { state: "applied", receipt: { ...outcome.receipt, messageTs: firstOutcome.receipt.messageTs } } : outcome;
    await expect(kit.service.work(second.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_NATIVE_RECEIPT_OWNED", executionCertainty: "uncertain" });
    expect((await kit.service.reconcile(second.reportRef, kit.machine)).executionCertainty).toBe("applied"); expect(kit.state.calls).toHaveLength(2);
  });
  it("cannot silently rotate the persisted scope key and duplicate a delivered logical report", async () => {
    const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    expect(() => createSlackReporting({ db: kit.db, scope: kit.scope, secret: "different-synthetic-private-test-key-000000000000", jobs: kit.jobs, source: kit.source, now: () => kit.now })).toThrow("REPORT_DURABLE_IDENTITY_MISMATCH");
    kit.reopen(); expect((await kit.accept(kit.locator, "after-restart")).reportRef).toBe(first.reportRef); expect(kit.state.calls).toHaveLength(1);
  });
  it("renders exact USD minor units across the accepted safe-integer boundary", () => {
    const snapshot = reportFixture(kit.now);
    for (const [minor, text] of [[0, "$0.00"], [1, "$0.01"], [1099, "$10.99"], [9007199254740990, "$90071992547409.90"], [Number.MAX_SAFE_INTEGER, "$90071992547409.91"]] as const) {
      snapshot.event.facts = [{ label: "amount", value: minor, unit: "USD-minor", missingReason: null }]; expect(formatReport(snapshot).body).toContain(`Amount: ${text}\n`);
    }
    snapshot.event.facts = [{ label: "amount", value: null, unit: "USD-minor", missingReason: "notApplicable" }]; expect(formatReport(snapshot).body).toContain("Amount: not applicable");
  });
  it("rejects a leading-zero native timestamp alias instead of assigning the same message to a second report", async () => {
    const first = await kit.accept(); await kit.service.work(first.reportRef, kit.machine);
    const original = kit.outcomes.get(kit.state.calls[0]!.requestKey) as Extract<ReportOutcome, { state: "applied" }>;
    const second = await kit.accept(kit.add(reportFixture(kit.now, "two")), "second-report");
    kit.state.ackOverride = outcome => outcome.state === "applied" ? { state: "applied", receipt: { ...outcome.receipt, messageTs: `0${original.receipt.messageTs}` } } : outcome;
    expect((await kit.service.work(second.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
    expect(kit.db.prepare("SELECT COUNT(*) n FROM report_native_receipts").get()?.n).toBe(1);
    const key = kit.state.calls[1]!.requestKey;
    expect((await kit.service.reconcile(second.reportRef, kit.machine)).executionCertainty).toBe("applied");
    expect(kit.state.lookups[0]!.requestKey).toBe(key); expect(kit.state.calls).toHaveLength(2); expect(kit.db.prepare("SELECT COUNT(*) n FROM report_native_receipts").get()?.n).toBe(2);
  });
});
