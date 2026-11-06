/** Section 5 error categories and the UI behaviour each one requires. */
export type ErrorCategory =
  | "unauthenticated"
  | "forbidden"
  | "notFound"
  | "validation"
  | "conflict"
  | "approvalHold"
  | "capabilityHold"
  | "resourceHold"
  | "rateLimited"
  | "unavailable"
  | "outcomeUncertain"
  | "replayed"
  | "unknown";

const CODE_TO_CATEGORY: Record<string, ErrorCategory> = {
  UNAUTHENTICATED: "unauthenticated",
  SESSION_EXPIRED: "unauthenticated",
  FORBIDDEN: "forbidden",
  SOURCE_AUTHORITY_DENIED: "forbidden",
  /** Q-02. Returned only for a record inside the caller's verified scope. Outside it the answer is FORBIDDEN, so one tenant cannot probe another. */
  RECORD_NOT_FOUND: "notFound",
  VALIDATION_FAILED: "validation",
  INVALID_CURSOR: "validation",
  POLICY_VIOLATION: "validation",
  STALE_VERSION: "conflict",
  VERSION_CONFLICT: "conflict",
  IDEMPOTENCY_KEY_REUSED: "conflict",
  CREATOR_IDENTITY_CHANGED: "conflict",
  INVALID_OFFER_TERMS: "validation",
  INVALID_INPUT: "validation",
  OBSERVATION_OUTSIDE_REVIEW: "validation",
  EVIDENCE_REVIEW_LIMIT: "resourceHold",
  INVALID_COLLABORATION_REFERENCE: "validation",
  INVALID_PROPOSAL_TARGET: "validation",
  SOURCE_RESPONSE_INVALID: "unavailable",
  ASSET_EVIDENCE_UNVERIFIED: "unavailable",
  SOURCE_VERSION_CHANGED: "conflict",
  SOURCE_COVERAGE_INCOMPLETE: "capabilityHold",
  SOURCE_TIME_UNVERIFIED: "unavailable",
  SOURCE_STALE: "conflict",
  SOURCE_SCOPE_DENIED: "forbidden",
  SOURCE_COVERAGE_PARTIAL: "capabilityHold",
  SUBMISSION_UNVERIFIED: "capabilityHold",
  OUTREACH_SUPPRESSED: "capabilityHold",
  SUPPRESSION_UNVERIFIED: "capabilityHold",
  RELATIONSHIP_CLOSED: "capabilityHold",
  POSTING_OBLIGATION_UNVERIFIED: "capabilityHold",
  CREATOR_PLATFORM_CURSOR_INVALID: "conflict",
  CREATOR_PLATFORM_SCOPE_MISMATCH: "forbidden",
  FUNNEL_NARROW_COHORT_WINDOW: "validation",
  APPROVAL_INVALID: "conflict",
  MANIFEST_CHANGED: "conflict",
  LEASE_CONFLICT: "conflict",
  APPROVAL_REQUIRED: "approvalHold",
  APPROVAL_EXPIRED: "approvalHold",
  CAPABILITY_UNVERIFIED: "capabilityHold",
  CAPABILITY_UNSUPPORTED: "capabilityHold",
  SOURCE_LOGIN_REQUIRED: "capabilityHold",
  SOURCE_UI_CHANGED: "capabilityHold",
  QUOTA_OR_STOCK_HOLD: "resourceHold",
  BUDGET_HOLD: "resourceHold",
  RATE_LIMITED: "rateLimited",
  SOURCE_UNAVAILABLE: "unavailable",
  TIMEOUT: "unavailable",
  INTEGRATION_PENDING: "unavailable",
  OFFLINE_NOT_SENT: "unavailable",
  OUTCOME_UNCERTAIN: "outcomeUncertain",
};

export type AdapterErrorBody = {
  code: string;
  message: string;
  requestId: string | null;
  correlationId: string | null;
  retryable: boolean;
  retryAfterMs: number | null;
  fieldErrors?: Record<string, string>;
  currentVersion?: string | null;
  executionCertainty?: "notApplied" | "uncertain" | "applied";
};

export class AdapterError extends Error {
  readonly category: ErrorCategory;
  constructor(readonly body: AdapterErrorBody) {
    super(body.message);
    this.name = "AdapterError";
    this.category = categorize(body.code);
  }
}

export function categorize(code: string): ErrorCategory {
  return CODE_TO_CATEGORY[code] ?? "unknown";
}

/** Categories after which protected cached data must be dropped, not shown. */
export function mustClearProtectedData(category: ErrorCategory): boolean {
  return category === "unauthenticated" || category === "forbidden";
}
