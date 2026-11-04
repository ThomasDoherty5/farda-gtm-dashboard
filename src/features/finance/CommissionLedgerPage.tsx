import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import type { ReadResponse } from "@/adapter/contract";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney, formatMoneyExact } from "@/components/MetricValue";
import { ContextCard, FactList, GateRows, Page, PageHeader, Panel, SectionHeading } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { SourceDialog } from "@/features/approvals/shared";
import { ledgerTotals, netAccrued, STATE_LABEL, type CommissionGroup, type CommissionLedger, type CommissionState } from "@/fixtures/finance";
import { usd } from "@/fixtures/values";
import { toCsv } from "./csv";
import { FinanceTabs } from "./FinanceTabs";
import styles from "./Finance.module.css";

const cents = (n: number) => formatMoneyExact(usd(n));
const dollars = (n: number) => formatMoney(usd(n));
const signed = (n: number) => (n === 0 ? "$0" : `${n < 0 ? "−" : ""}${dollars(Math.abs(n))}`);
const TONE: Record<CommissionState, BadgeTone> = { held: "neutral", disputed: "warning", awaitingProvider: "violet", paid: "success" };
const ACTION: Record<CommissionState, string> = { held: "Review hold", disputed: "Review dispute", awaitingProvider: "Inspect eligibility", paid: "View receipt" };
const FOOTNOTE = "Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.";

/**
 * Commission ledger (Figma source 65:1037, owner THO-300). Provider-owned: there is no Pay action. Earned, held, disputed,
 * awaiting-provider and paid are separate facts, and every total is derived from the group rows.
 */
export function CommissionLedgerPage() {
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ scenario?: string }, CommissionLedger>("commissionLedger", scenario ? { scenario } : {});
  const [dialog, setDialog] = useState<null | "export" | { group: CommissionGroup } | { source: string }>(null);
  const res = query.data;
  const data = res?.data ?? null;
  return (
    <Page aria-labelledby="ledger-title" data-figma-source="65:1037">
      <PageHeader id="ledger-title" title="Every commission, accounted for." subtitle={data ? `${data.cohortLabel.split(" · ").slice(0, 2).join(" · ")} · separate from Overview and Launch cohort A` : undefined}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 198 }} onClick={() => setDialog("export")}>Export ledger</Button>
        <LinkButton to="/finance/settlements/COMM-DEMO-D" style={{ minWidth: 200 }}>Reconcile payout</LinkButton>
      </PageHeader>
      <FinanceTabs current="commissions" />
      {query.isPending && <SkeletonCard label="Loading the commission ledger…" />}
      {query.isError && <ViewError error={query.error} subject="The commission ledger" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No commissions yet"><p>The provider responded, but no commission groups exist for this scope. That is not the same as zero owed.</p></EmptyState>}
      {res && data && <Body res={res} data={data} setDialog={setDialog} />}
      <ExportDialog open={dialog === "export"} res={res} data={data} onClose={() => setDialog(null)} />
      <EvidenceDialog group={dialog && typeof dialog === "object" && "group" in dialog ? dialog.group : null} onClose={() => setDialog(null)} />
      <SourceDialog open={Boolean(dialog && typeof dialog === "object" && "source" in dialog)} title={dialog && typeof dialog === "object" && "source" in dialog ? dialog.source : ""} url={null} onClose={() => setDialog(null)} />
    </Page>
  );
}

type SetDialog = (d: null | "export" | { group: CommissionGroup } | { source: string }) => void;

