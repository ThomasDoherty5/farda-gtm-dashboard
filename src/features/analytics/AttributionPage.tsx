import { useState } from "react";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DEMO_OFFER_ID, type AttributionData } from "@/fixtures/analytics";
import type { MetricDictionaryData } from "@/fixtures/headlineMetrics";
import { LAUNCH_TABS } from "./LaunchControlPage";
import { allocateCosts, aov as aovOf, blendedCac, evaluateCase, mer as merOf, moneyResult, multipleResult } from "./headlineMetrics";
import { weekBarHeight, weekTotals, AXIS_MAX_MINOR } from "./attributionMath";
import { BarList, Card, DetailRow, HandoffDialog, KpiCard, KpiGrid, MetricText, Notice, PageHeader, PeriodDialog, SectionHeading, ViewShell, WorkspaceTabs, count, percent, ratio, usd, usdExact, useIsDemo } from "./parts";
import styles from "./Analytics.module.css";

const axisLabel = (minor: number) => (minor === 0 ? "$0" : `$${minor / 100_000}k`);
const multiple = (n: number) => `${n.toFixed(2)}×`;

/** Performance attribution (Figma source 14:377, owner THO-293, CTRL-202 and CTRL-203). */
export function AttributionPage() {
  const query = useView<Record<string, never>, AttributionData>("attribution", {});
  const [dialog, setDialog] = useState<"period" | "definitions" | null>(null);
  return (
    <section aria-labelledby="attribution-title" data-figma-source="14:377" className={styles.page}>
      <PageHeader id="attribution-title" title="Every dollar, in perspective." subtitle="Performance · one period, clear attribution, and the economics behind growth.">
        <Button variant="secondary" style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setDialog("period")}>Last 30 days</Button>
        <Button style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setDialog("definitions")}>Metric definitions</Button>
      </PageHeader>
      <WorkspaceTabs tabs={LAUNCH_TABS("performance")} />
      <ViewShell query={query} subject="Performance attribution" emptyTitle="No performance data" emptyBody="The source responded, but nothing matches this period.">
        {(data) => <Body data={data} openDefinitions={() => setDialog("definitions")} />}
      </ViewShell>
      <PeriodDialog open={dialog === "period"} onClose={() => setDialog(null)} period={query.data?.data?.periodLabel ?? null} />
      <Dialog open={dialog === "definitions"} title="Metric definitions" badge="Proposed" onClose={() => setDialog(null)}>
        {dialog === "definitions" && <Definitions />}
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </section>
  );
}

const OTHER_DEFS: [string, string][] = [
  ["Net receipts", "Order receipts after refunds, before fees. Valid orders in the reporting period."],
  ["Contribution before marketing", "Net receipts less product, shipping, transaction and variable fulfilment costs. Proposed formula; not final."],
  ["Attribution", "One winning method per order: discount code, then UTM, then platform-reported. Orders with none are unattributed, not assigned."],
];

