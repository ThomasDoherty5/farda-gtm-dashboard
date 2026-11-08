import { useState } from "react";
import type { NativeCommissionLedger } from "@/creator-agent/settlements/contract";
import { Button } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { FactList } from "@/components/Panels";
import { moneyFact, observed } from "./NativeFinance";
import styles from "./NativeFinance.module.css";

export function NativeContribution({ data }: { data: NativeCommissionLedger }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const facts = data.economics;
  if (!facts) return <><div className={styles.unknownPlot} role="status">A source-backed cost breakdown was not supplied. No waterfall values are inferred from paid cash or historical examples.</div><FactList label="Contribution evidence" rows={[["Source contribution", moneyFact(data.totals.contribution)], ["Currency", data.currency ?? "Unknown · do not combine currencies"], ["Observed", observed(data.source.observedAt)]]} /></>;
  const items = [
    ["Gross sales", facts.grossSales], ["Refunds", facts.refunds], ["Net revenue", facts.netRevenue],
    ["Creator commissions", facts.creatorCommissions], ["Provider fees", facts.providerFees],
    ["Fulfillment cost", facts.fulfillmentCost], ["Sample cost", facts.sampleCost], ["Contribution", facts.contribution],
  ] as const;
  const currencies = new Set(items.flatMap(([, fact]) => fact.state === "known" ? [fact.value.currency] : []));
  const comparable = currencies.size === 1 && items.every(([, fact]) => fact.state === "known") && data.accountingPolicy.state === "verified";
  const maximum = Math.max(1, ...items.map(([, fact]) => fact.state === "known" ? Math.abs(fact.value.minorUnits) : 0));
  return <>
    <div className={styles.filters} aria-label="Contribution view"><Button variant="secondary" aria-pressed={mode === "chart"} onClick={() => setMode("chart")}>Chart</Button><Button variant="secondary" aria-pressed={mode === "table"} onClick={() => setMode("table")}>Accessible table</Button></div>
    <FactList label="Contribution cohort" rows={[["Cohort", facts.cohortRef], ["Period", `${observed(facts.periodStart)} – ${observed(facts.periodEnd)}`], ["Eligible orders", facts.eligibleOrders.state === "known" ? String(facts.eligibleOrders.value) : "Unknown"], ["Accounting policy", data.accountingPolicy.reference ?? "Unknown"]]} />
    {mode === "chart" && comparable ? <figure aria-label="Source-reported contribution components"><figcaption>Source-reported components · amounts are not recomputed from cash payments</figcaption><ul className={styles.contribution}>{items.map(([label, fact]) => <li key={label}><span>{label}</span><span className={styles.barTrack} aria-hidden="true"><span className={styles.bar} style={{ width: `${fact.state === "known" ? Math.abs(fact.value.minorUnits) / maximum * 100 : 0}%` }} /></span><strong>{moneyFact(fact)}</strong></li>)}</ul></figure> : <>{mode === "chart" && <p role="status">Chart unavailable: a complete single-currency breakdown and verified accounting policy are required. Source facts remain available below.</p>}<DataTable caption="Source contribution components" columns={[{ label: "Component" }, { label: "Source amount" }, { label: "Evidence" }, { label: "Observed" }]} rows={items.map(([label, fact]) => [label, moneyFact(fact), fact.evidenceRef ?? "Unknown", observed(fact.observedAt)])} /></>}
  </>;
}
