import { SCHEMA_VERSION, type ReadRequest, type ReadResponse, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError, type AdapterErrorBody } from "./errors";
import { MAX_OBSERVATIONS, ROUTE_LABEL, validateMediaUrl, validateObservation } from "@/features/acquisition/evidenceRules";
import type { EvidenceDraft, EvidenceRecord } from "@/features/acquisition/evidenceTypes";
import { DEMO_ACTOR_ROLE } from "@/fixtures/approvals";
import { seedEvidence } from "@/fixtures/evidence";
import { DEMO_NOW } from "@/fixtures/overview";

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

/**
 * In-memory stand-in for the evidence service. It saves versioned drafts and enforces what the real
 * server must: expected version, idempotency, field validation, and observations that can't be
 * re-attributed to other media. It has no "watched" state, so a save can never complete a review.
 */
export function createDemoEvidence() {
  const records = new Map(seedEvidence().map((r) => [r.evidenceRef, r]));
  const saves = new Map<string, { hash: string; result: Promise<SaveResourceResponse<EvidenceRecord>> }>();

  const apply = (request: SaveResourceRequest<EvidenceDraft>): SaveResourceResponse<EvidenceRecord> => {
    const rid = request.requestId;
    if (request.resourceKind !== "evidenceDraft") fail("VALIDATION_FAILED", "This isn't an evidence draft.", rid);
    const current = records.get(request.resourceRef ?? "");
    if (!current) return fail(request.resourceRef ? "RECORD_NOT_FOUND" : "VALIDATION_FAILED", request.resourceRef ? "This evidence record does not exist." : "Evidence records are created by the review job, not here.", rid);
    if (request.expectedVersion !== current.version) fail("STALE_VERSION", "This record changed. Reload it before saving.", rid, { currentVersion: current.version });

    const draft = request.payload;
    const fieldErrors: Record<string, string> = {};
    if (!(draft.checkoutRoute in ROUTE_LABEL)) fieldErrors.checkoutRoute = "Choose a checkout route.";
    const mediaUrl = draft.mediaUrl?.trim() || null;
    if (mediaUrl) {
      const error = validateMediaUrl(mediaUrl);
      if (error) fieldErrors.mediaUrl = error;
    }
    if (!Array.isArray(draft.observations) || draft.observations.length > MAX_OBSERVATIONS) fieldErrors.observations = `Keep it to ${MAX_OBSERVATIONS} observations.`;
    else {
      const stored = new Map(current.observations.map((o) => [o.id, o]));
      draft.observations.forEach((o, i) => {
        const errors = validateObservation(o);
        for (const [field, message] of Object.entries(errors)) fieldErrors[`observations.${i}.${field}`] = message;
        const prior = stored.get(o.id);
        // An observation belongs to the media it was recorded against. It can't be moved to other media.
        if (prior ? o.recordedAgainst !== prior.recordedAgainst : o.recordedAgainst !== mediaUrl) fieldErrors[`observations.${i}.recordedAgainst`] = "An observation is tied to the video it was recorded against.";
      });
    }
    if (Object.keys(fieldErrors).length) fail("VALIDATION_FAILED", "Fix the highlighted fields and save again.", rid, { fieldErrors });

    const next: EvidenceRecord = { ...current, mediaUrl, checkoutRoute: draft.checkoutRoute, observations: structuredClone(draft.observations).map((o) => ({ ...o, text: o.text.trim() })) };
    const same = JSON.stringify([next.mediaUrl, next.checkoutRoute, next.observations]) === JSON.stringify([current.mediaUrl, current.checkoutRoute, current.observations]);
    if (same) return respond(request, current, ["NO_CHANGE"]);
    next.version = `v${Number(current.version.slice(1)) + 1}`;
    next.savedAt = DEMO_NOW;
    next.reviewerRole = DEMO_ACTOR_ROLE;
    records.set(next.evidenceRef, next);
    return respond(request, next, []);
  };

  const respond = (request: SaveResourceRequest<EvidenceDraft>, record: EvidenceRecord, reasonCodes: string[]): SaveResourceResponse<EvidenceRecord> => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    resourceRef: record.evidenceRef,
    resourceVersion: record.version,
    persistedAt: record.savedAt ?? DEMO_NOW,
    persistedByRef: "demo-reviewer",
    record: structuredClone(record),
    reasonCodes,
  });

  return {
    read(request: ReadRequest<{ creatorId: string; evidenceId: string }>): ReadResponse<EvidenceRecord> {
      const record = records.get(request.filters.evidenceId) ?? fail("RECORD_NOT_FOUND", "This evidence record does not exist or was removed.", request.requestId);
      return respondWith(request, structuredClone(record), {
        dataVersion: record.version,
        capabilities: [
          { actionKind: "saveEvidenceDraft", state: "available", reasonCodes: [] },
          { actionKind: "markWatched", state: "unverified", reasonCodes: ["PLAYBACK_UNVERIFIED"] },
        ],
      });
    },
    /** Same key and payload returns the original result; the same key with a changed payload is refused. */
    save(request: SaveResourceRequest<EvidenceDraft>): Promise<SaveResourceResponse<EvidenceRecord>> {
      const hash = JSON.stringify([request.resourceKind, request.resourceRef, request.expectedVersion, request.payload]);
      const prior = saves.get(request.idempotencyKey);
      if (prior && prior.hash !== hash) return Promise.reject(new AdapterError({ code: "MANIFEST_CHANGED", message: "This save changed, so it needs a fresh review.", requestId: request.requestId, correlationId: `demo-${request.requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" }));
      if (prior) return prior.result;
      const result = Promise.resolve().then(() => apply(request));
      saves.set(request.idempotencyKey, { hash, result });
      result.catch(() => saves.delete(request.idempotencyKey));
      return result;
    },
  };
}
