import { useScope } from "@/adapter/scope";
import { NativeSettlementPage } from "./NativeSettlementPage";
import { useState } from "react";
import { useParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney, formatMoneyExact } from "@/components/MetricValue";
import { ContextCard, FactList, GateRows, PageHeader, Panel, SectionHeading } from "@/components/Panels";
import { ActionError, blockedReason, EXECUTION_LABELS, SourceDialog } from "@/features/approvals/shared";
import { netAccrued, type SettlementRecord } from "@/fixtures/finance";
import { usd } from "@/fixtures/values";
import { FinanceTabs } from "./FinanceTabs";
import { RecordShell } from "@/features/operations/RecordShell";
import { TikTokSettlement } from "./TikTokSettlement";
import styles from "./Finance.module.css";

export const FOOTNOTE = "Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.";
const dollars = (n: number) => formatMoney(usd(n));

type DialogState = null | { kind: "source"; title: string } | { kind: "match" } | { kind: "evidence" } | { kind: "crosswalk" } | { kind: "identity" };

/**
 * Settlement detail (Figma sources 66:252 Collabs payout reconciliation and 66:447 TikTok native settlement, owner THO-300).
 * The record's provider picks the composition. Settlement is observed and reconciled here, never paid: there is no Pay action,
 * and a paid receipt is immutable.
 */
export function SettlementPage() {
  const { adapter } = useScope();
  return adapter.kind === "demo" ? <DemoSettlementPage /> : <NativeSettlementPage />;
}

function DemoSettlementPage() {
  const { settlementId = "" } = useParams();
  const query = useView<{ settlementId: string }, SettlementRecord>("settlementDetail", { settlementId });
  return (
    <RecordShell query={query} id="settlement-title" title="Settlement" subject="settlement" figma="66:252">
      {(res, s) => (s.provider === "tiktok" ? <TikTokSettlement res={res} s={s} /> : <Collabs res={res} s={s} />)}
    </RecordShell>
  );
}

