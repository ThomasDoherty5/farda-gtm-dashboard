import { useState } from "react";
import type { NativeCampaignFunnel as CampaignData } from "@/creator-agent/analytics/views";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Fact, NativeAnalyticsEvidence, factText, nativeCount, nativePercent } from "./NativeAnalyticsEvidence";
import { BarList, Card, DetailRow, HandoffDialog, KpiCard, KpiGrid, SectionHeading, Table } from "./parts";
import styles from "./Analytics.module.css";
const steps = ["contacted", "replied", "agreed", "shipped", "delivered", "posted"] as const;
const labels = { instagram: "Instagram", tiktokWebsite: "TikTok website", tiktokShop: "TikTok Shop" };
const title = (value: string) => value[0]!.toUpperCase() + value.slice(1);
export function NativeCampaignFunnel({ data, refresh, refreshing }: { data: CampaignData; refresh: () => void; refreshing: boolean }) {
  const [reservations, setReservations] = useState(false);
  const metric = (id: string) => data.measures.find(row => row.metricId === id)?.result;
  return <>
    <NativeAnalyticsEvidence data={data} refresh={refresh} refreshing={refreshing} />
    <KpiGrid>
      <KpiCard label="Contacts" context={data.aggregation === "disjointComplete" ? "Source-qualified disjoint channel opportunity sets" : "Channel partition or complete membership Unknown"} testId="metric-contacts"><Fact fact={data.totals.contacted} format={nativeCount} /></KpiCard>
      <KpiCard label="Reply conversion" context={`${factText(data.totals.replied, nativeCount)} replies ÷ ${factText(data.totals.contacted, nativeCount)} contacts`} testId="metric-reply-conversion"><Fact fact={metric("replyConversion")} format={nativePercent} /></KpiCard>
      <KpiCard label="Gift allocation" context={`${factText(data.totals.shipped, nativeCount)} shipped + ${factText(data.reserved, nativeCount)} reserved`} testId="metric-gift">Cap <Fact fact={data.giftCap} format={nativeCount} /></KpiCard>
      <KpiCard label="Mature no-post" context="Mature delivered less posts qualified within that same mature group" testId="metric-no-post"><Fact fact={data.matureNoPost} format={nativeCount} /></KpiCard>
    </KpiGrid>
    <Card labelledBy="native-reference-title" className={styles.card20}>
      <SectionHeading id="native-reference-title" title="Contacts against source-qualified references" note="Reference counts are separate from an approved forecast." />
      <BarList large label="Contacts against qualified reference" cols="200px minmax(0, 1fr) 160px 138px" gap={20} rows={data.channels.map(row => {
        const used = row.measures.find(value => value.metricId === "contactReferenceUse")?.result;
        return { key: row.channel, label: labels[row.channel], value: `${factText(row.steps.contacted, nativeCount)} / ${factText(row.contactReference, nativeCount)}`, note: factText(used, nativePercent), share: Math.max(0, Math.min(1, (used?.value ?? 0) / 100)) };
      })} />
      {!data.channels.length && <p>Channel progression Unknown · no source rows supplied.</p>}
      <p className={styles.small}>{data.historicalBasis ? `Historical basis: ${data.historicalBasis.period.startAt} to ${data.historicalBasis.period.endAt} exclusive (${data.historicalBasis.period.timezone}).` : "Historical reference basis Unknown; no historical forecast inferred."} Rebaseline before interpreting a target gap or releasing media. New recruitment is commission-only.</p>
    </Card>
    <Card labelledBy="native-progression-title"><SectionHeading id="native-progression-title" title="One cohort, six evidence-based steps" note="Distinct opportunities progress cumulatively; stages are not mutually exclusive bins." />
      <Table caption="Campaign progression" columns={[{ label: "Campaign", width: 300 }, ...steps.map(step => ({ label: title(step), width: 158 }))]} rows={[...data.channels.map(row => ({ key: row.channel, cells: [labels[row.channel], ...steps.map(step => <Fact key={step} fact={row.steps[step]} format={nativeCount} />)] })), { key: "total", cells: ["Total", ...steps.map(step => <Fact key={step} fact={data.totals[step]} format={nativeCount} />)] }]} />
      <p className={styles.small}>Historical replies / agreements: {data.channels.map(row => `${labels[row.channel]} ${factText(row.historical.replies, nativeCount)} / ${factText(row.historical.agreements, nativeCount)}`).join("; ") || "Unknown"}. Missing stage targets are never invented.</p>
    </Card>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card labelledBy="native-caps-title" className={styles.card20}><SectionHeading id="native-caps-title" title="Capacity includes active reservations" note="Shipped + reserved cannot exceed the source-qualified campaign gift cap." />
        <BarList label="Gift capacity used" rows={data.channels.map(row => {
          const value = row.measures.find(metric => metric.metricId === "capacityUsed")?.result, share = row.measures.find(metric => metric.metricId === "capacityUse")?.result;
          return { key: row.channel, label: labels[row.channel], value: `${factText(value, nativeCount)} / ${factText(row.giftCap, nativeCount)}`, share: Math.max(0, Math.min(1, (share?.value ?? 0) / 100)) };
        })} />
        <p className={styles.small}>Reservations hold capacity, not physical on-hand. A sample still needs stock, accepted terms and exact-action approval.</p><Button variant="secondary" onClick={() => setReservations(true)}>Review reservations</Button>
      </Card>
      <Card labelledBy="native-mature-title" className={styles.card20}><SectionHeading id="native-mature-title" title="Measure only the mature delivered group" note="Review-after date = accepted posting due + grace, or voluntary observation date." />
        <DetailRow label="Delivered opportunities" value={<Fact fact={data.totals.delivered} format={nativeCount} />} /><DetailRow label="Not yet mature" value={<Fact fact={data.notYetMature} format={nativeCount} />} /><DetailRow label="Mature delivered" value={<Fact fact={data.matureDelivered} format={nativeCount} />} /><DetailRow label="Published among mature" value={<Fact fact={data.maturePosted} format={nativeCount} />} /><DetailRow label="Mature posting rate" value={<Fact fact={metric("maturePostingRate")} format={nativePercent} />} />
        <Badge tone="warning">{factText(data.matureNoPost, nativeCount)} follow-ups need review</Badge><p className={styles.small}>All published posts are not a substitute for posts among mature recipients. Early posts and not-yet-due recipients do not inflate this denominator. Voluntary gifts have no contractual posting requirement.</p><LinkButton variant="secondary" to="/operations?view=hub&ship-recipient=creator&ship-state=delivered">Review delivered creator shipments</LinkButton>
      </Card>
    </div>
    <HandoffDialog open={reservations} onClose={() => setReservations(false)} title="Sample reservations" rows={data.channels.map(row => ({ label: labels[row.channel], value: `${factText(row.steps.shipped, nativeCount)} shipped + ${factText(row.reserved, nativeCount)} reserved of ${factText(row.giftCap, nativeCount)}` }))}><p>This is a source read, not a reservation release or shipment. Canonical homes, items, costs and approvals stay with their owning workflow.</p></HandoffDialog>
  </>;
}
