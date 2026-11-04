import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { AdapterError } from "./errors";
import { discoveryDemo } from "@/fixtures/discovery";

export type BatchApprovalPayload = { batchId: string; recipients: number; rateLabel: string; sampleUnits: number; sampleUnitCostMinor: number; upfrontFeeMinor: number; policyVersion: string };
export const DISCOVERY_VERSION = "discovery-demo@1";

const fail = (code: string, message: string, requestId: string, fieldErrors?: Record<string, string>): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...(fieldErrors ? { fieldErrors } : {}) });
};

/**
 * Stand-in for the approval service on the daily plan. It accepts an approval request for exactly the plan's batch and
 * answers "approval pending". It never approves, sends or reserves anything, and the same key returns the first result.
 */
export function createDemoDiscovery() {
  const results = new Map<string, { hash: string; response: ActionResponse }>();
  return {
    handles: (request: ActionRequest<unknown>) => request.actionKind === "requestBatchApproval",
    submit(request: ActionRequest<BatchApprovalPayload>): ActionResponse {
      const hash = JSON.stringify([request.expectedVersion, request.payload]);
      const prior = results.get(request.idempotencyKey);
      if (prior && prior.hash !== hash) fail("MANIFEST_CHANGED", "This request changed, so it needs a fresh review.", request.requestId);
      if (prior) return prior.response;
      if (request.expectedVersion !== DISCOVERY_VERSION) fail("STALE_VERSION", "The plan changed. Reload it before requesting approval.", request.requestId);
      const p = request.payload;
      const { batch } = discoveryDemo;
      if (p.upfrontFeeMinor !== 0) fail("POLICY_VIOLATION", "New acquisition is commission-only, so an upfront fee can't be requested.", request.requestId, { upfrontFee: "Upfront fee must be zero for new acquisition." });
      if (p.batchId !== batch.batchId) fail("RECORD_NOT_FOUND", "This batch does not exist.", request.requestId);
      if (!Number.isInteger(p.recipients) || p.recipients <= 0 || p.recipients > batch.eligible) fail("VALIDATION_FAILED", `The request must name between 1 and ${batch.eligible} eligible recipients. Open-ended batches are refused.`, request.requestId, { recipients: "Name a finite number of eligible recipients." });
      const response: ActionResponse = {
        schemaVersion: SCHEMA_VERSION,
        requestId: request.requestId,
        scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
        actionRef: `demo-action-${request.idempotencyKey}`,
        state: "approvalPending",
        runRef: null,
        approvalRef: "demo-approval-batch-024",
        manifestRef: `demo-manifest-${p.batchId}-${p.recipients}`,
        payloadVersion: "batch-approval-v1",
        policyVersion: p.policyVersion,
        modelVersion: null,
        offerVersion: null,
        reasonCodes: ["AWAITING_DECISION"],
        receiptRefs: [],
        nextAction: { kind: "decideApproval", ownerRef: "Thomas", dueAt: null, available: false },
        nextPollAfterMs: null,
      };
      results.set(request.idempotencyKey, { hash, response });
      return response;
    },
  };
}
