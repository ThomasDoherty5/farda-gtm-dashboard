import { useState } from "react";
import { useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { scopeKey, useScope } from "@/adapter/scope";
import type { NativePayable, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { ContextCard, Divider, FactList, Note, PageHeader, Panel } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { displayReference, exactMoney, FinanceGrant, FinanceSourceLink, FinancialEvidenceDialog, moneyFact, observed, stateText } from "./NativeFinance";
import styles from "./Finance.module.css";
import native from "./NativeFinance.module.css";

export function NativePayablePage() {
  const { payableId = "" } = useParams(), ctx = useScope();
  const query = useView<{ payableId: string }, NativePayable>("payableDetail", { payableId });
  const refresh = () => { void query.refetch(); };
  return <RecordShell query={query} id="payable-title" title="Historical payable" subject="historical payable" figma="9:551">{(response, data) => data.kind === "native-payable" ?
    <FinanceGrant data={data} response={response} refresh={refresh} titleId="payable-title" title="Historical payable">
      {data.record ? <PayableBody key={JSON.stringify([...scopeKey(ctx), data.record.ref, data.record.version])} record={data.record} data={data} /> : <><PageHeader id="payable-title" title="Historical payable" /><p>No historical obligation was returned for this address.</p></>}
    </FinanceGrant> : <><PageHeader id="payable-title" title="Historical payable" /><p role="alert">A qualified native payable was not returned. Refresh source evidence before reviewing an obligation.</p></>
  }</RecordShell>;
}

function PayableBody({ record, data }: { record: SettlementRecord; data: NativePayable }) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const history = record.historical;
  const requested = record.facts.find(fact => fact.state === "requested");
  const executed = record.facts.find(fact => fact.state === "executed");
  const approval = record.facts.find(fact => fact.state === "approved");
  const paid = record.facts.find(fact => fact.state === "creatorPaid");
  const reconciled = record.facts.find(fact => fact.state === "reconciled");
  const stages = [
    { title: "Requested", note: requested ? `Source request observed ${observed(requested.observedAt)}` : "Unknown · request evidence not supplied" },
    { title: "Founder approval", note: approval ? `Source approval observed ${observed(approval.observedAt)}` : "Unknown · current approval not supplied" },
    { title: "Execution", note: executed ? `Source execution observed ${observed(executed.observedAt)}` : "Unknown · execution evidence not supplied" },
    { title: "Settled", note: paid ? `${paid.amount ? exactMoney(paid.amount) : "Amount unknown"} · ${observed(paid.eventAt)}` : "Unknown · settlement event not supplied" },
    { title: "Posted", note: record.accounting.qboRef ? `${record.accounting.state} · ${record.accounting.qboRef}` : "Unknown · accounting receipt not supplied" },
    { title: "Reconciled", note: reconciled ? `Source reconciliation observed ${observed(reconciled.observedAt)}` : "Unknown · reconciliation evidence not supplied" },
  ];
  return <>
    <PageHeader id="payable-title" title="Direct content fees end with proof." subtitle={<span className={native.reference}>{displayReference(record.ref)} · {displayReference(record.creatorRef)} · {history ? exactMoney(history.acceptedAmount) : "Accepted amount unknown"}</span>}>
      <FinanceSourceLink record={record} kind="ledger" label="Open ledger source" />
      <FinanceSourceLink record={record} kind="approval" label="Founder review" />
    </PageHeader>
    <ContextCard title="Existing payable · accepted historical terms" actions={<><FinanceSourceLink record={record} kind="currentOffer" label="Current affiliate terms" /><LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton></>}>
      {history ? `The accepted ${exactMoney(history.acceptedAmount)} obligation remains subject to its original terms, approval and source evidence.` : "Accepted historical terms were not supplied. Do not infer an amount or create a new commitment."} This is not a new acquisition offer or a second payment of provider-settled commission. <span className={native.historicalTerms}>Contract {history?.contractRef ?? "Unknown"} · accepted terms {history?.termsRef ?? "Unknown"} · version {history?.termsVersion ?? "Unknown"}</span>
    </ContextCard>
    <div className={styles.paymentRow}><Badge tone="warning">{stateText[record.state]}</Badge><p className={native.reference}>Invoice reference {history?.invoiceRef ?? "Unknown"}</p><span className={styles.spacer} /><Badge>{data.source.synthetic ? "Synthetic payable" : "Historical payable"}</Badge></div>
    <Panel large roomy title="Approval, execution, and reconciliation are separate." testId="native-payment-lifecycle">
      <ol className={styles.stages} aria-label="Independent payment evidence">{stages.map(stage => <li key={stage.title} className={styles.stage}><p className={styles.stageTitle}>{stage.title}</p><p className={styles.stageNote}>{stage.note}</p></li>)}</ol>
    </Panel>
    <div className={styles.payGrid}>
      <Panel large roomy title="Creator fee · accepted historical obligation" testId="native-payment-request">
        <FactList wide labelWidth={299} gap={20} label="Historical payment request" rows={[["Accepted amount", history ? exactMoney(history.acceptedAmount) : "Unknown"], ["Creator reference", record.creatorRef], ["Collaboration", record.collaborationRef ?? "Unknown"], ["Budget category", record.budgetCategory?.state === "known" ? record.budgetCategory.value : "Unknown"], ["Deliverable evidence", history?.deliverableRef ?? "Unknown"], ["Invoice reference", history?.invoiceRef ?? "Unknown"]]} />
        <Divider /><h3 className={styles.stageTitle}>Settlement evidence</h3>
        <FactList wide labelWidth={299} gap={20} label="Settlement evidence" rows={[["Provider receipt", record.receipts.map(receipt => receipt.ref).join(", ") || "Unknown · no receipt returned"], ["Settlement status", `Creator paid ${moneyFact(record.balances.creatorPaid)} · outstanding ${moneyFact(record.balances.outstanding)}`], ["QuickBooks reference", record.accounting.qboRef ?? "Unknown"], ["Reconciliation / policy", `${record.accounting.state} · ${data.accountingPolicy.state === "verified" ? data.accountingPolicy.reference ?? "Policy reference not supplied" : "CPA-approved policy unverified"}`]]} />
        <Note>Preserve the original accepted liability and paid receipts. Provider-settled commissions never create another manual payment here.</Note>
      </Panel>
      <div className={styles.stackCol}>
        <section className={styles.dark} aria-labelledby="native-founder-title"><h2 id="native-founder-title">A founder releases this step.</h2><p className={styles.bodyText}>The source approval must identify this creator, exact amount, currency, invoice and payment purpose. Viewing an approval does not release payment.</p><FinanceSourceLink record={record} kind="approval" label="Open Slack approval" /><span><Badge tone="warning">Execution held</Badge></span><p className={styles.smallText}>Current payment execution is not authorized by this screen. Expiry or changed terms require source review.</p></section>
        <Panel title="Handle exceptions explicitly." testId="native-payment-recovery">
          <FactList wide labelWidth={197} label="Exception handling" rows={[["Rejected", "Retain the reason; do not pay"], ["Failed", "Review original provider evidence"], ["Outcome unknown", "Reconcile the original request before retry"], ["Partial settlement", moneyFact(record.balances.outstanding)], ["Refund / reversal", `${record.adjustments.length} source adjustments returned`]]} />
          <Button variant="secondary" aria-haspopup="dialog" onClick={() => setEvidenceOpen(true)}>Inspect source evidence</Button>
          <FinanceSourceLink record={record} kind="evidence" label="Open source evidence" />
        </Panel>
      </div>
    </div>
    <section className={styles.closing} aria-labelledby="native-closing-title"><h2 id="native-closing-title">Close only when settlement and ledger agree.</h2><p>Require the direct-fee source receipt, settled amount, accounting posting and reconciliation. A sent message, saved proposal or approval alone proves neither payment nor settlement.</p></section>
    <FinancialEvidenceDialog record={evidenceOpen ? record : null} onClose={() => setEvidenceOpen(false)} />
  </>;
}
