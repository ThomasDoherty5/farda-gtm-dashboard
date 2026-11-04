import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Kpi } from "@/components/Kpi";
import { ContextCard, FactList, GateRows, PageHeader, Panel } from "@/components/Panels";
import { SectionTabs } from "@/components/SectionTabs";
import { SourceDialog } from "@/features/approvals/shared";
import { figure } from "@/features/operations/format";
import type { SettlementRecord } from "@/fixtures/finance";
import styles from "./Finance.module.css";

const FOOTNOTE = "Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.";
const TABS = [
  { key: "rates", label: "Rates & terms", width: 123 },
  { key: "samples", label: "Samples", width: 100 },
  { key: "settlement", label: "Native settlement", width: 151 },
  { key: "exceptions", label: "Exceptions", width: 102 },
] as const;
const TAB_NOTE: Record<string, string> = {
  samples: "Provider-scoped sample requests, acceptance, stock and fulfillment evidence. Opening a sample request never approves, rejects or ships anything.",
  settlement: "Confirmed native commission, matched to the provider receipt and then to QuickBooks. The provider pays; Farda observes and reconciles.",
  exceptions: "Current provider exceptions with their original record IDs and recovery reasons.",
};

/** TikTok native settlement and rates (Figma source 66:447, owner THO-300). Rates are read from the source: unread is Unverified, never a number. */
export function TikTokSettlement({ s }: { res: ReadResponse<SettlementRecord>; s: SettlementRecord }) {
  const [search] = useSearchParams();
  const tab = TABS.find((t) => t.key === search.get("tab"))?.key ?? "rates";
  const [dialog, setDialog] = useState<null | { kind: "source"; title: string } | { kind: "historical" } | { kind: "adjustment" } | { kind: "takeover" }>(null);
  const src = (title: string) => () => setDialog({ kind: "source", title });
  const lane = (key: "standard" | "shopAds", title: string, context: string, tone: "violet" | "subtle") => {
    const rate = s.rates.find((r) => r.lane === key)!;
    return (
      <section className={styles.lane} data-tone={tone} aria-labelledby={`lane-${key}`}>
        <h3 id={`lane-${key}`} style={{ font: "var(--text-h2)" }}>{title}</h3>
        <p className={styles.footnote}>{context}</p>
        <div className={styles.rateKpis}>
          <Kpi label="Active native rate" context="Read from the connected source" testId={`metric-Active native rate ${key}`}>{figure(rate.active, (r) => `${r}%`).replace("N/A", "Unverified")}</Kpi>
          <Kpi label="Proposed rate" context="Exact offer version requires approval" testId={`metric-Proposed rate ${key}`}>{rate.proposed}</Kpi>
        </div>
        <FactList wide labelWidth={237} gap={12} label={`${title} facts`} rows={[["Effective time", "Native value to verify"], ["Eligible products", "Source-approved product set"], ["Rate owner", "TikTok Shop native record"]]} />
      </section>
    );
  };
  return (
    <>
      <PageHeader id="settlement-title" title="Native rates. Native settlement." subtitle="TikTok Shop checkout · native affiliate entitlement · account access unverified">
        <LinkButton variant="secondary" to="/creators/tiktok/invitations/new" style={{ minWidth: 198 }}>Open target invite</LinkButton>
        <LinkButton to="/settings/capabilities" style={{ minWidth: 200 }}>Validate native access</LinkButton>
      </PageHeader>
      <SectionTabs label="TikTok settlement sections" tabs={TABS.map((t) => ({ label: t.label, to: t.key === "rates" ? `/finance/settlements/${s.settlementId}` : `/finance/settlements/${s.settlementId}?tab=${t.key}`, width: t.width, current: t.key === tab }))} />
      <ContextCard title="Historical funded work and current commission terms" actions={<><LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton><LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton></>}>
        Existing funded flat-fee obligations retain their native review and settlement rules. New acquisition has no guaranteed content fee; standard and Shop Ads commission terms remain separately verified.
      </ContextCard>
      <ContextCard title="Keep commission components separate">Standard commission and Shop Ads commission use the source-authoritative winning rate. The same order does not earn both by assumption, and imported Shopify mirrors never create a second payout.</ContextCard>
      {tab !== "rates" ? (
        <Panel large title={TABS.find((t) => t.key === tab)!.label} subtitle="Provider-scoped · no mutation on opening this tab" testId="tab-panel">
          <p style={{ margin: 0, font: "var(--text-body)", color: "var(--color-muted)" }}>{TAB_NOTE[tab]}</p>
          <p style={{ margin: 0, font: "var(--text-small)", color: "var(--color-muted)" }}>This tab has no Figma source of its own, so it shows no records.</p>
        </Panel>
      ) : (
        <>
          <Panel large spacious title="Read the rate that actually applies." subtitle="Current, proposed and effective terms are distinct. Official timing varies by context; the live native record is authoritative." testId="rates">
            <div className={styles.rateLanes}>
              {lane("standard", "Standard commission", "Organic / native affiliate context", "violet")}
              {lane("shopAds", "Shop Ads commission", "Eligible ad-driven order context", "subtle")}
            </div>
            <DataTable
              caption="Native commission routing"
              columns={[{ label: "Order event", width: "24%" }, { label: "Entitlement", width: "27.2%" }, { label: "Financial state", width: "28.8%" }, { label: "Action" }]}
              rows={[
                ["Eligible affiliate order", "Winning standard OR Shop Ads rate", "Estimated / awaiting maturity", <Button key="a" variant="ghost" aria-haspopup="dialog" style={{ minWidth: 188 }} onClick={src("Inspect the native order")}>Inspect native order</Button>],
                ["Cancellation / refund", "Native adjustment or reversal", "Do not subtract refund twice", <Button key="a" variant="ghost" aria-haspopup="dialog" style={{ minWidth: 188 }} onClick={() => setDialog({ kind: "adjustment" })}>Review adjustment</Button>],
                ["Native settlement", "Confirmed native commission", "Match receipt, then QBO", <LinkButton key="a" variant="secondary" to="/finance/settlements/COMM-DEMO-D" style={{ minWidth: 188 }}>Open reconciliation</LinkButton>],
              ]}
            />
          </Panel>
          <Panel
            large
            roomy
            id="hist-title"
            title="Historical accepted terms · read only"
            subtitle={<span id="hist-title-sub">Previously accepted flat-fee terms remain auditable. These controls do not select a new offer; current acquisition is commission-only.</span>}
            testId="historical"
          >
            <SectionTabs label="Historical offer models, read only" tabs={[{ label: "Commission only", to: "#", width: 137, disabled: true, reasonId: "hist-title-sub" }, { label: "Flat fee", to: "#", width: 100, disabled: true, reasonId: "hist-title-sub" }, { label: "Flat fee + commission", to: "#", width: 179, disabled: true, reasonId: "hist-title-sub" }]} />
            <GateRows
              label="Historical funding and review"
              rows={[
                { badge: <Badge tone="warning" width={140}>Founder approval</Badge>, title: "Invitation funding", text: "Approve exact funding and economic terms before source commitment" },
                { badge: <Badge tone="violet" width={140}>Source deadline</Badge>, title: "Content review round", text: "Native 14-day review round can auto-approve/release; read actual deadline" },
                { badge: <Badge width={140}>New review state</Badge>, title: "Revision / resubmission", text: "Track each native round, evidence and its deadline" },
                { badge: <Badge width={140}>Observe + reconcile</Badge>, title: "Provider release", text: "No invented manual payout gate after funds are committed" },
              ]}
            />
            <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 240, alignSelf: "flex-start" }} onClick={() => setDialog({ kind: "historical" })}>Review historical terms</Button>
          </Panel>
          <Panel large roomy title="Missing API action routes to a validated browser task." subtitle="Supported Open requests can use a verified API. Other authorized actions may use a validated native browser route; denied permission requires owner handoff." testId="browser-route">
            <ul className={styles.chips} aria-label="Browser task route">
              <li><Badge width={232}>API or connector missing</Badge></li>
              <li><Badge tone="violet" width={246}>Browser capability check</Badge></li>
              <li><Badge width={246}>Exact approved decision</Badge></li>
              <li><Badge tone="success" width={172}>Native receipt</Badge></li>
            </ul>
            <p className={styles.footnote}>Use the actual request/program deadline; three-day automatic behavior applies only to the relevant native program. Login/MFA or UI drift needs takeover. Verify ambiguous submissions before repeating.</p>
            <div className={styles.actionsRow}>
              <Button aria-haspopup="dialog" style={{ minWidth: 220 }} onClick={src("Open the native sample request")}>Open sample request</Button>
              <LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 258 }}>Reconcile unknown result</LinkButton>
              <Button variant="ghost" aria-haspopup="dialog" style={{ minWidth: 204 }} onClick={() => setDialog({ kind: "takeover" })}>Request takeover</Button>
            </div>
          </Panel>
        </>
      )}
      <p className={styles.footnote}>{FOOTNOTE}</p>
      <Dialog open={dialog?.kind === "historical"} title="Historical accepted terms" badge="Read only" onClose={() => setDialog(null)}>
        <p>Previously accepted flat-fee and hybrid terms stay auditable with their original approvals, receipts and effective dates. Reviewing them creates no new commitment, changes no current policy and offers no manual Pay action. Current acquisition is commission-only.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "adjustment"} title="Native adjustment" badge="Read only" onClose={() => setDialog(null)}>
        <p>A refund or reversal is recorded as an adjustment next to the original, immutable receipt. The refund is subtracted once, from the net base; it is not subtracted again from the commission.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "takeover"} title="Request a takeover" onClose={() => setDialog(null)}>
        <p>A takeover hands an unfinished browser task to a person when login, MFA or a changed page blocks it. Nothing is requested from here in the demo, and an ambiguous submission is verified before it is repeated.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <SourceDialog open={dialog?.kind === "source"} title={dialog?.kind === "source" ? dialog.title : ""} url={null} onClose={() => setDialog(null)} />
    </>
  );
}
