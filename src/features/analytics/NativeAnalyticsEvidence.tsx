import { useState } from "react";
import type { AnalyticsFact, NativeAnalyticsView } from "@/creator-agent/analytics/views";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DataTable } from "@/components/DataTable";
import { formatCount, formatMoneyExact } from "@/components/MetricValue";
import { Notice } from "./parts";
import styles from "./Analytics.module.css";

export const nativeCount = (value: number) => formatCount(value);
export const nativeMoney = (value: { minorUnits: number; currency: string }) => formatMoneyExact(value);
export const nativePercent = (value: number) => `${value.toFixed(1)}%`;
export const nativeMultiple = (value: number) => `${value.toFixed(2)}×`;
export function factText<T>(fact: AnalyticsFact<T> | null | undefined, format: (value: T) => string): string {
  return fact?.state === "known" && fact.value !== null ? format(fact.value) : fact?.state === "notApplicable" ? "N/A" : "Unknown";
}
export function Fact<T>({ fact, format }: { fact: AnalyticsFact<T> | null | undefined; format: (value: T) => string }) {
  const reason = fact?.reasonCodes.join(" · ") || "SOURCE_MISSING";
  return <span data-state={fact?.state ?? "unknown"} title={fact?.state === "known" ? undefined : reason}>{factText(fact, format)}{fact?.provisional && <small className={styles.small}> · provisional</small>}</span>;
}
export function nativePeriod(data: Pick<NativeAnalyticsView, "period">) {
  const period = data.period;
  return period ? `${period.startAt} to ${period.endAt} (end exclusive) · ${period.timezone} · event time` : "Reporting window Unknown";
}
export function NativeAnalyticsEvidence({ data, refresh, refreshing }: { data: NativeAnalyticsView; refresh: () => void; refreshing: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <Notice tone={data.coverage.state === "complete" && data.freshness.state === "current" ? "violet" : "warning"} title={data.provenance.synthetic ? "Synthetic source evidence · sandbox" : "Source-owned reporting evidence"}>
      {nativePeriod(data)}. Coverage: {data.coverage.state}; freshness: {data.freshness.state}. Missing figures remain Unknown; N/A means the measure does not apply. Reading never releases media spend.
    </Notice>
    <div className={styles.btnRow}><Button variant="secondary" onClick={() => setOpen(true)}>Source evidence</Button><Button variant="secondary" loading={refreshing} onClick={refresh}>Refresh reporting evidence</Button></div>
    <Dialog open={open} focusHeading title="Reporting source evidence" onClose={() => setOpen(false)}>
      <p style={{ overflowWrap: "anywhere" }}>{nativePeriod(data)}. Cohort: {data.cohortRef ?? "Unknown"}.</p>
      <p>Observed {data.provenance.observedAt}; access expires {data.provenance.validUntil}. {data.provenance.synthetic ? "Fictional fixtures do not validate a live reporting connection." : "Access and dataset freshness are verified separately."}</p>
      <DataTable caption="Reporting source coverage" minWidth={760} columns={[{ label: "Owner" }, { label: "Coverage" }, { label: "Source time" }, { label: "Observed" }, { label: "Definition" }]} rows={data.sources.map(source => [source.owner, source.coverage, source.sourceAsOf ?? "Unknown", source.observedAt, <span key="definition" style={{ overflowWrap: "anywhere" }}>{source.definitionVersion}</span>])} />
      {data.sources.length === 0 && <p>No qualified reporting owner rows.</p>}
      <p>{data.coverage.reasonCodes.join(" · ") || "No coverage limitation reported."}</p>
      <Button variant="secondary" onClick={() => setOpen(false)}>Close source evidence</Button>
    </Dialog>
  </>;
}
