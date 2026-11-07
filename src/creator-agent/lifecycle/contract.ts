import { z } from "zod";

/** Browser-safe lifecycle contracts. No recipient, device, provider session or send command is accepted. */
export const flowKeys = ["setup", "early-access", "abandoned-checkout", "review-request"] as const;
export const flowKeySchema = z.enum(flowKeys);
export const editableFlowKeys = ["early-access", "abandoned-checkout", "review-request"] as const;
export const flowResourceSchema = z.enum(["flow-early-access", "flow-abandoned-checkout", "flow-review-request"]);
export const lifecycleViewKeys = ["lifecycleOverview", "emailFlow", "consentEligibility", "activationRetention"] as const;
export type LifecycleViewKey = typeof lifecycleViewKeys[number];
export type FlowKey = typeof flowKeys[number];
export const refSchema = z.string().trim().min(1).max(240);
export const instantSchema = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), "A finite timestamp is required.");
export const timezoneSchema = z.string().min(1).max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }, "Unknown timezone.");
const text = z.string().trim().min(1).max(500);
const count = z.number().int().nonnegative().safe();
export const observedCountSchema = z.object({ value: count.nullable(), missingReason: text.nullable() }).strict()
  .refine(v => (v.value === null) === (v.missingReason !== null), "Unknown counts need a reason; observed counts do not.");
export type ObservedCount = z.infer<typeof observedCountSchema>;
export const cohortSchema = z.object({ ref: refSchema, start: instantSchema, end: instantSchema, timezone: timezoneSchema,
  definition: text, unit: z.enum(["people", "orders", "devices", "events"]), receipt: refSchema }).strict()
  .refine(v => Date.parse(v.start) < Date.parse(v.end), "Cohort start must precede its exclusive end.");
const purpose = z.enum(["marketing", "transactional-support", "review"]);
export const mandatoryPolicies = { recheckConsentBeforeSend: true, stopOnOptOutOrSuppression: true, preventDuplicateEnrollment: true } as const;
export const lockedPoliciesSchema = z.object({ recheckConsentBeforeSend: z.literal(true), stopOnOptOutOrSuppression: z.literal(true), preventDuplicateEnrollment: z.literal(true) }).strict();
export const entrySchema = z.object({ ref: refSchema, version: refSchema, label: text, purpose,
  trigger: z.enum(["confirmed-subscription", "eligible-abandoned-checkout", "setup-help-eligible", "confirmed-delivery"]) }).strict();
export const timingSchema = z.object({ ref: refSchema, version: refSchema, label: text, entryEventRef: refSchema, timezone: timezoneSchema,
  delayMinutes: count.nullable(), launchAt: instantSchema.nullable(), approval: z.enum(["proposed", "approved"]), approvalRef: refSchema.nullable() }).strict()
  .refine(v => v.approval !== "approved" || v.approvalRef !== null, "Approved timing requires source approval.");
export const templateSchema = z.object({ ref: refSchema, version: refSchema, label: text, claimPolicyVersion: refSchema,
  allowedVariables: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,50}$/)).max(30), approval: z.enum(["proposed", "approved"]), approvalRef: refSchema.nullable(),
  preview: z.object({ kind: z.enum(["synthetic", "approved-generic"]), subject: text, lines: z.array(text).max(20) }).strict().nullable() }).strict()
  .superRefine((v, c) => {
    if (v.approval === "approved" && v.approvalRef === null || v.preview?.kind === "approved-generic" && v.approval !== "approved") c.addIssue({ code: "custom", message: "Approved template material requires source approval." });
    const material = [v.preview?.subject ?? "", ...(v.preview?.lines ?? [])].join("\n");
    if ([...material.matchAll(/\{\{([^{}]+)\}\}/g)].some(m => !v.allowedVariables.includes(m[1]!.trim()))) c.addIssue({ code: "custom", message: "Template contains an unapproved variable." });
  });
export const evidenceBasisSchema = z.object({ catalogVersion: refSchema, policyVersion: refSchema, entryEventRef: refSchema,
  timingRuleRef: refSchema, templateRef: refSchema, templateVersion: refSchema }).strict();
export const flowEvidenceSchema = z.object({ kind: z.enum(["eligible-delivery", "unsubscribe", "suppression", "deduplication", "publication", "activation"]),
  state: z.enum(["passed", "failed", "published", "enabled", "paused", "unknown"]), receipt: refSchema.nullable(), observedAt: instantSchema.nullable(),
  validUntil: instantSchema.nullable(), basis: evidenceBasisSchema.nullable(), missingReason: text.nullable() }).strict()
  .superRefine((v, c) => {
    if (v.state !== "unknown" && (!v.receipt || !v.observedAt || !v.validUntil || !v.basis)) c.addIssue({ code: "custom", message: "Source evidence needs exact basis, receipt and lease." });
    if (v.observedAt && v.validUntil && Date.parse(v.validUntil) <= Date.parse(v.observedAt)) c.addIssue({ code: "custom", message: "Invalid evidence lease." });
    if (["publication", "activation"].includes(v.kind) ? ["passed", "failed"].includes(v.state) : ["published", "enabled", "paused"].includes(v.state)) c.addIssue({ code: "custom", message: "Evidence kind and state disagree." });
    if (v.kind === "publication" && ["enabled", "paused"].includes(v.state) || v.kind === "activation" && v.state === "published") c.addIssue({ code: "custom", message: "Publication and activation are separate." });
  });
