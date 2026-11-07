import { z } from "zod";
import { approvalInstantSchema as instant } from "../approvals/contract.ts";
import { itemStateSchema } from "../jobs/schema.ts";

const count = z.number().int().nonnegative().safe();
const alias = z.string().min(1).max(240);
const reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/** A withheld or unavailable source field must never retain its protected value. */
export const reviewFieldSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("visible"), value: z.string().min(1).max(12_000), reasonCode: z.null() }).strict(),
  z.object({ state: z.literal("redacted"), value: z.string().min(1).max(12_000), reasonCode: reason }).strict(),
  z.object({ state: z.literal("unavailable"), value: z.null(), reasonCode: reason }).strict(),
]);
export type ReviewField = z.infer<typeof reviewFieldSchema>;

export const reviewLinkSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), url: z.string().url().max(2_000).refine(value => {
    const u = new URL(value); return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  }, "A review link must be a permitted HTTPS source URL."), label: z.string().min(1).max(100) }).strict(),
  z.object({ state: z.literal("unavailable"), url: z.null(), label: z.string().min(1).max(100), reasonCode: reason }).strict(),
]);
export type ReviewLink = z.infer<typeof reviewLinkSchema>;

export const settlementLaneSchema = z.enum(["manualHistoricalPayable", "collabsAutoSettlement", "tiktokAutoSettlement", "notApplicable", "unknown"]);

export const approvalReviewSchema = z.object({
  state: z.enum(["complete", "partial", "unavailable"]),
  sourceVersionAlias: alias.nullable(), observedAt: instant.nullable(), validUntil: instant.nullable(),
  reasonCodes: z.array(reason).max(30),
  context: z.object({ provider: reviewFieldSchema, account: reviewFieldSchema, requestedBy: reviewFieldSchema,
    reviewer: reviewFieldSchema, historicalRole: reviewFieldSchema }).strict(),
  items: z.array(z.object({ itemRef: alias, recipient: reviewFieldSchema, product: reviewFieldSchema,
    terms: reviewFieldSchema, payload: reviewFieldSchema }).strict()).min(1).max(100),
  links: z.object({ approval: reviewLinkSchema, source: reviewLinkSchema, session: reviewLinkSchema,
    settlement: reviewLinkSchema }).strict(),
  settlement: z.object({ lane: settlementLaneSchema, detail: reviewFieldSchema }).strict(),
  confersAuthority: z.literal(false),
}).strict();
export type ApprovalReview = z.infer<typeof approvalReviewSchema>;

const historicalDecision = z.object({ decision: z.enum(["approved", "rejected", "editRequired", "canceled"]),
  decidedAt: instant, actorRef: alias, receiptRef: alias }).strict();
export const approvalHistorySchema = z.object({
  mode: z.enum(["current", "history"]), selectedVersion: count.positive(), latestVersion: count.positive(),
  records: z.array(z.object({ manifestVersion: count.positive(), createdAt: instant, expiresAt: instant,
    manifestRef: alias, decision: historicalDecision.nullable(), outcomeCount: count }).strict()).max(25),
  selectedDecisions: z.array(historicalDecision).max(100),
  totalVersions: count, hasMore: z.boolean(), nextBeforeVersion: count.positive().nullable(),
  confersAuthority: z.literal(false),
}).strict();
export type ApprovalHistory = z.infer<typeof approvalHistorySchema>;

export const runAttemptOutcomeSchema = z.object({
  state: z.enum(["unstarted", "open", "applied", "closedNotApplied", "unknown"]),
  attemptNumber: count.positive().nullable(), receiptRef: alias.nullable(), observedAt: instant.nullable(),
}).strict().superRefine((value, ctx) => {
  const terminal = value.state === "applied" || value.state === "closedNotApplied";
  if ((terminal && (!value.attemptNumber || !value.receiptRef || !value.observedAt)) ||
    (value.state === "open" && (!value.attemptNumber || value.receiptRef !== null)) ||
    ((value.state === "unstarted" || value.state === "unknown") && (value.attemptNumber !== null || value.receiptRef !== null)))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Attempt outcome must bind its exact recorded attempt and receipt." });
});
export type RunAttemptOutcome = z.infer<typeof runAttemptOutcomeSchema>;

export const runItemRecoverySchema = z.object({
  kind: z.enum(["login", "mfa", "denied", "throttled", "failed", "uncertain", "notApplicable", "unknown"]),
  owner: reviewFieldSchema,
  nextAction: z.enum(["signInAtSource", "completeMfaAtSource", "ownerPermissionReview", "waitForSourceReset", "inspectFailure", "reconcileOriginal", "none", "sourceEvidenceRequired"]),
  deadline: instant.nullable(), resetAt: instant.nullable(), reasonCodes: z.array(reason).max(30),
  observedAt: instant.nullable(), validUntil: instant.nullable(),
}).strict();
export type RunItemRecovery = z.infer<typeof runItemRecoverySchema>;

export const runItemExecutionSchema = z.object({
  state: itemStateSchema, attempts: count, dueAt: instant, updatedAt: instant, checkpointVersion: count,
  reasonCode: reason.nullable(), attemptOutcome: runAttemptOutcomeSchema, recovery: runItemRecoverySchema,
}).strict();
export type RunItemExecution = z.infer<typeof runItemExecutionSchema>;
