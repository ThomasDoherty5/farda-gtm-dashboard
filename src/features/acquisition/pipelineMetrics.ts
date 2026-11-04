import type { Money } from "@/adapter/contract";
import { CURRENT_STAGES, PIPELINE_STAGES, type CurrentStageKey, type PipelineData, type SourceFacts } from "@/fixtures/pipeline";

/** Sums values across sources. One unknown makes the total unknown: a missing part is never counted as zero. */
export const sum = (values: (number | null)[]): number | null => (values.some((v) => v === null) ? null : values.reduce<number>((a, v) => a + (v ?? 0), 0));

/** A rate as a one-decimal percentage, or null when the denominator is missing or zero. */
export const percent = (numerator: number | null, denominator: number | null): string | null =>
  numerator === null || denominator === null || denominator === 0 ? null : `${((100 * numerator) / denominator).toFixed(1)}%`;

/** Median days per stage. Sources don't pool medians, so a combined view shows one only when every source agrees. */
function pooledMedian(sources: SourceFacts[], index: number): number | null {
  const values = sources.map((s) => s.medianDays[index] ?? null);
  return values.length > 0 && values.every((v) => v !== null && v === values[0]) ? values[0]! : null;
}

export type StageRow = { key: string; label: string; reached: number | null; conversion: string | null; medianDays: number | null; notAdvanced: number | null };

/** Funnel rows: reached counts, previous-stage conversion, median elapsed days and the opportunities that did not advance. */
export function stageRows(sources: SourceFacts[]): StageRow[] {
  const reached = PIPELINE_STAGES.map((_, i) => sum(sources.map((s) => s.reached[i] ?? null)));
  return PIPELINE_STAGES.map((stage, i) => ({
    key: stage.key,
    label: stage.label,
    reached: reached[i]!,
    conversion: i === 0 ? null : percent(reached[i]!, reached[i - 1]!),
    medianDays: i === 0 ? null : pooledMedian(sources, i),
    notAdvanced: i === 0 || reached[i] === null || reached[i - 1] === null ? null : reached[i - 1]! - reached[i]!,
  }));
}

export const currentCount = (sources: SourceFacts[], key: CurrentStageKey) => sources.reduce((a, s) => a + s.current[key], 0);
export const currentTotal = (sources: SourceFacts[]) => CURRENT_STAGES.reduce((a, stage) => a + currentCount(sources, stage.key), 0);

export function sendTotals(sources: SourceFacts[]) {
  const add = (pick: (s: SourceFacts["sends"]) => number) => sources.reduce((a, s) => a + pick(s.sends), 0);
  return { approved: add((s) => s.approved), confirmed: add((s) => s.confirmed), uncertain: add((s) => s.uncertain), queued: add((s) => s.queued), replies: add((s) => s.replies), attempts: add((s) => s.attempts), opportunities: add((s) => s.opportunities) };
}

export function outcomeTotals(sources: SourceFacts[]) {
  const add = (pick: (o: SourceFacts["outcomes"]) => number) => sources.reduce((a, s) => a + pick(s.outcomes), 0);
  const merchandise = add((o) => o.merchandise.minorUnits);
  const refunds = add((o) => o.refunds.minorUnits);
  const views = add((o) => o.views);
  const engagements = add((o) => o.engagements);
  const orders = add((o) => o.orders);
  const refunded = add((o) => o.fullyRefundedOrders);
  return {
    posts: add((o) => o.posts),
    comparablePosts: add((o) => o.comparablePosts),
    views,
    engagements,
    engagementRate: percent(engagements, views),
    orders,
    fullyRefunded: refunded,
    retained: orders - refunded,
    merchandise: { minorUnits: merchandise, currency: "USD" } satisfies Money,
    refunds: { minorUnits: refunds, currency: "USD" } satisfies Money,
    net: { minorUnits: merchandise - refunds, currency: "USD" } satisfies Money,
  };
}

/** Net sales by source, for the note under the outcome cards. */
export const netBySource = (data: PipelineData) => data.sources.map((s) => ({ label: s.label, net: { minorUnits: s.outcomes.merchandise.minorUnits - s.outcomes.refunds.minorUnits, currency: "USD" } satisfies Money }));
