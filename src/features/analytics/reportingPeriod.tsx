import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { Period } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { analyticsPeriodSchemaNative } from "@/creator-agent/analytics/contract";
import { Button } from "@/components/Button";
import { TextField } from "@/components/Field";
import styles from "./Analytics.module.css";

export function useReportingPeriod(): Period | null {
  const [search] = useSearchParams(), { adapter } = useScope();
  if (adapter.kind === "demo" || !["report-start", "report-end", "report-zone"].some(key => search.has(key))) return null;
  // Invalid deep links reach the strict source boundary as invalid requests;
  // they never silently select a different default reporting window.
  return { startAt: search.get("report-start") ?? "", endAt: search.get("report-end") ?? "", timezone: search.get("report-zone") ?? "", basis: "eventTime" };
}
export function reportingRoute(route: string, period: Period | null) {
  if (!period) return route;
  const [path, raw] = route.split("?"), params = new URLSearchParams(raw);
  params.set("report-start", period.startAt); params.set("report-end", period.endAt); params.set("report-zone", period.timezone);
  return `${path}?${params}`;
}
/** The195 traffic owner accepts complete source-calendar days, not arbitrary
 * instants. Refuse a drilldown when either reporting boundary is not midnight. */
export function trafficReportingRoute(period: Period): string | null {
  const day = (instant: string) => {
    const value = new Date(instant);
    if (!Number.isFinite(value.getTime()) || value.getUTCMilliseconds() !== 0) return null;
    try {
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: period.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(value).map(part => [part.type, part.value]));
      return parts.hour === "00" && parts.minute === "00" && parts.second === "00" ? `${parts.year}-${parts.month}-${parts.day}` : null;
    } catch { return null; }
  };
  const startDay = day(period.startAt), endDayExclusive = day(period.endAt);
  return startDay && endDayExclusive && Date.parse(period.endAt) > Date.parse(period.startAt) ? `/analytics/customer-journey?${new URLSearchParams({ startDay, endDayExclusive, timezone: period.timezone })}` : null;
}
export function ReportingPeriodForm({ onApplied }: { onApplied: () => void }) {
  const [search, setSearch] = useSearchParams();
  const [startAt, setStart] = useState(search.get("report-start") ?? ""), [endAt, setEnd] = useState(search.get("report-end") ?? ""), [timezone, setZone] = useState(search.get("report-zone") ?? "UTC");
  const [error, setError] = useState<string | null>(null);
  return <form className={styles.page} onSubmit={event => {
    event.preventDefault();
    const parsed = analyticsPeriodSchemaNative.safeParse({ startAt, endAt, timezone, basis: "eventTime" });
    if (!parsed.success) { setError("Use complete ISO timestamps with an offset, an end after the start within 367 days, and a valid reporting timezone."); return; }
    const next = new URLSearchParams(search); next.set("report-start", parsed.data.startAt); next.set("report-end", parsed.data.endAt); next.set("report-zone", parsed.data.timezone); next.delete("asset-cursor"); setSearch(next); onApplied();
  }}>
    <TextField label="Reporting start" value={startAt} onChange={setStart} helpText="ISO timestamp with UTC or numeric offset, for example 2026-10-01T00:00:00Z." error={error} />
    <TextField label="Reporting end (exclusive)" value={endAt} onChange={setEnd} helpText="The source includes events before this timestamp." />
    <TextField label="Reporting timezone" value={timezone} onChange={setZone} helpText="Calendar grouping uses this timezone; timestamps retain their exact instant." />
    <p>The source must qualify this exact window and cohort. An unsupported period remains an explicit hold.</p>
    <div className={styles.btnRow}><Button type="submit">Apply reporting period</Button><Button type="button" variant="secondary" onClick={() => { const next = new URLSearchParams(search); for (const key of ["report-start", "report-end", "report-zone", "asset-cursor"]) next.delete(key); setSearch(next); onApplied(); }}>Use source-selected window</Button></div>
  </form>;
}
