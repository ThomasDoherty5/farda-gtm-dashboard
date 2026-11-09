/**
 * Runtime schemas for approvals and runs, including the recovery states (uncertain outcome, reconciliation), plus the
 * action payloads and action responses of the approval and run operations.
 *
 * Strictness: `.strict()` is used only where an unexpected key is a real risk.
 *  - `ApprovalPayload` and its `terms`: this is the exact payload a person approves. A key the screen does not render is
 *    content or a term that was approved unseen, so it is refused rather than stripped.
 *  - Action payloads: a key the approver never saw is a parameter nobody approved.
 * The rest of the view data uses zod's default (unknown keys are stripped), so the server can add display fields.
 *
 * Invariants checked beyond shape, because the screens would otherwise show a false success:
 *  - Approved is not Sent: `execution` exists only on an approved approval; `succeeded` / `partiallySucceeded` (on an
 *    execution, a run, or an action response) needs a source receipt; a confirmed run item needs its receipt.
 *  - A decided version names who decided, when, and the decision receipt; an undecided one carries none of that.
 *  - The run's `counts` are the tally of its `items`, so a headline number cannot disagree with the rows under it.
 *
 * Value states: this area has no `ProvenanceValue` fields. Plain numbers are never nullable, so a missing figure can't
 * become a zero. `sampleCost` is the one nullable amount and null there means "no sample cost", not zero. Money is the
 * contract's `moneySchema` narrowed to non-negative whole minor units.
 */
import { z } from "zod";
import { actionResponseSchema, actionStateSchema, environmentSchema, executionModeSchema, moneySchema, sourceRefSchema } from "../contract.ts";
import { nativeApprovalViewSchema, nativeRunViewSchema } from "../../creator-agent/actions/views.ts";
import { safeRuntimeRunSchema } from "../../creator-agent/jobs/runtimeViews.ts";
import { exportPayloadSchema, readinessPayloadSchema, reference } from "../../creator-agent/actions/contract.ts";
import { previewPayload } from "../../creator-agent/actions/wire.ts";

const nonBlank = z.string().trim().min(1);
const iso = z.string().datetime({ offset: true });
const money = moneySchema.extend({ minorUnits: z.number().int().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) });
const count = z.number().int().nonnegative();

/* ---------- approvals (approvalDetail) ---------- */

const approvalDecision = z.enum(["approved", "rejected", "editRequired", "expired", "canceled"]);

export const approvalPayloadSchema = z
  .object({
    actionLabel: nonBlank,
    account: sourceRefSchema,
    creator: sourceRefSchema,
    recipients: z.array(sourceRefSchema).min(1),
    recruitmentSource: z.string(),
    publishingNetworks: z.array(z.string()),
    checkout: z.string(),
    message: z.string(),
    terms: z
      .object({ commissionRatePct: z.number().min(0).max(100), upfrontFee: money, sampleCost: money.nullable() })
      .strict(),
  })
  .strict();

export const approvalVersionSchema = z
  .object({
    version: nonBlank,
    payload: approvalPayloadSchema,
    payloadHash: nonBlank,
    policyVersion: nonBlank,
    offerVersion: z.string().nullable(),
    decision: approvalDecision.nullable(),
    decidedByRole: z.string().nullable(),
    decidedAt: iso.nullable(),
    reason: z.string().nullable(),
    decisionReceiptRef: z.string().nullable(),
    slackPermalink: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    const decided = v.decision !== null;
    for (const field of ["decidedByRole", "decidedAt", "decisionReceiptRef"] as const) {
      if (decided && !v[field]) ctx.addIssue({ code: "custom", path: [field], message: "A decided version records who, when and the decision receipt" });
      if (!decided && v[field]) ctx.addIssue({ code: "custom", path: [field], message: "An undecided version has no decision details" });
    }
  });

const executionSchema = z
  .object({ runRef: nonBlank, state: actionStateSchema, receiptRefs: z.array(nonBlank) })
  .superRefine((e, ctx) => {
    if ((e.state === "succeeded" || e.state === "partiallySucceeded") && e.receiptRefs.length === 0)
      ctx.addIssue({ code: "custom", path: ["receiptRefs"], message: "Sent needs a source receipt" });
  });

