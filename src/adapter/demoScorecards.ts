import { SCHEMA_VERSION, type ReadRequest, type ReadResponse, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError, type AdapterErrorBody } from "./errors";
import {
  DEMO_ASSESSMENT_CONTENT_ID,
  DEMO_ASSESSMENT_SC_ID,
  DEMO_ASSESSMENT_TIKTOK_ID,
  commerceScorecard,
  contentScorecard,
  offerDraftSeed,
  tiktokScorecard,
  type CommerceScorecardRecord,
  type OfferDraftPayload,
  type OfferDraftRecord,
  type ScorecardRecord,
} from "@/fixtures/scorecards";
import { DEMO_NOW, type OverviewFixtureKey } from "@/fixtures/overview";

export type AssessmentData = ScorecardRecord | CommerceScorecardRecord;
const ASSESSMENTS: Record<string, AssessmentData> = {
  [DEMO_ASSESSMENT_CONTENT_ID]: contentScorecard,
  [DEMO_ASSESSMENT_TIKTOK_ID]: tiktokScorecard,
  [DEMO_ASSESSMENT_SC_ID]: commerceScorecard,
};

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: code === "SOURCE_UNAVAILABLE", retryAfterMs: null, ...extra });
};

/** The same fixture switches as the Overview: offline, denied and expired sessions fail the read; the rest change the state label. */
function gate(fixture: OverviewFixtureKey, requestId: string) {
  if (fixture === "FX-07-offline-read") fail("SOURCE_UNAVAILABLE", "The data service could not be reached.", requestId);
  if (fixture === "FX-08-forbidden-account") fail("FORBIDDEN", "You do not have access to this account.", requestId);
  if (fixture === "FX-09-expired-session") fail("SESSION_EXPIRED", "Your session expired. Sign in again.", requestId);
}

/** A missing-metric fixture drops one rating, so the scorecard shows Needs data instead of a rescaled total. */
function dropRating(record: AssessmentData): AssessmentData {
  return { ...record, criteria: record.criteria.map((c, i) => (i === 2 ? { ...c, rating: null } : c)) } as AssessmentData;
}

export function readAssessment<T>(request: ReadRequest<{ creatorId: string; assessmentId: string }>, fixture: OverviewFixtureKey): ReadResponse<T> {
  gate(fixture, request.requestId);
  const record = ASSESSMENTS[request.filters.assessmentId] ?? fail("RECORD_NOT_FOUND", "This assessment does not exist or was removed.", request.requestId);
  if (fixture === "FX-03-empty-filter") return { ...respondWith(request, null as unknown, { dataVersion: "assessment-demo@1", dataState: "empty" }) } as ReadResponse<T>;
  const data = fixture === "FX-04-missing-metric" ? dropRating(record) : record;
  return respondWith(request, structuredClone(data), {
    dataVersion: `${record.assessmentId}@v2`,
    dataState: fixture === "FX-06-stale-source" ? "stale" : "ready",
    capabilities: [{ actionKind: "holdCandidate", state: "held", reasonCodes: ["HISTORICAL_SNAPSHOT"] }],
  }) as ReadResponse<T>;
}

/** In-memory stand-in for the offer service. It enforces what the real server must: commission-only terms, supported compensation and the expected version. */
export function createDemoOffers() {
  const records = new Map<string, OfferDraftRecord>([[offerDraftSeed.offerId, structuredClone(offerDraftSeed)]]);
  const saves = new Map<string, { hash: string; result: Promise<SaveResourceResponse<OfferDraftRecord>> }>();

  const apply = (request: SaveResourceRequest<OfferDraftPayload>): SaveResourceResponse<OfferDraftRecord> => {
    const rid = request.requestId;
    const current = records.get(request.resourceRef ?? "") ?? fail("RECORD_NOT_FOUND", "This offer does not exist.", rid, { executionCertainty: "notApplied" });
    if (request.expectedVersion !== current.version) fail("STALE_VERSION", "This offer changed. Reload it before saving.", rid, { currentVersion: current.version, executionCertainty: "notApplied" });
    const p = request.payload;
    const fieldErrors: Record<string, string> = {};
    if (p.upfrontFeeMinor !== 0) fieldErrors.upfrontFee = "New guaranteed or upfront content fees are not permitted.";
    if (p.compensation !== "percentage") fieldErrors.compensation = "Fixed per qualified sale needs a verified compatible provider.";
    if (!(p.commissionPct > 0 && p.commissionPct <= 100)) fieldErrors.commission = "The percentage must be above 0 and at most 100.";
    if (!Number.isInteger(p.sampleShippingMinor) || p.sampleShippingMinor < 0) fieldErrors.sample = "Enter a non-negative amount.";
    if (Object.keys(fieldErrors).length) fail("POLICY_VIOLATION", "Fix the highlighted terms and save again.", rid, { fieldErrors, executionCertainty: "notApplied" });
    const same = JSON.stringify(p) === JSON.stringify(current.payload);
    const next: OfferDraftRecord = same ? current : { ...current, payload: structuredClone(p), version: `v${Number(current.version.slice(1)) + 1}`, savedAt: DEMO_NOW };
    records.set(next.offerId, next);
    return {
      schemaVersion: SCHEMA_VERSION,
      requestId: rid,
      scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
      resourceRef: next.offerId,
      resourceVersion: next.version,
      persistedAt: next.savedAt ?? DEMO_NOW,
      persistedByRef: "demo-offer-owner",
      record: structuredClone(next),
      reasonCodes: same ? ["NO_CHANGE"] : [],
      executionCertainty: "applied",
    };
  };

  return {
    read<T>(request: ReadRequest<{ offerId: string }>, fixture: OverviewFixtureKey): ReadResponse<T> {
      gate(fixture, request.requestId);
      const record = records.get(request.filters.offerId) ?? fail("RECORD_NOT_FOUND", "This offer does not exist or was removed.", request.requestId);
      return respondWith(request, structuredClone(record), {
        dataVersion: record.version,
        capabilities: [
          { actionKind: "saveOfferDraft", state: "available", reasonCodes: [] },
          { actionKind: "activateOffer", state: "unverified", reasonCodes: ["APPROVAL_REQUIRED", "PROVIDER_ACCESS_UNVERIFIED"] },
        ],
      }) as ReadResponse<T>;
    },
    /** Same key and payload returns the original result; the same key with a changed payload is refused. */
    save(request: SaveResourceRequest<OfferDraftPayload>): Promise<SaveResourceResponse<OfferDraftRecord>> {
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
