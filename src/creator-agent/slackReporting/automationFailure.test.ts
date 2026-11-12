// @vitest-environment node
import { describe, expect, it } from "vitest";
import { automationFailureEvent, bindAutomationFailureReporting, inspectAutomationTriggerOverlap } from "./automationFailure.ts";
import { createReportingTestkit, reportFixture, reportingScope as scope } from "./fixtures.testkit.ts";
import { ReportError, type ReportEvent, type ReportSnapshot } from "./contract.ts";
import { createSlackReporting } from "./service.ts";

const secret = "synthetic-automation-failure-key-000000000000";
const observedAt = "2026-11-08T10:00:00.000Z";
const binding: Pick<ReportEvent, "producerRef" | "link"> = {
  producerRef: "producer:synthetic-shipment",
  link: { kind: "linear", workspaceSlug: "synthetic", issueIdentifier: "EXAMPLE-1", authorizationRef: "synthetic-linear-evidence" },
};
const failure = {
  scope, observedAt, sourceVersion: "synthetic-evidence-v1", zapRef: "synthetic-private-zap",
  jobRef: "synthetic-private-job", runRef: "synthetic-private-run", itemRef: "synthetic-private-item",
  originalAttemptRef: "synthetic-private-attempt", checkpointRef: "synthetic-private-checkpoint",
  terminalFailureReceipt: "synthetic-private-failure", transition: "breach", errorClass: "executionFailure", replay: { state: "safeRead" },
};