function Collabs({ res, s }: { res: ReadResponse<SettlementRecord>; s: SettlementRecord }) {
  const [dialog, setDialog] = useState<DialogState>(null);
  const g = s.group;
  const paid = netAccrued(g);
  const fee = Math.round((paid * s.processingFeePct) / 100);
  const src = (title: string) => () => setDialog({ kind: "source", title });
  const submitted = s.submitted;
  return (
    <>
      <PageHeader id="settlement-title" title="Follow the money." subtitle={`${g.id} · local synthetic group · Collabs payout ownership`}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 198 }} onClick={src("Open the native payout")}>Open native payout</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 200 }} onClick={() => setDialog({ kind: "match" })}>Match statement</Button>
      </PageHeader>
      <FinanceTabs current="payouts" />
      <ContextCard title="Existing provider obligations" actions={<LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>}>
        This isolated illustrative commission cohort remains separate from acquisition forecasts. Honor earned amounts, preserve settled records and record later reversals as adjustments.
      </ContextCard>
      <ContextCard title="Settlement is not a second payment">The provider controls billing and creator payout. Farda observes, resolves exceptions and reconciles the source evidence to QuickBooks. This lane never creates a duplicate manual Pay task.</ContextCard>
      {submitted && <Alert state="info" title={EXECUTION_LABELS.approvalPending} testId="match-status"><p>{submitted.state}</p></Alert>}
      <Panel
        id="paid-title"
        spacious
        testId="paid-receipt"
        header={
          <div className={styles.headRow}>
            <SectionHeading id="paid-title" large title="Creator paid. Invoice match still open." subtitle={`Synthetic settled group · ${s.retainedOrders} retained orders × ${dollars(s.eligibleMerchandise)} eligible merchandise × ${s.ratePct}% = ${dollars(paid)}.`} />
            <span style={{ width: 174, maxWidth: "100%", flexShrink: 0 }}><Badge tone="violet" width={174}>Source fixture</Badge></span>
          </div>
        }
      >
        <KpiRow align="start">
          <Kpi label="Creator cash paid" context="Illustrative provider-paid event" testId="metric-Creator cash paid">{dollars(paid)}</Kpi>
          <Kpi label="Merchant invoice" context="Not yet matched to authoritative statement" testId="metric-Merchant invoice">{s.invoiceState === "unmatched" ? "Unmatched" : "Matched"}</Kpi>
          <Kpi label="Fee estimate" context={`${s.processingFeePct}% of ${dollars(paid)} · tax/FX excluded`} testId="metric-Fee estimate">{formatMoneyExact(usd(fee))}</Kpi>
          <Kpi label="Ledger reconciliation" context={<>No second commission expense or<br />payment</>} testId="metric-Ledger reconciliation">Pending</Kpi>
        </KpiRow>
        <div className={styles.lanes}>
          <section className={styles.lane} data-tone="violet" style={{ gap: 16 }} aria-labelledby="provider-lane">
            <h3 id="provider-lane">Provider-owned lane</h3>
            <FactList wide labelWidth={232} gap={12} label="Source-owned facts" rows={[["Commission eligible", "Recorded in provider"], ["Hold/review", "Source deadline observed"], ["Merchant billing", "Invoice match pending"], ["Creator payout", `${dollars(paid)} paid · illustrative receipt`]]} />
            <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: "min(230px, 100%)", alignSelf: "flex-start" }} onClick={src("Inspect the source receipt")}>Inspect source receipt</Button>
          </section>
          <section className={styles.lane} data-tone="subtle" style={{ gap: 16 }} aria-labelledby="farda-lane">
            <h3 id="farda-lane">Farda accounting lane</h3>
            <FactList wide labelWidth={242} gap={12} label="Farda-side facts" rows={[["Expense recognized", "Net accrued, after reversals"], ["Cash event", "Match the provider payment"], ["Processing fee", "Replace estimate with invoice"], ["QBO posting", "Link journal / transaction ID"]]} />
            <Button aria-haspopup="dialog" style={{ minWidth: "min(248px, 100%)", alignSelf: "flex-start" }} onClick={() => setDialog({ kind: "evidence" })}>Review matching evidence</Button>
          </section>
        </div>
      </Panel>
      <Panel large roomy title="Identity first, then accounting." subtitle="Match the creator agreement, orders and provider statement before posting. An unmatched source record stays in review." testId="identity">
        <DataTable
          caption="Source identity and matching"
          columns={[{ label: "Record", width: "24.9%" }, { label: "Observed value", width: "37.7%" }, { label: "Match status", width: "20.8%" }, { label: "Action" }]}
          rows={[
            ["Commission group", `${g.id} · local fixture`, "Provider identity pending", <Button key="a" variant="ghost" aria-haspopup="dialog" aria-label="Review identity" style={{ minWidth: 174 }} onClick={() => setDialog({ kind: "identity" })}>Review identity</Button>],
            ["Order-line crosswalk", "TikTok import is a mirror, never another sale", "Required when applicable", <Button key="a" variant="ghost" aria-haspopup="dialog" style={{ minWidth: 174 }} onClick={() => setDialog({ kind: "crosswalk" })}>Open crosswalk</Button>],
            ["Provider receipt", `${dollars(paid)} paid · example only`, "Native evidence to match", <Button key="a" variant="ghost" aria-haspopup="dialog" style={{ minWidth: 174 }} onClick={src("Inspect the provider receipt")}>Inspect receipt</Button>],
            ["QuickBooks entry", "Awaiting matched statement", "Not reconciled", <Button key="a" variant="ghost" aria-haspopup="dialog" style={{ minWidth: 174 }} onClick={src("Open the ledger source")}>Open ledger source</Button>],
          ]}
        />
      </Panel>
      <Panel large roomy title="Separate exception scenarios" subtitle="These are alternative cases, not the state of the $90 paid example above. Each stays with its provider and owner." testId="exceptions">
        <GateRows
          label="Settlement exception scenarios"
          rows={[
            { badge: <Badge tone="warning" width={140}>Activation pending</Badge>, title: "Creator payout activation", text: "Creator setup incomplete; this does not mean billed or paid" },
            { badge: <Badge tone="violet" width={140}>Deadline owned</Badge>, title: "Holding / dispute review", text: "Review before the source hold expires; configurable source terms" },
            { badge: <Badge tone="warning" width={140}>Needs recovery</Badge>, title: "Billing or payout failure", text: "Inspect native reason and receipt; never trigger a second external payout" },
            { badge: <Badge tone="warning" width={140}>Reconcile first</Badge>, title: "Partial or post-hold refund", text: "Unverified behavior stays an exception until the source adjustment is matched" },
          ]}
        />
        <div className={styles.actionsRow}>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 254 }} onClick={src("View the activation exception")}>View activation exception</Button>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 242 }} onClick={src("Review the provider failure")}>Review provider failure</Button>
          <LinkButton variant="ghost" to="/finance/commissions" style={{ minWidth: 220 }}>Back to commissions</LinkButton>
        </div>
      </Panel>
      <p className={styles.footnote}>{FOOTNOTE}</p>

      <MatchDialog open={dialog?.kind === "match"} res={res} s={s} onClose={() => setDialog(null)} />
      <Dialog open={dialog?.kind === "evidence"} title="Matching evidence" badge="Read only" onClose={() => setDialog(null)}>
        <FactList label="Matching evidence" rows={[["Provider receipt", g.evidence.receipt ?? "None"], ["Adjustments after payout", (g.adjustments ?? []).length ? (g.adjustments ?? []).map((a) => `${a.id}: ${dollars(a.amountMinor)} (${a.reason})`).join("; ") : "None"], ["Group", g.id], ["Net accrued", dollars(paid)], ["Provider paid", `${dollars(paid)} · illustrative`], ["Difference", "$0 · not confirmed until a statement matches"], ["Merchant invoice", "Unmatched"]]} />
        <p>Viewing evidence does not confirm a match or change a payout.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "crosswalk"} title="Payee and order crosswalk" badge="Read only" onClose={() => setDialog(null)}>
        <FactList label="Crosswalk" rows={[["Canonical group", g.id], ["Provider payee", "Not resolved"], ["Mapping evidence", "None recorded"], ["Conflicts", "None observed"], ["Freshness", "Synthetic fixture"]]} />
        <p>Editing a mapping is a separately authorized action, not this button.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "identity"} title="Identity review" badge="Read only" onClose={() => setDialog(null)}>
        <p>The provider identity for {g.id} is pending. An ambiguous payee is never merged automatically: it stays in review until the source resolves it.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <SourceDialog open={dialog?.kind === "source"} title={dialog?.kind === "source" ? dialog.title : ""} url={null} onClose={() => setDialog(null)} />
    </>
  );
}

