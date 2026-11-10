import { NativeExportDialog } from "./NativeExportDialog";
import { NativeContribution } from "./NativeContribution";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import type { ReadResponse } from "@/adapter/contract";
import type { NativeCommissionLedger, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { KpiRow } from "@/components/Kpi";
import { ContextCard, GateRows, PageHeader, Panel, SectionHeading } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { displayReference, exactMoney, FinanceGrant, FinancialEvidenceDialog, NativeMoneyKpi, moneyFact, NativeFinanceTabs, RecordNavigation, recordPath, stateText } from "./NativeFinance";
import styles from "./Finance.module.css";
import native from "./NativeFinance.module.css";

export function NativeCommissionLedgerPage() {
  const ctx = useScope(), [params, setParams] = useSearchParams();
  const rawProvider = params.get("provider"), provider = rawProvider === "collabs" || rawProvider === "tiktok" || rawProvider === "externalManual" ? rawProvider : "all";
  const rawCurrency = params.get("currency"), currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : undefined;
  const filterKey = JSON.stringify([...scopeKey(ctx), provider, currency]);
  const [paging, setPaging] = useState<{ filterKey: string; cursors: (string | null)[] }>({ filterKey, cursors: [null] });
  const cursors = paging.filterKey === filterKey ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  const query = useView<{ provider?: "all" | "collabs" | "tiktok" | "externalManual"; currency?: string }, NativeCommissionLedger>("commissionLedger", { provider, ...(currency ? { currency } : {}) }, null, { page: { cursor, limit: 50 } });
  const refresh = () => { void query.refetch(); };
  return <RecordShell query={query} id="ledger-title" title="Every commission, accounted for." subject="commission ledger" figma="65:1037">{(response, data) =>
    data.kind === "native-commission-ledger" ? <FinanceGrant data={data} response={response} refresh={refresh} titleId="ledger-title" title="Every commission, accounted for.">
      <LedgerBody key={JSON.stringify([...scopeKey(ctx), provider, currency, data.version])} data={data} response={response} provider={provider} pageNumber={cursors.length} previousPage={() => setPaging({ filterKey, cursors: cursors.slice(0, -1) })} nextPage={() => { const next = query.data?.page.nextCursor; if (next) setPaging({ filterKey, cursors: [...cursors, next] }); }} changeProvider={value => setParams(prior => { const next = new URLSearchParams(prior); next.set("provider", value); next.delete("cursor"); return next; })} />
    </FinanceGrant> : <><PageHeader id="ledger-title" title="Every commission, accounted for." /><p role="alert">A qualified native commission record was not returned. Refresh the source before reviewing this ledger.</p></>
  }</RecordShell>;
}

function LedgerBody({ data, response, provider, changeProvider, pageNumber, previousPage, nextPage }: { pageNumber: number; previousPage: () => void; nextPage: () => void; data: NativeCommissionLedger; response: ReadResponse<NativeCommissionLedger>; provider: string; changeProvider: (value: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null), [exportOpen, setExportOpen] = useState(false);
  const record = data.records.find(row => row.ref === selected) ?? null;
  const payout = data.records.find(row => row.provider !== "externalManual");
  const segments = [{ key: "held", label: "Held" }, { key: "disputed", label: "Disputed" }, { key: "awaitingProvider", label: "Awaiting provider" }, { key: "paid", label: "Paid" }] as const;
  const quantitative = data.coverage.complete && segments.every(({ key }) => data.stateTotals?.[key].state === "known") && segments.some(({ key }) => { const fact = data.stateTotals?.[key]; return fact?.state === "known" && fact.value.minorUnits > 0; });
  return <>
    <PageHeader id="ledger-title" title="Every commission, accounted for." subtitle={`${data.currency ?? "Multiple or unknown currencies"} · source ledger · ${data.coverage.returned} of ${data.coverage.total ?? "unknown"} records`}>
      <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 198 }} onClick={() => setExportOpen(true)}>Export ledger</Button>
      {payout ? <RecordNavigation record={payout}>Reconcile payout</RecordNavigation> : <Button disabledReason="No provider settlement was returned in this scope.">Reconcile payout</Button>}
    </PageHeader>
    <NativeFinanceTabs current="commissions" payout={payout} />
    <ContextCard title="Existing provider obligations" actions={<LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton>}>
      Honor earned amounts and historical accepted liabilities. Preserve settled receipts and record later reversals as adjustments; a source observation is not a new payment authorization.
    </ContextCard>
    <ContextCard title="Provider-owned commission settlement">Recruitment, publishing and checkout are separate from the provider that owns this entitlement. Imported order records never create another commission or a manual Pay task.</ContextCard>
    <KpiRow>
      <NativeMoneyKpi label="Net eligible sales" context="Source-reported eligible basis" fact={data.totals.eligible} />
      <NativeMoneyKpi label="Net accrued commission" context="Source balance; adjustments remain separate" fact={data.totals.accrued} />
      <NativeMoneyKpi label="Cash commission paid" context="Cash is not deducted again from contribution" fact={data.totals.creatorPaid} />
      <NativeMoneyKpi label="Estimated contribution" context={data.accountingPolicy.state === "verified" ? "Source accounting policy supplied" : "Accounting policy unknown"} fact={data.totals.contribution} />
    </KpiRow>
    <Panel id="native-ledger-records" roomy header={<div className={`${styles.headRow} ${native.panelHeader}`}>
      <SectionHeading id="native-ledger-records" large title="Accrued expense and cash are different." subtitle={`Showing ${data.coverage.returned} of ${data.coverage.total ?? "unknown"} source records. ${data.coverage.complete && response.coverage.complete ? "Complete returned scope." : "Partial coverage; visible rows are not the whole ledger."}`} />
      <div className={native.filters}><FilterButton name="Provider" title="Choose a settlement provider" value={provider} onChange={changeProvider} options={[{ value: "all", label: "All providers" }, { value: "collabs", label: "Collabs" }, { value: "tiktok", label: "TikTok Shop" }, { value: "externalManual", label: "Historical manual fees" }]} />{payout && <RecordNavigation record={payout}>View payout</RecordNavigation>}</div>
    </div>}>
      <ul className={styles.statusBar} aria-label="Whole-snapshot source balances by state">{segments.map(segment => { const fact = data.stateTotals?.[segment.key]; return <li key={segment.key} data-state={segment.key} style={{ flex: `${quantitative && fact?.state === "known" ? fact.value.minorUnits : 1} 1 0px` }}>{segment.label} {fact?.state === "known" ? exactMoney(fact.value) : fact?.state === "notApplicable" ? "N/A" : "Unknown"}</li>; })}</ul>
      {!quantitative && <p className={styles.footnote}>Segment widths are not quantitative: complete source balances are unavailable or all balances are zero. Visible page rows are never used to calculate this distribution.</p>}
      <DataTable caption="Commission and historical obligation records" minWidth={1248} columns={[{ label: "Record / provider", width: "180px" }, { label: "Gross → eligible basis", width: "180px" }, { label: "Gross earned", width: "150px" }, { label: "Reversed", width: "140px" }, { label: "Net accrued", width: "160px" }, { label: "Current source state", width: "230px" }, { label: "Next action", width: "208px" }]} rows={data.records.map(row => [
        <span key="identity" className={native.reference}><Link to={recordPath(row)} title={row.ref} aria-label={`Open ${row.provider === "externalManual" ? "historical payable" : "settlement"} ${row.ref}`}>{displayReference(row.ref)}</Link><br />{row.provider}</span>, `${moneyFact(row.grossSales)} → ${moneyFact(row.eligibleBase)}`, row.grossEarned ? moneyFact(row.grossEarned) : "Unknown · gross earned not supplied", row.reversed ? moneyFact(row.reversed) : "Unknown · reversal total not supplied", row.netAccrued ? moneyFact(row.netAccrued) : "Unknown · source accrual not supplied", <Badge key="state">{stateText[row.state]}</Badge>, <Button key="evidence" variant={ledgerEvidenceLabel(row) === "View receipt" ? "secondary" : "ghost"} aria-haspopup="dialog" onClick={() => setSelected(row.ref)}>{ledgerEvidenceLabel(row)}<span className="visually-hidden"> for {row.ref}</span></Button>,
      ])} />
      {(pageNumber > 1 || response.page.hasMore) && <nav className={native.filters} aria-label="Ledger pages"><Button variant="secondary" disabledReason={pageNumber === 1 ? "This is the first page." : undefined} onClick={previousPage}>Previous page</Button><span role="status">Page {pageNumber}</span><Button variant="secondary" disabledReason={!response.page.hasMore || !response.page.nextCursor ? "No next page was returned." : undefined} onClick={nextPage}>Next page</Button></nav>}
      {!data.records.length && <p>No financial records were returned for this provider and currency scope. Unknown amounts are not zero owed.</p>}
      <p className={styles.footnote}>Financial facts are independently evidenced. A billed amount does not prove creator payment, and a paid receipt does not prove accounting reconciliation.</p>
    </Panel>
    <NativeContribution data={data} />
    <Panel title="One entitlement. One authoritative owner." large subtitle="Match each commission to its creator agreement, order and provider record. Unmatched source records need review.">
      <GateRows label="Ledger integrity rules" rows={[
        { badge: <Badge tone="warning" width={140}>Crosswalk required</Badge>, title: "Imported TikTok orders in Shopify", text: "A mirrored order never creates a second website sale or commission" },
        { badge: <Badge tone="violet" width={140}>Separate records</Badge>, title: "Marketing attribution vs payee", text: "Farda credit cannot overwrite provider-authoritative entitlement" },
        { badge: <Badge width={140}>No manual Pay</Badge>, title: "Provider-settled commissions", text: "Fixed content-fee payables remain a separate lane" },
      ]} />
    </Panel>
    <FinancialEvidenceDialog record={record} onClose={() => setSelected(null)} />
    <NativeExportDialog open={exportOpen} data={data} response={response} onClose={() => setExportOpen(false)} />
  </>;
}

/** Navigation into independent evidence; none of these labels authorizes a source mutation. */
function ledgerEvidenceLabel(record: SettlementRecord) {
  if (record.state === "held") return "Review hold";
  if (record.state === "disputed") return "Review dispute";
  if (record.state === "awaitingProvider" || record.state === "awaitingCreator" || record.state === "earned" || record.state === "estimated") return "Inspect eligibility";
  if (record.receipts.length > 0) return "View receipt";
  return "Inspect evidence";
}