/** The versioned dictionary, cost allocation and hand-checked cases behind the four headline metrics. Read through the adapter. */
function Definitions() {
  const query = useView<Record<string, never>, MetricDictionaryData>("metricDictionary", {});
  const dict = query.data?.data ?? null;
  if (!dict) return <p className={styles.small} role="status">{query.isError ? "Definitions are unavailable." : "Loading definitions…"}</p>;
  const alloc = allocateCosts(dict.buckets);
  return (
    <div data-testid="metric-dictionary">
      <p className={styles.small}>Dictionary {dict.version} · effective {dict.effective} · {dict.stage}. Demo fixture, not connected sources.</p>
      <dl className={styles.defs}>
        {dict.entries.map((e) => (
          <div key={e.key} data-testid={`definition-${e.key}`}>
            <dt>{e.label}</dt>
            <dd>
              {e.numerator} ÷ {e.denominator}. Source: {e.source}. Currency: {e.currency}. Window: {e.window}. Cost buckets: {e.costBuckets} Refunds: {e.refundTreatment}
            </dd>
          </div>
        ))}
        {dict.related.map((r) => <div key={r.label}><dt>{r.label}</dt><dd>{r.basis}</dd></div>)}
        {OTHER_DEFS.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
      </dl>
      <h3 className={styles.label}>Cost allocation · {usd({ minorUnits: alloc.totalMinor, currency: "USD" })}, each bucket once</h3>
      <ul className={styles.small} data-testid="cost-buckets">
        {dict.buckets.map((b) => <li key={b.key}>{b.label}: {usd({ minorUnits: b.minorUnits, currency: "USD" })} · {b.basis} · {b.note}</li>)}
      </ul>
      <h3 className={styles.label}>Calculation evidence · hand-checked cases</h3>
      <ul className={styles.small} data-testid="metric-cases">
        {dict.cases.map((c) => {
          const r = evaluateCase(c.input);
          return <li key={c.id} data-case={c.id}><strong>{c.label}</strong>: AOV {r.aov} · CAC {r.cac} · MER {r.mer}. {c.handCalculation}</li>;
        })}
      </ul>
      <p className={styles.small}>{dict.sourceNote}</p>
    </div>
  );
}

function Body({ data, openDefinitions }: { data: AttributionData; openDefinitions: () => void }) {
  const demo = useIsDemo();
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState(2);
  const net = data.netReceipts.value;
  const contribution = data.contribution.value;
  const orders = data.orders.value;
  const attributed = data.attribution.reduce((s, a) => s + a.orders, 0);
  const unattributed = data.attribution.find((a) => a.key === "unattributed")?.orders ?? 0;
  const spend = data.marketingSpend;
  const cac = blendedCac(spend.minorUnits, data.newRetainedCustomers);
  const merResult = merOf(net?.minorUnits ?? null, spend.minorUnits);
  const aovResult = aovOf(net?.minorUnits ?? null, orders);
  const cacMinor = cac.value;
  const perOrder = aovOf(contribution?.minorUnits ?? null, orders);
  const perOrderMinor = perOrder.value;
  const channelTotal = data.channels.reduce((s, c) => s + c.netReceipts.minorUnits, 0);
  const totals = weekTotals(data.weeks);
  const shopifyLeads = data.weeks.every((w) => w.shopify.minorUnits > w.tiktok.minorUnits);
  const week = data.weeks[selected] ?? data.weeks[0]!;
  const roiScale = 3;
  return (
    <>
      {demo && (
        <Notice tone="warning" title={`Illustrative data · ${data.periodLabel}`}>
          This is the post-launch layout with a consistent sample dataset. Live data is not connected. Forecasts remain pending rebaseline and the current period is provisional.
        </Notice>
      )}
      <KpiGrid>
        <KpiCard label="Net receipts" context={`${orders === null ? "Orders unknown" : `${count(orders)} orders`} · AOV ${aovResult.value === null ? "N/A" : usdExact({ minorUnits: aovResult.value, currency: "USD" })}`} testId="metric-net-receipts"><MetricText value={data.netReceipts} format={usd} /></KpiCard>
        <KpiCard label="Contribution before marketing" context={contribution && net ? `${((100 * contribution.minorUnits) / net.minorUnits).toFixed(2)}% · proposed definition` : "Proposed definition · cost incomplete"} testId="metric-contribution"><MetricText value={data.contribution} format={usd} /></KpiCard>
        <KpiCard label="Blended CAC" context={`${usd(spend)} ÷ ${count(data.newRetainedCustomers)} new retained customers`} testId="metric-cac">{moneyResult(cac)}</KpiCard>
        <KpiCard label="MER" context="Net receipts ÷ marketing cost" testId="metric-mer">{multipleResult(merResult)}</KpiCard>
      </KpiGrid>
      <div className={styles.split} style={{ gridTemplateColumns: "864fr 408fr" }}>
        <Card labelledBy="weekly-title">
          <SectionHeading id="weekly-title" title={shopifyLeads ? "Shopify leads net receipts in every week" : "Net receipts by week and channel"} note="Channel receipts after refunds · USD · zero-baseline comparison" />
          <div className={styles.legend}>
            <Badge tone="violet" width={132}>Shopify</Badge>
            <Badge width={146}>TikTok Shop</Badge>
            <p className={styles.small}>Totals: {usd({ minorUnits: totals.shopify, currency: "USD" })} / {usd({ minorUnits: totals.tiktok, currency: "USD" })}</p>
          </div>
          <div className={styles.weekly}>
            <div className={styles.yAxis} aria-hidden="true">
              {[AXIS_MAX_MINOR, AXIS_MAX_MINOR / 2, 0].map((t, i) => <span key={t} style={{ top: 35 + 90 * i }}>{axisLabel(t)}</span>)}
            </div>
            <ul className={styles.weeks} aria-label="Weekly net receipts by channel. Select a week for its totals.">
              {data.weeks.map((w, i) => (
                <li key={w.label}>
                  <button type="button" className={styles.weekButton} aria-pressed={i === selected} aria-label={`${w.label}${w.note ? " (partial week)" : ""}: Shopify ${usd(w.shopify)}, TikTok Shop ${usd(w.tiktok)}`} onClick={() => setSelected(i)}>
                    <span className={styles.channelBars}>
                      <span className={styles.valueBar} style={{ justifyContent: "flex-end" }}><span>{usd(w.shopify)}</span><span className={`${styles.receiptBar} ${styles.receiptBarShopify}`} style={{ height: weekBarHeight(w.shopify.minorUnits) }} /></span>
                      <span className={styles.valueBar} style={{ justifyContent: "flex-end" }}><span>{usd(w.tiktok)}</span><span className={styles.receiptBar} style={{ height: weekBarHeight(w.tiktok.minorUnits) }} /></span>
                    </span>
                    <span>{w.label}{w.note}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <hr className={styles.divider} />
          <div className={styles.tooltip} role="status" aria-live="polite">
            <strong>{week.label}</strong>
            <span>Shopify  {usd(week.shopify)}</span>
            <span>TikTok Shop  {usd(week.tiktok)}</span>
            <strong>Total  {usd({ minorUnits: week.shopify.minorUnits + week.tiktok.minorUnits, currency: "USD" })}</strong>
          </div>
          <p className={styles.small}>Source: {data.provenance.source} as of 29 Oct 2026 · week 5 has two days.</p>
        </Card>
        <Card labelledBy="cost-title">
          <SectionHeading id="cost-title" title="What does a customer cost?" note="Compare acquisition with contribution." />
          <DetailRow label="Blended CAC" value={cacMinor === null ? "N/A" : usdExact({ minorUnits: cacMinor, currency: "USD" })} />
          <div className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: "100%" }} /></div>
          <DetailRow label="Contribution / order¹" value={perOrderMinor === null ? "N/A" : usdExact({ minorUnits: perOrderMinor, currency: "USD" })} />
          <div className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ width: `${(ratio(perOrderMinor ?? 0, cacMinor ?? 0) * 100).toFixed(2)}%` }} /></div>
          {cacMinor !== null && perOrderMinor !== null && <div className={styles.btnRow}><Badge tone="warning" width={160}>Different bases</Badge></div>}
          <p className={styles.small} data-testid="cac-basis-note">¹ Before marketing. CAC is per new retained customer; contribution is per valid order, so the two are not a profit per customer.</p>
          <hr className={styles.divider} />
          <p className={styles.metric} data-testid="metric-platform-roas"><MetricText value={data.tiktokPlatformRoas} format={multiple} /></p>
          <p className={styles.label}>TikTok platform ROAS</p>
          <p className={styles.small}>Platform-reported purchase value ÷ platform spend. Separate from MER; never added to storefront orders.</p>
          <div className={styles.btnRow}><Button variant="ghost" style={{ minWidth: 212 }} aria-haspopup="dialog" onClick={openDefinitions}>View definitions</Button></div>
        </Card>
      </div>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="mix-title">
          <SectionHeading id="mix-title" title="Two channels, one reconciled total" note="Revenue share · net receipts after refunds" />
          <p className={styles.metric}>{net ? usd(net) : "N/A"}</p>
          <div className={styles.stack} role="img" aria-label={data.channels.map((c) => `${c.label} ${percent(c.netReceipts.minorUnits, channelTotal)}`).join(", ")}>
            {data.channels.map((c) => <span key={c.key} className={c.key === "shopify" ? styles.stackShopify : styles.stackTiktok} style={{ width: `${(ratio(c.netReceipts.minorUnits, channelTotal) * 100).toFixed(2)}%` }} />)}
          </div>
          {data.channels.map((c) => (
            <DetailRow key={c.key} label={`${c.label} · ${percent(c.netReceipts.minorUnits, channelTotal)}`} value={usd(c.netReceipts)} />
          ))}
          <hr className={styles.divider} />
          <p className={styles.label}>{orders === null ? "Orders unknown" : `${count(orders)} orders`} · {count(data.retainedUnits)} retained units</p>
          <p className={styles.small}>Attribution is a second view of these same orders, not additional revenue.</p>
          <div className={styles.btnRow}><LinkButton variant="secondary" to="/operations" style={{ minWidth: 230 }}>View channel orders</LinkButton></div>
        </Card>
        <Card labelledBy="creators-title">
          <SectionHeading id="creators-title" title="Creator efficiency, on a common basis" note="Attributed contribution ÷ total creator cost · demo ranking" />
          <BarList label="Creator return on cost" cols="160px minmax(0, 1fr) 64px" gap={12} rows={data.creators.map((c) => ({ key: c.handle, label: c.handle, value: multiple(c.roi).replace(/(\.\d)0/, "$1"), share: ratio(c.roi, roiScale) }))} />
          <div className={styles.axis} aria-hidden="true" style={{ gridTemplateColumns: "172px repeat(3, minmax(0, 1fr)) 76px", font: "var(--text-small)" }}>
            <span /><span>0×</span><span>1×</span><span>2×</span><span>3×</span>
          </div>
          <p className={styles.small}>Total creator cost = commission, historical accepted fees and sample landed cost, labeled separately. Actual landed cost is pending QBO; incomplete cost shows “Incomplete.”</p>
          <div className={styles.btnRow}><LinkButton variant="ghost" to={`/offers/${DEMO_OFFER_ID}`} style={{ minWidth: 246 }}>Open creator economics</LinkButton></div>
        </Card>
      </div>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="coverage-title">
          <SectionHeading id="coverage-title" title={`${count(unattributed)} orders need attribution review`} note="One winning method per order: code → UTM → platform." />
          <BarList label="Orders by attribution method" cols="176px minmax(0, 1fr) 124px" gap={12} rows={data.attribution.map((a) => ({ key: a.key, label: a.label, value: `${count(a.orders)} · ${percent(a.orders, attributed, 0)}`, share: ratio(a.orders, attributed), ...(a.key === "unattributed" ? { tone: "warning" as const } : {}) }))} />
          <p className={styles.small}>Source: Orders mirror · {count(attributed)} orders · {data.periodLabel}.</p>
          <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 230 }} aria-haspopup="dialog" onClick={() => setReviewing(true)}>Review unattributed</Button></div>
        </Card>
        <Card labelledBy="integrity-title">
          <SectionHeading id="integrity-title" title="When a number needs context" note="Definitions link to the existing Agent Guide." />
          <DetailRow label="Zero denominator" value="N/A" />
          <DetailRow label="No source data" value="Awaiting data" />
          <DetailRow label="Missing landed cost" value="Cost incomplete" />
          <DetailRow label="Open accounting month" value="Provisional" />
          <DetailRow label="Forecast" value="Pending rebaseline" />
          <hr className={styles.divider} />
          <p className={styles.small}>Anonymous customer aggregates supply CAC. Weekly snapshots are versioned; late refunds create a correction. No customer identities enter this dashboard.</p>
        </Card>
      </div>
      <HandoffDialog
        open={reviewing}
        onClose={() => setReviewing(false)}
        title="Unattributed orders"
        rows={[
          { label: "Orders", value: `${count(unattributed)} of ${count(attributed)} (${percent(unattributed, attributed, 0)})` },
          { label: "Window", value: data.periodLabel },
          { label: "Precedence", value: "Discount code, then UTM, then platform-reported" },
          { label: "Provenance", value: `${data.provenance.source}; order rows aren't listed in this build` },
        ]}
      >
        <p>Opening the review doesn't assign a creator or invent an attribution. Matching happens in the order source.</p>
      </HandoffDialog>
    </>
  );
}

