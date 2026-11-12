import { alertCatalog } from "../operationalAlerts/catalog.ts";
import type { LaunchPulseContext } from "./contract.ts";

const number = (value: number | null) => value === null ? "N/A" : value.toLocaleString("en-US");
function money(value: { minorUnits: number; currency: string; decimals: number }) {
  const digits = String(value.minorUnits).padStart(value.decimals + 1, "0");
  return `${value.currency} ${value.decimals ? digits.slice(0, -value.decimals) + "." + digits.slice(-value.decimals) : digits}`;
}
const usd = (minorUnits: number | null) => minorUnits === null ? "N/A" : money({ minorUnits, currency: "USD", decimals: 2 });
const when = (source: { sourceAsOf: string | null }) => source.sourceAsOf ? ` · as of ${source.sourceAsOf}` : "";
const state = { missing: "unavailable", stale: "stale", partial: "partial coverage", mismatch: "source review needed" };
const unavailable = (item: { reason: keyof typeof state | null; sourceAsOf: string | null }) =>
  `N/A (${item.reason ? state[item.reason] : "unknown"})${when(item)}`;
const platform = { meta: "Meta", tiktok: "TikTok", gmvMax: "TikTok GMV Max" };
const pacificTime = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles",
  month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

export function launchPulseBody(pulse: LaunchPulseContext, owner: string, sourceLink: string, evidence: string, controlled: boolean) {
  const { slot, commerce, media, stock, support, alerts } = pulse;
  const heading = `🟢 Launch pulse · ${pacificTime.format(new Date(slot.scheduledAt))}${controlled ? " · Controlled sandbox test" : ""}`;
  const lines = [
    heading,
    `${slot.interpretation === "elapsed72Hours" ? "First 72 elapsed hours" : "Launch day through L+3"} · ends ${pacificTime.format(new Date(slot.launchEnd))}${pulse.coverage === "partial" ? " · Incomplete source coverage" : ""}`,
  ];
  if (commerce.value) {
    const { hour, today, launch, attribution, topCodes } = commerce.value;
    for (const [label, rollup] of [["This hour", hour], ["Today", today], ["Since launch", launch]] as const) {
      lines.push(`• *${label}* · ${number(rollup.orders)} orders · ${number(rollup.retainedUnits)} retained units · ${usd(rollup.netReceiptsMinor)} net receipts`);
    }
    lines.push(`• *Attribution since launch* · code ${number(attribution.code)} · UTM ${number(attribution.utm)} · platform ${number(attribution.platform)} · unattributed ${number(attribution.unattributed)} · unknown ${number(attribution.unknown)}${when(commerce)}`);
    lines.push(`• *Top creator codes* · ${topCodes ? topCodes.map(row => `${row.code} ${number(row.orders)}`).join(", ") || "None in covered orders" : "N/A (code ownership incomplete)"}`);
  } else lines.push(`• *Commerce and attribution* · ${unavailable(commerce)}`);
  const mediaText = media.value?.map(row => `${platform[row.platform]} ${row.stage} · today ${money(row.spentToday)} · stage ${money(row.stageSpend)} / ${money(row.stageCap)}`).join("\n    ");
  lines.push(`• *Platform-reported spend and approved caps* · ${media.value ? (mediaText || "No stage observations") + when(media) : unavailable(media)}`);
  lines.push(`• *Available stock* · ${stock.value ? `${number(stock.value.availableUnits)} units · ${stock.value.hoursOfCover === null ? "N/A" : stock.value.hoursOfCover.toFixed(1)} hours of cover${when(stock)}` : unavailable(stock)}`);
  lines.push(`• *Open support cases* · ${support.value ? (support.value.map(row => `${row.category} ${number(row.count)}`).join(" · ") || "None in covered sources") + when(support) : unavailable(support)}`);
  const red = alerts.value?.filter(row => row.count > 0);
  lines.push(`• *Red alerts in the last hour* · ${red ? (red.slice(0, 6).map(row => `${alertCatalog[row.kind][1]} ${number(row.count)}`).join(" · ") || "None in covered sources") +
    (red.length > 6 ? ` · ${red.length - 6} more categories in the dashboard` : "") + when(alerts) : unavailable(alerts)}`);
  lines.push(`Owner ${owner} · <${pulse.dashboardLink}|Open dashboard> · <${sourceLink}|Authorized source record> · evidence ${evidence}`);
  return lines.join("\n");
}
