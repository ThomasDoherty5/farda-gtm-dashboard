/**
 * Runtime schemas for the customer-lifecycle views (overview, email flows, consent and eligibility, activation and
 * retention) and the one write in the area, the email-flow draft.
 *
 * Strictness: `.strict()` is used only where an unexpected key is a real risk.
 *  - `consentEligibility`, the lifecycle overview and `activationRetention` hold aggregate counts only. No contact,
 *    consent record, send or health data may be copied here, so a key that is not in the schema (an email, a subscriber
 *    list, a per-device record) is refused, not stripped and not forwarded.
 *  - The flow draft payload: a key the owner never reviewed is a configuration nobody approved.
 * The email flow view keeps zod's default (unknown keys stripped) so the server can add display text.
 *
 * Value states: these views carry plain counts, not `ProvenanceValue`, so there is no "unknown" to confuse with zero here.
 * Every count is a required non-negative integer: a missing or null count fails instead of becoming 0. Consent
 * categories are mutually exclusive and must add up to the total, because unknown is never counted as opted in.
 * Saving a draft never enables or publishes a flow, and nothing here can say a message was sent.
 */
import { z } from "zod";
import { nativeLifecycleSchema, nativeEmailFlowSchema, nativeConsentSchema, nativeActivationSchema } from "@/creator-agent/lifecycle/contract";

export const FLOW_KEY_VALUES = ["setup", "early-access", "abandoned-checkout", "review-request"] as const;
export const flowKeySchema = z.enum(FLOW_KEY_VALUES);

const count = z.number().int().nonnegative();
const nonBlank = z.string().trim().min(1);
const context = z.object({ badge: nonBlank, text: z.string() });

/* ---------- lifecycleOverview ---------- */

export const lifecycleOverviewSchema = z
  .object({
    context,
    metrics: z.array(z.object({ label: nonBlank, value: count, context: z.string(), definition: z.string() })).min(1),
    flows: z.array(z.object({ key: flowKeySchema, name: nonBlank, entryExit: z.string(), gate: z.string(), state: z.string() })),
    activation: z.object({ paired: count, weekOne: count }),
    returnsAwaitingInspection: count,
    closeLoop: z.string(),
    closeLoopNote: z.string(),
    sources: z.string(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.activation.weekOne > v.activation.paired) ctx.addIssue({ code: "custom", path: ["activation", "weekOne"], message: "Week-one activations can't exceed paired devices" });
  });

/* ---------- emailFlow ---------- */

const flowStep = z.object({ n: nonBlank, title: nonBlank, note: z.string(), kind: nonBlank, hold: z.boolean().optional() });
const labeled = z.object({ value: nonBlank, help: z.string() });

export const emailFlowSchema = z.object({
  key: flowKeySchema,
  title: nonBlank,
  subtitle: z.string(),
  context,
  steps: z.array(flowStep).min(1),
  neverSendWhen: z.array(z.string()),
  nextOutcomes: z.array(z.tuple([z.string(), z.string()])),
  eligibilityNote: z.string(),
  changes: z.array(z.object({ action: z.string(), review: z.string(), result: z.string() })),
  entryEvent: labeled,
  timing: labeled,
  template: labeled,
  draft: z.object({ timing: nonBlank, template: nonBlank }),
  draftVersion: z.string().regex(/^v\d+$/),
  preview: z.object({ subject: nonBlank, body: z.array(z.string()) }),
  tests: z.array(z.object({ title: z.string(), result: z.string() })),
  footnote: z.string(),
});

/* ---------- consentEligibility ---------- */

export const consentEligibilitySchema = z
  .object({
    context,
    total: count,
    eligible: count,
    withdrawn: count,
    suppressed: count,
    unknown: count,
    exclusions: z.array(z.object({ reason: nonBlank, action: z.string(), recovery: z.string() })),
    footnote: z.string(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const sum = v.eligible + v.withdrawn + v.suppressed + v.unknown;
    if (sum !== v.total) ctx.addIssue({ code: "custom", path: ["total"], message: `Categories add up to ${sum}, not the total ${v.total}` });
  });

/* ---------- activationRetention ---------- */

export const activationRetentionSchema = z
  .object({
    context,
    cohort: z.object({ delivered: count, paired: count, weekOne: count, pairingFailureEvents: count }),
    horizons: z.array(z.object({ day: z.number().int().positive(), label: nonBlank, state: z.enum(["Defined", "Proposed"]) })),
    retentionNote: z.string(),
    reactivationNote: z.string(),
    footnote: z.string(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const { delivered, paired, weekOne } = v.cohort;
    if (paired > delivered) ctx.addIssue({ code: "custom", path: ["cohort", "paired"], message: "Paired devices can't exceed delivered" });
    if (weekOne > paired) ctx.addIssue({ code: "custom", path: ["cohort", "weekOne"], message: "Week-one activations can't exceed paired devices" });
  });

export const lifecycleViewSchemas: Record<string, z.ZodTypeAny> = {
  lifecycleOverview: z.union([nativeLifecycleSchema, lifecycleOverviewSchema]),
  emailFlow: z.union([nativeEmailFlowSchema, emailFlowSchema]),
  consentEligibility: z.union([nativeConsentSchema, consentEligibilitySchema]),
  activationRetention: z.union([nativeActivationSchema, activationRetentionSchema]),
};

/* ---------- actions ---------- */

/**
 * The draft an owner saves. Which timings are allowed for a flow is server policy, so it is not copied here: the server
 * answers VALIDATION_FAILED with field errors. The template is a name, not markup or variables.
 */
export const flowDraftPayloadSchema = z
  .object({
    timing: nonBlank,
    template: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^[^<>{}]*$/, "A template name can't contain markup or variables"),
  })
  .strict();

/**
 * `saveFlowDraft` is written with `saveResource` (resourceKind "configurationDraft", resourceRef "flow-<key>"), not
 * `submitAction`, because it never dispatches anything. It is listed here so the live adapter validates its payload too.
 * `enableFlow` is held by the server until a provider is selected, so it has no payload schema yet.
 */
export const lifecycleActionSchemas: Record<string, { payload: z.ZodTypeAny }> = {
  saveFlowDraft: { payload: flowDraftPayloadSchema },
};

/** The record returned by saving a flow draft: the saved draft, never an "enabled" or "sent" state. */
export const flowDraftRecordSchema = flowDraftPayloadSchema;