function Body({ res, data, setDialog }: { res: ReadResponse<CommissionLedger>; data: CommissionLedger; setDialog: SetDialog }) {
  const t = ledgerTotals(data);
  const partial = res.dataState === "partial" || res.coverage.complete === false;
  const stale = res.dataState === "stale";
  const bar: [CommissionState, number][] = [["held", t.held], ["disputed", t.disputed], ["awaitingProvider", t.awaiting], ["paid", t.paid]];
  const e = data.economics;
  const waterfall = [
    { label: "Net sales", value: t.netSales, kind: "total" as const },
    { label: "Commerce costs", value: -e.commerceCosts },
    { label: "Fixed fee", value: -e.historicalFixedFee },
    { label: "Samples", value: -e.samples },
    { label: "Net commission", value: -t.accrued },
    { label: "Fee estimate", value: -t.fee },
    { label: "Contribution", value: t.contribution, kind: "total" as const },
  ];
  const PX = 224 / t.netSales;
  const ZERO = 258;
  let running = t.netSales;
  const geometry = waterfall.map((w, i) => {
    if (i === 0) return { ...w, top: ZERO - w.value * PX, height: w.value * PX };
    if (w.kind === "total") return { ...w, top: ZERO - w.value * PX, height: w.value * PX };
    const top = ZERO - running * PX;
    running += w.value;
    return { ...w, top, height: Math.abs(w.value) * PX };
  });
  const COL = 164.571;
  return (
    <>
      {stale && <p className={styles.footnote} role="status">The provider mirror is behind. Balances may be out of date.</p>}
      {partial && <p className={styles.footnote} role="status">Showing {data.groups.length} of {res.coverage.expectedCount ?? "?"} groups. The totals below cover only these, and the export is blocked until the snapshot is complete.</p>}
      <ContextCard title="Existing provider obligations" actions={<LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>}>
        This isolated illustrative commission cohort remains separate from acquisition forecasts. Honor earned amounts, preserve settled records and record later reversals as adjustments.
      </ContextCard>
      <ContextCard title="Provider-owned commission settlement">Social Cat is the recruitment source. Instagram + TikTok are publishing networks. Shopify website is checkout; Collabs is the illustrative commission and payout owner.</ContextCard>
      <KpiRow>
        <Kpi label="Net eligible sales" context={`${dollars(t.grossSales)} gross less ${dollars(t.refunds)} refunds`} testId="metric-Net eligible sales">{dollars(t.netSales)}</Kpi>
        <Kpi label="Net accrued commission" context={`${dollars(t.earned)} earned less ${dollars(t.reversed)} reversals`} testId="metric-Net accrued commission">{dollars(t.accrued)}</Kpi>
        <Kpi label="Cash commission paid" context="Cash is not deducted again from contribution" testId="metric-Cash commission paid">{dollars(t.paid)}</Kpi>
        <Kpi label="Estimated contribution" context={`${t.contributionPct.toFixed(2)}% · before shared overhead`} testId="metric-Estimated contribution">{cents(t.contribution)}</Kpi>
      </KpiRow>
      <Panel
        id="accrued-title"
        roomy
        testId="accrued"
        header={
          <div className={styles.headRow}>
            <SectionHeading id="accrued-title" large title="Accrued expense and cash are different." subtitle={`Four grouped synthetic claims · mutually exclusive current balances sum to ${dollars(t.accrued)}.`} />
            <LinkButton variant="secondary" to="/finance/settlements/COMM-DEMO-D" style={{ minWidth: 174 }}>View payout</LinkButton>
          </div>
        }
      >
        <ul className={styles.statusBar} aria-label="Current balances by state">
          {bar.map(([state, amount]) => <li key={state} data-state={state} style={{ flex: `${amount} 1 0` }}>{state === "awaitingProvider" ? "Awaiting" : STATE_LABEL[state]} {dollars(amount)}</li>)}
        </ul>
        <DataTable
          caption="Commission groups"
          testId="ledger-table"
          columns={[{ label: "Group", width: "14.4%" }, { label: "Gross → net base", width: "14.4%" }, { label: "Gross earned", width: "12%" }, { label: "Reversed", width: "11.2%" }, { label: "Net accrued", width: "12.8%" }, { label: "Current state", width: "18.4%" }, { label: "Next action" }]}
          rows={data.groups.map((g) => [
            g.id,
            `${dollars(g.grossSales)} → ${dollars(g.netBase)}`,
            dollars(g.earned),
            signed(-g.reversed),
            dollars(netAccrued(g)),
            <Badge key="b" tone={TONE[g.state]} width={g.state === "awaitingProvider" ? 190 : 154}>{STATE_LABEL[g.state]}</Badge>,
            <Button key="a" variant={g.state === "paid" ? "secondary" : "ghost"} aria-haspopup="dialog" aria-label={`${ACTION[g.state]}: ${g.id}`} style={{ minWidth: 170 }} onClick={() => setDialog(g.state === "paid" ? { source: `Receipt for ${g.id}` } : { group: g })}>{ACTION[g.state]}</Button>,
          ])}
        />
        <p className={styles.footnote}>Held {dollars(t.held)} + disputed {dollars(t.disputed)} + awaiting provider {dollars(t.awaiting)} + paid {dollars(t.paid)} = {dollars(t.held + t.disputed + t.awaiting + t.paid)} net accrued. COMM-DEMO IDs are local fixture groups. Provider eligibility is separate from commitment approval; source identity and receipts require reconciliation.</p>
      </Panel>
      <section id="contribution" className="" aria-labelledby="contribution-title">
        <Panel
          id="contribution-title"
          roomy
          large
          title="Contribution after creator costs"
          subtitle={`${data.orders.retained} retained orders from ${data.orders.initial} initial; ${data.orders.refundedBeforeFulfillment} refunded before fulfillment. USD · measured fixture + estimated processing fee.`}
          testId="contribution"
        >
          <div className={styles.plotScroll} role="region" aria-label="Contribution waterfall" tabIndex={0}>
            <div className={styles.waterfall} role="img" aria-label={`Net sales ${cents(t.netSales)} less commerce costs, fixed fee, samples, net commission and a processing estimate leaves a contribution of ${cents(t.contribution)}.`}>
              {[34, 146, 258].map((y) => <span key={y} className={styles.wfLine} style={{ top: y }} />)}
              {geometry.map((g, i) => {
                const left = `${(i * (COL + 16) * 100) / 1248}%`;
                const width = `${(COL * 100) / 1248}%`;
                return (
                  <span key={g.label}>
                    <span className={styles.wfBar} data-kind={g.kind} style={{ left, width, top: g.top, height: Math.max(g.height, 1) }} />
                    <p className={styles.wfValue} data-kind={g.kind} style={{ left, top: g.top - 27 }}>{g.value < 0 ? "−" : ""}{cents(Math.abs(g.value)).replace(/\.00$/, "")}</p>
                    <p className={styles.wfLabel} style={{ left }}>{g.label}</p>
                  </span>
                );
              })}
            </div>
            <table className="visually-hidden">
              <caption>Contribution after creator costs, USD</caption>
              <thead><tr><th scope="col">Step</th><th scope="col">Amount</th></tr></thead>
              <tbody>{waterfall.map((w) => <tr key={w.label}><th scope="row">{w.label}</th><td>{cents(w.value)}</td></tr>)}</tbody>
            </table>
          </div>
          <p className={styles.footnote}>Processing estimate = {e.processingFeePct}% × {dollars(t.accrued)}, excluding tax/FX. Actual invoice is authoritative. Refunds are already removed from net sales; paid cash is settlement of the accrued expense.</p>
        </Panel>
      </section>
      <Panel large title="One entitlement. One authoritative owner." subtitle="Match each commission to its creator agreement, order and provider record. Unmatched source records need review." testId="integrity">
        <GateRows
          label="Ledger integrity rules"
          rows={[
            { badge: <Badge tone="warning" width={140}>Crosswalk required</Badge>, title: "Imported TikTok orders in Shopify", text: "A mirrored order never creates a second website sale or commission" },
            { badge: <Badge tone="violet" width={140}>Separate records</Badge>, title: "Marketing attribution vs payee", text: "Farda credit cannot overwrite provider-authoritative entitlement" },
            { badge: <Badge width={140}>No manual Pay</Badge>, title: "Provider-settled commissions", text: "Fixed content-fee payables remain a separate lane" },
          ]}
        />
      </Panel>
      <p className={styles.footnote}>{FOOTNOTE}</p>
    </>
  );
}

