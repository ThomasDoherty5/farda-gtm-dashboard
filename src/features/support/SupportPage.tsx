import { useScope } from "@/adapter/scope";
import { NativeSupportPage } from "./NativeSupportPage";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { formatMoney } from "@/components/MetricValue";
import { Kpi, KpiRow } from "@/components/Kpi";
import { BarRows, Divider, FactList, FlatTable, HalfColumns, Notice, PageHeader, Panel, TwoColumns } from "@/components/Panels";
import { SourceDialog } from "@/features/approvals/shared";
import { OpsTabs } from "@/features/operations/OpsTabs";
import { RecordShell } from "@/features/operations/RecordShell";
import { figure, minutesAgoLabel } from "@/features/operations/format";
import type { SupportState, SupportWorkspace } from "@/fixtures/support";
import styles from "./Support.module.css";

const TONE: Record<SupportState, BadgeTone> = { "Needs reply": "danger", Waiting: "warning", "In review": "violet", Resolved: "success" };
const OWNER: Record<string, string> = { Ops: "Operations" };
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((100 * n) / d)}%` : "N/A");

/**
 * Support workspace (Figma source 7:317, owner THO-302). The case lives in Intercom. This page mirrors only safe operational
 * fields and hands off through dialogs; it never shows conversation text or customer details, and it can't reopen, reassign or reply.
 * The 14-day cohort and the all-time open queue are different sets and are labeled as such.
 */
export function SupportPage() {
  return useScope().scope.environment === "demo" ? <DemoSupportPage /> : <NativeSupportPage />;
}

function DemoSupportPage() {
  const { caseId = "" } = useParams();
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ caseId: string; scenario?: string }, SupportWorkspace>("supportWorkspace", scenario ? { caseId, scenario } : { caseId });
  const [dialog, setDialog] = useState<"cohort" | string | null>(null);
  return (
    <RecordShell query={query} id="support-title" title="Support & returns" subject="support case" figma="7:317">
      {(res, d) => {
        const total = d.cohort.tickets.reduce((n, t) => n + t.count, 0);
        const stale = res.dataState === "stale";
        const c = d.case;
        const finPct = d.fin.cap.minorUnits > 0 ? Math.round((100 * d.fin.cost.minorUnits) / d.fin.cap.minorUnits) : null;
        const link = (to: string, label: string) => <Link className={styles.link} to={to}>{label}</Link>;
        return (
          <>
            <PageHeader id="support-title" title="Support & returns" subtitle="Keep the handoff clear. Keep customer details in Intercom.">
              <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setDialog("cohort")}>{d.cohort.days}-day cohort</Button>
              <Button aria-haspopup="dialog" style={{ minWidth: 190 }} onClick={() => setDialog("Open Intercom")}>Open Intercom</Button>
            </PageHeader>
            <OpsTabs current="support" />
            <Notice tone={stale ? "warning" : "violet"} label={stale ? "Behind" : "Source"} title="Only safe operational fields are mirrored" role={stale ? "status" : undefined} testId="source-freshness">
              {`Order ID, issue tags, owner, outcome and cost. Conversation text and personal details stay in Intercom.${stale ? ` The mirror is behind: synced ${minutesAgoLabel(d.source.syncedMinutesAgo)}.` : ""}`}
            </Notice>
            <KpiRow>
              <Kpi label="All-time open queue" context={`${d.cohort.open} open in the ${d.cohort.days}-day cohort`} testId="metric-All-time open queue">{figure(d.allTimeOpen, String)}</Kpi>
              <Kpi label="First contact resolution" context={`${d.cohort.resolvedFirstContact} of ${total} cohort tickets`} testId="metric-First contact resolution">{pct(d.cohort.resolvedFirstContact, total)}</Kpi>
              <Kpi label="Returns" context={`${d.cohort.returns} / ${d.cohort.deliveredUnits} delivered units · same cohort`} testId="metric-Returns">{d.cohort.deliveredUnits > 0 ? `${((100 * d.cohort.returns) / d.cohort.deliveredUnits).toFixed(1)}%` : "N/A"}</Kpi>
              <Kpi label="Fin cost" context={`Demo monthly cap · ${finPct === null ? "usage N/A" : `${finPct}% used`}`} testId="metric-Fin cost">{formatMoney(d.fin.cost)} / {formatMoney(d.fin.cap)}</Kpi>
            </KpiRow>
            <TwoColumns>
              <Panel title="Handoffs that need an owner" subtitle="All-time queue · source remains Intercom" testId="handoff-queue">
                <FlatTable
                  caption="Handoffs that need an owner"
                  columns={[{ label: "Issue / order", width: 288 }, { label: "Type", width: 180 }, { label: "State", width: 172 }, { label: "Owner", width: 136 }]}
                  testId="queue-table"
                  rows={d.queue.map((q) => ({
                    key: q.id,
                    cells: [
                      <Link key="i" className={styles.issue} to={`/support/cases/${q.id}`} aria-current={q.id === d.caseId ? "true" : undefined}>{q.id} / {q.orderRef.replace("TEST-", "")}</Link>,
                      q.type,
                      <Badge key="s" tone={TONE[q.state]} width={132}>{q.state}</Badge>,
                      q.owner,
                    ],
                  }))}
                />
                <Button aria-haspopup="dialog" style={{ minWidth: 210, alignSelf: "flex-start" }} onClick={() => setDialog("Open the selected case in Intercom")}>Open selected case</Button>
              </Panel>
              <Panel title={c.id} subtitle={`${c.type} · ${c.orderRef}`} testId="case-panel">
                <FactList
                  label="Case"
                  rows={[
                    ["Status", c.status],
                    c.linkedReturn ? ["Linked return", link(`/returns/${c.linkedReturn}`, c.linkedReturn)] : ["Linked shipment", c.linkedShipment ? link(`/shipments/${c.linkedShipment}/exceptions/TEST-EVT-129`, c.linkedShipment) : "None"],
                    ["Owner", OWNER[c.owner] ?? c.owner],
                    ["Last updated", minutesAgoLabel(c.updatedMinutesAgo)],
                  ]}
                />
                <Divider />
                <p className={styles.label}>Next step</p>
                <p className={styles.body}>{c.nextStep}</p>
                <Button aria-haspopup="dialog" style={{ minWidth: 222, alignSelf: "flex-start" }} onClick={() => setDialog("View the conversation in Intercom")}>View conversation</Button>
                <p className={styles.small}>Resolved → Reopened is supported when the customer needs further help.</p>
              </Panel>
            </TwoColumns>
            <HalfColumns>
              <Panel title="What people need help with" subtitle={`${d.cohort.days}-day cohort · ${total} tickets`} testId="issue-mix">
                <BarRows label="Tickets by type" max={20} rows={d.cohort.tickets.map((t) => ({ label: t.label, value: t.count }))} />
              </Panel>
              <Panel title="After a handoff" subtitle="Illustrative outcome subsets, tied to original orders" testId="outcomes">
                <FactList
                  wide
                  label="After a handoff"
                  rows={[
                    ["Refunded", `${formatMoney(d.outcomes.refundedAmount)} · ${d.outcomes.refundedOrders} orders`],
                    ["Replacement sent", `${d.outcomes.replacementShipments} shipments`],
                    ["Reviews received", `${d.cohort.reviews} rated reviews · same cohort`],
                    ["Support load", d.cohort.deliveredUnits > 0 ? `${Math.round((100 * total) / d.cohort.deliveredUnits)} tickets / 100 delivered` : "N/A"],
                  ]}
                />
              </Panel>
            </HalfColumns>
            <Dialog open={dialog === "cohort"} title={`The ${d.cohort.days}-day cohort`} onClose={() => setDialog(null)}>
              <p>Cohort figures cover the {total} tickets from the last {d.cohort.days} days, and the {d.cohort.deliveredUnits} delivered units from the same days. The all-time open queue ({figure(d.allTimeOpen, String)}) is a different set from the {d.cohort.open} tickets still open in the cohort.</p>
              <p>The demo holds only this cohort, so there is no other period to choose.</p>
              <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
            </Dialog>
            <SourceDialog open={dialog !== null && dialog !== "cohort"} title={dialog ?? ""} url={null} onClose={() => setDialog(null)} />
          </>
        );
      }}
    </RecordShell>
  );
}
