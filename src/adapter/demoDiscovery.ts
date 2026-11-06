import { certaintyOfState, SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "./contract";
import { AdapterError } from "./errors";
import { discoveryCommission, discoveryDemo } from "@/fixtures/discovery";
import { BASE_POLICY, evaluateTerms, type PolicyConfig } from "./commissionPolicy";

export type BatchApprovalPayload = { batchId: string; recipients: number; rateLabel: string; sampleUnits: number; sampleUnitCostMinor: number; upfrontFeeMinor: number; policyVersion: string };
export const DISCOVERY_VERSION = "discovery-demo@1";

const fail = (code: string, message: string, requestId: string, fieldErrors?: Record<string, string>): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...(fieldErrors ? { fieldErrors } : {}) });
};

const usd = (minor: number) => `$${(minor / 100).toFixed(2)}`;

/** A short, stable digest for deriving demo references. Not a security primitive. */
function digest(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    a = Math.imul(a ^ text.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b + text.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const manifestFields = new Set(["batchId", "recipients", "rateLabel", "sampleUnits", "sampleUnitCostMinor", "upfrontFeeMinor", "policyVersion"]);

/** Rejects a payload that is not shaped like a manifest, whatever its values mean. The client is never trusted for the shape either. */
function shape(p: BatchApprovalPayload, requestId: string): void {
  const bad: Record<string, string> = {};
  if (Object.keys(p ?? {}).some(key => !manifestFields.has(key))) bad.terms = "Use only the terms named in this finite plan.";
  if (typeof p?.batchId !== "string" || p.batchId === "") bad.batchId = "Name the batch.";
  if (!Number.isSafeInteger(p?.recipients)) bad.recipients = "Name a finite number of eligible recipients.";
  if (typeof p?.rateLabel !== "string") bad.rateLabel = "State the commission terms as text.";
  if (!isCount(p?.sampleUnits)) bad.sampleUnits = "Sample units must be a whole, non-negative number.";
  if (!isCount(p?.sampleUnitCostMinor)) bad.sampleUnitCostMinor = "Sample unit cost must be whole, non-negative minor units.";
  if (typeof p?.upfrontFeeMinor !== "number" || !Number.isFinite(p.upfrontFeeMinor)) bad.upfrontFee = "Upfront fee must be a number, and zero for new acquisition.";
  if (typeof p?.policyVersion !== "string" || p.policyVersion === "") bad.policyVersion = "Name the policy version the request was built on.";
  if (Object.keys(bad).length > 0) fail("VALIDATION_FAILED", "The approval request is not a complete manifest.", requestId, bad);
}

/** The label selects this exact plan. It is never parsed into terms or used as proof of acceptance. */
function termViolations(p: BatchApprovalPayload, policy: PolicyConfig): Record<string, string> {
  const { batch } = discoveryDemo;
  const out: Record<string, string> = {};
  if (p.rateLabel !== batch.rateLabel) out.rateLabel = `The commission must match the plan: ${batch.rateLabel}.`;
  const eligibility = evaluateTerms({
    ...discoveryCommission, upfrontFeeMinor: p.upfrontFeeMinor,
    sampleCostMinor: p.sampleUnits > 0 ? p.sampleUnitCostMinor : 0,
  }, policy);
  for (const blocker of eligibility.blockers) {
    const field = blocker.field === "sample" ? "sampleUnitCostMinor" : blocker.field === "commission" ? "rateLabel" : blocker.field;
    out[field] ??= blocker.message;
  }
  if (p.sampleUnits > batch.sampleUnits) out.sampleUnits = `At most ${batch.sampleUnits} sample units are approved for this plan.`;
  if (p.sampleUnitCostMinor > batch.sampleUnitCost.minorUnits) out.sampleUnitCostMinor = `A sample unit may cost at most ${usd(batch.sampleUnitCost.minorUnits)} under this plan.`;
  return out;
}

/**
 * Stand-in for the approval service on the daily plan. It accepts an approval request for exactly the plan's batch and
 * answers "approval pending". It never approves, sends or reserves anything, and the same key returns the first result.
 */
export function createDemoDiscovery(currentPolicy: () => PolicyConfig = () => BASE_POLICY) {
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
      const config = currentPolicy();
      const policy = config.version;
      shape(p, request.requestId);
      if (p.policyVersion !== policy)
        fail("STALE_VERSION", `The policy changed. The plan proposes ${batch.rateLabel}. Current policy ${policy} allows up to ${config.maxCommissionPct}% commission, no upfront fee and at most ${usd(config.sampleCapMinor)} per sample. This request used ${p.policyVersion}. Review the current terms and ask again.`, request.requestId, { policyVersion: `Current policy is ${policy}; this request used ${p.policyVersion}.` });
      if (p.batchId !== batch.batchId) fail("RECORD_NOT_FOUND", "This batch does not exist.", request.requestId);
      if (p.recipients <= 0 || p.recipients > batch.eligible) fail("VALIDATION_FAILED", `The request must name between 1 and ${batch.eligible} eligible recipients. Open-ended batches are refused.`, request.requestId, { recipients: "Name a finite number of eligible recipients." });
      const violations = termViolations(p, config);
      if (Object.keys(violations).length > 0) fail("POLICY_VIOLATION", "These terms are outside the current commission-only policy.", request.requestId, violations);
      const manifest = JSON.stringify([p.batchId, p.recipients, p.rateLabel, p.sampleUnits, p.sampleUnitCostMinor, p.upfrontFeeMinor, p.policyVersion]);
      const response: ActionResponse = {
        schemaVersion: SCHEMA_VERSION,
        requestId: request.requestId,
        scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
        actionRef: `demo-action-${request.idempotencyKey}`,
        state: "approvalPending",
        runRef: null,
        approvalRef: `demo-approval-batch-${digest(`${manifest}|${request.idempotencyKey}`)}`,
        manifestRef: `demo-manifest-${digest(manifest)}`,
        payloadVersion: "batch-approval-v1",
        policyVersion: policy,
        modelVersion: null,
        offerVersion: null,
        reasonCodes: ["AWAITING_DECISION"],
        executionCertainty: certaintyOfState("approvalPending"),
        receiptRefs: [],
        nextAction: { kind: "decideApproval", ownerRef: "Thomas", dueAt: null, available: false },
        nextPollAfterMs: null,
      };
      results.set(request.idempotencyKey, { hash, response });
      return response;
    },
  };
}
