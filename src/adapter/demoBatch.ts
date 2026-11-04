import { SCHEMA_VERSION, certaintyOfState, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError } from "./errors";
import { respondWith } from "./demoViews";
import { BATCH_ID, DEFAULT_BATCH_FILTERS, heldReasons, isUnsent, seedItems, type BatchData, type BatchItem } from "@/fixtures/batch";
import { OWNERS } from "@/fixtures/creators";

const fail = (code: string, message: string, requestId: string): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
};

export type CancelPayload = { batchId: string; itemIds?: string[] };

/**
 * In-memory stand-in for the batch service. Pause and cancel touch unsent items only: confirmed, running,
 * reconciling and login-blocked items are excluded and report why. Same key returns the first result.
 * It contacts no provider and resets on reload.
 */
export function createDemoBatch() {
  let items: BatchItem[] = seedItems();
  let paused = false;
  let version = 1;
  const results = new Map<string, ActionResponse>();

  const versionLabel = () => `batch-v${version}`;
  const response = (request: ActionRequest<unknown>, state: ActionResponse["state"], reasonCodes: string[]): ActionResponse => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `demo-action-${request.idempotencyKey}`,
    state,
    runRef: null,
    approvalRef: request.approvalRef,
    manifestRef: request.manifestRef,
    payloadVersion: versionLabel(),
    policyVersion: "commission-only@demo",
    modelVersion: null,
    offerVersion: null,
    reasonCodes,
    receiptRefs: [],
    nextAction: null,
    nextPollAfterMs: null,
    executionCertainty: certaintyOfState(state),
  });

  return {
    read(request: ReadRequest<unknown>): ReadResponse<BatchData> {
      const { batchId, ...f } = (request.filters ?? {}) as Partial<BatchData["filters"]> & { batchId?: string };
      if (batchId !== undefined && batchId !== BATCH_ID) fail("RECORD_NOT_FOUND", "This batch does not exist or was removed.", request.requestId);
      const filters = { ...DEFAULT_BATCH_FILTERS, ...f };
      if (!["tiktok", "all"].includes(filters.source)) fail("VALIDATION_FAILED", "source must be tiktok or all.", request.requestId);
      if (!["affiliate", "all"].includes(filters.deal)) fail("VALIDATION_FAILED", "deal must be affiliate or all.", request.requestId);
      if (filters.owner !== "all" && !(OWNERS as readonly string[]).includes(filters.owner)) fail("VALIDATION_FAILED", "owner must be all or a known owner.", request.requestId);
      const unsent = items.filter((i) => isUnsent(i.state)).length;
      const data: BatchData = {
        datasetKey: "batch-demo",
        batchId: BATCH_ID,
        version: versionLabel(),
        paused,
        items: structuredClone(items),
        held: heldReasons,
        filters,
        model: { label: "current v3 pending", status: "pending" },
        capacity: { nativeInvitations: 24, sampleUnits: 12, sampleCostMinor: 30_000, collaborationSlots: null },
      };
      return respondWith(request, data, {
        dataVersion: versionLabel(),
        capabilities: [
          { actionKind: "pauseBatch", state: paused ? "held" : unsent > 0 ? "available" : "held", reasonCodes: paused ? ["ALREADY_PAUSED"] : unsent > 0 ? [] : ["NOTHING_TO_PAUSE"] },
          { actionKind: "cancelUnsent", state: unsent > 0 ? "available" : "held", reasonCodes: unsent > 0 ? [] : ["NOTHING_TO_CANCEL"] },
        ],
      });
    },
    async submit(request: ActionRequest<unknown>): Promise<ActionResponse> {
      const prior = results.get(request.idempotencyKey);
      if (prior) return prior;
      if (request.expectedVersion !== versionLabel()) fail("STALE_VERSION", "This batch changed since you opened it. Reload to see the current state.", request.requestId);
      let result: ActionResponse;
      if (request.actionKind === "pauseBatch") {
        const queued = items.filter((i) => i.state === "queued");
        if (queued.length === 0 && paused) fail("VALIDATION_FAILED", "New work is already paused.", request.requestId);
        items = items.map((i) => (i.state === "queued" ? { ...i, state: "paused" as const } : i));
        paused = true;
        version += 1;
        result = response(request, "paused", ["IN_FLIGHT_DRAINS"]);
      } else if (request.actionKind === "cancelUnsent") {
        const { itemIds } = (request.payload ?? {}) as CancelPayload;
        const selected = items.filter((i) => !itemIds || itemIds.includes(i.id));
        const eligible = selected.filter((i) => isUnsent(i.state));
        if (eligible.length === 0) fail("VALIDATION_FAILED", "None of the selected items is unsent, so there is nothing to cancel.", request.requestId);
        const ids = new Set(eligible.map((i) => i.id));
        items = items.map((i) => (ids.has(i.id) ? { ...i, state: "canceled" as const } : i));
        version += 1;
        result = response(request, selected.length === eligible.length ? "canceled" : "partiallySucceeded", selected.length === eligible.length ? [] : ["SENT_OR_RUNNING_EXCLUDED"]);
      } else {
        throw new AdapterError({ code: "INTEGRATION_PENDING", message: `No demo behavior for ${request.actionKind}.`, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      }
      results.set(request.idempotencyKey, result);
      return result;
    },
  };
}
