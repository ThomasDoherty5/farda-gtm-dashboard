import { z } from "zod";
import { approvalPhaseSchema, approvalInstantSchema as instant, approvalRefSchema as ref, versionRequirementSchema } from "../approvals/contract.ts";
import { jobRunViewSchema } from "../jobs/schema.ts";
import { readinessPayloadSchema } from "./contract.ts";
import { readinessEntityRefSchema } from "./wire.ts";
import { commercialEligibilityViewSchema } from "../commercialPolicy/views.ts";
import { providerOutcomeSchema } from "../jobs/dispatchSchema.ts";
import { approvalReviewSchema, approvalHistorySchema, runItemExecutionSchema } from "./reviewViews.ts";

const count = z.number().int().nonnegative().safe();
const current = z.object({ state: z.enum(["pending", "held", "approved", "rejected", "editRequired", "canceled"]), reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)) }).strict();
export const approvalExecutionSchema = z.object({
  runs:z.array(z.object({runRef:ref,state:jobRunViewSchema.shape.state,executionCertainty:z.enum(["notApplied","applied","uncertain"]),
    confirmedItems:count.max(100),providerAcceptedItems:count.max(100),providerRejectedItems:count.max(100),localArtifactItems:count.max(100),unknownOutcomeItems:count.max(100),totalItems:count.min(1).max(100)}).strict()).max(25),
  coverage:z.object({returned:count.max(25),total:count,complete:z.boolean()}).strict(),
}).strict().superRefine((value,ctx)=>{
  if(value.coverage.returned!==value.runs.length || value.coverage.total<value.runs.length || value.coverage.complete!==(value.coverage.total===value.runs.length) || new Set(value.runs.map(run=>run.runRef)).size!==value.runs.length)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"Execution coverage must describe the exact returned unique runs."});
  for(const [index,run] of value.runs.entries()){
    const known=run.providerAcceptedItems+run.providerRejectedItems+run.localArtifactItems;
    if(run.confirmedItems<known || run.confirmedItems>run.totalItems || run.unknownOutcomeItems<run.confirmedItems-known || run.unknownOutcomeItems>run.totalItems-known)
      ctx.addIssue({code:z.ZodIssueCode.custom,path:["runs",index],message:"Receipt and known-outcome counts must reconcile without inferring provider success."});
  }
});
/** Browser-safe projection, deliberately excluding source locators, raw payloads and provider identities. */
export const nativeApprovalViewSchema = z.object({ kind: z.literal("native-approval"), approvalRef: ref, manifestRef: ref, version: ref,
  actionKind: ref, policyVersion: ref, phase: approvalPhaseSchema, manifestVersion: count.positive(), current, createdAt: instant, expiresAt: instant,
  bounds: z.object({ maxItems: count.max(100), maxUnits: count, maxSpendMinor: count, currency: z.literal("USD") }).strict(),
  exposure: z.discriminatedUnion("state", [z.object({ state: z.literal("known"), minor: count, currency: z.literal("USD") }).strict(), z.object({ state: z.literal("unknown"), reason: z.literal("Authoritative economic exposure unavailable") }).strict()]),
  authorization: z.object({ kind: z.literal("mediaStageCap"), accountKind: z.literal("internalGovernance"),
    capMinor: count.positive(), currency: z.literal("USD"), allocationHash: z.string().regex(/^[a-f0-9]{64}$/),
    immediateProviderSpendMinor: z.literal(0) }).strict().optional(),
  items: z.array(z.object({ itemRef: ref, targetRef: ref, itemVersion: ref, units: count, spendMinor: count,
    commercialApplicability: z.enum(["required", "notApplicable"]).optional(), commercialEligibility: commercialEligibilityViewSchema.optional() }).strict()).min(1).max(100),
  versions: z.object({ product: versionRequirementSchema, terms: versionRequirementSchema, rights: versionRequirementSchema }).strict(),
  requestState: z.enum(["local", "recorded", "uncertain"]), sourceEffect: z.literal("none"),
  decision: z.object({ receiptRef: ref, decision: z.enum(["approved", "rejected", "editRequired", "canceled"]), decidedAt: instant, actorRef: ref }).strict().nullable(),
  appDecision: z.object({ allowed: z.literal(false), reasonCode: z.literal("APPROVAL_CHANNEL_REQUIRED") }).strict(), approvedIsSent: z.literal(false),
  review: approvalReviewSchema.optional(), history: approvalHistorySchema.optional(), execution:approvalExecutionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.phase === "mediaStageRelease") {
    if (!value.authorization || value.actionKind !== "media.stageRelease" || value.exposure.state !== "known" ||
      value.authorization.capMinor !== value.exposure.minor || value.authorization.capMinor !== value.bounds.maxSpendMinor ||
      value.items.length !== 1 || value.bounds.maxItems !== 1 || value.bounds.maxUnits !== 0 ||
      value.items.some(item => item.units !== 0 || item.spendMinor !== 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Stage authorization must expose its full cap and zero immediate provider spend." });
  } else if (value.authorization) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Stage cap metadata requires its exact phase." });
});
export type NativeApprovalView = z.infer<typeof nativeApprovalViewSchema>;
export const nativeRunViewSchema = z.object({ kind: z.literal("native-run"), runRef: ref, version: ref, approvalRef: ref, manifestRef: ref,
  state: jobRunViewSchema.shape.state, control: jobRunViewSchema.shape.control,
  current: z.object({ state: z.enum(["held", "ready", "running", "completed", "uncertain", "cancelled"]), reasonCodes: z.array(z.string()) }).strict(),
  executionCertainty: z.enum(["notApplied", "applied", "uncertain"]), counts: jobRunViewSchema.shape.counts, usage: jobRunViewSchema.shape.usage,
  providerRejectedCount: count.optional(),
  review: approvalReviewSchema.optional(), approvalManifestVersion: count.positive().optional(),
  items: z.array(z.object({ itemRef: ref, receiptRef: ref.nullable(), sourceEffect: z.enum(["localArtifact", "providerApplied"]).nullable(), observedAt: instant.nullable(),
    providerOutcome: providerOutcomeSchema.optional(), commercialApplicability: z.enum(["required", "notApplicable"]).optional(), commercialEligibility: commercialEligibilityViewSchema.optional(), execution: runItemExecutionSchema.optional() }).strict()).min(1).max(100),
}).strict().superRefine((value,ctx)=>{
  if(value.providerRejectedCount!==undefined && value.providerRejectedCount!==value.items.filter(item=>item.providerOutcome?.state==="rejected").length)
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"Recorded rejection count must match the exact returned items."});
  if(value.items.some(item=>item.providerOutcome && (!item.receiptRef || item.sourceEffect!=="providerApplied" || !item.observedAt)))
    ctx.addIssue({code:z.ZodIssueCode.custom,message:"Provider outcomes require an actual observed native receipt."});
});
export type NativeRunView = z.infer<typeof nativeRunViewSchema>;
export const readinessRecoveryIntentSchema = z.object({ operation: z.literal("recordSourceDecision"), actionKind: z.literal("recordLaunchReadiness"),
  requestKey: ref, actorRef: ref, targetRef: ref, expectedVersion: ref, entityRefs: z.tuple([readinessEntityRefSchema]),
  payload: readinessPayloadSchema, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const readinessPublicReceiptSchema = z.object({ kind: z.literal("launch-readiness-record"), receiptRef: ref, recordedVersion: ref,
  recordedAt: instant, provider: z.literal("notion"), requestKey: ref, actorRef: ref, targetRef: ref, expectedVersion: ref,
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), confersRelease: z.literal(false),
}).strict();
export const readinessRequestRecoverySchema = z.object({ requestKey: ref, state: z.enum(["recorded", "pending", "notApplied", "notFound", "unverified"]),
  intent: readinessRecoveryIntentSchema.nullable(), receipt: readinessPublicReceiptSchema.nullable(),
  terminalProof: z.object({ receiptRef: ref, observedAt: instant }).strict().nullable(), reasonCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
}).strict().superRefine((value, ctx) => {
  const { intent, receipt, terminalProof, state } = value;
  let valid: boolean;
  if (state === "notFound" || state === "unverified") valid = intent === null && receipt === null && terminalProof === null;
  else {
    valid = intent !== null && intent.requestKey === value.requestKey && intent.entityRefs[0].canonicalId === intent.targetRef && intent.entityRefs[0].provenanceRef === intent.expectedVersion;
    if (state === "recorded") valid = valid && receipt !== null && terminalProof === null && receipt.requestKey === value.requestKey &&
      receipt.actorRef === intent?.actorRef && receipt.targetRef === intent.targetRef && receipt.expectedVersion === intent.expectedVersion && receipt.payloadDigest === intent.payloadDigest;
    else valid = valid && receipt === null && (state === "notApplied" ? terminalProof !== null : terminalProof === null);
  }
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Recovery must bind the exact original intent and matching source outcome." });
});
export type ReadinessRequestRecovery = z.infer<typeof readinessRequestRecoverySchema>;
export const nativeReadinessViewSchema = z.object({ kind: z.literal("native-launch-readiness"), targetRef: ref, version: ref, actorRef: ref,
  observedAt: instant, validUntil: instant, launchDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), launchDateApproved: z.boolean(),
  phase: z.enum(["review", "effective-l-minus-4"]), phaseAllowed: z.boolean(), policyVersion: ref,
  gates: z.array(z.object({ id: ref, required: z.boolean(), state: z.enum(["pass", "fail", "unknown"]), evidenceRef: ref.nullable() }).strict()).min(1).max(100),
  evidenceRefs: z.array(ref).min(1).max(100), confersRelease: z.literal(false), requestRecovery: readinessRequestRecoverySchema.nullable(),
}).strict();
export type NativeReadinessView = z.infer<typeof nativeReadinessViewSchema>;
