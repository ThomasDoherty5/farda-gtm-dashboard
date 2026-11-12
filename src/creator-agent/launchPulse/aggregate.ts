import { digest } from "../config.ts";
import { ownedOrderRows } from "../analytics/ownedOrderRows.ts";
import type { OrderRow } from "../analytics/sources.ts";
import { launchPulseContextSchema, type LaunchPulseContext, type LaunchPulseSourceSnapshot } from "./contract.ts";
import { launchPacificDay, type PulseSlot } from "./schedule.ts";

type Source = NonNullable<LaunchPulseSourceSnapshot["orders"]>["coverage"];
type Reason = NonNullable<LaunchPulseContext["commerce"]["reason"]>;
type Observed<T> = { sourceAsOf: string | null; reason: Reason | null; value: T | null };
const unknown = (source: Source | undefined, reason: Reason): Observed<never> =>
  ({ sourceAsOf: source?.sourceAsOf ?? null, reason, value: null });
const known = <T>(source: Source, value: T): Observed<T> => ({ sourceAsOf: source.sourceAsOf, reason: null, value });

function coverageIssue(source: Source | undefined, observedAt: number): Reason | null {
  if (!source?.sourceAsOf || source.state === "unavailable") return "missing";
  if (source.state !== "complete") return "partial";
  const asOf = Date.parse(source.sourceAsOf);
  if (asOf > observedAt) return "mismatch";
  return observedAt - asOf > source.maximumAgeMs ? "stale" : null;
}
function covers(input: { through: { start: string; end: string }; coverage: Source }, start: number, end: number) {
  return Date.parse(input.through.start) <= start && Date.parse(input.through.end) >= end &&
    Date.parse(input.through.end) <= Date.parse(input.coverage.sourceAsOf!);
}
const safeSum = (values: number[]) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
};
const rowsBetween = (rows: OrderRow[], start: number, end: number) =>
  rows.filter(row => Date.parse(row.placedAt) >= start && Date.parse(row.placedAt) < end);
function orderRollup(rows: OrderRow[]) {
  return {
    orders: rows.length,
    retainedUnits: rows.some(row => row.unitsRetained === null) ? null : safeSum(rows.map(row => row.unitsRetained!)),
    netReceiptsMinor: rows.some(row => row.currency !== "USD") ? null : safeSum(rows.map(row => row.netReceiptsMinor)),
  };
}

function commerce(source: LaunchPulseSourceSnapshot, slot: PulseSlot, observedAt: number) {
  const input = source.orders;
  const issue = coverageIssue(input?.coverage, observedAt);
  if (issue || !input) return { result: unknown(input?.coverage, issue ?? "missing"), sellingUnits: null };
  const start = Date.parse(slot.launchStart), day = Date.parse(slot.todayStart), end = Date.parse(slot.scheduledAt);
  const earliest = Math.min(start, day);
  const { snapshot } = input;
  const basisMismatch = digest(snapshot.scope) !== digest(source.scope) || snapshot.window.timezone !== slot.timezone ||
    snapshot.window.start > launchPacificDay(earliest) || snapshot.window.end < launchPacificDay(end - 1) || !covers(input, earliest, end);
  const owned = ownedOrderRows(snapshot.feeds);
  if (basisMismatch || owned.conflict) return { result: unknown(input.coverage, "mismatch"), sellingUnits: null };
  if (owned.channels.some(({ feed, mismatch }) => mismatch || !feed?.lastSuccessAt || feed.syncState === "error" ||
      feed.coverage !== "complete" || Date.parse(feed.observedAt) > observedAt ||
      observedAt - Date.parse(feed.lastSuccessAt) > input.coverage.maximumAgeMs)) {
    return { result: unknown(input.coverage, "partial"), sellingUnits: null };
  }
  const rows = owned.channels.flatMap(channel => channel.rows);
  const hour = orderRollup(rowsBetween(rows, Date.parse(slot.hourStart), end));
  const today = orderRollup(rowsBetween(rows, day, end));
  const launchRows = rowsBetween(rows, start, end), launch = orderRollup(launchRows);
  const attribution = { code: 0, utm: 0, platform: 0, unattributed: 0, unknown: 0 };
  const codes = new Map(input.creatorCodes.map(row => [row.canonicalOrderId, row.code]));
  const codeOrders = new Map<string, number>();
  let codeComplete = codes.size === input.creatorCodes.length;
  for (const row of launchRows) {
    attribution[row.attribution ?? "unknown"]++;
    if (row.attribution === null || row.codeOwner === "unknown") codeComplete = false;
    if (row.attribution !== "code" || row.codeOwner !== "creator") continue;
    const value = codes.get(row.canonicalOrderId!);
    if (!value) codeComplete = false;
    else codeOrders.set(value, (codeOrders.get(value) ?? 0) + 1);
  }
  const topCodes = codeComplete ? [...codeOrders].sort(([codeA, countA], [codeB, countB]) =>
    countB - countA || codeA.localeCompare(codeB)).slice(0, 3).map(([code, orders]) => ({ code, orders })) : null;
  const sellingUnits = orderRollup(rowsBetween(rows, Math.max(start, day), end)).retainedUnits;
  return { result: known(input.coverage, { hour, today, launch, attribution, topCodes }), sellingUnits };
}

function section<T extends { coverage: Source }, U>(input: T | null, at: number, select: (value: T) => U | null): Observed<U> {
  const issue = coverageIssue(input?.coverage, at);
  if (issue || !input) return unknown(input?.coverage, issue ?? "missing");
  const value = select(input);
  return value === null ? unknown(input.coverage, "mismatch") : known(input.coverage, value);
}

export function projectLaunchPulse(source: LaunchPulseSourceSnapshot, slot: PulseSlot, dashboardLink: string) {
  const observedAt = Date.parse(source.observedAt), at = Date.parse(slot.scheduledAt);
  const { result, sellingUnits } = commerce(source, slot, observedAt);
  const media = section(source.media, observedAt, value => {
    const unique = new Set(value.stages.map(row => `${row.platform}:${row.stage}`));
    return covers(value, Date.parse(slot.todayStart), at) && unique.size === value.stages.length ? value.stages : null;
  });
  const elapsed = (at - Math.max(Date.parse(slot.todayStart), Date.parse(slot.launchStart))) / 3_600_000;
  const stock = section(source.stock, observedAt, value => value.availableUnits === null ? null : {
    availableUnits: value.availableUnits,
    hoursOfCover: elapsed > 0 && sellingUnits !== null && sellingUnits > 0
      ? value.availableUnits / sellingUnits * elapsed : null,
  });
  const support = section(source.support, observedAt, value =>
    new Set(value.categories.map(row => row.category)).size === value.categories.length ? value.categories : null);
  const alerts = section(source.alerts, observedAt, value =>
    covers(value, Date.parse(slot.hourStart), at) &&
      new Set(value.conditions.map(row => row.kind)).size === value.conditions.length ? value.conditions : null);
  const orderResults = result.value;
  const partial = [result, media, stock, support, alerts].some(value => value.reason !== null) ||
    !orderResults?.topCodes || !!orderResults.attribution.unknown ||
    [orderResults.hour, orderResults.today, orderResults.launch].some(value => value.retainedUnits === null || value.netReceiptsMinor === null);
  return launchPulseContextSchema.parse({
    slot, dashboardLink, coverage: partial ? "partial" : "complete",
    commerce: result, media, stock, support, alerts,
  });
}