function EvidenceDialog({ group, onClose }: { group: CommissionGroup | null; onClose: () => void }) {
  return (
    <Dialog open={group !== null} title={group ? `${group.id} · ${STATE_LABEL[group.state]}` : ""} badge="Read only" onClose={onClose}>
      {group && (
        <>
          <p>{group.evidence.note}</p>
          <FactList label="Evidence" rows={[["Gross → net base", `${dollars(group.grossSales)} → ${dollars(group.netBase)}`], ["Earned", dollars(group.earned)], ["Reversed", signed(-group.reversed)], ["Net accrued", dollars(netAccrued(group))], ["Provider receipt", group.evidence.receipt ?? "None yet"]]} />
          <p>Viewing this changes nothing. Holds, disputes and eligibility are decided in the provider.</p>
        </>
      )}
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}

function ExportDialog({ open, res, data, onClose }: { open: boolean; res: ReadResponse<CommissionLedger> | undefined; data: CommissionLedger | null; onClose: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const complete = Boolean(res && res.coverage.complete === true && res.dataState !== "partial");
  const rows = data?.groups ?? [];
  const download = () => {
    if (!data) return;
    const csv = toCsv(
      ["ledger_group", "state", "gross_sales_minor", "net_base_minor", "earned_minor", "reversed_minor", "net_accrued_minor", "commission_rate_pct", "currency", "observed_at", "ledger_revision"],
      rows.map((g) => [g.id, STATE_LABEL[g.state], g.grossSales, g.netBase, g.earned, g.reversed, netAccrued(g), g.netBase ? +((100 * g.earned) / g.netBase).toFixed(2) : null, data.currency, data.observedAt, data.version]),
    );
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `commission-ledger-${data.version}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage(`CSV with ${rows.length} rows prepared in your browser from the loaded snapshot. Nothing was sent anywhere.`);
  };
  return (
    <Dialog open={open} title="Export the commission ledger" badge="Demo" onClose={() => { setMessage(null); onClose(); }}>
      <p>UTF-8 CSV of the whole filtered snapshot, not only what is on screen. No customer personal data. Cells that could run as spreadsheet formulas are neutralized.</p>
      <FactList label="Export scope" rows={[["Rows", complete ? `${rows.length} of ${rows.length}` : `${rows.length} of ${res?.coverage.expectedCount ?? "?"} (incomplete)`], ["Currency", "USD"], ["As of", data?.observedAt.slice(0, 10) ?? "Unknown"], ["Ledger revision", data?.version ?? "Unknown"]]} />
      {!complete && <p role="alert">The snapshot is incomplete, so it can't be exported as the whole ledger. Reload when the provider has finished.</p>}
      <Button disabledReason={complete ? null : "Blocked until the snapshot is complete."} onClick={download}>Download CSV</Button>
      {message && <p role="status">{message}</p>}
      <Button variant="secondary" onClick={() => { setMessage(null); onClose(); }}>Close</Button>
    </Dialog>
  );
}
