/**
 * Frontend-facing adapter contract, transcribed from sections 2–5 of
 * "Farda frontend — adapter contracts, fixtures and verification" (Linear, 2026-11-02).
 * Status: PROPOSED. THO-283 freezes it. Do not add fields that the document does not define.
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

/** Section 4 action operations. Only the names are frozen here; payloads come with THO-283/THO-321. */
export const actionOperations = [
  "previewAction",
  "requestApproval",
  "decideApproval",
  "dispatchApprovedAction",
  "inspectRun",
  "reconcileRun",
  "controlRun",
] as const;
export type ActionOperation = (typeof actionOperations)[number];
