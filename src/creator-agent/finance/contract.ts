import { z } from "zod";

/** Finance (THO-303) and payable/settlement (THO-300) read models served at the authenticated `/v1/read` boundary. Read only. */
export const financeViewKeys = ["financeDashboard", "periodClose", "monthsHistory", "closePackage", "reportManifest",
  "commissionLedger", "settlementDetail", "payableDetail"] as const;
export type FinanceViewKey = (typeof financeViewKeys)[number];
export const isFinanceViewKey = (value: string): value is FinanceViewKey => (financeViewKeys as readonly string[]).includes(value);

const ref = z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/**
 * Exact filters per view. D-11: `scenario` and `fixture` are demo-only and are refused here, so a demo selector can never
 * pick what the service answers. No view accepts a free-form query.
 */
export const financeFilters = {
  financeDashboard: z.object({}).strict(),
  commissionLedger: z.object({}).strict(),
  monthsHistory: z.object({}).strict(),
  reportManifest: z.object({}).strict(),
  periodClose: z.object({ period }).strict(),
  closePackage: z.object({ period }).strict(),
  settlementDetail: z.object({ settlementId: ref }).strict(),
  payableDetail: z.object({ payableId: ref }).strict(),
} satisfies Record<FinanceViewKey, z.ZodTypeAny>;

/** Detail views name one record. An absent record inside the verified scope is RECORD_NOT_FOUND (Q-02), never an empty success. */
export const financeDetailViews: ReadonlySet<FinanceViewKey> = new Set(["periodClose", "closePackage", "settlementDetail", "payableDetail"]);

const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const reasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);

/**
 * What an injected server-only source reader must return for one view. The reader is never supplied by a browser request.
 * `record: null` is the source's own statement that nothing exists for this address; it is not used for an unread source.
 */
export const financeSnapshotSchema = z.object({
  scope: z.object({ workspaceId: z.string().min(1), accountId: z.string().min(1), environment: z.literal("sandbox") }).strict(),
  viewKey: z.enum(financeViewKeys),
  version: ref,
  principalRef: ref,
  permissionVersion: ref,
  observedAt: instant,
  validUntil: instant,
  coverage: z.object({ state: z.enum(["complete", "partial"]), expectedCount: count.nullable(), observedCount: count.nullable(),
    reasonCodes: z.array(reasonCode).max(20) }).strict(),
  currency: z.literal("USD"),
  period: period.nullable(),
  record: z.unknown().refine(value => value !== undefined, "A record or an explicit null is required."),
}).strict().superRefine((s, ctx) => {
  if (Date.parse(s.validUntil) <= Date.parse(s.observedAt)) ctx.addIssue({ code: "custom", message: "Invalid source lease." });
  const { state, expectedCount, observedCount, reasonCodes } = s.coverage;
  if (expectedCount !== null && observedCount !== null && observedCount > expectedCount) ctx.addIssue({ code: "custom", message: "Observed exceeds expected." });
  if (state === "complete" && (expectedCount === null || observedCount !== expectedCount)) ctx.addIssue({ code: "custom", message: "Complete coverage needs equal known counts." });
  if (state === "partial" && reasonCodes.length === 0) ctx.addIssue({ code: "custom", message: "Partial coverage needs a reason." });
  // "Nothing exists" is only a complete answer when the source counted zero expected rows; otherwise it is unknown, not empty.
  if (s.record === null && state === "complete" && expectedCount !== 0) ctx.addIssue({ code: "custom", message: "An empty record needs a counted zero." });
});
export type FinanceSnapshot = z.infer<typeof financeSnapshotSchema>;
