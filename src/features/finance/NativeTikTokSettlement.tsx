import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { NativeSettlement, SettlementRecord } from "@/creator-agent/settlements/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi } from "@/components/Kpi";
import { ContextCard, FactList, GateRows, PageHeader, Panel } from "@/components/Panels";
import { SectionTabs } from "@/components/SectionTabs";
import { displayReference, exactMoney, FinancialEvidenceDialog, FinancialHeldButton, FinanceSourceLink, moneyFact, observed, reasonText, recordPath, stateText } from "./NativeFinance";
import { SettlementExceptions } from "./NativeSettlementPage";
import { SettlementMatchDialog } from "./NativeStatementMatch";
import styles from "./Finance.module.css";

const tabs = [{ key: "rates", label: "Rates & terms", width: 123 }, { key: "samples", label: "Samples", width: 100 }, { key: "settlement", label: "Native settlement", width: 151 }, { key: "exceptions", label: "Exceptions", width: 102 }] as const;
const rateText = (fact: SettlementRecord["commissionRatePct"] | undefined) => !fact ? "Unknown" : fact.state === "known" ? `${fact.value}%` : fact.state === "notApplicable" ? "N/A" : "Unknown";

export function NativeTikTokSettlement({ data, record }: { data: NativeSettlement; record: SettlementRecord }) {
  const [params] = useSearchParams();
  const tab = tabs.find(item => item.key === params.get("tab"))?.key ?? "rates";
  const [dialog, setDialog] = useState<"history" | "evidence" | "match" | "recovery" | null>(null);
  const tabTo = (key: string) => { const next = new URLSearchParams(params); if (key === "rates") next.delete("tab"); else next.set("tab", key); return `${recordPath(record)}${next.size ? `?${next}` : ""}`; };
  const historical = record.historical;
  const lane = (key: "standard" | "shopAds", title: string, tone: "violet" | "subtle") => {
    const rate = record.rates.find(item => item.lane === key);
    return <section className={styles.lane} data-tone={tone} aria-labelledby={`native-rate-${key}`}><h3 id={`native-rate-${key}`}>{title}</h3><p className={styles.footnote}>{key === "standard" ? "Organic / native affiliate context" : "Eligible ad-driven order context"}</p>
      <div className={styles.rateKpis}><Kpi label="Active native rate" context={rate?.activePct.state === "known" ? "Exact source component" : rate ? reasonText(rate.activePct.reasonCode ?? "NOT_OBSERVED") : "Source component not supplied"}>{rateText(rate?.activePct)}</Kpi><Kpi label="Proposed rate" context={rate?.proposedPct.state === "known" ? "Not active until source-effective" : rate ? reasonText(rate.proposedPct.reasonCode ?? "NOT_OBSERVED") : "Source component not supplied"}>{rateText(rate?.proposedPct)}</Kpi></div>
      <FactList wide labelWidth={237} gap={12} label={`${title} facts`} rows={[["Active from", observed(rate?.activeFrom ?? null)], ["Proposed from", observed(rate?.proposedFrom ?? null)], ["Terms version", rate?.termsVersion ?? "Unknown"], ["Rate owner", "TikTok Shop native record"]]} />
    </section>;
  };
  return <>
    <PageHeader id="settlement-title" title="Native rates. Native settlement." subtitle={`${displayReference(record.ref)} · TikTok Shop · ${record.accountRef}`}>
      <FinancialHeldButton reason="Target invite unavailable. Refresh source access.">Open target invite</FinancialHeldButton><LinkButton to="/settings/capabilities">Validate native access</LinkButton>
    </PageHeader>
    <SectionTabs label="TikTok settlement sections" tabs={tabs.map(item => ({ label: item.label, to: tabTo(item.key), width: item.width, current: item.key === tab }))} />
    <ContextCard title="Historical funded work and current commission terms" actions={<><LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton><LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton></>}>Previously accepted funded obligations retain their own source terms. New acquisition is commission-only; Standard and Shop Ads terms remain independently evidenced.</ContextCard>
    <ContextCard title="Keep commission components separate">The source determines the winning component. An order does not earn both rates by assumption, and an imported Shopify mirror never creates another payout.</ContextCard>
    {tab === "rates" ? <>
      <Panel title="Read the rate that actually applies." large spacious subtitle="Current, proposed and effective terms are distinct. Read the exact source dates and versions.">
        <div className={styles.rateLanes}>{lane("standard", "Standard commission", "violet")}{lane("shopAds", "Shop Ads commission", "subtle")}</div>
        <DataTable caption="Native commission routing" minWidth={1248} columns={[{ label: "Order event", width: "300px" }, { label: "Entitlement", width: "340px" }, { label: "Financial state", width: "360px" }, { label: "Action", width: "248px" }]} rows={[
          ["Affiliate order", record.orderRef ?? "Unknown order identity", stateText[record.state], <FinanceSourceLink key="order" record={record} kind="order" targetRef={record.orderRef ?? ""} label="Inspect native order" />],
          ["Refund / reversal", `${record.adjustments.length} source adjustments`, "Original receipts remain immutable", <Button key="adjustment" variant="ghost" aria-haspopup="dialog" onClick={() => setDialog("evidence")}>Review adjustment</Button>],
          ["Native settlement", record.componentRef, record.accounting.state, <Button key="match" variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("match")}>Open reconciliation</Button>],
        ]} />
      </Panel>
      <Panel id="native-historical-title" title="Historical accepted terms · read only" large roomy subtitle={<span id="native-historical-explanation">Previously accepted terms remain auditable. These categories cannot select a new offer, fee, approval or payment.</span>}>
        <SectionTabs label="Historical offer models, read only" tabs={[{ label: "Commission only", to: "#", width: 137, disabled: true, reasonId: "native-historical-explanation" }, { label: "Flat fee", to: "#", width: 100, disabled: true, reasonId: "native-historical-explanation" }, { label: "Flat fee + commission", to: "#", width: 179, disabled: true, reasonId: "native-historical-explanation" }]} />
        <GateRows label="Historical funding and review" rows={[
          { badge: <Badge tone="warning">Source approval</Badge>, title: "Invitation funding", text: historical?.fundingRef ?? "Unknown · no historical funding evidence returned" },
          { badge: <Badge tone="violet">Source deadline</Badge>, title: "Content review round", text: observed(historical?.reviewDeadline ?? null) },
          { badge: <Badge>Historical version</Badge>, title: "Accepted terms", text: historical?.termsVersion ?? "Unknown · no accepted historical terms returned" },
          { badge: <Badge>Observe + reconcile</Badge>, title: "Provider release", text: "No duplicate manual payout after provider funding" },
        ]} />
        <Button variant="secondary" style={{ alignSelf: "flex-start", minWidth: 240 }} aria-haspopup="dialog" onClick={() => setDialog("history")}>Review historical terms</Button>
      </Panel>
      <Panel title="Missing API action routes to a validated browser task." large roomy subtitle="A missing API does not grant permission. A native browser route requires its own verified authority.">
        <ul className={styles.chips} aria-label="Source action requirements"><li><Badge>Verified source capability</Badge></li><li><Badge tone="violet">Exact approved decision</Badge></li><li><Badge>Current source permission</Badge></li><li><Badge>Original native receipt</Badge></li></ul>
        <p className={styles.footnote}>Use the actual request and program deadline. Login/MFA, denied access, UI drift and uncertain submission require source-owner recovery; do not repeat an unknown request.</p>
        <div className={styles.actionsRow}><FinanceSourceLink record={record} kind="sample" label="Open sample request" /><Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("recovery")}>Reconcile unknown result</Button><Button variant="ghost" aria-haspopup="dialog" onClick={() => setDialog("recovery")}>Request takeover</Button></div>
      </Panel>
    </> : tab === "samples" ? <Panel title="Samples" large roomy subtitle="Provider-scoped source evidence; opening this tab changes nothing.">
      <DataTable caption="Native sample requests" columns={[{ label: "Sample" }, { label: "Source state" }, { label: "Quantity" }, { label: "Cost" }, { label: "Evidence" }]} rows={record.samples.map(sample => [sample.ref, sample.state, sample.quantity === null ? "Unknown" : String(sample.quantity), moneyFact(sample.cost), sample.evidenceRef ?? "Unknown"])} />
      {!record.samples.length && <p>No sample observations were returned for this record.</p>}<FinanceSourceLink record={record} kind="sample" label="Open sample request" />
    </Panel> : tab === "settlement" ? <Panel title="Native settlement" large roomy subtitle="Source receipts and accounting matches remain separate.">
      <FactList rows={[["Earned", moneyFact(record.balances.earned)], ["Creator paid", moneyFact(record.balances.creatorPaid)], ["Outstanding", moneyFact(record.balances.outstanding)], ["Accounting", record.accounting.state]]} />
      <div className={styles.actionsRow}><Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("evidence")}>Inspect immutable receipts</Button><Button aria-haspopup="dialog" onClick={() => setDialog("match")}>Match statement</Button></div>
    </Panel> : <Panel title="Exceptions" large roomy subtitle="Original records and source recovery reasons."><SettlementExceptions record={record} /><Button variant="secondary" aria-haspopup="dialog" onClick={() => setDialog("recovery")}>Review recovery</Button></Panel>}
    <Dialog open={dialog === "history"} title="Historical accepted terms" onClose={() => setDialog(null)}>
      {historical ? <FactList rows={[["Accepted", observed(historical.acceptedAt)], ["Accepted amount", exactMoney(historical.acceptedAmount)], ["Terms", historical.termsRef], ["Version", historical.termsVersion], ["Contract", historical.contractRef], ["Original approval", historical.approvalRef ?? "Unknown"], ["Funding", historical.fundingRef ?? "Unknown"], ["Review deadline", observed(historical.reviewDeadline)], ["Settlement owner", historical.payoutOwner]]} /> : <p>No historical accepted terms were returned. No flat-fee or hybrid obligation is inferred.</p>}<p>Read only. This review cannot create a new commitment or change current commission-only policy.</p><Button variant="secondary" onClick={() => setDialog(null)}>Close historical terms</Button>
    </Dialog>
    <Dialog open={dialog === "recovery"} title="Source recovery and human takeover" onClose={() => setDialog(null)}><SettlementExceptions record={record} /><p>Preserve the original request and receipt. Ask the listed source owner to reconcile an uncertain native result before any retry. This dialog has not sent a takeover request or created a provider action.</p><FinanceSourceLink record={record} kind="evidence" label="Open original source evidence" /><Button variant="secondary" onClick={() => setDialog(null)}>Close recovery</Button></Dialog>
    <FinancialEvidenceDialog record={dialog === "evidence" ? record : null} onClose={() => setDialog(null)} />
    <SettlementMatchDialog data={data} record={record} open={dialog === "match"} onClose={() => setDialog(null)} />
  </>;
}
