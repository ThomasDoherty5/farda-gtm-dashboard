/** Monetary values are in minor units. An obligation identifies the economic cost; a cash ID identifies its settlement. */
export const COST_ALLOCATION_VERSION = "economic-events@1";
export type CostBasis = "paid" | "accrued" | "estimated";
export type ReportingWindow = { start: string; end: string; timezone: string };
export type CostScope = { cohortId: string; currency: string; period: ReportingWindow; coverage: "complete" | "partial" | "unknown" };
export type CostBucket = {
  key: string; label: string; basis: CostBasis; minorUnits: number | null; alsoInCash: boolean;
  cohortId?: string; obligationId?: string; evidenceId?: string; cashId?: string | null; currency?: string; period?: ReportingWindow;
};
export type CostAllocation = {
  totalMinor: number | null; cashPaidMinor: number | null; byBasis: Record<CostBasis, number> | null;
  state: "known" | "provisional" | "unresolved"; duplicates: string[]; diagnostics: string[];
};

const currencies = new Set<string>(Intl.supportedValuesOf("currency"));
export const isCurrency = (code: string) => currencies.has(code);
function validDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const time = Date.parse(day);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day;
}
export function validReportingWindow(w: ReportingWindow | undefined): w is ReportingWindow {
  if (!w || !validDay(w.start) || !validDay(w.end) || w.start > w.end || !w.timezone?.trim()) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: w.timezone }); return true; }
  catch { return false; }
}
export const sameReportingWindow = (a: ReportingWindow, b: ReportingWindow) => a.start === b.start && a.end === b.end && a.timezone === b.timezone;
const present = (v: string | null | undefined): v is string => !!v?.trim();
const safeMinor = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const rank: Record<CostBasis, number> = { estimated: 0, accrued: 1, paid: 2 };
export function allocateCosts(rows: readonly CostBucket[], scope?: CostScope): CostAllocation {
  const diagnostics = new Set<string>();
  const duplicates = new Set<string>();
  const obligations = new Map<string, { amount: number; basis: CostBasis; cashId: string | null }>();
  const evidence = new Map<string, Set<string>>();
  const settlements = new Map<string, string>();
  const units = new Set<string>();
  const windows = new Set<string>();
  const cohorts = new Set<string>();
  if (!rows.length) diagnostics.add("NO_COST_OBSERVATIONS");
  if (!scope) diagnostics.add("COST_SCOPE_UNVERIFIED");
  if (scope && (scope.coverage !== "complete" || !present(scope.cohortId) || !validReportingWindow(scope.period) || !isCurrency(scope.currency))) diagnostics.add("COST_SCOPE_INCOMPLETE");
  for (const row of rows) {
    if (!present(row.cohortId)) { diagnostics.add("MISSING_COST_COHORT"); continue; }
    cohorts.add(row.cohortId);
    if (scope && row.cohortId !== scope.cohortId) diagnostics.add("COST_COHORT_MISMATCH");
    if (!present(row.obligationId) || !present(row.evidenceId)) { diagnostics.add("MISSING_OBLIGATION_OR_EVIDENCE_ID"); continue; }
    if ([row.obligationId, row.evidenceId, row.cashId].some(id => id != null && (!id || id !== id.trim()))) {
      diagnostics.add("INVALID_ECONOMIC_IDENTITY"); continue;
    }
    if (!safeMinor(row.minorUnits)) { diagnostics.add("UNKNOWN_OR_INVALID_AMOUNT"); continue; }
    if (!row.currency || !isCurrency(row.currency)) { diagnostics.add("INVALID_CURRENCY"); continue; }
    if (!validReportingWindow(row.period)) { diagnostics.add("INVALID_REPORTING_WINDOW"); continue; }
    units.add(row.currency);
    windows.add(JSON.stringify([row.period.start, row.period.end, row.period.timezone]));
    if (scope && row.currency !== scope.currency) diagnostics.add("CURRENCY_MISMATCH");
    if (scope && !sameReportingWindow(row.period, scope.period)) diagnostics.add("REPORTING_WINDOW_MISMATCH");
    const cash = row.basis === "paid" || row.alsoInCash;
    if (cash !== present(row.cashId)) diagnostics.add("CASH_IDENTITY_UNRESOLVED");
    const fingerprint = JSON.stringify([row.obligationId, row.cohortId, row.basis, row.minorUnits, row.currency, row.period.start, row.period.end, row.period.timezone, cash, row.cashId ?? null]);
    const observations = evidence.get(row.evidenceId) ?? new Set<string>();
    if (observations.has(fingerprint)) duplicates.add(row.evidenceId);
    observations.add(fingerprint); evidence.set(row.evidenceId, observations);
    if (observations.size > 1) diagnostics.add("EVIDENCE_CONFLICT");
    if (row.basis === "estimated" && cash) diagnostics.add("ESTIMATED_CASH_UNVERIFIED");
    const existing = obligations.get(row.obligationId);
    if (existing && existing.amount !== row.minorUnits) diagnostics.add("OBLIGATION_AMOUNT_CONFLICT");
    if (cash && row.cashId) {
      const owner = settlements.get(row.cashId);
      if (owner && owner !== row.obligationId) diagnostics.add("CASH_ALLOCATION_CONFLICT");
      if (existing?.cashId && existing.cashId !== row.cashId) diagnostics.add("MULTIPLE_SETTLEMENTS_UNRECONCILED");
      settlements.set(row.cashId, row.obligationId);
    }
    obligations.set(row.obligationId, {
      amount: row.minorUnits,
      basis: existing && rank[existing.basis] >= rank[row.basis] ? existing.basis : row.basis,
      cashId: existing?.cashId ?? (cash ? row.cashId ?? null : null),
    });
  }
  if (cohorts.size > 1) diagnostics.add("COST_COHORT_MISMATCH");
  if (units.size > 1) diagnostics.add("CURRENCY_MISMATCH");
  if (windows.size > 1) diagnostics.add("REPORTING_WINDOW_MISMATCH");
  const repeats = [...duplicates].sort();
  const unresolved = (): CostAllocation => ({ totalMinor: null, cashPaidMinor: null, byBasis: null,
    state: "unresolved", duplicates: repeats, diagnostics: [...diagnostics].sort() });
  if (diagnostics.size) return unresolved();
  const byBasis: Record<CostBasis, number> = { paid: 0, accrued: 0, estimated: 0 };
  let total = 0, cash = 0;
  for (const event of obligations.values()) {
    byBasis[event.basis] += event.amount;
    total += event.amount;
    if (event.cashId) cash += event.amount;
  }
  if (!safeMinor(total) || !safeMinor(cash)) diagnostics.add("AMOUNT_OUT_OF_RANGE");
  if (diagnostics.size) return unresolved();
  const estimated = [...obligations.values()].some(obligation => obligation.basis === "estimated");
  return { totalMinor: total, cashPaidMinor: cash, byBasis, state: estimated ? "provisional" : "known", duplicates: repeats, diagnostics: [] };
}
