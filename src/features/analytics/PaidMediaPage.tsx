import type { NativePaidMedia as NativePaidData } from "@/creator-agent/analytics/views";
import { NativePaidMedia } from "./NativePaidMedia";
import { nativePeriod } from "./NativeAnalyticsEvidence";
import { useReportingPeriod } from "./reportingPeriod";
import { useScope } from "@/adapter/scope";
import { useSourceLease } from "@/adapter/useSourceLease";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { PaidMediaFilters } from "@/adapter/demoAnalytics";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button } from "@/components/Button";
import { type PaidMediaData, type RightsState } from "@/fixtures/analytics";
import { BarList, Card, ChoiceButton, DetailRow, HandoffDialog, KpiCard, KpiGrid, Notice, PageHeader, PeriodDialog, ProvenanceDialog, SectionHeading, Table, ViewShell, count, ratio, usd } from "./parts";
import { channelRates, compact, dollars, pctText, rightsLabel } from "./paidMediaMath";
import styles from "./Analytics.module.css";

const PLATFORMS = [{ value: "all", label: "All platforms" }, { value: "meta", label: "Meta" }, { value: "tiktok", label: "TikTok" }];
const RIGHTS = [
  { value: "all", label: "all states" },
  { value: "cleared", label: "cleared" },
  { value: "expiring", label: "expiring" },
  { value: "expired", label: "expired" },
  { value: "notGranted", label: "not granted" },
  { value: "unknown", label: "unknown" },
];
const allowed = (options: { value: string }[], raw: string | null) => (options.some((o) => o.value === raw) ? (raw as string) : "all");
const RIGHTS_TONE: Record<RightsState, BadgeTone> = { cleared: "success", expiring: "warning", expired: "danger", notGranted: "danger", unknown: "neutral" };

/** Paid media (Figma source 30:349, owner THO-293, CTRL-204 to CTRL-206). Media spend is never counted as creator content fees. */
export function PaidMediaPage() {
  const [search, setSearch] = useSearchParams();
  const { adapter } = useScope();
  const filters: PaidMediaFilters = { rights: (adapter.kind === "demo" ? allowed(RIGHTS, search.get("rights")) : search.get("rights") ?? "all") as PaidMediaFilters["rights"], platform: (adapter.kind === "demo" ? allowed(PLATFORMS, search.get("platform")) : search.get("platform") ?? "all") as PaidMediaFilters["platform"] };
  const period = useReportingPeriod(), cursor = adapter.kind === "demo" ? null : search.get("asset-cursor");
  const query = useView<PaidMediaFilters, PaidMediaData | NativePaidData>("paidMedia", filters, period, { keepPrevious: true, ...(adapter.kind === "demo" ? {} : { page: { cursor, limit: 25 } }) });
  const value = query.data?.data, expired = useSourceLease(value?.datasetKey === "analytics-native" ? value.provenance.validUntil : undefined);
  const visible = query.isError || expired ? null : value;
  const native = visible?.datasetKey === "analytics-native" ? visible : null;
  const legacy = visible && visible.datasetKey !== "analytics-native" ? visible : null;
  const assetPage = (nextCursor: string | null) => setSearch(prev => { const next = new URLSearchParams(prev); if (nextCursor) next.set("asset-cursor", nextCursor); else next.delete("asset-cursor"); return next; });
  const clearFilters = () => setSearch(prev => { const next = new URLSearchParams(prev); for (const key of ["rights", "platform", "asset-cursor"]) next.delete(key); return next; });
  const [dialog, setDialog] = useState<"period" | "source" | null>(null);
  const setFilter = (key: "rights" | "platform", value: string) =>
    setSearch((prev) => { const next = new URLSearchParams(prev); next.delete("asset-cursor"); if (value === "all") next.delete(key); else next.set(key, value); return next; });
  return (
    <section aria-labelledby="paid-media-title" data-figma-source="30:349" className={styles.page}>
      <PageHeader id="paid-media-title" title="See what earns the click." subtitle="Paid media · spend, attention, conversion signals and permission to use each asset.">
        <Button variant="secondary" style={{ minWidth: 172 }} aria-haspopup="dialog" onClick={() => setDialog("period")}>{adapter.kind === "demo" ? "Last 30 days" : "Reporting period"}</Button>
        <Button style={{ minWidth: 192 }} aria-haspopup="dialog" onClick={() => setDialog("source")}>Open ad source</Button>
      </PageHeader>
      <ViewShell query={query} subject="Paid media" emptyTitle="No paid media data" emptyBody="The source responded, but nothing matches this period.">
        {(data) => data.datasetKey === "analytics-native" ? <NativePaidMedia data={data} filters={filters} setFilter={setFilter} clear={clearFilters} next={() => assetPage(data.pagination.nextCursor)} first={() => assetPage(null)} paged={Boolean(cursor)} refresh={() => void query.refetch()} refreshing={query.isFetching} /> : <Body data={data} filters={filters} setFilter={setFilter} clear={clearFilters} />}
      </ViewShell>
      <PeriodDialog open={dialog === "period"} onClose={() => setDialog(null)} period={native ? nativePeriod(native) : legacy?.periodLabel ?? null} />
      <HandoffDialog open={dialog === "source"} onClose={() => setDialog(null)} title="Ad source" rows={[{ label: "Sources", value: "Meta Ads Manager and TikTok Ads Manager" }, { label: "Link", value: "No verified source link in this build" }, ...(legacy?.channels ?? []).map(c => ({ label: c.label + " attribution window", value: c.attributionWindow ? c.attributionWindow.label + " · " + c.attributionWindow.sourceRef : "Unknown · not supplied by the source" }))]}>
        <p>{legacy?.datasetKey === "paid-media-demo" ? "These are illustrative platform reports." : "Each reporting window comes from its platform report."}</p>
      </HandoffDialog>
    </section>
  );
}

