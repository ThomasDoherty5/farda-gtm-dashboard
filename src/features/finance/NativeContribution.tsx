import { useState } from "react";
import type { NativeCommissionLedger } from "@/creator-agent/settlements/contract";
import { Button } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { FactList } from "@/components/Panels";
import { moneyFact, observed, type MoneyFact } from "./NativeFinance";
import styles from "./NativeFinance.module.css";
import finance from "./Finance.module.css";

export function NativeContribution({ data }: { data: NativeCommissionLedger }) {
  const [mode, setMode] = useState<"chart" | "table">("chart");
  const facts = data.economics;
  if (!facts) return <><div className={styles.unknownPlot} role="status">A source-backed cost breakdown was not supplied. No waterfall values are inferred from paid cash or historical examples.</div><FactList label="Contribution evidence" rows={[["Source contribution", moneyFact(data.totals.contribution)], ["Currency", data.currency ?? "Unknown · do not combine currencies"], ["Observed", observed(data.source.observedAt)]]} /></>;
  const waterfall = facts.waterfall;
  const items: [string, MoneyFact | null][] = [
    ["Net sales", waterfall?.netSales ?? null], ["Commerce costs", waterfall?.commerceCosts ?? null],
    ["Fixed fee", waterfall?.fixedFees ?? null], ["Samples", waterfall?.samples ?? null],
    ["Net commission", waterfall?.netCommission ?? null], ["Fee estimate", waterfall?.feeEstimate ?? null], ["Contribution", waterfall?.contribution ?? null],
  ];
  const amounts = items.map(([, fact]) => fact?.state === "known" ? fact.value.minorUnits : null);
  const complete = amounts.every((amount): amount is number => amount !== null && amount >= 0);
  const consistent = complete && BigInt(amounts[0]!) - amounts.slice(1, -1).reduce((sum, amount) => sum + BigInt(amount!), 0n) === BigInt(amounts[6]!);
  const comparable = consistent && data.accountingPolicy.state === "verified";
  const scale = 224 / Math.max(1, amounts[0] ?? 1);
  let remaining = amounts[0] ?? 0;
  const geometry = items.map(([label, fact], index) => {
    const amount = amounts[index] ?? 0;
    const total = index === 0 || index === 6;
    const high = total ? amount : remaining;
    if (!total) remaining -= amount;
    return { label, fact, total, top: 258 - high * scale, height: amount * scale, left: `${index * (1248 / 7 + 16 / 7) / 1248 * 100}%`, width: `${(1248 - 6 * 16) / 7 / 1248 * 100}%` };
  });
  const table = <DataTable caption="Source contribution components" columns={[{ label: "Component" }, { label: "Source amount" }, { label: "Evidence" }, { label: "Observed" }]} rows={items.map(([label, fact]) => [label, fact ? moneyFact(fact) : "Unknown · source component not supplied", fact?.evidenceRef ?? "Unknown", observed(fact?.observedAt ?? null)])} />;
  return <>
    <div className={styles.filters} aria-label="Contribution view"><Button variant="secondary" aria-pressed={mode === "chart"} onClick={() => setMode("chart")}>Chart</Button><Button variant="secondary" aria-pressed={mode === "table"} onClick={() => setMode("table")}>Accessible table</Button></div>
    <FactList label="Contribution cohort" rows={[["Cohort", facts.cohortRef], ["Period", `${observed(facts.periodStart)} – ${observed(facts.periodEnd)}`], ["Eligible orders", facts.eligibleOrders.state === "known" ? String(facts.eligibleOrders.value) : "Unknown"], ["Accounting policy", data.accountingPolicy.reference ?? "Unknown"]]} />
    {mode === "chart" && comparable ? <>
      <div className={finance.plotScroll} role="region" aria-label="Contribution waterfall" tabIndex={0}><div className={finance.waterfall} role="img" aria-label={`Source-reported net sales less commerce costs, historical fixed fees, samples, net commission and fee estimate. Contribution ${waterfall ? moneyFact(waterfall.contribution) : "unknown"}.`}>
        {[34, 146, 258].map(top => <span key={top} className={finance.wfLine} style={{ top }} />)}
        {geometry.map(item => <span key={item.label}><span className={finance.wfBar} data-kind={item.total ? "total" : "cost"} style={{ left: item.left, width: item.width, top: item.top, height: Math.max(item.height, 1) }} /><p className={finance.wfValue} data-kind={item.total ? "total" : "cost"} style={{ left: item.left, top: item.top - 27 }}>{item.total ? "" : "−"}{item.fact ? moneyFact(item.fact) : "Unknown"}</p><p className={finance.wfLabel} style={{ left: item.left }}>{item.label}</p></span>)}
      </div></div><table className="visually-hidden"><caption>Source contribution components</caption><thead><tr><th scope="col">Component</th><th scope="col">Source amount</th></tr></thead><tbody>{items.map(([label, fact]) => <tr key={label}><th scope="row">{label}</th><td>{fact ? moneyFact(fact) : "Unknown"}</td></tr>)}</tbody></table>
    </> : <>{mode === "chart" && <p role="status">Chart unavailable: complete, consistent source components and a verified accounting policy are required. No missing costs are inferred. Source facts remain available below.</p>}{table}</>}
  </>;
}