export const approvalDetailSchema = z
  .object({
    approvalRef: nonBlank,
    displayId: nonBlank,
    title: nonBlank,
    contextLine: z.string(),
    source: z.string(),
    platform: z.string(),
    actionName: z.string(),
    requestedBy: z.string(),
    reviewer: z.string(),
    historicalNote: z.string().nullable(),
    executionPlan: z.string(),
    capabilityLabel: z.string(),
    queueLabel: z.string(),
    queue: z.array(z.object({ approvalRef: nonBlank, handle: z.string(), summary: z.string(), status: z.string(), tone: z.enum(["warning", "neutral"]) })),
    timeline: z.array(z.object({ time: z.string(), title: z.string(), note: z.string() })),
    status: z.enum(["pending", "approved", "rejected", "editRequired", "expired", "canceled"]),
    currentVersion: nonBlank,
    requiredRole: nonBlank,
    expiresAt: iso,
    manifestRef: nonBlank,
    versions: z.array(approvalVersionSchema).min(1),
    execution: executionSchema.nullable(),
  })
  .superRefine((a, ctx) => {
    const current = a.versions.find((v) => v.version === a.currentVersion);
    if (!current) {
      ctx.addIssue({ code: "custom", path: ["currentVersion"], message: "The current version is not in the version history" });
      return;
    }
    if (a.status === "pending" && current.decision !== null) ctx.addIssue({ code: "custom", path: ["status"], message: "A pending approval's current version has no decision" });
    if ((a.status === "approved" || a.status === "rejected") && current.decision !== a.status)
      ctx.addIssue({ code: "custom", path: ["status"], message: "The status must match the current version's decision" });
    if (a.execution && a.status !== "approved") ctx.addIssue({ code: "custom", path: ["execution"], message: "Only an approved approval can have been dispatched" });
  });

/* ---------- runs (runDetail) ---------- */

const runItemState = z.enum(["confirmed", "failed", "held", "unsent", "paused", "uncertain"]);
export const runItemSchema = z
  .object({ itemId: nonBlank, recipient: sourceRefSchema, state: runItemState, receiptRef: z.string().nullable(), reasonCode: z.string().nullable() })
  .superRefine((i, ctx) => {
    if (i.state === "confirmed" && !i.receiptRef) ctx.addIssue({ code: "custom", path: ["receiptRef"], message: "A confirmed item needs its source receipt" });
  });

export const reconciliationSchema = z
  .object({
    result: z.enum(["notChecked", "sourceReceiptFound", "confirmedNotExecuted", "stillUnknown"]),
    evidence: z.object({ receiptRef: nonBlank, provider: nonBlank, accountId: nonBlank, identity: nonBlank, observedAt: iso }).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.result === "sourceReceiptFound" && !r.evidence) ctx.addIssue({ code: "custom", path: ["evidence"], message: "A found receipt carries its evidence" });
    if (r.result === "notChecked" && r.evidence) ctx.addIssue({ code: "custom", path: ["evidence"], message: "An unchecked run has no evidence" });
  });