export const outcomeSchema = z.object({ state: z.enum(["ineligible", "suppressed", "waiting", "queued", "sent", "delivered", "bounced", "failed", "paused", "unknown"]),
  count: observedCountSchema, receipt: refSchema.nullable(), reasonCode: text.nullable() }).strict()
  .refine(v => v.count.value === null || v.receipt !== null, "An observed outcome count requires a receipt.");
export const flowCatalogSchema = z.object({ flow: flowKeySchema, flowRef: refSchema, catalogVersion: refSchema, policyVersion: refSchema,
  purpose, draftAllowed: z.boolean(), entryEvents: z.array(entrySchema).min(1).max(10), timingRules: z.array(timingSchema).min(1).max(20),
  templates: z.array(templateSchema).min(1).max(20), eligibilityRules: z.array(text).max(20), cancellationRules: z.array(text).max(20),
  evidence: z.array(flowEvidenceSchema).max(30), outcomes: z.object({ cohort: cohortSchema, rows: z.array(outcomeSchema).max(10) }).strict().nullable(),
  recoveryOwner: refSchema.nullable() }).strict().superRefine((v, c) => {
    for (const list of [v.entryEvents, v.timingRules, v.templates]) if (new Set(list.map(x => x.ref)).size !== list.length) c.addIssue({ code: "custom", message: "Catalog references must be unique." });
    if (v.timingRules.some(t => !v.entryEvents.some(e => e.ref === t.entryEventRef)) || v.entryEvents.some(e => e.purpose !== v.purpose)) c.addIssue({ code: "custom", message: "Catalog event/purpose mismatch." });
    const expected = { setup: "setup-help-eligible", "early-access": "confirmed-subscription", "abandoned-checkout": "eligible-abandoned-checkout", "review-request": "confirmed-delivery" };
    if (v.entryEvents.some(e => e.trigger !== expected[v.flow])) c.addIssue({ code: "custom", message: "An event cannot enroll an unrelated flow." });
    if (v.outcomes && new Set(v.outcomes.rows.map(r => r.state)).size !== v.outcomes.rows.length) c.addIssue({ code: "custom", message: "Duplicate source outcome categories." });
  });
export type FlowCatalog = z.infer<typeof flowCatalogSchema>;
export const consentAggregateSchema = z.object({ cohort: cohortSchema, purpose, categoryDefinitionVersion: refSchema,
  total: observedCountSchema, eligible: observedCountSchema, withdrawn: observedCountSchema, suppressed: observedCountSchema, unknown: observedCountSchema,
  exclusions: z.array(z.object({ reason: text, recovery: text }).strict()).max(20) }).strict().superRefine((v, c) => {
    const values = [v.eligible.value, v.withdrawn.value, v.suppressed.value, v.unknown.value];
    const sum = values.reduce<number>((s, n) => s + (n ?? 0), 0);
    if (v.cohort.unit !== "people" || !Number.isSafeInteger(sum) || v.total.value !== null && (sum > v.total.value || values.every(n => n !== null) && sum !== v.total.value))
      c.addIssue({ code: "custom", message: "Exclusive consent categories require one matching population and safe total." });
  });
export const activationAggregateSchema = z.object({ cohort: cohortSchema, delivered: observedCountSchema, paired: observedCountSchema,
  weekOne: observedCountSchema, pairingFailureEvents: observedCountSchema, weekOneDefinition: z.literal("first-seven-days-after-delivery"),
  privacyApproval: z.object({ state: z.enum(["approved", "unverified"]), receipt: refSchema.nullable() }).strict(),
  laterRetention: z.array(z.object({ day: z.number().int().min(8).max(365), state: z.literal("proposed") }).strict()).max(10) }).strict().superRefine((v, c) => {
    if (v.cohort.unit !== "devices" || v.paired.value !== null && v.delivered.value !== null && v.paired.value > v.delivered.value ||
      v.weekOne.value !== null && v.paired.value !== null && v.weekOne.value > v.paired.value || v.privacyApproval.state === "approved" && !v.privacyApproval.receipt)
      c.addIssue({ code: "custom", message: "Anonymous activation needs matching device denominators and privacy proof." });
  });
