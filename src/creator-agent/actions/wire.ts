import { z } from "zod";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { proposeCommandSchema } from "../approvals/contract.ts";
import { exportPayloadSchema, readinessPayloadSchema, reference } from "./contract.ts";

const base = z.object({ schemaVersion: z.literal(SCHEMA_VERSION), requestId: reference,
  requestedScope: z.object({ workspaceId: reference, accountIds: z.array(reference).length(1), environment: z.literal("sandbox") }).strict(),
  expectedVersion: reference, idempotencyKey: reference, entityRefs: z.array(z.never()).max(0),
  approvalRef: reference.nullable(), manifestRef: reference.nullable(), runRef: z.null().optional() }).strict();
export const previewPayload = proposeCommandSchema.omit({ actionKind: true, approvalRef: true, expectedVersion: true });
const exactEmpty = z.object({}).strict();
export const foundationActionSchema = z.discriminatedUnion("operation", [
  base.extend({ operation: z.literal("previewAction"), actionKind: reference, payload: previewPayload }),
  base.extend({ operation: z.literal("requestApproval"), actionKind: z.enum(["requestApproval", "reconcileApproval"]), approvalRef: reference, manifestRef: reference, payload: exactEmpty }),
  base.extend({ operation: z.literal("decideApproval"), actionKind: z.literal("decideApproval"), approvalRef: reference, manifestRef: reference,
    payload: z.discriminatedUnion("decision", [z.object({ decision: z.literal("approved"), reason: z.string().max(2000).optional() }).strict(),
      z.object({ decision: z.literal("rejected"), reason: z.string().trim().min(1).max(2000) }).strict(), z.object({ decision: z.literal("editRequired"), editedMessage: z.string().trim().min(1).max(5000), reason: z.string().max(2000).optional() }).strict()]) }),
  base.extend({ operation: z.literal("dispatchApprovedAction"), actionKind: z.literal("dispatchApprovedAction"), approvalRef: reference, manifestRef: reference,
    payload: z.object({ itemRefs: z.array(reference).min(1).max(100).refine(v => new Set(v).size === v.length).optional() }).strict() }),
  base.extend({ operation: z.literal("controlRun"), actionKind: z.enum(["pauseRun", "cancelUnsent", "resumeRun"]), runRef: reference,
    payload: z.discriminatedUnion("control",[
      z.object({control:z.literal("cancel"),itemRefs:z.array(reference).min(1).max(100).refine(v=>new Set(v).size===v.length).optional()}).strict(),
      z.object({control:z.literal("pause")}).strict(),z.object({control:z.literal("resume")}).strict()
    ]) }),
  base.extend({ operation: z.literal("reconcileRun"), actionKind: z.enum(["lookup", "recordConfirmedSent", "freshAttempt"]), runRef: reference,
    payload: z.object({ request: z.enum(["lookup", "recordConfirmedSent", "freshAttempt"]) }).strict() }),
]);
export type FoundationAction = z.infer<typeof foundationActionSchema>;
export const readinessEntityRefSchema = z.object({ source: z.literal("launch-readiness"), accountId: reference, sourceId: z.null(), canonicalId: reference, url: z.null(), identityState: z.literal("resolved"), provenanceRef: reference }).strict();
export const domainActionSchema = z.discriminatedUnion("actionKind", [
  base.extend({ operation: z.literal("exportSnapshot"), approvalRef: z.null(), manifestRef: z.null(), actionKind: z.literal("exportLedger"), payload: exportPayloadSchema }),
  base.extend({ operation: z.literal("recordSourceDecision"), approvalRef: z.null(), manifestRef: z.null(), actionKind: z.literal("recordLaunchReadiness"),
    entityRefs: z.tuple([readinessEntityRefSchema]), payload: readinessPayloadSchema }),
]);
export type DomainAction = z.infer<typeof domainActionSchema>;