describe("automation failure reports", () => {
  it("routes one safe root alert and its recovery through the existing reporter and original thread", async () => {
    const kit = createReportingTestkit();
    try {
      let readable = true;
      const evidenceByVersion = new Map<string, { evidence: unknown; delivery: Omit<ReportSnapshot, "event"> }>();
      const source = bindAutomationFailureReporting(kit.source, scope, secret, {
        event: binding,
        async read(locator) {
          const result = evidenceByVersion.get(locator.eventVersion);
          if (!result) throw new ReportError("REPORT_EVENT_MISMATCH");
          return result;
        },
        assertCurrent(snapshot) {
          if (!readable || !evidenceByVersion.has(snapshot.event.eventVersion)) throw new ReportError("REPORT_PERMISSION_DENIED", 403);
        },
      });
      const service = createSlackReporting({ db: kit.db, scope, secret: kit.secret, jobs: kit.jobs, source, now: () => kit.now });
      function add(evidence: unknown) {
        const { event: template, ...delivery } = reportFixture(kit.now);
        expect(template.producerRef).toBe(binding.producerRef);
        const event = automationFailureEvent(evidence, binding, secret);
        evidenceByVersion.set(event.eventVersion, { evidence, delivery });
        return kit.add({ ...delivery, event });
      }
      const exact = { ...failure, observedAt: new Date(kit.now).toISOString(), replay: { state: "uncertain" } };
      const locator = add(exact);
      const record = await service.accept(locator, "automation-failure", kit.machine);
      readable = false;
      await expect(service.work(record.reportRef, kit.machine)).rejects.toMatchObject({ code: "REPORT_PERMISSION_DENIED" });
      expect(kit.state.calls).toHaveLength(0);
      readable = true;
      kit.state.mode = "lostAck";
      expect((await service.work(record.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
      expect((await service.reconcile(record.reportRef, kit.machine)).executionCertainty).toBe("applied");
      const call = kit.state.calls[0]!;
      expect(call.body).toContain("Reconcile the original attempt before any retry.");
      expect(call.body).toContain("Execution failed");
      expect(call.body).toContain("<@USYNTHETIC>");
      expect(call.body).toMatch(/Zap [a-f0-9]{20} · job [a-f0-9]{20} · run [a-f0-9]{20} · item [a-f0-9]{20}/);
      expect(call.body).not.toContain("synthetic-private");
      expect(kit.state.lookups.map(command => command.requestKey)).toEqual([call.requestKey]);
      expect((await service.accept(locator, "automation-failure-repeat", kit.machine)).reportRef).toBe(record.reportRef);
      expect(kit.state.calls).toHaveLength(1);

      kit.advance(1000);
      const recoveryLocator = add({ ...exact, transition: "clear", sourceVersion: "synthetic-evidence-v2",
        observedAt: new Date(kit.now).toISOString(), replay: { state: "held" }, recoveryReceipt: "synthetic-native-recovery" });
      const reply = await service.accept(recoveryLocator, "automation-recovery", kit.machine);
      kit.state.mode = "applied";
      expect((await service.work(reply.reportRef, kit.machine)).executionCertainty).toBe("applied");
      expect(kit.state.calls).toHaveLength(2);
      const first = kit.outcomes.get(call.requestKey);
      expect(first?.state).toBe("applied");
      if (first?.state === "applied") expect(kit.state.calls[1]!.threadTs).toBe(first.receipt.messageTs);
      expect(kit.state.calls[1]!.body).toContain("Source recovery confirmed.");
    } finally {
      kit.close();
    }
  });

  it.each([
    ["permissionLost", "restoreAccess"],
    ["tasksExhausted", "waitForTasks"],
    ["rateLimited", "waitForRateLimit"],
    ["invalidConfiguration", "fixConfiguration"],
    ["executionFailure", "retryVerifiedCheckpoint"],
    ["unknownOutcome", "reconcileOriginal"],
  ])("projects %s as %s from typed evidence", (errorClass, expected) => {
    expect(automationFailureEvent({ ...failure, errorClass }, binding, secret).automationFailure?.recovery).toBe(expected);
  });

  it("holds an unverified checkpoint or original outcome and rejects raw error data", () => {
    expect(automationFailureEvent({ ...failure, checkpointRef: null }, binding, secret).automationFailure?.recovery).toBe("reviewRun");
    expect(automationFailureEvent({ ...failure, replay: { state: "held" } }, binding, secret).automationFailure?.recovery).toBe("reviewRun");
    expect(() => automationFailureEvent({ ...failure, rawError: "synthetic private payload" }, binding, secret)).toThrow();
    expect(() => automationFailureEvent({ ...failure, transition: "clear", recoveryReceipt: "synthetic-recovery",
      replay: { state: "uncertain" } }, binding, secret)).toThrow("AUTOMATION_RECOVERY_UNVERIFIED");
  });

  it("detects two successful runs of the same adopted migration window and holds unqualified coverage", () => {
    const old = { ref: "old-trigger", version: "v1" }, replacement = { ref: "new-trigger", version: "v2" };
    const base = { scope, jobRef: "synthetic-same-job", windowRef: "synthetic-canonical-window" };
    const previous = { ...base, trigger: old, runRef: "synthetic-old-run", receiptRef: "synthetic-old-receipt", outcome: "succeeded", observedAt };
    const next = { ...base, trigger: replacement, runRef: "synthetic-new-run", receiptRef: "synthetic-new-receipt", outcome: "succeeded", observedAt };
    const evidence = { ...base, old, replacement, coverage: "complete", coverageReceipt: "synthetic-coverage", reads: [previous, next, previous] };
    expect(inspectAutomationTriggerOverlap(evidence)).toMatchObject({ state: "duplicate", original: previous, replacement: next });
    expect(inspectAutomationTriggerOverlap({ ...evidence, coverage: "partial" })).toEqual({ state: "unknown" });
    expect(inspectAutomationTriggerOverlap({ ...evidence, reads: [previous, { ...next, windowRef: "different-window" }] })).toEqual({ state: "unknown" });
    expect(inspectAutomationTriggerOverlap({ ...evidence, reads: [previous, { ...next, runRef: previous.runRef }] })).toEqual({ state: "unknown" });
    expect(inspectAutomationTriggerOverlap({ ...evidence, reads: [next] })).toEqual({ state: "noOverlap" });
    const duplicate = { ...failure, jobRef: base.jobRef, runRef: next.runRef, errorClass: "duplicateTrigger", replay: { state: "uncertain" } };
    expect(() => automationFailureEvent(duplicate, binding, secret)).toThrow("AUTOMATION_DUPLICATE_TRIGGER_UNVERIFIED");
    expect(automationFailureEvent({ ...duplicate, migration: evidence }, binding, secret).automationFailure?.recovery).toBe("reviewDuplicateTrigger");
  });
});