export const draftPayloadSchema = z.object({ entryEventRef: refSchema, timingRuleRef: refSchema, timezone: timezoneSchema,
  templateRef: refSchema, templateVersion: refSchema,
  templateName: z.string().trim().min(3).max(80).regex(/^[^<>{}\r\n]*$/, "Use a local title without markup or variables.") }).strict();
export type FlowDraft = z.infer<typeof draftPayloadSchema>;
export const lifecycleFilters = {
  lifecycleOverview: z.object({}).strict(), emailFlow: z.object({ flow: flowKeySchema, draftRequestKey: refSchema.optional() }).strict(),
  consentEligibility: z.object({}).strict(), activationRetention: z.object({}).strict(),
};
export const saveDraftSchema = z.object({ resourceKind: z.literal("configurationDraft"), resourceRef: flowResourceSchema,
  expectedVersion: z.string().regex(/^lf1-[a-f0-9]{64}$/), payload: draftPayloadSchema, idempotencyKey: refSchema }).strict();
export type SaveDraftInput = z.infer<typeof saveDraftSchema>;
export const draftRecordSchema = z.object({ kind: z.literal("local-flow-draft"), flow: z.enum(editableFlowKeys), revision: count.positive(),
  payload: draftPayloadSchema, sourceVersion: refSchema, catalogVersion: refSchema, policyVersion: refSchema, templateVersion: refSchema,
  lockedPolicies: lockedPoliciesSchema, savedAt: instantSchema, savedBy: refSchema }).strict();
export type DraftRecord = z.infer<typeof draftRecordSchema>;
export const saveReceiptSchema = z.object({ resourceRef: flowResourceSchema, resourceVersion: z.string().regex(/^lf1-[a-f0-9]{64}$/),
  scope: z.object({ workspaceId: refSchema, accountId: refSchema, environment: z.literal("sandbox") }).strict(),
  persistedAt: instantSchema, persistedByRef: refSchema, record: draftRecordSchema, reasonCodes: z.array(text), requestKey: refSchema,
  expectedVersion: refSchema, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SaveReceipt = z.infer<typeof saveReceiptSchema>;
export const requestedSaveSchema = z.object({ state: z.enum(["applied", "notApplied", "unknown"]), disposition: z.enum(["recorded", "rejected", "absent", "unverified"]),
  requestKey: refSchema, resourceRef: flowResourceSchema, actorRef: refSchema, expectedVersion: refSchema.nullable(), payloadDigest: refSchema.nullable(),
  original: z.object({ payload: draftPayloadSchema, expectedVersion: refSchema }).strict().nullable(),
  receipt: saveReceiptSchema.nullable(), reasonCode: text.nullable() }).strict();
const header = { observedAt: instantSchema, actorRef: refSchema, sourceAsOf: instantSchema.nullable(), sourceVersion: refSchema.nullable(),
  validUntil: instantSchema.nullable(), freshness: z.enum(["current", "stale", "unknown"]), coverage: z.enum(["complete", "partial", "unknown"]),
  sourceState: z.enum(["current", "partial", "expired", "unavailable", "unconfigured"]), missingReason: text.nullable(), sourceLink: z.null() };
export const nativeLifecycleSchema = z.object({ ...header, kind: z.literal("source-lifecycle"), flows: z.array(flowCatalogSchema),
  consent: consentAggregateSchema.nullable(), activation: activationAggregateSchema.nullable(), returnsAwaitingInspection: observedCountSchema }).strict();
export const nativeEmailFlowSchema = z.object({ ...header, kind: z.literal("source-email-flow"), flow: flowKeySchema, sourceConfig: flowCatalogSchema.nullable(),
  lockedPolicies: lockedPoliciesSchema, draft: draftRecordSchema.nullable(), draftVersion: refSchema, currentSourceMatch: z.boolean(),
  history: z.object({ total: count, truncated: z.boolean(), rows: z.array(draftRecordSchema).max(20) }).strict(),
  requestedSave: requestedSaveSchema.nullable(), saveHoldReasons: z.array(text) }).strict();
export const nativeConsentSchema = z.object({ ...header, kind: z.literal("source-consent"), consent: consentAggregateSchema.nullable() }).strict();
export const nativeActivationSchema = z.object({ ...header, kind: z.literal("source-activation"), activation: activationAggregateSchema.nullable() }).strict();
export type NativeLifecycle = z.infer<typeof nativeLifecycleSchema>;
export type NativeEmailFlow = z.infer<typeof nativeEmailFlowSchema>;
export type NativeConsent = z.infer<typeof nativeConsentSchema>;
export type NativeActivation = z.infer<typeof nativeActivationSchema>;
export type NativeLifecycleData = NativeLifecycle | NativeEmailFlow | NativeConsent | NativeActivation;
