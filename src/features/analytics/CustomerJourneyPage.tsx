import { useState } from "react";
import { useView } from "@/adapter/useView";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DEMO_RETURN_ID, DEMO_SUPPORT_CASE_ID, type CustomerJourneyData } from "@/fixtures/analytics";
import { averageRating, niceScale, rate } from "./journeyMath";
import { BarList, Card, DetailRow, HandoffDialog, KpiCard, KpiGrid, MetricText, Notice, PageHeader, SectionHeading, ViewShell, count, percent, ratio, usd, usdExact, useIsDemo } from "./parts";
import { NativeSiteTrafficPage } from "./NativeSiteTrafficPage";
import styles from "./Analytics.module.css";

/** Commerce, support and reviews (Figma source 30:721, owner THO-293, CTRL-209). Each metric keeps its own cohort and denominator. */
export function CustomerJourneyPage() {
  return useIsDemo() ? <DemoCustomerJourneyPage /> : <NativeSiteTrafficPage />;
}
function DemoCustomerJourneyPage() {
  const query = useView<Record<string, never>, CustomerJourneyData>("customerJourney", {});
  const [definitions, setDefinitions] = useState(false);
  const data = query.data?.data ?? null;
  return (
    <section aria-labelledby="journey-title" data-figma-source="30:721" className={styles.page}>
      <PageHeader id="journey-title" title="Watch the journey after the click." subtitle="Commerce and experience · conversion, support load, returns and review outcomes.">
        <Button variant="secondary" style={{ minWidth: 192 }} aria-haspopup="dialog" onClick={() => setDefinitions(true)}>Cohort definitions</Button>
        <LinkButton to={`/support/cases/${DEMO_SUPPORT_CASE_ID}`} style={{ minWidth: 176 }}>Open support</LinkButton>
      </PageHeader>
      <ViewShell query={query} subject="Commerce, support and reviews" emptyTitle="No customer journey data" emptyBody="The source responded, but nothing matches this period.">
        {(d) => <Body data={d} />}
      </ViewShell>
      <Dialog open={definitions} title="Cohort definitions" badge="Demo" onClose={() => setDefinitions(false)}>
        <dl className={styles.defs}>
          {(data?.cohorts ?? []).map((c) => (
            <div key={c.metric}><dt>{c.metric} · {c.version}</dt><dd>Grain: {c.grain}. Window: {c.window}. Denominator: {c.denominator}. Includes: {c.inclusion}.</dd></div>
          ))}
        </dl>
        <p>All-time counts and cohort counts stay separate: the review average is all time, while support load and returns use the 14-day delivered cohort.</p>
        <Button variant="secondary" onClick={() => setDefinitions(false)}>Close</Button>
      </Dialog>
    </section>
  );
}

