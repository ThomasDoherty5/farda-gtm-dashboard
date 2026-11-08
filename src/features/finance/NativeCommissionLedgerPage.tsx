import { NativeExportDialog } from "./NativeExportDialog";
import { NativeContribution } from "./NativeContribution";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import type { ReadResponse } from "@/adapter/contract";
import type { NativeCommissionLedger } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Kpi, KpiRow } from "@/components/Kpi";
import { ContextCard, PageHeader, Panel } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { FinanceGrant, FinancialEvidenceDialog, moneyFact, NativeFinanceTabs, RecordNavigation, stateText } from "./NativeFinance";
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
  const stateGroups = [...new Set(data.records.map(row => row.state))];
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
    <div className={native.filters}><FilterButton name="Provider" title="Choose a settlement provider" value={provider} onChange={changeProvider} options={[{ value: "all", label: "All providers" }, { value: "collabs", label: "Collabs" }, { value: "tiktok", label: "TikTok Shop" }, { value: "externalManual", label: "Historical manual fees" }]} /></div>
    <KpiRow>
      <Kpi label="Net eligible sales" context="Source-reported eligible basis">{moneyFact(data.totals.eligible)}</Kpi>
      <Kpi label="Net accrued commission" context="Source balance; adjustments remain separate">{moneyFact(data.totals.accrued)}</Kpi>
      <Kpi label="Cash commission paid" context="Cash is not deducted again from contribution">{moneyFact(data.totals.creatorPaid)}</Kpi>
      <Kpi label="Estimated contribution" context={data.accountingPolicy.state === "verified" ? "Source accounting policy supplied" : "Accounting policy unknown"}>{moneyFact(data.totals.contribution)}</Kpi>
    </KpiRow>
    <Panel id="native-ledger-records" title="Accrued expense and cash are different." large roomy subtitle={`Showing ${data.coverage.returned} of ${data.coverage.total ?? "unknown"} source records. ${data.coverage.complete && response.coverage.complete ? "Complete returned scope." : "Partial coverage; visible rows are not the whole ledger."}`}>
      <ul className={styles.chips} aria-label="Source states in these records">{stateGroups.map(state => <li key={state}><Badge>{stateText[state]}</Badge></li>)}</ul>
      <DataTable caption="Commission and historical obligation records" columns={[{ label: "Record / provider" }, { label: "Eligible basis" }, { label: "Earned" }, { label: "Adjustments" }, { label: "Creator paid" }, { label: "Current source state" }, { label: "Evidence" }]} rows={data.records.map(row => [
        <span key="identity" className={native.reference}>{row.ref}<br />{row.provider}</span>, moneyFact(row.eligibleBase), moneyFact(row.balances.earned), moneyFact(row.balances.adjusted), moneyFact(row.balances.creatorPaid), <Badge key="state">{stateText[row.state]}</Badge>, <Button key="evidence" variant="secondary" aria-haspopup="dialog" onClick={() => setSelected(row.ref)}>Inspect evidence<span className="visually-hidden"> for {row.ref}</span></Button>,
      ])} />
      <nav className={native.filters} aria-label="Ledger pages"><Button variant="secondary" disabledReason={pageNumber === 1 ? "This is the first page." : undefined} onClick={previousPage}>Previous page</Button><span role="status">Page {pageNumber}</span><Button variant="secondary" disabledReason={!response.page.hasMore || !response.page.nextCursor ? "No next page was returned." : undefined} onClick={nextPage}>Next page</Button></nav>
      {!data.records.length && <p>No financial records were returned for this provider and currency scope. Unknown amounts are not zero owed.</p>}
      <p className={styles.footnote}>Financial facts are independently evidenced. A billed amount does not prove creator payment, and a paid receipt does not prove accounting reconciliation.</p>
    </Panel>
    <Panel id="contribution" title="Contribution after creator costs" large roomy subtitle="Currency, cohort and accounting policy must agree before a cost breakdown can be combined.">
      <NativeContribution data={data} />
    </Panel>
    <Panel title="One entitlement. One authoritative owner." large roomy>
      <p>Review the exact creator, account, program and component before matching source receipts. An imported order is a mirror; a historical accepted fee remains a separate obligation.</p>
      <div className={styles.actionsRow}>{data.records.map(row => <RecordNavigation key={row.ref} record={row}>Open {row.provider === "externalManual" ? "historical payable" : "settlement"}<span className="visually-hidden"> {row.ref}</span></RecordNavigation>)}</div>
    </Panel>
    <FinancialEvidenceDialog record={record} onClose={() => setSelected(null)} />
    <NativeExportDialog open={exportOpen} data={data} response={response} onClose={() => setExportOpen(false)} />
  </>;
}
