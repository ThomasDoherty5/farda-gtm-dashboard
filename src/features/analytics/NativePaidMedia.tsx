import { useState } from "react";
import type { NativePaidMedia as PaidData } from "@/creator-agent/analytics/views";
import type { PaidMediaFilters } from "@/adapter/demoAnalytics";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Fact, NativeAnalyticsEvidence, factText, nativeCount, nativeMoney, nativeMultiple, nativePercent } from "./NativeAnalyticsEvidence";
import { BarList, Card, ChoiceButton, DetailRow, KpiCard, KpiGrid, SectionHeading, Table } from "./parts";
import styles from "./Analytics.module.css";

const platforms = [{ value: "all", label: "All platforms" }, { value: "meta", label: "Meta" }, { value: "tiktok", label: "TikTok" }];
const rights = ["all", "cleared", "expiring", "expired", "notGranted", "unknown"].map(value => ({ value, label: value === "all" ? "all" : value === "notGranted" ? "not granted" : value }));
const money = (value: number) => nativeMoney({ minorUnits: value, currency: "USD" });
const label = (platform: string) => platform === "meta" ? "Meta" : "TikTok";
export function NativePaidMedia({ data, filters, setFilter, clear, next, first, paged, refresh, refreshing }: {
  data: PaidData; filters: PaidMediaFilters; setFilter: (key: "rights" | "platform", value: string) => void; clear: () => void;
  next: () => void; first: () => void; paged: boolean; refresh: () => void; refreshing: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null), asset = data.assets.find(row => row.assetRef === selected);
  const [asOf, setAsOf] = useState(false);
  const aggregate = (id: string) => data.totals.measures.find(row => row.metricId === id)?.result;
  const ranked = data.assets.slice(0, 4), chartMax = Math.max(3, ...ranked.map(row => row.ctr.state === "known" ? row.ctr.value ?? 0 : 0));
  return <>
    <NativeAnalyticsEvidence data={data} refresh={refresh} refreshing={refreshing} />
    <KpiGrid>
      <KpiCard label="Media spend" context="Selected platforms, including GMV Max" testId="metric-media-spend"><Fact fact={data.totals.spend} format={nativeMoney} /></KpiCard>
      <KpiCard label="Impressions" context="Standard campaigns; matched with standard clicks"><Fact fact={data.totals.impressions} format={nativeCount} /></KpiCard>
      <KpiCard label="Clicks / CTR" context="Standard clicks ÷ standard impressions"><Fact fact={data.totals.clicks} format={nativeCount} /> / <Fact fact={aggregate("ctr")} format={nativePercent} /></KpiCard>
      <KpiCard label="Blended CPC" context="Standard campaign spend ÷ standard clicks"><Fact fact={aggregate("cpc")} format={money} /></KpiCard>
    </KpiGrid>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card className={styles.card20}><SectionHeading title="Where the media spend goes" note="Platform reports stay separate from reconciled storefront receipts." />
        <BarList label="Media spend by platform" rows={data.channels.map(channel => {
          const share = channel.measures.find(row => row.metricId === `shareSpend.${channel.platform}`)?.result;
          return { key: channel.platform, label: label(channel.platform), value: factText(channel.spend, nativeMoney), note: factText(share, nativePercent), share: share?.state === "known" && share.value !== null ? Math.min(1, Math.max(0, share.value / 100)) : 0 };
        })} />
        <hr className={styles.divider} />
        <DetailRow label="Media total" value={<Fact fact={data.totals.spend} format={nativeMoney} />} />
        <DetailRow label="Creator / sample economics" value={<Fact fact={data.creatorSampleEconomics} format={nativeMoney} />} />
        <DetailRow label="Acquisition-cost total" value="Unknown · no combined qualified cost basis" />
        <p className={styles.small}>Gifted-product economic cost is counted once; it is not added again to inventory-purchase cash outflow.</p>
      </Card>
      <Card labelledBy="native-ctr-title" className={styles.card20}><SectionHeading id="native-ctr-title" title="Click-through by asset" note="Source-computed CTR · up to four assets from the current filtered page" />
        {ranked.length ? <><BarList label="Click-through rate by asset" rows={ranked.map(row => ({ key: row.assetRef, label: row.label,
          value: factText(row.ctr, nativePercent), share: row.ctr.state === "known" && row.ctr.value !== null ? Math.max(0, Math.min(1, row.ctr.value / chartMax)) : 0 }))} />
          <div className={`${styles.axis} ${styles.nativeCtrAxis}`} aria-hidden="true" data-testid="native-ctr-axis"><span />{[0, 1, 2, 3].map(step => <span key={step}>{(chartMax * step / 3).toFixed(chartMax === 3 ? 0 : 1)}%</span>)}</div></> : <p className={styles.small}>Asset click-through evidence unavailable for this selection.</p>}
        <p className={styles.small}>Clicks are a leading signal. They are not attributed orders, customer count or paid-media revenue.</p>
      </Card>
    </div>
    <Card labelledBy="native-channel-table"><SectionHeading id="native-channel-table" title="Compare costs on a common basis" note="GMV Max spend is included in media spend. CTR, CPC, CPM and platform ROAS use matched standard campaigns." />
      <Table caption="Paid channel metrics" columns={[{ label: "Channel", width: 180 }, { label: "Media spend", width: 170 }, { label: "Impressions", width: 170 }, { label: "Clicks", width: 130 }, { label: "CTR", width: 120 }, { label: "CPM", width: 140 }, { label: "CPC", width: 140 }, { label: "Platform ROAS", width: 238 }]}
        rows={data.channels.map(channel => ({ key: channel.platform, cells: [label(channel.platform), <Fact key="s" fact={channel.spend} format={nativeMoney} />, <Fact key="i" fact={channel.impressions} format={nativeCount} />, <Fact key="c" fact={channel.clicks} format={nativeCount} />, ...(["ctr", "cpm", "cpc", "platformRoas"] as const).map(id => <Fact key={id} fact={channel.measures.find(row => row.metricId === `${id}.${channel.platform}`)?.result} format={id === "ctr" ? nativePercent : id === "platformRoas" ? nativeMultiple : money} />)] }))} />
      <p className={styles.small}>{data.channels.map(channel => `${label(channel.platform)}: purchase value ${factText(channel.platformPurchaseValue, nativeMoney)}; ${channel.attributionWindow ? `${channel.attributionWindow.clickDays}-day click / ${channel.attributionWindow.viewDays}-day view` : "attribution window Unknown"}`).join(". ")}. Platform values are never added to Shopify or TikTok order totals.</p>
    </Card>
    <Card labelledBy="native-assets-title">
      <div className={styles.filters}><h2 id="native-assets-title">Top assets by CTR</h2><span style={{ flex: "0 1 200px" }} />
        <ChoiceButton legend="Platform" title="Filter by platform" options={platforms} value={filters.platform} onChange={value => setFilter("platform", value)} width={180} buttonLabel={choice => choice.label} />
        <ChoiceButton legend="Rights state" title="Filter by rights state" options={rights} value={filters.rights} onChange={value => setFilter("rights", value)} width={204} buttonLabel={choice => `Rights: ${choice.label}`} />
        <Button variant="ghost" style={{ minWidth: 190 }} aria-haspopup="dialog" onClick={() => setAsOf(true)}>Metrics as of</Button>
      </div>
      <p className={styles.small} role="status">{data.pagination.returned} returned of {factText(data.assetTotal, nativeCount)} filtered assets. Source selection: {data.selection.platform} · {data.selection.rights}. Metrics observed {data.provenance.observedAt}.</p>
      {data.assets.length ? <Table caption="Top assets by click-through rate" columns={[{ label: "Asset", width: 300 }, { label: "Clicks / impressions", width: 290 }, { label: "CTR", width: 150 }, { label: "Rights state", width: 300 }, { label: "Next action", width: 208 }]}
        rows={data.assets.map(row => ({ key: row.assetRef, cells: [row.label, `${factText(row.clicks, nativeCount)} / ${factText(row.impressions, nativeCount)}`, <Fact key="ctr" fact={row.ctr} format={nativePercent} />, <Badge key="rights" tone={row.rights === "cleared" ? "success" : "warning"}>{row.rights}</Badge>, <Button key="action" variant="secondary" onClick={() => setSelected(row.assetRef)} aria-haspopup="dialog" aria-label={`Review source evidence for ${row.label}`}>Review evidence</Button>] }))} /> : <p>{data.assetTotal.state === "known" && data.assetTotal.value === 0 ? "No assets match this qualified source selection." : "No asset rows supplied; total coverage remains Unknown."}</p>}
      <div className={styles.btnRow}><Button variant="secondary" onClick={clear}>Clear asset filters</Button>{paged && <Button variant="secondary" onClick={first}>First asset page</Button>}{data.pagination.nextCursor && <Button onClick={next} loading={refreshing}>Next asset page</Button>}</div>
      <p className={styles.small}>Expired, missing or unknown rights hold paid reuse. Expiry within 30 days requires review. These controls inspect evidence only.</p>
    </Card>
    <Dialog open={asOf} focusHeading title="Metrics as of" onClose={() => setAsOf(false)}>
      <p>Observed {data.provenance.observedAt}; source access valid until {data.provenance.validUntil}.</p>
      <p>Coverage: {data.coverage.state}. Freshness: {data.freshness.state}. Every asset keeps its own source observation and rights state.</p>
      <p>The initial $1,500 test requires qualified product, usable permissioned content, functioning checkout, attribution and fulfillment. These reads do not authorize spend.</p>
      <Button variant="secondary" onClick={() => setAsOf(false)}>Close metrics timestamp</Button>
    </Dialog>
    <Dialog open={Boolean(asset)} focusHeading title={asset ? `Asset evidence · ${asset.label}` : "Asset evidence"} onClose={() => setSelected(null)}>
      {asset && <><p>Platform: {label(asset.platform)}. Rights: {asset.rights}. Expiry: {asset.expiresOn ?? "Unknown / no dated expiry supplied"}.</p><p>Clicks: <Fact fact={asset.clicks} format={nativeCount} />. Impressions: <Fact fact={asset.impressions} format={nativeCount} />. CTR: <Fact fact={asset.ctr} format={nativePercent} />.</p><p className={styles.small}>Evidence source time {asset.clicks.sourceAsOf ?? "Unknown"}; observed {asset.clicks.observedAt}. Evidence references stay bound to the current source version.</p><p>No verified external asset link or grant document is supplied here. Review the canonical content-rights workflow before paid reuse.</p></>}
      <Button variant="secondary" onClick={() => setSelected(null)}>Close asset evidence</Button>
    </Dialog>
  </>;
}
