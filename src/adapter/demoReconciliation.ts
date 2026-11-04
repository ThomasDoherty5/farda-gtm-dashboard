import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError } from "./errors";
import { respondWith } from "./demoViews";
import { RECONCILIATION_NOW, seedReconciliation, type ReconciliationData } from "@/fixtures/reconciliation";

export type RepairPayload = { conflictId: string };

const fail = (code: string, message: string, requestId: string): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
};

/**
 * Stand-in for the reconciliation service. A repair request only moves a conflict to "repair requested", appends an audit entry
 * and returns an approval-pending answer. It never edits either system, and the audit list only ever grows.
 */
export function createDemoReconciliation() {
  const data: ReconciliationData = seedReconciliation();
  const results = new Map<string, ActionResponse>();
  const version = () => `rec${1 + data.audit.length - 3}`;

  return {
    handles: (request: ActionRequest<unknown>) => request.actionKind === "requestConflictRepair",
    read(request: ReadRequest<unknown>): ReadResponse<ReconciliationData> {
      const open = data.conflicts.filter((c) => c.state === "open").length;
      return respondWith(request, { ...structuredClone(data), version: version() }, {
        dataVersion: version(),
        capabilities: [{ actionKind: "requestConflictRepair", state: open > 0 ? "available" : "held", reasonCodes: open > 0 ? [] : ["NO_OPEN_CONFLICT"] }],
      });
    },
    submit(request: ActionRequest<RepairPayload>): ActionResponse {
      const prior = results.get(request.idempotencyKey);
      if (prior) return prior;
      if (request.expectedVersion !== version()) fail("STALE_VERSION", "The reconciliation changed. Reload it before requesting a repair.", request.requestId);
      const conflict = data.conflicts.find((c) => c.id === request.payload.conflictId) ?? fail("RECORD_NOT_FOUND", "This conflict does not exist.", request.requestId);
      if (conflict.state !== "open") fail("VALIDATION_FAILED", "A repair was already requested for this conflict.", request.requestId);
      conflict.state = "repairRequested";
      data.audit.push({
        id: `AUD-${String(data.audit.length + 1).padStart(3, "0")}`,
        at: RECONCILIATION_NOW,
        actor: "Demo operator",
        action: "Repair requested",
        subject: conflict.id,
        detail: `${conflict.proposal} Waiting for approval; nothing was changed in either system.`,
      });
      const response: ActionResponse = {
        schemaVersion: SCHEMA_VERSION,
        requestId: request.requestId,
        scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
        actionRef: `demo-repair-${conflict.id}`,
        state: "approvalPending",
        runRef: null,
        approvalRef: null,
        manifestRef: null,
        payloadVersion: version(),
        policyVersion: "demo-policy-1",
        modelVersion: null,
        offerVersion: null,
        reasonCodes: ["AWAITING_APPROVAL"],
        receiptRefs: [],
        nextAction: { kind: "decideApproval", ownerRef: "founder", dueAt: null, available: false },
        nextPollAfterMs: null,
      };
      results.set(request.idempotencyKey, response);
      return response;
    },
  };
}
