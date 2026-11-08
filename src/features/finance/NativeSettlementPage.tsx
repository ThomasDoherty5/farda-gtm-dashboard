import { useState } from "react";
import { useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import type { NativeSettlement, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi, KpiRow } from "@/components/Kpi";
import { ContextCard, FactList, PageHeader, Panel } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { FinanceGrant, FinancialEvidenceDialog, FinanceSourceLink, moneyFact, NativeFinanceTabs, observed, reasonText, stateText } from "./NativeFinance";
import { SettlementMatchDialog } from "./NativeStatementMatch";
import { NativeTikTokSettlement } from "./NativeTikTokSettlement";
import styles from "./Finance.module.css";
import native from "./NativeFinance.module.css";

export function NativeSettlementPage() {
  const { settlementId = "" } = useParams(), ctx = useScope();
  const query = useView<{ settlementId: string }, NativeSettlement>("settlementDetail", { settlementId });
  const refresh = () => { void query.refetch(); };
  return <RecordShell query={query} id="settlement-title" title="Settlement" subject="settlement" figma={query.data?.data?.record?.provider === "tiktok" ? "66:447" : "66:252"}>{(response, data) => data.kind === "native-settlement" ?
    <FinanceGrant data={data} response={response} refresh={refresh} titleId="settlement-title" title="Settlement">
      {data.record ? <NativeSettlementBody key={JSON.stringify([...scopeKey(ctx), data.record.ref, data.record.version])} data={data} record={data.record} /> : <><PageHeader id="settlement-title" title="Settlement" /><p>No source settlement was returned for this address.</p></>}
    </FinanceGrant> : <><PageHeader id="settlement-title" title="Settlement" /><p role="alert">A qualified native settlement was not returned. Refresh source evidence before reviewing this record.</p></>
  }</RecordShell>;
}

function NativeSettlementBody({ data, record }: { data: NativeSettlement; record: SettlementRecord }) {
  return record.provider === "tiktok" ? <NativeTikTokSettlement data={data} record={record} /> : <NativeCollabsSettlement data={data} record={record} />;
}
function NativeCollabsSettlement({ data, record }: { data: NativeSettlement; record: SettlementRecord }) {
  const [dialog, setDialog] = useState<"match" | "evidence" | "identity" | "crosswalk" | "exceptions" | null>(null);
  return <>
    <PageHeader id="settlement-title" title="Follow the money." subtitle={<span className={native.reference}>{record.ref} · {record.provider} · {record.accountRef}</span>}>
      <FinanceSourceLink record={record} kind="payout" label="Open native payout" /><Button aria-haspopup="dialog" onClick={() => setDialog("match")}>Match statement</Button>
    </PageHeader>
    <NativeFinanceTabs current="payouts" payout={record} />
    <ContextCard title="Existing provider obligations" actions={<LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton>}>Honor earned amounts, preserve original paid receipts and record later reversals as adjustments. Existing accepted obligations remain with their source owner.</ContextCard>
    <ContextCard title="Settlement is not a second payment">The provider owns billing and creator payout. Farda reviews the exact source evidence and accounting match; this lane cannot create a duplicate manual Pay task.</ContextCard>
    <Panel large spacious title={`${stateText[record.state]}. Accounting ${record.accounting.state}.`} subtitle="Financial events and accounting status are separate source facts." testId="native-settlement-facts">
      <KpiRow><Kpi label="Creator cash paid" context="Independent source balance">{moneyFact(record.balances.creatorPaid)}</Kpi><Kpi label="Merchant invoice" context="Billed does not mean creator paid">{moneyFact(record.balances.billed)}</Kpi><Kpi label="Processing fee" context="Source amount; no assumed percentage">{moneyFact(record.fee)}</Kpi><Kpi label="Ledger reconciliation" context="No second commission expense or payment">{record.accounting.state}</Kpi></KpiRow>
      <div className={styles.lanes}>
        <section className={styles.lane} data-tone="violet" aria-labelledby="native-provider-lane"><h3 id="native-provider-lane">Provider-owned lane</h3><FactList wide labelWidth={232} gap={12} rows={[["Earned", moneyFact(record.balances.earned)], ["Held", moneyFact(record.balances.held)], ["Disputed", moneyFact(record.balances.disputed)], ["Merchant paid", moneyFact(record.balances.merchantPaid)], ["Creator paid", moneyFact(record.balances.creatorPaid)]]} /><FinanceSourceLink record={record} kind="evidence" label="Inspect source receipt" /></section>
        <section className={styles.lane} data-tone="subtle" aria-labelledby="native-accounting-lane"><h3 id="native-accounting-lane">Farda accounting lane</h3><FactList wide labelWidth={237} gap={12} rows={[["Accounting policy", data.accountingPolicy.state === "verified" ? data.accountingPolicy.reference ?? "Reference not supplied" : "Unknown"], ["Cash event", moneyFact(record.balances.creatorPaid)], ["Processing fee", moneyFact(record.fee)], ["QBO posting", record.accounting.qboRef ?? "Unknown"]]} /><Button aria-haspopup="dialog" onClick={() => setDialog("evidence")}>Review matching evidence</Button></section>
      </div>
    </Panel>
    <Panel large roomy title="Identity first, then accounting." subtitle="An unmatched source record stays in review. Inspect the account, payee and original evidence before requesting a match.">
      <DataTable caption="Source identity and matching" columns={[{ label: "Record" }, { label: "Observed value" }, { label: "Match status" }, { label: "Action" }]} rows={[
        ["Commission component", record.componentRef, record.crosswalk.state, <Button key="identity" variant="ghost" aria-haspopup="dialog" onClick={() => setDialog("identity")}>Review identity</Button>],
        ["Order-line crosswalk", record.crosswalk.orderRef ?? "Unknown", record.crosswalk.state, <Button key="crosswalk" variant="ghost" aria-haspopup="dialog" onClick={() => setDialog("crosswalk")}>Open crosswalk</Button>],
        ["Provider receipt", `${record.receipts.length} source receipts`, "Inspect original evidence", <Button key="receipt" variant="ghost" aria-haspopup="dialog" onClick={() => setDialog("evidence")}>Inspect receipt</Button>],
        ["QuickBooks entry", record.accounting.qboRef ?? "Unknown", record.accounting.state, <FinanceSourceLink key="ledger" record={record} kind="ledger" label="Open ledger source" />],
      ]} />
    </Panel>
    <Panel large roomy title="Source exceptions" subtitle="Each reported exception stays with its provider and source owner.">
      <SettlementExceptions record={record} />
      <div className={styles.actionsRow}><Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("exceptions")}>Review provider failure</Button><LinkButton variant="ghost" to="/finance/commissions">Back to commissions</LinkButton></div>
    </Panel>
    <FinancialEvidenceDialog record={dialog === "evidence" ? record : null} onClose={() => setDialog(null)} />
    <CrosswalkDialog record={record} open={dialog === "identity" || dialog === "crosswalk"} onClose={() => setDialog(null)} />
    <Dialog open={dialog === "exceptions"} title="Provider exceptions and recovery" onClose={() => setDialog(null)}><SettlementExceptions record={record} /><p>Keep the original provider correlation and immutable receipts. An unknown result must be reconciled by the source owner before another request; this review cannot pay or retry a payout.</p><Button variant="secondary" onClick={() => setDialog(null)}>Close recovery</Button></Dialog>
    <SettlementMatchDialog data={data} record={record} open={dialog === "match"} onClose={() => setDialog(null)} />
  </>;
}
export function SettlementExceptions({ record }: { record: SettlementRecord }) {
  return record.exceptions.length ? <ul className={native.evidence}>{record.exceptions.map(exception => <li key={exception.ref}><Badge tone="warning">{reasonText(exception.reason)}</Badge> {exception.ref} · owner {exception.owner} · deadline {observed(exception.deadline)} · evidence {exception.evidenceRef ?? "Unknown"}</li>)}</ul> : <p>No exception observations were returned. This does not establish provider health or completed settlement.</p>;
}
export function CrosswalkDialog({ record, open, onClose }: { record: SettlementRecord; open: boolean; onClose: () => void }) {
  return <Dialog open={open} title="Payee identity and crosswalk" onClose={onClose}><FactList label="Provider payee crosswalk" rows={[["Provider", record.provider], ["Account", record.accountRef], ["Settlement", record.ref], ["Canonical creator", record.creatorRef], ["Native identity", record.nativeRef ?? "Unknown"], ["Payee", record.crosswalk.payeeRef ?? "Unknown"], ["Order", record.crosswalk.orderRef ?? "Unknown"], ["State", record.crosswalk.state], ["Evidence", record.crosswalk.evidenceRefs.join(", ") || "Unknown"], ["Observed", observed(record.crosswalk.observedAt)]]} /><p>Read-only evidence. Viewing this crosswalk does not merge an ambiguous identity or confirm a financial match.</p><Button variant="secondary" onClick={onClose}>Close crosswalk</Button></Dialog>;
}
