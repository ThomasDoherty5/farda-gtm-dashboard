import type { CollaborationEvidenceData, CollaborationEvidenceRecord } from "@/creator-agent/collaborationEvidence";
import { COLLABORATION_ID } from "@/fixtures/collaboration";
import type { OverviewFixtureKey } from "@/fixtures/overview";
import type { ReadRequest } from "./contract";
import { respondWith } from "./demoViews";
import { AdapterError } from "./errors";

const observedAt = "2026-11-04T18:42:00Z";
const asset = {
  kind: "asset", id: "demo-asset-v2", recordedAt: observedAt,
  assetId: "demo-routine-cut", version: 2, fileVersion: "file-v2",
  productId: "demo-product", productRevision: "demo-revision",
  parentAssetId: "demo-routine-original", parentVersion: 1, availability: "available",
  reviewState: "accepted", rightsState: "unknown", rightsObservedAt: null,
} as const;
const saved: CollaborationEvidenceRecord[] = [
  asset,
  { kind: "review", id: "demo-review", recordedAt: observedAt, reviewKey: "demo-review", revision: 1, creatorId: "demo-creator", action: "renew", sourceVerified: false },
  { kind: "decision", id: "demo-decision", recordedAt: observedAt, reviewKey: "demo-review", revision: 1, creatorId: "demo-creator", action: "renew", decision: "approved", decidedAt: observedAt, linearDecisionRef: "demo-decision-receipt", sourceVerified: false },
  { kind: "participation", id: "demo-participation", recordedAt: observedAt, creatorId: "demo-creator", decisionId: "demo-decision", state: "accepted", occurredAt: observedAt, sourceReceiptRef: "demo-participation-receipt", sourceVerified: false },
];

/** Synthetic examples are exact collaboration matches and never enter the live adapter. */
export function readDemoCollaborationEvidence(request: ReadRequest<{ collaborationId: string }>, fixture: OverviewFixtureKey) {
  const id = request.filters.collaborationId;
  const fail = (code: string, message: string): never => {
    throw new AdapterError({ code, message, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null });
  };
  if (typeof id !== "string" || !id.trim()) fail("VALIDATION_FAILED", "A collaboration reference is required.");
  if (fixture === "FX-08-forbidden-account") fail("FORBIDDEN", "This scope cannot read saved evidence.");
  if (fixture === "FX-09-expired-session") fail("SESSION_EXPIRED", "The session expired.");
  if (fixture === "FX-07-offline-read") fail("SOURCE_UNAVAILABLE", "The saved evidence source is unavailable.");

  const rows = id === COLLABORATION_ID && fixture !== "FX-03-empty-filter" ? saved : [];
  const limit = Math.min(100, Math.max(1, request.page.limit));
  const offset = request.page.cursor === null ? 0 : Number(request.page.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length) fail("INVALID_CURSOR", "The evidence cursor is invalid.");
  const records = rows.slice(offset, offset + limit);
  const hasMore = offset + records.length < rows.length;
  const data: CollaborationEvidenceData = { kind: "collaboration-evidence", source: "saved-agent-records", collaborationId: id, observedAt, total: rows.length, records, offset, hasMore };
  const result = respondWith(request, data, { dataVersion: "synthetic-evidence-v1", dataState: rows.length ? "ready" : "empty" });
  result.page = { hasMore, nextCursor: hasMore ? String(offset + records.length) : null };
  result.coverage = { expectedCount: rows.length, observedCount: records.length, missingCount: rows.length - records.length, complete: records.length === rows.length, reasonCodes: [] };
  return result;
}
