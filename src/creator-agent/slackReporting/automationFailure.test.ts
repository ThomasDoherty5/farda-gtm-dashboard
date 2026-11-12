// @vitest-environment node
import { describe, expect, it } from "vitest";
import { automationFailureEvent } from "./automationFailure.ts";
import { createReportingTestkit, reportFixture, reportingScope as scope } from "./fixtures.testkit.ts";
import type { ReportEvent } from "./contract.ts";

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
      const exact = { ...failure, observedAt: new Date(kit.now).toISOString(), replay: { state: "uncertain" } };
      const event = automationFailureEvent(exact, binding, secret);
      const locator = kit.add({ ...reportFixture(kit.now), event });
      const record = await kit.accept(locator, "automation-failure");
      kit.state.mode = "lostAck";
      expect((await kit.service.work(record.reportRef, kit.machine)).executionCertainty).toBe("uncertain");
      expect((await kit.service.reconcile(record.reportRef, kit.machine)).executionCertainty).toBe("applied");
      const call = kit.state.calls[0]!;
      expect(call.body).toContain("Reconcile the original attempt before any retry.");
      expect(call.body).toContain("Execution failed");
      expect(call.body).toContain("<@USYNTHETIC>");
      expect(call.body).toMatch(/Zap [a-f0-9]{20} · job [a-f0-9]{20} · run [a-f0-9]{20} · item [a-f0-9]{20}/);
      expect(call.body).not.toContain("synthetic-private");
      expect(kit.state.lookups.map(command => command.requestKey)).toEqual([call.requestKey]);
      expect((await kit.accept(locator, "automation-failure-repeat")).reportRef).toBe(record.reportRef);
      expect(kit.state.calls).toHaveLength(1);

      kit.advance(1000);
      const recovery = automationFailureEvent({ ...exact, transition: "clear", sourceVersion: "synthetic-evidence-v2",
        observedAt: new Date(kit.now).toISOString(), replay: { state: "held" }, recoveryReceipt: "synthetic-native-recovery" }, binding, secret);
      const recoveryLocator = kit.add({ ...reportFixture(kit.now), event: recovery });
      const reply = await kit.accept(recoveryLocator, "automation-recovery");
      kit.state.mode = "applied";
      expect((await kit.service.work(reply.reportRef, kit.machine)).executionCertainty).toBe("applied");
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
    ["duplicateTrigger", "reviewDuplicateTrigger"],
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
});
