/**
 * Frontend-facing adapter contract, transcribed from sections 2–5 of
 * "Farda frontend — adapter contracts, fixtures and verification" (Linear, 2026-11-02).
 * Status: PROPOSED. THO-283 freezes it. Do not add fields that the document does not define.
 * Exception: Q-01 to Q-04 and D-13 of docs/adapter-decisions.md (2026-11-04) are defaults decided for the build and are
 * implemented below. They are not verified against any service, and the backend owner may change them.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "2026-11-02.proposed";

export const environmentSchema = z.enum(["demo", "sandbox", "production"]);
export type Environment = z.infer<typeof environmentSchema>;

export const executionModeSchema = z.enum(["observe", "propose", "executeApproved", "reconcile"]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export const valueStateSchema = z.enum(["known", "unknown", "notApplicable"]);
export type ValueState = z.infer<typeof valueStateSchema>;

export const sourceRefSchema = z.object({
  source: z.string(),
  accountId: z.string(),
  sourceId: z.string().nullable(),
  canonicalId: z.string().nullable(),
  url: z.string().nullable(),
  identityState: z.enum(["resolved", "unresolved"]),
  provenanceRef: z.string(),
});
export type SourceRef = z.infer<typeof sourceRefSchema>;

/**
 * Known zero is value=0 + state=known. Unknown and notApplicable carry null + a reason.
 * Known null is rejected.
 */
export const provenanceValueSchema = <T extends z.ZodTypeAny>(value: T) =>
  z
    .object({
      state: valueStateSchema,
      value: value.nullable(),
      reasonCode: z.string().nullable(),
      evidenceRefs: z.array(z.string()),
      sourceRef: sourceRefSchema.nullable(),
      occurredAt: z.string().nullable(),
      sourceUpdatedAt: z.string().nullable(),
      observedAt: z.string(),
    })
    .superRefine((v, ctx) => {
      if (v.state === "known" && v.value === null)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Known value cannot be null" });
      if (v.state !== "known" && v.value !== null)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown/notApplicable value must be null" });
      if (v.state !== "known" && !v.reasonCode)
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown/notApplicable value needs a reasonCode" });
    });
export type ProvenanceValue<T> = {
  state: ValueState;
  value: T | null;
  reasonCode: string | null;
  evidenceRefs: string[];
  sourceRef: SourceRef | null;
  occurredAt: string | null;
  sourceUpdatedAt: string | null;
  observedAt: string;
};

