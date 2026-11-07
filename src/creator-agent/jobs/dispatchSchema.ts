import { z } from "zod";
import { approvalRefSchema as ref, approvalHashSchema as hash, approvalInstantSchema as instant, dispatchApprovalBindingSchema, type DispatchApprovalBinding, type CurrentApprovalResult, type VerifiedApprovalProof } from "../approvals/contract.ts";
import { expectedBindingSchema } from "../connections/schema.ts";
import { jobDefinitionSchema, type JobRunView } from "./schema.ts";
export const dispatchIntentSchema = z.object({ approval: dispatchApprovalBindingSchema, handlerRef: ref, payloadRef: ref }).strict();
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;
const notApplicable = z.object({ state: z.literal("notApplicable"), policyVersion: ref, reason: z.string().min(1).max(500) }).strict();
export const resourceRequirementSchema = z.discriminatedUnion("state", [notApplicable, z.object({ state: z.literal("required"), resourceRef: ref, quantity: z.number().int().positive().safe(), unit: ref, currency: z.string().regex(/^[A-Z]{3}$/).nullable() }).strict()]);
export const resourceRequirementsSchema = z.object({ budget: resourceRequirementSchema, stock: resourceRequirementSchema, quota: resourceRequirementSchema }).strict();
export type ResourceRequirements = z.infer<typeof resourceRequirementsSchema>;
export const grantSchema = z.object({ grantRef: ref, issuerRef: ref, allocationVersion: ref, scope: dispatchApprovalBindingSchema.shape.scope, dispatchKey: ref, dimension: z.enum(["budget", "stock", "quota"]), resourceRef: ref, quantity: z.number().int().positive().safe(), unit: ref, currency: z.string().regex(/^[A-Z]{3}$/).nullable(), observedAt: instant, validUntil: instant, exclusive: z.literal(true), quotaBasis: z.object({ publishedLimit: z.number().int().positive().safe(), operatingLimit: z.number().int().positive().safe(), allocatedTotal: z.number().int().positive().safe(), windowRef: ref, windowStart: instant, windowEnd: instant, sharedAcrossRoutes: z.literal(true) }).strict().optional() }).strict();
export type ResourceGrant = z.infer<typeof grantSchema>;
export const providerOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("accepted"), reasonCode: z.null() }).strict(),
    z.object({ state: z.literal("rejected"), reasonCode: z.literal("PROVIDER_REJECTED") }).strict(),
]);
export const receiptSchema = z.object({ receiptRef: ref, dispatchKey: ref, payloadHash: hash, handlerRef: ref, providerBindingHash: hash, sourceEffect: z.enum(["localArtifact", "providerApplied"]), observedAt: instant,
    providerOutcome: providerOutcomeSchema.optional() }).strict().superRefine((value,ctx)=>{
    if(value.providerOutcome && value.sourceEffect!=="providerApplied")ctx.addIssue({code:z.ZodIssueCode.custom,message:"Only a native provider receipt can carry a provider outcome."});
});
export type DispatchReceipt = z.infer<typeof receiptSchema>;
export const dispatchReadbackSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("applied"), receipt: receiptSchema }).strict(),
    z.object({ state: z.literal("notApplied"), attemptRef: ref, attemptNumber: z.number().int().positive().safe(), dispatchKey: ref, payloadHash: hash, handlerRef: ref, providerBindingHash: hash, receiptRef: ref, observedAt: instant, validUntil: instant, complete: z.literal(true), originalAttemptClosed: z.literal(true) }).strict(),
    z.object({ state: z.literal("unknown"), reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/) }).strict(),
]);
export type DispatchReadback = z.infer<typeof dispatchReadbackSchema>;
export const providerRequirementSchema = z.discriminatedUnion("state", [notApplicable, z.object({ state: z.literal("required"), binding: expectedBindingSchema }).strict()]);
export type DispatchHandler = {
    policyVersion: string;
    idempotency: "source-enforced";
    sourceEffect: "localArtifact" | "providerApplied";
    provider: z.infer<typeof providerRequirementSchema>;
    /** Distinct current permission for source readback; never inferred from the write capability. */
    reconcileBinding?: z.infer<typeof expectedBindingSchema>;
    resources: (intent: DispatchIntent) => ResourceRequirements;
    budgets: z.infer<typeof jobDefinitionSchema>["budgets"];
    /** Registered trusted implementation. No endpoint, code or policy comes from the browser. */
    execute: (context: DispatchContext) => Promise<DispatchReadback>;
    reconcile: (context: DispatchReconcileContext) => Promise<DispatchReadback>;
};
/** Readback gets identity only. It cannot obtain an execution lease, grant or release proof. */
export type DispatchReconcileContext = {
    attemptRef:string;
    attemptNumber:number;
    intent: DispatchIntent;
    dispatchKey: string;
    providerBindingHash: string;
};
export type DispatchContext = DispatchReconcileContext & {
    heartbeat: () => Promise<string>;
    /** Invoke synchronously immediately before the native effect, after the handler's last await. */
    assertCurrent: () => void;
    /** Defensive copies of the latest successfully fenced heartbeat preflight; not new allocations. */
    resourceGrants: () => readonly ResourceGrant[];
    approvalProof: () => VerifiedApprovalProof;
};
export type DispatchApprovalAuthority = {
    resolveCurrentProof: (binding: DispatchApprovalBinding) => Promise<CurrentApprovalResult>;
    assertCurrentProof: (proof: VerifiedApprovalProof, now: number) => void;
};
export type ResourceAuthority = {
    /** The owning budget/J15/quota service atomically allocates an exclusive grant, shared across ALL routes/callers. A remaining-balance snapshot is not a grant. */
    resolveGrants: (request: {
        intent: DispatchIntent;
        dispatchKey: string;
        requirements: ResourceRequirements;
    }) => Promise<ResourceGrant[]>;
    /** Synchronous source-issued proof fence; called inside the job's final SQLite transaction. */
    assertCurrent: (grants: ResourceGrant[], request: {
        intent: DispatchIntent;
        dispatchKey: string;
        requirements: ResourceRequirements;
    }, now: number) => void;
};
export type DispatchRead = {
    schemaVersion: "farda.dispatch.v1";
    runRef: string;
    revision: number;
    intent: DispatchIntent;
    dispatchKey: string;
    run: JobRunView;
    items: {
        intent: DispatchIntent;
        dispatchKey: string;
        receipt: DispatchReceipt | null;
    }[];
    receipt: DispatchReceipt | null;
    current: {
        state: "held" | "ready" | "running" | "completed" | "uncertain" | "cancelled";
        reasonCodes: string[];
    };
    executionCertainty: "notApplied" | "applied" | "uncertain";
    controlReceipt?: {
        requestKey: string;
        principalRef: string;
        command: "pause" | "resume" | "cancel";
        expectedRevision: number;
        appliedRevision: number;
    };
};
export class DispatchError extends Error {
    readonly code: string;
    readonly status: number;
    readonly executionCertainty: "notApplied" | "applied" | "uncertain";
    readonly retryAfterMs: number | null;
    constructor(code: string, status = 409, certainty: "notApplied" | "applied" | "uncertain" = "notApplied", retryAfterMs: number | null = null) { super(code); this.name = "DispatchError"; this.code = code; this.status = status; this.executionCertainty = certainty; this.retryAfterMs = retryAfterMs; }
}

/** Server-injected machine authority, never supplied through the browser. */
export type DispatchWorker = {workerRef:string;assertCurrent:()=>void};

/** Read-only latest durable provider-attempt observation; never an execution grant. */
export type DispatchAttemptObservation = {
  state: "unstarted" | "open" | "applied" | "closedNotApplied" | "unknown";
  attemptNumber: number | null; receiptRef: string | null; observedAt: string | null;
};