export const runDetailSchema = z
  .object({
    runRef: nonBlank,
    displayId: nonBlank,
    source: z.string(),
    collaboration: z.string(),
    handle: z.string(),
    revision: z.string(),
    decisionLabel: z.string(),
    lastEvent: z.string(),
    historicalNote: z.string().nullable(),
    steps: z.array(z.object({ title: z.string(), note: z.string(), status: z.enum(["Complete", "Waiting", "Blocked"]) })),
    stages: z.array(z.string()),
    currentStage: z.string(),
    previewMessage: z.string(),
    sourceDetails: z.array(z.object({ label: z.string(), value: z.string() })),
    version: nonBlank,
    jobId: nonBlank,
    jobVersion: nonBlank,
    mode: executionModeSchema,
    environment: environmentSchema,
    trigger: z.string(),
    correlationId: nonBlank,
    approvalRef: nonBlank,
    state: actionStateSchema,
    attempt: z.number().int().positive(),
    pausedAt: iso.nullable(),
    counts: z.object({ confirmed: count, failed: count, held: count, unsent: count, paused: count, uncertain: count }),
    items: z.array(runItemSchema),
    reconciliation: reconciliationSchema,
  })
  .superRefine((r, ctx) => {
    for (const state of runItemState.options) {
      const tally = r.items.filter((i) => i.state === state).length;
      if (r.counts[state] !== tally) ctx.addIssue({ code: "custom", path: ["counts", state], message: `counts.${state} is ${r.counts[state]} but ${tally} items are ${state}` });
    }
    if (r.state === "succeeded" && (r.items.length === 0 || r.items.some((i) => i.state !== "confirmed")))
      ctx.addIssue({ code: "custom", path: ["state"], message: "A succeeded run has every item confirmed with a receipt" });
  });

export const approvalViewSchemas: Record<string, z.ZodTypeAny> = {
  approvalDetail: z.union([nativeApprovalViewSchema, approvalDetailSchema]),
  runDetail: z.union([nativeRunViewSchema, safeRuntimeRunSchema, runDetailSchema]),
};

/* ---------- action responses ---------- */

/**
 * The contract's `actionResponseSchema` plus the rule the envelope can't express: success needs a source receipt.
 * Approved is not Sent, and a response with no receipt never reads as sent.
 */
export const receiptBackedResponse = actionResponseSchema.superRefine((r, ctx) => {
  if ((r.state === "succeeded" || r.state === "partiallySucceeded") && r.receiptRefs.length === 0)
    ctx.addIssue({ code: "custom", path: ["receiptRefs"], message: "Success needs a source receipt" });
});

/** Deciding is not sending: a decision response is never a success, so an approval can't read as sent. */
export const decideApprovalResponseSchema = receiptBackedResponse.refine((r) => r.state !== "succeeded" && r.state !== "partiallySucceeded", {
  message: "A decision is not a send",
});

/* ---------- action payloads ---------- */

const text = z.string();
export const decidePayloadSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), reason: text.optional() }).strict(),
  z.object({ decision: z.literal("rejected"), reason: nonBlank }).strict(),
  z.object({ decision: z.literal("editRequired"), editedMessage: nonBlank, reason: text.optional() }).strict(),
]);
/** Dispatch carries nothing of its own: what is sent is the approved version, named by `approvalRef` and `expectedVersion`. */
export const dispatchPayloadSchema = z.object({ itemRefs: z.array(reference).min(1).max(100).refine(values => new Set(values).size === values.length).optional() }).strict();
export const controlPayloadSchema = z.object({ control: z.literal("pause") }).strict();
const reconcilePayload = <R extends "lookup" | "recordConfirmedSent" | "freshAttempt">(request: R) => z.object({ request: z.literal(request) }).strict();

/** The reconcile kinds are named after the request, as the run page sends them. */
export const approvalActionSchemas: Record<string, { payload: z.ZodTypeAny }> = {
  decideApproval: { payload: decidePayloadSchema },
  dispatchApprovedAction: { payload: dispatchPayloadSchema },
  pauseRun: { payload: controlPayloadSchema },
  lookup: { payload: reconcilePayload("lookup") },
  recordConfirmedSent: { payload: reconcilePayload("recordConfirmedSent") },
  freshAttempt: { payload: reconcilePayload("freshAttempt") },
  previewAction: { payload: previewPayload },
  requestApproval: { payload: z.object({}).strict() },
  reconcileApproval: { payload: z.object({}).strict() },
  cancelUnsent: { payload: z.object({ control: z.literal("cancel"),itemRefs:z.array(reference).min(1).max(100).refine(v=>new Set(v).size===v.length).optional() }).strict() },
  resumeRun: { payload: z.object({ control: z.literal("resume") }).strict() },
  exportLedger: { payload: exportPayloadSchema },
  recordLaunchReadiness: { payload: readinessPayloadSchema },
};