export const moneySchema = z.object({
  minorUnits: z.number().int(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof moneySchema>;

export const periodSchema = z.object({
  startAt: z.string(),
  endAt: z.string(),
  timezone: z.string(),
  basis: z.enum(["eventTime", "observationTime"]),
});
export type Period = z.infer<typeof periodSchema>;

export const verifiedScopeSchema = z.object({
  workspaceId: z.string(),
  accountIds: z.array(z.string()),
  environment: environmentSchema,
  authorizationScopeVersion: z.string(),
});
export type VerifiedScope = z.infer<typeof verifiedScopeSchema>;

export type RequestedScope = { workspaceId: string; accountIds: string[]; environment: Environment };

export type ReadRequest<F> = {
  schemaVersion: string;
  operation: "readView";
  viewKey: string;
  requestedScope: RequestedScope;
  filters: F;
  period: Period | null;
  sort: { field: string; direction: "asc" | "desc" }[];
  page: { cursor: string | null; limit: number };
  requestId: string;
};

export const dataStateSchema = z.enum(["ready", "empty", "partial", "stale", "unavailable"]);
export type DataState = z.infer<typeof dataStateSchema>;

/** D-13: the server's own verdict on one source. A client that is told nothing falls back to the reason-code mapping. */
export const freshnessStateSchema = z.enum(["current", "noChange", "partial", "error", "neverSynced"]);
export type FreshnessState = z.infer<typeof freshnessStateSchema>;

/** Q-04: whether a write reached the provider. `notApplied` only with proof that nothing did; a timeout after submission is `uncertain`. */
export const executionCertaintySchema = z.enum(["notApplied", "uncertain", "applied"]);
export type ExecutionCertainty = z.infer<typeof executionCertaintySchema>;

export const capabilityStateSchema = z.enum(["available", "unverified", "unsupported", "denied", "held"]);

export const readResponseSchema = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    schemaVersion: z.string(),
    requestId: z.string(),
    scope: verifiedScopeSchema,
    dataVersion: z.string(),
    dataState: dataStateSchema,
    data: data.nullable(),
    sourceFreshness: z.array(
      z.object({
        sourceRef: sourceRefSchema,
        lastSourceSuccessAt: z.string().nullable(),
        observedAt: z.string().nullable(),
        mirroredAt: z.string().nullable(),
        staleReasonCode: z.string().nullable(),
        /** D-13. Computed by the server. Optional so a server that predates it still validates; see `freshnessStateOf`. */
        freshnessState: freshnessStateSchema.optional(),
      }),
    ),
    coverage: z.object({
      expectedCount: z.number().nullable(),
      observedCount: z.number().nullable(),
      missingCount: z.number().nullable(),
      complete: z.boolean().nullable(),
      reasonCodes: z.array(z.string()),
    }),
    capabilities: z.array(
      z.object({ actionKind: z.string(), state: capabilityStateSchema, reasonCodes: z.array(z.string()) }),
    ),
    page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
    refresh: z.object({ nextPollAfterMs: z.number().nullable() }),
  });
export type ReadResponse<T> = Omit<z.infer<ReturnType<typeof readResponseSchema>>, "data"> & { data: T | null };

/** Section 4 action operations. Generic envelopes are below; domain payloads come with THO-283/THO-321. */
export const actionOperations = [
  "previewAction",
  "requestApproval",
  "decideApproval",
  "dispatchApprovedAction",
  "inspectRun",
  "reconcileRun",
  "controlRun",
  "refreshObservation",
] as const;
export type ActionOperation = (typeof actionOperations)[number];

export type ActionRequest<P> = {
  schemaVersion: string;
  operation: Exclude<ActionOperation, "inspectRun">;
  requestedScope: RequestedScope;
  actionKind: string;
  entityRefs: SourceRef[];
  expectedVersion: string;
  approvalRef: string | null;
  manifestRef: string | null;
  /** Q-03. The run a `controlRun` or `reconcileRun` acts on. Null or absent for every other operation. */
  runRef?: string | null;
  idempotencyKey: string;
  payload: P;
  requestId: string;
};

export const actionStateSchema = z.enum([
  "draft",
  "approvalPending",
  /** Q-01. Approved, awaiting dispatch. Not a success state: nothing has been sent. */
  "approved",
  "queued",
  "blocked",
  "running",
  "succeeded",
  "partiallySucceeded",
  "failed",
  "outcomeUncertain",
  "reconciling",
  "paused",
  "canceled",
]);
export type ActionState = z.infer<typeof actionStateSchema>;

export const actionResponseSchema = z.object({
  schemaVersion: z.string(),
  requestId: z.string(),
  scope: verifiedScopeSchema,
  actionRef: z.string(),
  state: actionStateSchema,
  runRef: z.string().nullable(),
  approvalRef: z.string().nullable(),
  manifestRef: z.string().nullable(),
  payloadVersion: z.string(),
  policyVersion: z.string(),
  modelVersion: z.string().nullable(),
  offerVersion: z.string().nullable(),
  reasonCodes: z.array(z.string()),
  receiptRefs: z.array(z.string()),
  nextAction: z
    .object({ kind: z.string(), ownerRef: z.string().nullable(), dueAt: z.string().nullable(), available: z.boolean() })
    .nullable(),
  nextPollAfterMs: z.number().nullable(),
  /** Q-04. Required on every action answer. */
  executionCertainty: executionCertaintySchema,
});
export type ActionResponse = z.infer<typeof actionResponseSchema>;

/** Versioned saves that never dispatch a provider action. */
export type SaveResourceRequest<P> = {
  schemaVersion: string;
  operation: "saveResource";
  requestedScope: RequestedScope;
  resourceKind: "actionDraft" | "reviewerAssessment" | "evidenceDraft" | "configurationDraft";
  resourceRef: string | null;
  expectedVersion: string | null;
  idempotencyKey: string;
  requestId: string;
  payload: P;
};

export type SaveResourceResponse<T> = {
  schemaVersion: string;
  requestId: string;
  scope: VerifiedScope;
  resourceRef: string;
  resourceVersion: string;
  persistedAt: string;
  persistedByRef: string;
  record: T;
  reasonCodes: string[];
  /** Q-04. Required on every save answer. */
  executionCertainty: ExecutionCertainty;
};

/**
 * What the demo services and the reference server say for an action answer: the certainty describes the command the
 * request made, not any later dispatch. A blocked, failed or draft answer changed nothing; an uncertain one is unknown;
 * anything else was applied. Approved is applied (the decision is stored) and still not sent.
 */
export const certaintyOfState = (state: ActionState): ExecutionCertainty =>
  state === "blocked" || state === "failed" || state === "draft" ? "notApplied" : state === "outcomeUncertain" ? "uncertain" : "applied";