function Body({ data, filters, setFilter, clear }: { data: PaidMediaData; filters: PaidMediaFilters; setFilter: (k: "rights" | "platform", v: string) => void; clear: () => void }) {
  const [asOf, setAsOf] = useState(false);
  const [rights, setRights] = useState<PaidMediaData["assets"][number] | null>(null);
  const [source, setSource] = useState<PaidMediaData["assets"][number] | null>(null);
  // A total is known only when every input is: served data must cover both platforms, and its media spend (with GMV Max) is the server's.
  const observed = data.datasetKey === "paid-media-observed";
  const allPlatforms = !observed || data.channels.length === 2;
  const served = data.measures?.find((x) => x.key === "paidMediaSpend");
  const spend = observed ? (served?.state === "known" ? served.value : null)
    : data.channels.length && data.channels.every(c => c.spend) ? data.channels.reduce((sum, c) => sum + c.spend!.minorUnits, 0) : null;
  const impressions = data.channels.reduce((s, c) => s + c.impressions, 0);
  const clicks = data.channels.reduce((s, c) => s + c.clicks, 0);
  const totalsKnown = data.channels.length > 0 && allPlatforms;
  // CPC pairs spend and clicks from the same standard campaigns (GMV Max is excluded from both).
  const standardSpend = totalsKnown && data.channels.every(c => c.spend) ? data.channels.reduce((sum, c) => sum + c.spend!.minorUnits, 0) : null;
  const acquisition = spend === null || !data.creatorSampleEconomics ? null : spend + data.creatorSampleEconomics.minorUnits;
  const lead = [...data.channels].sort((a, b) => (b.spend?.minorUnits ?? -1) - (a.spend?.minorUnits ?? -1))[0];
  const ranked = [...data.assets].sort((a, b) => b.clicks / b.impressions - a.clicks / a.impressions);
  const filtered = filters.rights !== "all" || filters.platform !== "all";
  const m = (minorUnits: number | null | undefined) => minorUnits == null ? "Unknown" : usd({ minorUnits, currency: "USD" });
  return (
    <>
      <Notice tone="violet" title={`${data.datasetKey === "paid-media-demo" ? "Illustrative ad-source snapshots" : "Ad source observations"} · ${data.periodLabel}`}>
        Media spend is {m(spend)} of the {m(acquisition)} acquisition-cost total. Platform purchase value is reported separately from reconciled storefront receipts.
      </Notice>
      <KpiGrid>
        <KpiCard label="Media spend" context={data.channels.map((c) => `${c.label} ${m(c.spend?.minorUnits)}`).join(" + ")} testId="metric-media-spend">{m(spend)}</KpiCard>
        <KpiCard label="Impressions" context={data.channels.map((c) => `${compact(c.impressions)} ${c.label}`).join(" + ")} testId="metric-impressions">{totalsKnown ? compact(impressions) : "Unknown"}</KpiCard>
        <KpiCard label="Clicks / CTR" context={`${count(clicks)} clicks ÷ ${count(impressions)} impressions`} testId="metric-ctr">{totalsKnown ? `${compact(clicks)} / ${pctText(clicks, impressions)}` : "Unknown / N/A"}</KpiCard>
        <KpiCard label="Blended CPC" context={`${m(standardSpend)} ÷ ${totalsKnown ? count(clicks) : "unknown"} clicks`} testId="metric-cpc">{standardSpend !== null && clicks > 0 ? dollars(standardSpend / 100 / clicks) : "N/A"}</KpiCard>
      </KpiGrid>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="spend-title" className={styles.card20}>
          <SectionHeading id="spend-title" title={lead?.spend && spend !== null && spend > 0 ? `${Math.round((100 * lead.spend.minorUnits) / spend)}% of paid spend is on ${lead.label}` : "Paid spend"} note={data.datasetKey === "paid-media-demo" ? "USD · same reporting period · source exports pending" : "USD · reported period"} />
          <BarList label="Paid spend by channel" rows={data.channels.map((c) => ({ key: c.key, label: c.label, value: m(c.spend?.minorUnits), share: c.spend && spend !== null ? ratio(c.spend.minorUnits, spend) : 0 }))} />
          <hr className={styles.divider} />
          <DetailRow label="Media total" value={m(spend)} />
          <DetailRow label="Creator / sample economics" value={m(data.creatorSampleEconomics?.minorUnits)} />
          <DetailRow label="Acquisition-cost total" value={m(acquisition)} />
          {/* The design fixes this note at two lines; text metrics differ by platform, so the height is reserved. */}
          <p className={styles.small} style={{ minHeight: 36 }}>Gifted-product economic cost is counted once; it is not added again to inventory-purchase cash outflow.</p>
        </Card>
        <Card labelledBy="ctr-title" className={styles.card20}>
          <SectionHeading id="ctr-title" title={ranked[0] ? `${ranked[0].id} has the strongest click-through` : "Click-through by asset"} note={`CTR = clicks / impressions · ${data.assets.length === 4 ? "four" : data.assets.length} comparable ${data.datasetKey === "paid-media-demo" ? "demo assets" : "assets"}`} />
          {ranked.length === 0 ? <p className={styles.small}>No assets match the current filters.</p> : (
            <>
              <BarList label="Click-through rate by asset" rows={ranked.map((a) => ({ key: a.id, label: a.label, value: a.impressions > 0 ? `${(Math.round((100 * a.clicks) / a.impressions * 10) / 10).toString()}%` : "N/A", share: a.impressions > 0 ? ratio((100 * a.clicks) / a.impressions, 3) : 0 }))} />
              <div className={styles.axis} aria-hidden="true" style={{ gridTemplateColumns: "192px repeat(3, minmax(0, 1fr)) 72px" }}><span /><span>0%</span><span>1%</span><span>2%</span><span>3%</span></div>
            </>
          )}
          <p className={styles.small}>Clicks are a leading signal. They are not attributed orders, customer count or paid-media revenue. Paid media is not a creator fee.</p>
        </Card>
      </div>
      <Card labelledBy="costs-title">
        <SectionHeading id="costs-title" title="Compare costs on a common basis" note="CPM = spend / impressions × 1,000 · CPC = spend / clicks" />
        <Table
          caption="Channel advertising source table"
          columns={[{ label: "Channel", width: 170 }, { label: "Spend", width: 140 }, { label: "Impressions", width: 170 }, { label: "Clicks", width: 130 }, { label: "CTR", width: 120 }, { label: "CPM", width: 140 }, { label: "CPC", width: 140 }, { label: "Platform ROAS", width: 238 }]}
          rows={data.channels.map((c) => {
            const r = channelRates(c);
            return { key: c.key, cells: [c.label, m(c.spend?.minorUnits), count(c.impressions), count(c.clicks), r.ctr, r.cpm, r.cpc, r.roas] };
          })}
        />
        <p className={styles.small}>Platform-reported values: {data.channels.map((c) => `${c.label} ${m(c.platformPurchaseValue?.minorUnits)} (${c.attributionWindow?.label ?? "window unknown"})`).join("; ")}. These reports are never added to Shopify/TikTok order totals. {data.channels.some(c => !c.attributionWindow && c.platformPurchaseValue && c.spend && c.spend.minorUnits > 0) && "ROAS is provisional where the attribution window is unknown."}</p>
      </Card>
      <Card labelledBy="assets-title">
        <div className={styles.filters}>
          <h2 id="assets-title">Top assets by CTR</h2>
          <span style={{ flex: "0 1 200px" }} />
          <ChoiceButton legend="Platform" title="Filter by platform" options={PLATFORMS} value={filters.platform} onChange={(v) => setFilter("platform", v)} width={180} buttonLabel={(c) => c.label} />
          <ChoiceButton legend="Rights state" title="Filter by rights state" options={RIGHTS} value={filters.rights} onChange={(v) => setFilter("rights", v)} width={204} buttonLabel={(c) => `Rights: ${c.label}`} />
          <Button variant="ghost" style={{ minWidth: 190 }} aria-haspopup="dialog" onClick={() => setAsOf(true)}>Metrics as of</Button>
        </div>
        {filtered && (
          <p className={styles.small} role="status">
            Showing {data.assets.length} of {data.assetTotal} assets · {PLATFORMS.find((p) => p.value === filters.platform)?.label} · rights {RIGHTS.find((r) => r.value === filters.rights)?.label} · {data.periodLabel}. <button type="button" className={styles.linkText} style={{ background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", textDecoration: "underline" }} onClick={clear}>Clear filters</button>
          </p>
        )}
        {data.assets.length === 0 ? (
          <p className={styles.label}>No assets match these filters. That is not zero assets; the unfiltered set has {data.assetTotal}.</p>
        ) : (
          <Table
            caption="Top assets by click-through rate"
            columns={[{ label: "Asset", width: 300 }, { label: "Clicks / impressions", width: 290 }, { label: "CTR", width: 150 }, { label: "Rights state", width: 300 }, { label: "Next action", width: 208 }]}
            rows={ranked.map((a) => ({
              key: a.id,
              cells: [
                a.label,
                `${count(a.clicks)} / ${count(a.impressions)}`,
                pctText(a.clicks, a.impressions),
                <Badge key="r" tone={RIGHTS_TONE[a.rights]} width={150}>{rightsLabel(a)}</Badge>,
                a.rights === "cleared"
                  ? <Button key="a" variant="ghost" style={{ minWidth: 172 }} aria-haspopup="dialog" aria-label={`View asset ${a.label}`} onClick={() => setSource(a)}>View asset</Button>
                  : <Button key="a" variant="secondary" style={{ minWidth: 172 }} aria-haspopup="dialog" aria-label={`${a.rights === "notGranted" ? "Open" : "Review"} rights for ${a.label}`} onClick={() => setRights(a)}>{a.rights === "notGranted" ? "Open rights" : "Review rights"}</Button>,
              ],
            }))}
          />
        )}
        <p className={styles.small}>Ad-ready requires a documented grant and no expiry within 30 days. Metrics older than 7 days enter the stale queue. Snapshot timestamp, source and scope remain attached to each asset.</p>
      </Card>
      <ProvenanceDialog open={asOf} onClose={() => setAsOf(false)} provenance={data.provenance} />
      <HandoffDialog
        open={rights !== null}
        onClose={() => setRights(null)}
        title={rights ? `Rights · ${rights.label}` : ""}
        rows={rights ? [
          { label: "Rights state", value: rightsLabel(rights) },
          { label: "Scope", value: "Paid reuse of this asset" },
          { label: "Agreement and version", value: "Not attached in this fixture" },
          { label: "Expiry", value: rights.expiresInDays === null ? "Not recorded" : `In ${rights.expiresInDays} days` },
          { label: "Evidence", value: "None attached in this fixture" },
        ] : []}
      >
        <p>Missing, expired or unknown rights block paid reuse of this asset only. Opening this changes nothing.</p>
      </HandoffDialog>
      <HandoffDialog open={source !== null} onClose={() => setSource(null)} title={source ? `Asset · ${source.label}` : ""} rows={source ? [{ label: "Asset", value: source.label }, { label: "Link", value: "Synthetic asset; no verified source link" }] : []}>
        <p>This asset is a labeled demo record. No ad platform is opened.</p>
      </HandoffDialog>
    </>
  );
}
