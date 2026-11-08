import { useScope } from "@/adapter/scope";
import { NativePayablePage } from "./NativePayablePage";
import { useState } from "react";
import { useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { formatMoney } from "@/components/MetricValue";
import { ContextCard, Divider, FactList, Note, PageHeader, Panel } from "@/components/Panels";
import { blockedReason, SourceDialog } from "@/features/approvals/shared";
import { RecordShell } from "@/features/operations/RecordShell";
import { figure } from "@/features/operations/format";
import { PAYABLE_STAGES, type PayableDetail } from "@/fixtures/finance";
import styles from "./Finance.module.css";

/**
 * Historical manual fee settlement (Figma source 9:551, owner THO-300). An existing, accepted $150 content-fee payable. It is
 * not a new acquisition offer. Approval, execution, settlement, posting and reconciliation are separate steps, and nothing here pays.
 */
export function PayablePage() {
  const { adapter } = useScope();
  return adapter.kind === "demo" ? <DemoPayablePage /> : <NativePayablePage />;
}

function DemoPayablePage() {
  const { payableId = "" } = useParams();
  const query = useView<{ payableId: string }, PayableDetail>("payableDetail", { payableId });
  const [source, setSource] = useState<string | null>(null);
  return (
    <RecordShell query={query} id="payable-title" title={`Payable ${payableId}`} subject="payable" figma="9:551">
      {(res, p) => {
        const idx = PAYABLE_STAGES.findIndex((s) => s.key === p.stage);
        const amount = figure(p.amount, (m) => `USD ${m.minorUnits / 100}`);
        const blocked = blockedReason(res, "executePayment");
        return (
          <>
            <PageHeader id="payable-title" title="Direct content fees end with proof." subtitle={`${p.payableId} · ${p.handle} · ${amount} · founder approval required`}>
              <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 172 }} onClick={() => setSource("Open the ledger source")}>Open ledger source</Button>
              <LinkButton to={`/approvals/${p.approvalRef}`} style={{ minWidth: 166 }}>Founder review</LinkButton>
            </PageHeader>
            <ContextCard title="Existing payable · accepted historical terms" actions={<><LinkButton variant="secondary" to="/offers/demo-offer" style={{ minWidth: 208.5 }}>Current affiliate terms</LinkButton><LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton></>}>
              The agreed {p.amount.value ? formatMoney(p.amount.value) : "content fee amount is not reported, and the"} content fee remains payable through its original approval and evidence controls. It is not a new acquisition offer or a second payment of provider-settled commission.
            </ContextCard>
            <div className={styles.paymentRow}>
              <Badge tone="warning" width={166}>Approval pending</Badge>
              <p>Content approved · invoice reference {p.invoiceRef}</p>
              <span className={styles.spacer} />
              <Badge width={142}>Demo payment</Badge>
            </div>
            <Panel large roomy title="Approval, execution, and reconciliation are separate." testId="lifecycle">
              <ol className={styles.stages} aria-label="Payment lifecycle">
                {PAYABLE_STAGES.map((st, i) => (
                  <li key={st.key} className={styles.stage} aria-current={i === idx ? "step" : undefined} data-done={i < idx}>
                    <p className={styles.stageTitle}>{st.title}<span className="visually-hidden"> · {i < idx ? "done" : i === idx ? "current step" : "not yet"}</span></p>
                    <p className={styles.stageNote}>{st.note}</p>
                  </li>
                ))}
              </ol>
            </Panel>
            <div className={styles.payGrid}>
              <Panel large roomy title="Creator fee · approved deliverable" testId="payment-request">
                <FactList wide labelWidth={299} gap={20} label="Payment request" rows={[["Amount", amount], ["Creator handle", p.handle], ["Collaboration", p.collaboration], ["Deliverable evidence", p.evidence], ["Invoice reference", p.invoiceRef], ["Budget category", p.budgetCategory]]} />
                <Divider />
                <h3 style={{ margin: 0, font: "var(--text-h3)" }}>Settlement evidence</h3>
                <FactList wide labelWidth={299} gap={20} label="Settlement evidence" rows={[["Provider transaction", p.providerTransaction ?? "Not available"], ["Settlement status", p.settlementStatus], ["QuickBooks reference", p.quickbooksRef ?? "Not posted"], ["Reconciliation", p.reconciliation]]} />
                <Note>This is the direct $150 content-fee lane. Provider-settled Collabs or TikTok commissions never create a duplicate manual payment here.</Note>
              </Panel>
              <div className={styles.stackCol}>
                <section className={styles.dark} aria-labelledby="founder-title">
                  <h2 id="founder-title">A founder releases this step.</h2>
                  <p className={styles.bodyText}>The approval must identify this creator, amount, currency, invoice, and payment purpose.</p>
                  <Button variant="secondary" aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => setSource("Open the Slack approval")}>Open Slack approval</Button>
                  <span><Badge tone="warning" width={180}>Execution blocked</Badge></span>
                  <p className={styles.smallText}>Approval expiry or any changed amount returns the request to review.</p>
                  {blocked && <p className="visually-hidden">{blocked}</p>}
                </section>
                <Panel title="Handle exceptions explicitly." testId="recovery">
                  <FactList wide labelWidth={197} label="Exception handling" rows={[["Rejected", "Capture reason; do not pay"], ["Failed", "Review provider evidence"], ["Outcome unknown", "Reconcile before retry"], ["Partial settlement", "Record balance outstanding"], ["Refund / reversal", "Link source adjustment"]]} />
                  <Button variant="secondary" aria-haspopup="dialog" style={{ width: "100%" }} onClick={() => setSource("Open the source evidence")}>Open source evidence</Button>
                </Panel>
              </div>
            </div>
            <section className={styles.closing} aria-labelledby="closing-title">
              <h2 id="closing-title">Close only when settlement and ledger agree.</h2>
              <p>Require the direct-fee provider receipt, settled amount, QuickBooks posting and reconciliation. Provider commissions use their separate native settlement lane; a Sent message proves neither payment nor settlement.</p>
            </section>
            <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
          </>
        );
      }}
    </RecordShell>
  );
}