function MatchDialog({ open, res, s, onClose }: { open: boolean; res: ReadResponse<SettlementRecord>; s: SettlementRecord; onClose: () => void }) {
  const [chosen, setChosen] = useState<string[]>(["STMT-DEMO-0001"]);
  const action = useAction<{ settlementId: string; matches: { statementRef: string; groupId: string }[] }>();
  const blocked = blockedReason(res, "reconcileSettlement");
  const errors = action.error instanceof AdapterError ? (action.error.body.fieldErrors ?? {}) : {};
  const submit = () =>
    action.mutate(
      { operation: "requestApproval", actionKind: "reconcileSettlement", entityRefs: [], expectedVersion: s.version, approvalRef: null, manifestRef: null, payload: { settlementId: s.settlementId, matches: s.candidates.filter((c) => chosen.includes(c.statementRef)).map((c) => ({ statementRef: c.statementRef, groupId: c.groupId })) } },
      { onSuccess: onClose },
    );
  return (
    <Dialog open={open} title="Match the provider statement" badge="Preview" onClose={onClose}>
      <p>These are the candidate matches between the provider statement and the ledger. Submitting asks for a review. It marks nothing reconciled, and the paid receipt stays as it is.</p>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <fieldset className={styles.candidates} aria-describedby={errors.matches ? "match-error" : undefined}>
          <legend>Statement lines</legend>
          {s.candidates.map((c) => (
            <label key={c.statementRef} className={styles.candidate}>
              <input type="checkbox" checked={chosen.includes(c.statementRef)} disabled={Boolean(c.problem)} onChange={(e) => setChosen(e.target.checked ? [...chosen, c.statementRef] : chosen.filter((x) => x !== c.statementRef))} />
              <span><strong>{c.statementRef} → {c.groupId}</strong>{formatMoneyExact(c.amount)} · {c.period}<br />{c.evidence}{c.problem && <><br />Stays unresolved: {c.problem}. Resolve it in the source.</>}</span>
            </label>
          ))}
          {errors.matches && <span id="match-error" role="alert">{errors.matches}</span>}
        </fieldset>
        {action.error && <ActionError error={action.error} />}
        <Button type="submit" loading={action.isPending} disabledReason={blocked ? "A match is already submitted for review." : null}>Submit for review</Button>
        <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
      </form>
    </Dialog>
  );
}
