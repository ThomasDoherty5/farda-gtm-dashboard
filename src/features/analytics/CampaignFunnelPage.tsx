import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { CampaignFunnelFilters } from "@/adapter/demoAnalytics";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { DEMO_COLLABORATION_ID, type CampaignFunnelData } from "@/fixtures/analytics";
import { STEPS, capacityUse, maturePosting, totals } from "./funnelMath";
import { BarList, Card, ChoiceButton, DetailRow, HandoffDialog, KpiCard, KpiGrid, Notice, PageHeader, SectionHeading, Table, ViewShell, count, percent, ratio } from "./parts";
import styles from "./Analytics.module.css";

const COHORTS = [{ value: "first-wave", label: "First-wave cohort" }, { value: "launch-a", label: "Launch A monitoring" }];
const SHORT: Record<string, string> = { instagram: "Instagram", "tiktok-website": "TT website", "tiktok-shop": "Shop" };
const HEAD: Record<(typeof STEPS)[number], string> = { contacted: "Contacted", replied: "Replied", agreed: "Agreed", shipped: "Shipped", delivered: "Delivered", posted: "Posted" };

/** Campaign funnel and sample allocation (Figma source 30:550, owner THO-293, CTRL-207 and CTRL-208). Only the funnel tab is a design source. */
export function CampaignFunnelPage() {
  const { campaignId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") ?? "funnel";
  const cohort = (search.get("cohort") === "launch-a" ? "launch-a" : "first-wave") satisfies CampaignFunnelFilters["cohort"];
  const query = useView<CampaignFunnelFilters, CampaignFunnelData>("campaignFunnel", { campaignId, cohort });
  return (
    <section aria-labelledby="funnel-title" data-figma-source="30:550" className={styles.page}>
      <PageHeader id="funnel-title" title="Turn a plan into a checked cohort." subtitle="Creator campaigns · measured progression, gift capacity and mature posting outcomes.">
        <ChoiceButton legend="Cohort" title="Choose a campaign cohort" options={COHORTS} value={cohort} width={192} buttonLabel={(c) => c.label}
          onChange={(v) => setSearch((prev) => { const next = new URLSearchParams(prev); if (v === "first-wave") next.delete("cohort"); else next.set("cohort", v); return next; })} />
        <LinkButton to="/campaigns" style={{ minWidth: 192 }}>Open campaigns</LinkButton>
      </PageHeader>
      {tab !== "funnel" ? (
        <EmptyState state="Empty" title="This tab is not built"><p>Only the funnel and sample allocation view has a design source. No other campaign tab is invented here.</p></EmptyState>
      ) : (
        <ViewShell query={query} subject="The campaign funnel" emptyTitle="No campaign progression for this cohort" emptyBody="The source responded, but no progression is recorded for this cohort. That is not zero contacts.">
          {(data) => <Body data={data} />}
        </ViewShell>
      )}
    </section>
  );
}

function Body({ data }: { data: CampaignFunnelData }) {
  const [reservations, setReservations] = useState(false);
  const t = totals(data.campaigns);
  const reserved = data.campaigns.reduce((s, c) => s + c.reserved, 0);
  const cap = data.campaigns.reduce((s, c) => s + c.giftCap, 0);
  const mature = maturePosting(t.delivered, data.notYetMature, t.posted);
  const allBelow = data.campaigns.every((c) => c.steps.contacted < c.contactReference);
  return (
    <>
      <Notice tone="violet" title="Illustrative first-wave cohort · historical assumptions need rebaseline">
        This planning cohort is separate from the 12-creator Launch A monitoring cohort. L is unset. Historical contact/reply/agreement assumptions are a reference, not an approved forecast.
      </Notice>
      <KpiGrid>
        <KpiCard label="Contacts" context={data.campaigns.map((c) => `${c.steps.contacted} ${SHORT[c.key]}`).join(" + ")} testId="metric-contacts">{count(t.contacted)}</KpiCard>
        <KpiCard label="Reply conversion" context={`${count(t.replied)} replies ÷ ${count(t.contacted)} contacts`} testId="metric-reply-conversion">{t.contacted > 0 ? percent(t.replied, t.contacted) : "N/A"}</KpiCard>
        <KpiCard label="Gift allocation" context={`${t.shipped} shipped + ${reserved} reserved`} testId="metric-gift">{t.shipped + reserved} / {cap}</KpiCard>
        <KpiCard label="Mature no-post" context={`${mature.mature} mature delivered − ${t.posted} posted`} testId="metric-no-post">{String(mature.noPost).padStart(2, "0")}</KpiCard>
      </KpiGrid>
      <Card labelledBy="reference-title" className={styles.card20}>
        <SectionHeading id="reference-title" title={allBelow ? "All three cohorts are below historical contact assumptions" : "Contacts against historical contact assumptions"} note="Solid = illustrative recorded cohort · light track = historical reference" />
        <BarList large label="Contacts against historical reference" cols="200px minmax(0, 1fr) 160px 138px" gap={20}
          rows={data.campaigns.map((c) => ({ key: c.key, label: c.label, value: `${count(c.steps.contacted)} / ${count(c.contactReference)}`, note: percent(c.steps.contacted, c.contactReference), share: ratio(c.steps.contacted, c.contactReference) }))} />
        <p className={styles.small}>Source reference: {data.historicalSource}. Rebaseline before interpreting a target gap or releasing media. New acquisition is commission-only; no upfront creator fee is created here.</p>
      </Card>
      <Card labelledBy="progression-title">
        <SectionHeading id="progression-title" title="One cohort, six evidence-based steps" note="Counts are cumulative progression within each campaign, not mutually exclusive current-stage bins." />
        <Table
          caption="Campaign progression"
          columns={[{ label: "Campaign", width: 300 }, ...STEPS.map((s) => ({ label: HEAD[s], width: 158 }))]}
          rows={[
            ...data.campaigns.map((c) => ({ key: c.key, cells: [c.label, ...STEPS.map((s) => count(c.steps[s]))] })),
            { key: "total", cells: ["Total", ...STEPS.map((s) => count(t[s]))] },
          ]}
        />
        <p className={styles.small}>Historical reply/agreement references: {data.campaigns.map((c) => `${c.label} ${c.historical.replies} / ${c.historical.agreements}`).join("; ")}. Delivered/post target mapping remains awaiting rebaseline; no missing stage target is invented.</p>
      </Card>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="caps-title" className={styles.card20}>
          <SectionHeading id="caps-title" title="Capacity includes active reservations" note="Shipped + reserved cannot exceed the campaign gift cap." />
          <BarList label="Gift capacity used" rows={data.campaigns.map((c) => { const u = capacityUse(c); return { key: c.key, label: c.label, value: `${u.used} / ${u.cap}${u.over ? " over" : ""}`, share: ratio(u.used, u.cap), ...(u.over ? { tone: "warning" as const } : {}) }; })} />
          <p className={styles.small}>Releasing a reservation changes availability, not physical on-hand. A new sample needs both stock and campaign capacity.</p>
          <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 238 }} aria-haspopup="dialog" onClick={() => setReservations(true)}>Review reservations</Button></div>
        </Card>
        <Card labelledBy="mature-title" className={styles.card20}>
          <SectionHeading id="mature-title" title="Measure only the mature delivered group" note="Review-after date = agreed posting due + grace, or voluntary observation date." />
          <DetailRow label="Delivered units" value={count(t.delivered)} />
          <DetailRow label="Not yet mature" value={count(data.notYetMature)} />
          <DetailRow label="Mature delivered" value={count(mature.mature)} />
          <DetailRow label="Published among mature" value={count(t.posted)} />
          <DetailRow label="Mature posting rate" value={mature.rate === null ? "N/A" : `${mature.rate.toFixed(1)}% · ${t.posted} / ${mature.mature}`} />
          <div className={styles.btnRow}><Badge tone="warning" width={240}>{mature.noPost} follow-ups need review</Badge></div>
          <p className={styles.small}>Early posts and not-yet-due recipients do not inflate the denominator. A voluntary gift has no contractual posting requirement.</p>
          <div className={styles.btnRow}><LinkButton to={`/collaborations/${DEMO_COLLABORATION_ID}?tab=content`} style={{ minWidth: 238 }}>Open no-post queue</LinkButton></div>
        </Card>
      </div>
      <HandoffDialog
        open={reservations}
        onClose={() => setReservations(false)}
        title="Sample reservations"
        rows={[
          ...data.campaigns.map((c) => ({ label: c.label, value: `${c.steps.shipped} shipped + ${c.reserved} reserved of ${c.giftCap}` })),
          { label: "Home, item, unit cost and approval", value: "Not in this demo fixture" },
        ]}
      >
        <p>A reservation holds capacity. It isn't physical depletion or a shipment, and viewing it changes nothing.</p>
      </HandoffDialog>
    </>
  );
}
