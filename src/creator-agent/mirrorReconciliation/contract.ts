import { z } from "zod";
import { operationsControlSourceSchema } from "../operationsControlsSchema.ts";

/**
 * The comparison and conflict shapes are owned by `operationsControlsSchema.ts`. They are read from the exported source
 * schema rather than copied, so a change there changes what this module must produce.
 */
const sourceShape = operationsControlSourceSchema.innerType().shape;
export const reconciliationComparisonSchema = sourceShape.comparisons.element;
export const reconciliationConflictSchema = sourceShape.conflicts.element;
export type ReconciliationComparison = z.output<typeof reconciliationComparisonSchema>;
export type ReconciliationConflict = z.output<typeof reconciliationConflictSchema>;
export type ReconciliationGrain = ReconciliationComparison["grain"];
export type ReconciliationCategory = ReconciliationConflict["category"];
export type ReconciliationCoverage = ReconciliationComparison["coverage"];
/** The schema's limit on comparisons and on conflicts in one operations-control source snapshot. */
export const SOURCE_SLICE_LIMIT = 100;

const GRAINS = ["order", "shipment", "inventory", "support", "finance-summary"] as const satisfies readonly ReconciliationGrain[];
const AMOUNT_FIELDS = ["net-sales", "label-cost", "refund-total"] as const satisfies readonly ReconciliationConflict["field"][];

const refPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const ref = (max: number) => z.string().min(1).max(max).regex(refPattern).refine(v => !/^https?:/i.test(v), "Use a reference.");
const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
const currency = z.string().regex(/^[A-Z]{3}$/);
const timezone = z.string().min(1).max(64).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } },
  "Use an IANA timezone.");
/** A period is one local calendar day in the schedule's timezone. */
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "Use a real date.");
const minorUnits = z.number().int().safe();

export const expectedDatasetSchema = z.object({
  scope: ref(80), grain: z.enum(GRAINS), amountField: z.enum(AMOUNT_FIELDS),
  /** Currencies always compared for this dataset, so a complete read with no rows is a known zero rather than an absent row. */
  currencies: z.array(currency).min(1).max(10),
}).strict().refine(d => new Set(d.currencies).size === d.currencies.length, "Duplicate currency.");

/** AC1: the check schedule record. */
export const checkScheduleSchema = z.object({
  checkId: ref(80),
  version: z.number().int().positive().safe(),
  timezone,
  /** Local wall time of the daily check. */
  runAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  /** A period may be checked only once its end plus this lag has passed; the result is the comparison cutoff. */
  cutoffLagMinutes: z.number().int().min(0).max(7 * 24 * 60),
  /** How many past due periods each scheduled run rechecks. */
  coverage: z.object({ lookbackDays: z.number().int().min(1).max(31) }).strict(),
  expectedDatasets: z.array(expectedDatasetSchema).min(1).max(50),
}).strict().refine(s => new Set(s.expectedDatasets.map(d => `${d.scope}\u0000${d.grain}`)).size === s.expectedDatasets.length, "Duplicate expected dataset.");
export type CheckSchedule = z.infer<typeof checkScheduleSchema>;
export type ExpectedDataset = z.infer<typeof expectedDatasetSchema>;

/** One source or mirror row. `read` is the row-level coverage flag: a partial row was seen but its amount is not trusted. */
export const reconciliationRowSchema = z.object({
  key: ref(200), scope: ref(80), grain: z.enum(GRAINS), period: localDate, currency, amountMinor: minorUnits,
  read: z.enum(["complete", "partial"]),
}).strict();
export type ReconciliationRow = z.infer<typeof reconciliationRowSchema>;

/**
 * Dataset-level read coverage for one side, scope, grain and period. A dataset with no declaration is `unknown`. `readAt`
 * is when the read finished; a read that finished before the period's cutoff cannot prove completeness.
 */
export const readCoverageSchema = z.object({
  side: z.enum(["source", "mirror"]), scope: ref(80), grain: z.enum(GRAINS), period: localDate,
  state: z.enum(["complete", "partial", "failed"]), version: ref(120), readAt: instant,
}).strict();
export type ReadCoverage = z.infer<typeof readCoverageSchema>;

export const checkInputSchema = z.object({
  runId: ref(120), checkId: ref(80), scheduleVersion: z.number().int().positive().safe(),
  periods: z.array(localDate).min(1).max(31),
  coverage: z.array(readCoverageSchema).max(2000),
  sourceRows: z.array(reconciliationRowSchema).max(50_000),
  mirrorRows: z.array(reconciliationRowSchema).max(50_000),
}).strict().superRefine((v, c) => {
  if (new Set(v.periods).size !== v.periods.length) c.addIssue({ code: "custom", message: "Duplicate period." });
  const keys = v.coverage.map(d => [d.side, d.scope, d.grain, d.period].join("\u0000"));
  if (new Set(keys).size !== keys.length) c.addIssue({ code: "custom", message: "Duplicate read coverage." });
});
export type CheckInput = z.infer<typeof checkInputSchema>;

export type ComparisonOutcome = "matched" | "differences" | "incomplete" | "unknown";
export type RunOutcome = "matched" | "differences" | "incomplete";
export type ComparisonResult = {
  comparison: ReconciliationComparison;
  group: { scope: string; grain: ReconciliationGrain; period: string; currency: string; expected: boolean };
  outcome: ComparisonOutcome;
  findingFingerprints: string[];
};
export type ReconciliationFinding = {
  /** Stable across runs: identical findings share it, which is what suppression keys on. */
  fingerprint: string;
  comparisonId: string;
  /** The record key the finding is about. It stays server side; the conflict itself carries no key. */
  recordKey: string;
  side: "source" | "mirror" | "both";
  conflict: ReconciliationConflict;
};
export type CheckResult = {
  runId: string; checkId: string; scheduleVersion: number; observedAt: string; outcome: RunOutcome;
  comparisons: ComparisonResult[]; findings: ReconciliationFinding[];
};

export class MirrorReconciliationError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}
