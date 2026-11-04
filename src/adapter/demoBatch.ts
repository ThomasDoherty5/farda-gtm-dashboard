import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError } from "./errors";
import { respondWith } from "./demoViews";
import { BATCH_ID, DEFAULT_BATCH_FILTERS, heldReasons, isUnsent, seedItems, seedSamples, type BatchData, type BatchItem, type SampleRequest } from "@/fixtures/batch";
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
  let samples: SampleRequest[] = seedSamples();
  let paused = false;
  let version = 1;
  const results = new Map<string, { hash: string; response: ActionResponse }>();

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
        samples: structuredClone(samples),
        filters,
        model: { label: "current v3 pending", status: "pending" },
        capacity: { nativeInvitations: 24, sampleUnits: 12, sampleCostMinor: 30_000, collaborationSlots: null },
      };
      return respondWith(request, data, {
        dataVersion: versionLabel(),
        capabilities: [
          { actionKind: "pauseBatch", state: paused ? "held" : unsent > 0 ? "available" : "held", reasonCodes: paused ? ["ALREADY_PAUSED"] : unsent > 0 ? [] : ["NOTHING_TO_PAUSE"] },
          { actionKind: "cancelUnsent", state: unsent > 0 ? "available" : "held", reasonCodes: unsent > 0 ? [] : ["NOTHING_TO_CANCEL"] },
          { actionKind: "decideTikTokSample", state: "available", reasonCodes: [] },
        ],
      });
    },
    async submit(request: ActionRequest<unknown>): Promise<ActionResponse> {
      // A key names one logical action. Replaying it with a changed payload or version is a different request, never the first result.
      const hash = JSON.stringify([request.actionKind, request.expectedVersion, request.payload ?? null]);
      const prior = results.get(request.idempotencyKey);
      if (prior && prior.hash !== hash) fail("MANIFEST_CHANGED", "This request changed since the key was first used, so it needs a fresh review.", request.requestId);
      if (prior) return prior.response;
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
      } else if (request.actionKind === "decideTikTokSample") {
        const { sampleId, decision } = (request.payload ?? {}) as { batchId: string; sampleId: string; decision: "approve" | "decline" };
        const sample = samples.find((s) => s.id === sampleId) ?? fail("RECORD_NOT_FOUND", "This sample request does not exist.", request.requestId);
        if (decision !== "approve" && decision !== "decline") fail("VALIDATION_FAILED", "The decision must be approve or decline.", request.requestId);
        if (sample.state !== "pending") fail("VALIDATION_FAILED", "This sample request was already handled.", request.requestId);
        if (sample.route === "authorityDenied") {
          // TikTok refuses this account's scope. Nothing was decided; a named owner takes it over.
          samples = samples.map((s) => (s.id === sampleId ? { ...s, state: "handoff" as const, ownerRef: "Operations" } : s));
          version += 1;
          result = { ...response(request, "blocked", ["SOURCE_AUTHORITY_DENIED"]), nextAction: { kind: "ownerHandoff", ownerRef: "Operations", dueAt: null, available: true } };
        } else {
          const receiptRef = `demo-tiktok-sample-receipt-${sample.id}`;
          samples = samples.map((s) => (s.id === sampleId ? { ...s, state: decision === "approve" ? ("approved" as const) : ("declined" as const), receiptRef } : s));
          version += 1;
          result = { ...response(request, "succeeded", []), receiptRefs: [receiptRef] };
        }
      } else {
        throw new AdapterError({ code: "INTEGRATION_PENDING", message: `No demo behavior for ${request.actionKind}.`, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      }
      results.set(request.idempotencyKey, { hash, response: result });
      return result;
    },
  };
}