function Body({ data }: { data: CustomerJourneyData }) {
  const [source, setSource] = useState<"commerce" | "reviews" | null>(null);
  const sessions = data.sessions.state === "known" ? data.sessions.value : null;
  const delivered = data.deliveredUnits.state === "known" ? data.deliveredUnits.value : null;
  const rated = data.reviews.ratedCount.state === "known" ? data.reviews.ratedCount.value : null;
  const ticketTotal = data.tickets.reduce((s, t) => s + t.count, 0);
  const topTicket = [...data.tickets].sort((a, b) => b.count - a.count)[0];
  const ticketScale = niceScale(Math.max(0, ...data.tickets.map((t) => t.count)));
  const reviewScale = niceScale(Math.max(0, ...data.reviews.stars.map((s) => s.count)));
  const conversion = sessions === null ? null : rate(data.websiteOrders, sessions, 2);
  const supportLoad = delivered === null ? null : rate(ticketTotal, delivered, 1);
  const returnRate = delivered === null ? null : rate(data.returns.returned, delivered, 1);
  const rating = rated === null ? null : averageRating(data.reviews.stars);
  const ratingPoints = data.reviews.stars.reduce((s, r) => s + r.star * r.count, 0);
  const aov = data.websiteOrders > 0 ? usdExact({ minorUnits: Math.round(data.websiteNetReceipts.minorUnits / data.websiteOrders), currency: "USD" }) : "N/A";
  return (
    <>
      <Notice tone="violet" title="Illustrative sources · each metric keeps its own cohort">
        Commerce: Shopify website, {data.commercePeriod}. Service: {delivered === null ? "delivered-unit cohort unknown" : `${count(delivered)} delivered customer units`} over the last 14 days. Source selection, reconciliation and production feeds remain pending.
      </Notice>
      <KpiGrid>
        <KpiCard label="Website sessions" context="Shopify storefront source only" testId="metric-sessions"><MetricText value={data.sessions} format={count} /></KpiCard>
        <KpiCard label="Store conversion" context={sessions === null ? "Needs a selected sessions source" : `${count(data.websiteOrders)} Shopify orders ÷ ${count(sessions)} sessions`} testId="metric-conversion">{conversion === null ? "N/A" : `${conversion}%`}</KpiCard>
        <KpiCard label="Support load" context={delivered === null ? "Needs a delivered cohort" : `${ticketTotal} tickets ÷ ${count(delivered)} delivered units × 100`} testId="metric-support-load">{supportLoad === null ? "N/A" : `${supportLoad} / 100`}</KpiCard>
        <KpiCard label="Average rating" context={rated === null ? "Needs the ratings feed" : `${ratingPoints} rating points ÷ ${rated} rated reviews`} testId="metric-rating">{rating === null ? "N/A" : `${rating} / 5`}</KpiCard>
      </KpiGrid>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="flow-title" className={styles.card20}>
          <SectionHeading id="flow-title" title={sessions === null ? `${count(data.websiteOrders)} valid orders; sessions unknown` : `${count(data.websiteOrders)} valid orders from ${count(sessions)} sessions`} note="A single selected sessions source prevents duplicate traffic counts." />
          <BarList label="Store conversion flow" rows={[
            { key: "sessions", label: "Sessions", value: sessions === null ? "N/A" : count(sessions), share: sessions === null ? 0 : 1 },
            { key: "viewed", label: "Product viewed", value: count(data.productViewed), share: sessions === null ? 0 : ratio(data.productViewed, sessions) },
            { key: "checkout", label: "Checkout started", value: count(data.checkoutStarted), share: sessions === null ? 0 : ratio(data.checkoutStarted, sessions) },
            { key: "orders", label: "Valid orders", value: count(data.websiteOrders), share: sessions === null ? 0 : ratio(data.websiteOrders, sessions) },
          ]} />
          <hr className={styles.divider} />
          <DetailRow label="Shopify net receipts" value={usd(data.websiteNetReceipts)} />
          <DetailRow label="Shopify AOV" value={`${aov} · ${usd(data.websiteNetReceipts)} / ${count(data.websiteOrders)}`} />
          <p className={styles.small}>TikTok Shop's {count(data.tiktokOrders)} orders are excluded from this website conversion numerator. Global AOV remains {usdExact(data.globalAov)} across {count(data.globalOrders)} valid orders.</p>
          <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 250 }} aria-haspopup="dialog" onClick={() => setSource("commerce")}>Open commerce source</Button></div>
        </Card>
        <Card labelledBy="support-title" className={styles.card20}>
          <SectionHeading id="support-title" title={topTicket ? `${topTicket.category} accounts for ${percent(topTicket.count, ticketTotal, 0)} of tickets` : "Support categories"} note={`${ticketTotal} tickets from the same delivered-unit cohort · no message text`} />
          <BarList label="Support tickets by category" rows={data.tickets.map((t) => ({ key: t.category, label: t.category, value: String(t.count), share: ratio(t.count, ticketScale) }))} />
          <hr className={styles.divider} />
          <DetailRow label="Resolved by Fin" value={String(data.resolution.byFin)} />
          <DetailRow label="Resolved by people" value={String(data.resolution.byPeople)} />
          <DetailRow label="Open / handed off" value={String(data.resolution.open)} />
          <div className={styles.btnRow}><LinkButton to={`/support/cases/${DEMO_SUPPORT_CASE_ID}`} style={{ minWidth: 250 }}>Review support queue</LinkButton></div>
        </Card>
      </div>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="returns-title" className={styles.card20}>
          <SectionHeading id="returns-title" title="A return ends with a verified outcome" note={delivered === null ? `${data.returns.returned} returned units · return rate needs a delivered cohort.` : `${data.returns.returned} returned units / ${count(delivered)} delivered units = ${returnRate}% return rate.`} />
          <p className={styles.metric} data-testid="metric-return-rate">{returnRate === null ? "N/A" : `${returnRate}%`}</p>
          <DetailRow label="Received and inspected" value={`${data.returns.received} units`} />
          <DetailRow label="Awaiting inspection" value={`${data.returns.awaitingInspection} units`} />
          <DetailRow label="Restocked from inspected" value={`${data.returns.restocked} units`} />
          <DetailRow label="Quarantined from inspected" value={`${data.returns.quarantined} units`} />
          <p className={styles.small}>Refunds and physical returns are separate events. Restock only after inspection; replacements link the original order. Source Orders owns refund and retained-unit totals.</p>
          <div className={styles.btnRow}><LinkButton variant="secondary" to={`/returns/${DEMO_RETURN_ID}`} style={{ minWidth: 232 }}>Open return cases</LinkButton></div>
        </Card>
        <Card labelledBy="reviews-title" className={styles.card20}>
          <SectionHeading id="reviews-title" title={rated === null ? "Rated reviews unavailable" : `${rated} rated reviews, with a clear denominator`} note="Ratings-only feed · latest unique platform + review ID" />
          <BarList label="Reviews by star rating" rows={data.reviews.stars.map((s) => ({ key: String(s.star), label: `${s.star} ${s.star === 1 ? "star" : "stars"}`, value: String(s.count), share: ratio(s.count, reviewScale) }))} />
          <hr className={styles.divider} />
          <p className={styles.small}>Unrated reviews are excluded from the average. Review requests pause during unresolved support/returns. Low-rating follow-up stays in the source tool with an accountable owner.</p>
          <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 250 }} aria-haspopup="dialog" onClick={() => setSource("reviews")}>Open review outcomes</Button></div>
        </Card>
      </div>
      <Notice tone="violet" title="Unknown is not zero">
        Missing sessions → conversion N/A. No delivered cohort → support and return rates N/A. No rated reviews → rating N/A. Live feeds must show source time, sync time and source contract.
      </Notice>
      <HandoffDialog
        open={source !== null}
        onClose={() => setSource(null)}
        title={source === "reviews" ? "Review outcomes source" : "Commerce source"}
        rows={[{ label: "Source", value: source === "reviews" ? "Ratings-only review feed" : "Shopify storefront" }, { label: "Link", value: "No verified source link in this build" }]}
      >
        <p>These figures are illustrative. Nothing opens, and no store or review account is accessed.</p>
      </HandoffDialog>
    </>
  );
}
