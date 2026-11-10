import { digest } from "../config.ts";
import type { RuntimeExecutor, RuntimeStep } from "../jobs/runtimeSchema.ts";
import type { VideoEvidenceCollector } from "./collector.ts";
import { VideoEvidenceError } from "./ledger.ts";

/** The executor reference a future J20 registration would name. Nothing in this module registers it. */
export const J20_EXECUTOR_REF = "j20-video-evidence.v1";

/**
 * A J20 runtime executor shaped to the existing registration types (family "J20", daily calendar, observe mode).
 * The job input is loaded server-side from the item's subject reference; it is never taken from a source response.
 * Login and MFA hand over to a person, denial holds, a transient outage retries, and a cursor resumes from the last committed post.
 */
export function createVideoEvidenceExecutor(options: {
  collector: VideoEvidenceCollector;
  loadInput(subjectRef: string): Promise<unknown>;
  ownerRef: string;
  handoffRef: string;
  retryAfterMs?: number;
  /** The runtime grants one source-quota unit per work step, so one source call per step by default. */
  callsPerStep?: number;
}): RuntimeExecutor {
  return {
    mode: "observe",
    execute: async (context): Promise<RuntimeStep> => {
      context.assertCurrent();
      const input = await options.loadInput(context.subjectRef);
      const channel = context.binding.route === "browser" ? "browser" : context.registration.apiChannel;
      let step;
      try {
        step = await options.collector.collect(input, { cursor: context.cursor, maxRecords: context.maxRecords, maxCalls: options.callsPerStep ?? 1, runKey: `${context.runRef}:${context.itemRef}`,
          invoke: (operation) => context.invoke(channel, operation) });
      } catch (error) {
        if (error instanceof VideoEvidenceError && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code)) return { state: "held", reasonCode: error.code };
        throw error;
      }
      context.assertCurrent();
      const evidenceRefs = [...new Set(step.receipts.map((r) => r.evidenceRef))].slice(0, Math.min(100, step.recordCount));
      if (step.state === "completed")
        return { state: "completed", evidenceRefs, recordCount: step.recordCount, sourceReceiptRef: `j20-run:${digest({ run: context.runRef, item: context.itemRef, refs: step.output.evidenceRecordRefs })}` };
      if (step.state === "checkpoint")
        return { state: "checkpoint", evidenceRefs, recordCount: step.recordCount, nextCursor: step.nextCursor, sourceReceiptRef: `j20-run:${digest({ run: context.runRef, cursor: step.nextCursor })}` };
      const failure = step.failure;
      if (failure.state === "loginRequired" || failure.state === "mfaRequired")
        return { state: "takeover", kind: failure.state === "loginRequired" ? "login" : "mfa", handoffRef: options.handoffRef, ownerRef: options.ownerRef, reasonCode: failure.reason_code };
      if (failure.state === "permissionDenied") return { state: "held", reasonCode: failure.reason_code };
      return { state: "retry", reasonCode: failure.reason_code, retryAfterMs: options.retryAfterMs ?? 60_000 };
    },
  };
}
