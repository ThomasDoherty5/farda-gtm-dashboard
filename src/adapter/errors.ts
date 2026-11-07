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
  INVALID_MONITOR_CURSOR: "validation",
  MONITOR_CURSOR_EXPIRED: "conflict",
  MONITOR_SNAPSHOT_CHANGED: "conflict",
  MONITOR_SOURCE_INVALID: "unavailable",
  INVALID_REQUEST: "validation",
  IDEMPOTENCY_CONFLICT: "conflict",
  STOCK_BASIS_UNKNOWN: "capabilityHold",
  STOCK_CONFLICT: "conflict",
  RECEIPTS_MISSING: "capabilityHold",
  CASE_HANDOFF_HELD: "capabilityHold",
  LIFECYCLE_SOURCE_UNCONFIGURED: "unavailable",
  LIFECYCLE_SOURCE_UNAVAILABLE: "unavailable",
  LIFECYCLE_SOURCE_INVALID: "unavailable",
  LIFECYCLE_SOURCE_CONFLICT: "conflict",
  LIFECYCLE_SOURCE_REGRESSED: "conflict",
  FLOW_CATALOG_UNAVAILABLE: "capabilityHold",
  FLOW_CATALOG_SELECTION_INVALID: "validation",
  FLOW_DRAFT_DENIED: "forbidden",
  SETUP_FLOW_READ_ONLY: "forbidden",
  PERSISTENCE_UNCERTAIN: "outcomeUncertain",
  INVALID_CONTROL_REFERENCE: "validation",
  SOURCE_CHANGED: "conflict",
  TASK_PERMISSION_UNVERIFIED: "capabilityHold",
  TASK_BUDGET_EXCEEDED: "resourceHold",
  TAKEOVER_HELD: "capabilityHold",
  RECONCILIATION_INCOMPLETE: "capabilityHold",
  REPAIR_OWNERSHIP_HELD: "capabilityHold",
  PERMISSION_EVIDENCE_UNVERIFIED: "capabilityHold",
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
  AUTHORITY_REQUIRED: "forbidden",
  NAMED_ACTOR_UNCONFIGURED: "forbidden",
  ACTOR_AUTHORITY_FENCE_UNCONFIGURED: "forbidden",
  ACTOR_PROOF_INVALID: "forbidden",
  ACTION_SCOPE_DENIED: "forbidden",
  DISPATCH_SCOPE_DENIED: "forbidden",
  DISPATCH_WORKER_AUTHORITY_INVALID: "forbidden",
  EXPORT_ACCESS_DENIED: "forbidden",
  SOURCE_ACTION_UNSUPPORTED: "capabilityHold",
  SOURCE_ACTION_BOUNDARY_REQUIRED: "forbidden",
  SOURCE_ACTION_UNCONFIGURED: "capabilityHold",
  SOURCE_CAPABILITY_UNAVAILABLE: "capabilityHold",
  SOURCE_RECONCILIATION_CAPABILITY_UNAVAILABLE: "capabilityHold",
  DISPATCH_PROVIDER_AUTHORITY_UNKNOWN: "capabilityHold",
  DISPATCH_IDEMPOTENCY_UNSUPPORTED: "capabilityHold",
  DISPATCH_RECONCILIATION_BINDING_MISMATCH: "capabilityHold",
  DISPATCH_SHARED_QUOTA_REQUIRED: "resourceHold",
  DISPATCH_SHARED_QUOTA_UNVERIFIED: "resourceHold",
  DISPATCH_RESOURCE_AUTHORITY_UNAVAILABLE: "resourceHold",
  DISPATCH_RESOURCE_PROOF_INVALID: "resourceHold",
  DISPATCH_RESOURCE_POLICY_MISMATCH: "resourceHold",
  DISPATCH_BUDGET_REQUIRED: "resourceHold",
  DISPATCH_STOCK_REQUIRED: "resourceHold",
  DISPATCH_ITEM_SPEND_BOUND: "resourceHold",
  DISPATCH_ITEM_UNIT_BOUND: "resourceHold",
  DISPATCH_GRANT_ALREADY_CLAIMED: "resourceHold",
  DISPATCH_NO_ACTIVE_LEASE: "resourceHold",
  DISPATCH_POLICY_STALE: "approvalHold",
  APPROVAL_CHANNEL_REQUIRED: "approvalHold",
  APPROVAL_REQUEST_UNVERIFIED: "approvalHold",
  APPROVAL_NOT_CURRENT: "approvalHold",
  APPROVAL_PROOF_EXPIRED: "approvalHold",
  APPROVAL_CURRENT_AUTHORITY_UNAVAILABLE: "approvalHold",
  APPROVAL_CURRENT_SOURCE_UNVERIFIED: "approvalHold",
  APPROVAL_PROOF_UNVERIFIED: "approvalHold",
  LAUNCH_GO_HELD: "approvalHold",
  DISPATCH_VERSION_CONFLICT: "conflict",
  DISPATCH_HANDLER_CHANGED: "conflict",
  DISPATCH_PROVIDER_BINDING_MISMATCH: "conflict",
  DISPATCH_APPROVAL_BINDING_MISMATCH: "conflict",
  DISPATCH_IDEMPOTENCY_KEY_REUSED: "conflict",
  DISPATCH_ITEM_REUSED: "conflict",
  DISPATCH_ITEM_ALREADY_IN_RUN: "conflict",
  DISPATCH_CLOSURE_ATTEMPT_MISMATCH: "conflict",
  DISPATCH_RECEIPT_CONFLICT: "conflict",
  DISPATCH_RECEIPT_REUSED: "conflict",
  APPROVAL_VERSION_CHANGED: "conflict",
  APPROVAL_POLICY_CHANGED: "conflict",
  APPROVAL_SOURCE_CHANGED: "conflict",
  SOURCE_EVENT_CHANGED: "conflict",
  SOURCE_VERSION_CONFLICT: "conflict",
  SOURCE_REGRESSED: "conflict",
  READINESS_BASIS_CHANGED: "conflict",
  EXPORT_SNAPSHOT_CHANGED: "conflict",
  EXPORT_REQUEST_CHANGED: "conflict",
  EXPORT_EXPIRED: "conflict",
  EXACT_MANIFEST_ITEM_REQUIRED: "validation",
  DISPATCH_BATCH_BOUND: "validation",
  DISPATCH_MIXED_MANIFEST_OR_BINDING: "validation",
  PREVIEW_SELECTION_MISMATCH: "validation",
  EXPORT_TOO_LARGE: "resourceHold",
  EXPORT_RECONCILIATION_REQUIRED: "outcomeUncertain",
  READINESS_PRIOR_OUTCOME_UNCERTAIN: "outcomeUncertain",
  READINESS_RECEIPT_CONFLICT: "outcomeUncertain",
  DISPATCH_PRIOR_OUTCOME_UNCERTAIN: "outcomeUncertain",
  SOURCE_OUTCOME_UNCERTAIN: "outcomeUncertain",
  SOURCE_RECONCILIATION_UNAVAILABLE: "unavailable",
  READINESS_SOURCE_UNCONFIGURED: "unavailable",
  EXPORT_SOURCE_UNCONFIGURED: "unavailable",
  DISPATCH_WORKER_UNCONFIGURED: "unavailable",
  APPROVAL_INGRESS_UNCONFIGURED: "unavailable",
  APPROVAL_SOURCE_UNAVAILABLE: "unavailable",
  APPROVAL_POLICY_UNAVAILABLE: "unavailable",
  READINESS_SOURCE_INVALID: "unavailable",
  EXPORT_SOURCE_INVALID: "unavailable",
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
  reasonCodes?: string[];
  rowIndex?: number | null;
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
