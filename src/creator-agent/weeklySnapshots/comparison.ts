import { z } from "zod";
import { weeklyExpectedMeasures, weeklyFactsSchema, weeklyLinksSchema, type WeeklyFacts, type WeeklyMeasure } from "./contract.ts";
import { previousWeeklyDate } from "./schedule.ts";

const delta = z.object({ difference: z.number().int().safe(), percentBasisPoints: z.number().int().safe().nullable() }).strict().nullable();
export const weeklyReportContextSchema = z.object({
  snapshot: weeklyFactsSchema,
  priorVersion: z.string().regex(/^v[1-9]\d{0,6}$/).nullable(),
  links: weeklyLinksSchema,
  comparisons: z.array(z.object({ prior: delta, forecast: delta }).strict()).max(weeklyExpectedMeasures.length),
}).strict().refine(context => context.comparisons.length === context.snapshot.measures.length);
export type WeeklyReportContext = z.infer<typeof weeklyReportContextSchema>;

function compare(actual: WeeklyMeasure["actual"], comparator: WeeklyMeasure["actual"] | null | undefined) {
  if (actual.amount === null || comparator?.amount == null ||
      actual.currency !== comparator.currency || actual.decimals !== comparator.decimals) return null;
  const difference = actual.amount - comparator.amount;
  if (!Number.isSafeInteger(difference)) return null;
  const percent = comparator.amount > 0 ? Math.round(difference / comparator.amount * 10_000) : null;
  return { difference, percentBasisPoints: Number.isSafeInteger(percent) ? percent : null };
}

export function weeklyComparisons(snapshot: WeeklyFacts, candidate: WeeklyFacts | null): Pick<WeeklyReportContext, "priorVersion" | "comparisons"> {
  const prior = candidate && candidate.window.reportDate === previousWeeklyDate(snapshot.window.reportDate) &&
    candidate.window.end === snapshot.window.start &&
    candidate.scope.workspaceId === snapshot.scope.workspaceId && candidate.scope.accountId === snapshot.scope.accountId &&
    candidate.scope.environment === snapshot.scope.environment ? candidate : null;
  const byKey = new Map(prior?.measures.map(measure => [measure.metric + "/" + measure.dimension, measure]));
  const comparisons = snapshot.measures.map(measure => {
    const previous = byKey.get(measure.metric + "/" + measure.dimension);
    return {
      prior: compare(measure.actual, previous?.definition === measure.definition ? previous.actual : null),
      forecast: compare(measure.actual, measure.forecast?.definition === measure.definition ? measure.forecast : null),
    };
  });
  return { priorVersion: prior?.version ?? null, comparisons };
}
