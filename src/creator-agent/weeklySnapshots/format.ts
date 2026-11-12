import type { WeeklyReportContext } from "./comparison.ts";
import { weeklyExpectedMeasures, weeklyMetrics, weeklySections, type WeeklyMeasure } from "./contract.ts";

const sectionLabels = {
  headline: "Headline", channels: "Channels", creators: "Creators", content: "Content",
  cashMedia: "Cash and media", support: "Support",
};
const dimensionLabels: Record<string, string> = {
  shopify: "Shopify", tiktokShop: "TikTok Shop", discountCode: "Discount code", utm: "UTM",
  platformReported: "Platform reported", unattributed: "Unattributed", unknown: "Unknown",
  stageOne: "Stage 1", stageTwo: "Stage 2", stageThree: "Stage 3",
  setup: "Setup", shipping: "Shipping", returns: "Returns", product: "Product", other: "Other", appStore: "App Store",
};
const decisionLabels = { held: "Held", reviewDue: "Review due", released: "Released", unknown: "Unknown" };
const decimal = (value: number, scale: number) => (value / scale).toLocaleString("en-US", { maximumFractionDigits: 2 });

function displayAmount(measure: WeeklyMeasure, amount: number | null) {
  if (amount === null) return "N/A";
  const [, , unit] = weeklyMetrics[measure.metric];
  if (unit === "money") {
    const precision = measure.actual.decimals ?? 0;
    const digits = Math.abs(amount).toString().padStart(precision + 1, "0");
    const number = precision ? digits.slice(0, -precision) + "." + digits.slice(-precision) : digits;
    return `${measure.actual.currency} ${amount < 0 ? "-" : ""}${number}`;
  }
  if (unit === "percentage") return decimal(amount, 100) + "%";
  if (unit === "multiple") return decimal(amount, 10_000) + "×";
  return decimal(amount, unit === "count" ? 1 : 100);
}

function displayDelta(measure: WeeklyMeasure, value: WeeklyReportContext["comparisons"][number]["prior"]) {
  if (!value) return "N/A";
  const absolute = (value.difference > 0 ? "+" : "") + displayAmount(measure, value.difference);
  if (value.percentBasisPoints === null) return absolute;
  return `${absolute} (${value.percentBasisPoints > 0 ? "+" : ""}${decimal(value.percentBasisPoints, 100)}%)`;
}

function boundedFacts(facts: readonly string[], limit: number) {
  const selected: string[] = [];
  let used = 0;
  for (const fact of facts) {
    if (used + fact.length + 3 > limit) break;
    selected.push(fact);
    used += fact.length + 3;
  }
  if (selected.length < facts.length) selected.push("More in snapshot");
  return selected.join(" · ");
}

export function weeklyReportBody(context: WeeklyReportContext, owner: string, sourceLink: string, provenance: string, controlled: boolean) {
  const { snapshot, links } = context;
  const header = `🟢 Weekly KPI pre-read${controlled ? " · Controlled sandbox test" : ""} · ${snapshot.window.start.slice(0, 10)}–${snapshot.window.reportDate} (Pacific, end exclusive) · ${snapshot.version}`;
  const footer = `Owner ${owner} · <${sourceLink}|Frozen report record> · evidence ${provenance}`;
  const sections = weeklySections.map(section => {
    const measures = snapshot.measures.flatMap((measure, index) => {
      const [group, label] = weeklyMetrics[measure.metric];
      if (group !== section) return [];
      const dimension = dimensionLabels[measure.dimension];
      const formatted = `${label}${dimension ? ` (${dimension})` : ""} ${displayAmount(measure, measure.actual.amount)}`;
      const comparison = context.comparisons[index]!;
      return [{ measure, text: section === "headline"
        ? `${formatted} · prior ${displayDelta(measure, comparison.prior)} · plan ${displayDelta(measure, comparison.forecast)}`
        : measure.forecast ? `${formatted} · plan ${measure.forecast.amount === null ? "N/A" : displayAmount({ ...measure, actual: measure.forecast }, measure.forecast.amount)}` : formatted }];
    });
    const lines = measures.map(value => value.text);
    const expected = weeklyExpectedMeasures.filter(({ metric }) => weeklyMetrics[metric][0] === section).length;
    const missing = expected - measures.length;
    if (missing > 0 && measures.length) lines.unshift(`${missing} measures N/A (source unavailable)`);
    if (section === "creators" && snapshot.rankings.collaborations.length) {
      lines.push("Top collaborations " + snapshot.rankings.collaborations.map(value => value.label).join(", "));
    }
    if (section === "content") {
      if (snapshot.rankings.postsByViews.length) lines.push("Top by views " + snapshot.rankings.postsByViews.map(value => value.label).join(", "));
      if (snapshot.rankings.postsByCtr.length) lines.push("Top by CTR " + snapshot.rankings.postsByCtr.map(value => value.label).join(", "));
    }
    if (section === "cashMedia") {
      const budget = ["cashActual", "cashCommitted", "cashForecast", "cashCeiling"] as const;
      const figures = budget.map(metric => measures.find(value => value.measure.metric === metric)?.measure);
      const ceiling = figures[3];
      if (ceiling && figures.every(value => value?.actual.amount != null &&
          value.actual.currency === ceiling.actual.currency && value.actual.decimals === ceiling.actual.decimals)) {
        const remaining = Number(BigInt(ceiling.actual.amount!) -
          figures.slice(0, 3).reduce((sum, value) => sum + BigInt(value!.actual.amount!), 0n));
        if (Number.isSafeInteger(remaining)) lines.unshift(`After actual, committed and remaining forecast ${displayAmount(ceiling, remaining)} to ceiling`);
      }
      lines.unshift(...snapshot.mediaDecisions.map(decision =>
        `${dimensionLabels[decision.stage]} ${decisionLabels[decision.state]}${decision.dueAt ? ` ${decision.dueAt}` : ""}`));
    }
    const oldest = measures.flatMap(({ measure }) => measure.actual.asOf ? [measure.actual.asOf] : [])
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    return {
      prefix: `• *${sectionLabels[section]}* · `,
      suffix: ` · <${links[section]}|Source snapshot>${oldest ? ` · As of ${oldest}` : ""}`,
      lines: lines.length ? lines : ["N/A (source unavailable)"],
    };
  });
  const coverage = snapshot.coverage === "partial" ? "Partial source coverage" : "Complete source coverage";
  const fixed = [header, coverage, footer, ...sections.map(section => section.prefix + section.suffix)].join("\n").length;
  const remaining = 2980 - fixed - sections.length * 20;
  const headline = Math.min(sections[0]!.lines.join(" · ").length + 3, Math.floor(remaining / 2));
  const budget = Math.floor((remaining - headline) / 5);
  return [header, coverage, ...sections.map((section, index) =>
    section.prefix + boundedFacts(section.lines, index === 0 ? headline : budget) + section.suffix), footer].join("\n");
}
