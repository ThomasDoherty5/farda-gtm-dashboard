import { useState } from "react";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { DEMO_OFFER_ID, type AttributionData } from "@/fixtures/analytics";
import type { MetricDictionaryData } from "@/fixtures/headlineMetrics";
import { LAUNCH_TABS } from "./LaunchControlPage";
import { allocateCosts, aov as aovOf, contributionPerOrder, evaluateCase, periodHeadline, CAVEAT_TEXT, type Caveat } from "./headlineMetrics";
import { weekBarHeight, weekTotals, AXIS_MAX_MINOR } from "./attributionMath";
import { BarList, Card, DetailRow, HandoffDialog, KpiCard, KpiGrid, MetricText, Notice, PageHeader, PeriodDialog, SectionHeading, ViewShell, WorkspaceTabs, count, percent, ratio, usd, usdExact, useIsDemo } from "./parts";
import styles from "./Analytics.module.css";
import { NativeTrafficDefinitionRead } from "./NativeSiteTrafficPage";

const axisLabel = (minor: number) => (minor === 0 ? "$0" : `$${minor / 100_000}k`);
const multiple = (n: number) => `${n.toFixed(2)}×`;

/** Performance attribution (Figma source 14:377, owner THO-293, CTRL-202 and CTRL-203). */
export function AttributionPage() {
  const query = useView<Record<string, never>, AttributionData>("attribution", {});
  const report = query.data?.data;
  const periodLabel = report?.datasetKey === "attribution-observed"
    ? report.reportScope ? `${report.reportScope.period.start} to ${report.reportScope.period.end} (${report.reportScope.period.timezone})` : null
    : report?.periodLabel ?? null;
  const [dialog, setDialog] = useState<"period" | "definitions" | null>(null);
  return (
    <section aria-labelledby="attribution-title" data-figma-source="14:377" className={styles.page}>
      <PageHeader id="attribution-title" title="Every dollar, in perspective." subtitle="Performance · one period, clear attribution, and the economics behind growth.">
        <Button variant="secondary" style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setDialog("period")}>{report?.datasetKey === "attribution-observed" ? "Reporting period" : "Last 30 days"}</Button>
        <Button style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setDialog("definitions")}>Metric definitions</Button>
      </PageHeader>
      <WorkspaceTabs tabs={LAUNCH_TABS("performance")} />
      <ViewShell query={query} subject="Performance attribution" emptyTitle="No performance data" emptyBody="The source responded, but nothing matches this period.">
        {(data) => <Body data={data} openDefinitions={() => setDialog("definitions")} />}
      </ViewShell>
      <PeriodDialog open={dialog === "period"} onClose={() => setDialog(null)} period={periodLabel} />
      <Dialog open={dialog === "definitions"} title="Metric definitions" badge="Proposed" onClose={() => setDialog(null)}>
        {dialog === "definitions" && <Definitions data={query.data?.data ?? null} />}
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </section>
  );
}

/** Static definitions: always available, whatever the dictionary read does. */
const STATIC_DEFS: [string, string][] = [
  ["Net receipts", "Order receipts after refunds, before fees. Valid orders in the reporting period."],
  ["Contribution before marketing", "Net receipts less product, shipping, transaction and variable fulfilment costs. Proposed formula; not final."],
  ["Blended CAC", "Acquisition cost divided by new retained customers in the period. New acquisition is commission-only; historical accepted fees stay read-only and labeled historical."],
  ["MER", "Net receipts divided by marketing cost. Separate from platform ROAS."],
  ["Platform ROAS", "Platform-reported purchase value divided by platform spend. Never added to storefront orders."],
  ["Attribution", "One winning method per order: discount code, then UTM, then platform-reported. Orders with none are unattributed, not assigned."],
];

function Definitions({ data }: { data: AttributionData | null }) {
  const demo = useIsDemo();
  return (
    <div>
      <dl className={styles.defs} data-testid="static-definitions">
        {STATIC_DEFS.map(([t, d]) => <div key={t}><dt>{t}</dt><dd>{d}</dd></div>)}
      </dl>
      {data && <PeriodEvidence data={data} />}
      <DictionaryRead />
      {!demo && <NativeTrafficDefinitionRead />}
    </div>
  );
}

function PeriodEvidence({ data }: { data: AttributionData }) {
  const e = data.headlineEvidence;
  const result = periodHeadline(data);
  const amount = (n: number | null | undefined) => n == null ? "Unknown" : usdExact({ minorUnits: n, currency: "USD" });
  return <section data-testid="period-economic-evidence">
    <h3 className={styles.label}>Reporting-period evidence</h3>
    <p className={styles.small}>{e ? `${e.source === "fixture" ? "Illustrative fixture" : "Source record"} · ${e.sourceRef} · ${e.cohortWindow.start} to ${e.cohortWindow.end} (${e.cohortWindow.timezone}) · ${e.cohortId}` : "Source and cost coverage unknown."}</p>
    {data.datasetKey === "attribution-observed" && <p className={styles.small}>Report: {data.reportScope?.sourceRef ?? "unknown"}. Receipts: {data.receiptScope?.sourceRef ?? "unknown"}. Retained customers: {data.retainedCustomerScope?.sourceRef ?? "unknown"}.</p>}
    <p className={styles.small}>Economic cost {amount(result.cost)}. Linked cash receipts {amount(result.cost === null ? null : result.allocation?.cashPaidMinor)}.</p>
    <p className={styles.small}>Retention: {e?.retention ?? "unknown"}. Landed cost: {e?.landedCost ?? "unknown"}. Refund revision: {e?.refundRevision ?? "none supplied"}.</p>
    {result.diagnostics.length > 0 && <p className={styles.small} role="status">Reconciliation required: {result.diagnostics.map(reason => reason.toLowerCase().replaceAll("_", " ")).join("; ")}.</p>}
    {e && e.costs.length > 0 && <details><summary>Cost observations ({e.costs.length})</summary>
      <ul className={styles.small}>{e.costs.map((row, i) => <li key={(row.evidenceId ?? row.key) + "/" + i}>{row.label} · {row.basis} · {row.currency === "USD" ? amount(row.minorUnits) : "Currency unresolved"} · obligation {row.obligationId ?? "unknown"} · source {row.evidenceId ?? "unknown"}</li>)}</ul>
    </details>}
    {result.allocation?.state === "provisional" && <p className={styles.small}>Cost includes an estimate.</p>}
    {!!result.allocation?.duplicates.length && <p className={styles.small}>{result.allocation.duplicates.length} repeated evidence reference(s) counted once.</p>}
  </section>;
}

/** The versioned dictionary, cost allocation and hand-checked cases behind the headline metrics. Read through the adapter; the read's state never hides the static definitions. */
function DictionaryRead() {
  const query = useView<Record<string, never>, MetricDictionaryData>("metricDictionary", {});
  return (
    <ViewShell query={query} subject="Metric dictionary" emptyTitle="No metric dictionary" emptyBody="The source responded, but it returned no versioned dictionary. The definitions above still apply.">
      {(dict) => <Dictionary dict={dict} />}
    </ViewShell>
  );
}

function Dictionary({ dict }: { dict: MetricDictionaryData }) {
  const demo = useIsDemo();
  const alloc = allocateCosts(dict.buckets, dict.allocationScope);
  return (
    <div data-testid="metric-dictionary">
      <p className={styles.small}>Dictionary {dict.version} · effective {dict.effective} · {dict.stage}.{demo ? " Demo fixture, not connected sources." : ""}</p>
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
      </dl>
      <h3 className={styles.label}>Illustrative cost allocation · {dict.allocationScope && dict.allocationScope.currency !== "USD" ? `Unavailable in USD (${dict.allocationScope.currency})`
        : alloc.totalMinor === null ? "Unknown" : usd({ minorUnits: alloc.totalMinor, currency: "USD" })}</h3>
      {dict.allocationVersion && <p className={styles.small}>Allocation {dict.allocationVersion}. An accrual and its payment share one obligation. Matching amounts count once economically. Cash requires a linked settlement. Conflicting records hold the total.</p>}
      <ul className={styles.small} data-testid="cost-buckets">
        {dict.buckets.map((b, i) => <li key={(b.evidenceId ?? b.key) + "/" + i}>{b.label}: {b.minorUnits === null || b.currency !== "USD" ? "Unresolved amount or currency" : usd({ minorUnits: b.minorUnits, currency: "USD" })} · {b.basis} · {b.note}</li>)}
      </ul>
      {alloc.diagnostics.length > 0 && <p role="status" className={styles.small}>Example allocation unresolved: {alloc.diagnostics.join(", ")}.</p>}
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
  const demo = useIsDemo() || data.datasetKey === "overview-original";
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState(2);
  const net = data.netReceipts.value;
  const contribution = data.contribution.value;
  const orders = data.orders.value;
  const attributed = data.attribution.reduce((s, a) => s + a.orders, 0);
  const unattributed = data.attribution.find((a) => a.key === "unattributed")?.orders;
  const { cac, mer: merResult, cost, receiptsBound, customerCount } = periodHeadline(data);
  const caveat = (r: typeof cac) => r.state === "provisional" ? CAVEAT_TEXT[r.reasonCode as Caveat] : null;
  const spendText = cost === null ? "Unknown cost" : usd({ minorUnits: cost, currency: "USD" });
  const aovResult = aovOf(receiptsBound ? net?.minorUnits ?? null : null, orders);
  const cacMinor = cac.value;
  const perOrder = contributionPerOrder(receiptsBound ? contribution?.minorUnits ?? null : null, orders);
  const perOrderMinor = perOrder.value;
  const channelTotal = data.channels.reduce((s, c) => s + c.netReceipts.minorUnits, 0);
  const totals = weekTotals(data.weeks);
  const shopifyLeads = data.weeks.length > 0 && data.weeks.every((w) => w.shopify.minorUnits > w.tiktok.minorUnits);
  const week = data.weeks[selected] ?? data.weeks[0];
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
        <KpiCard label="Contribution before marketing" context={contribution && net && net.minorUnits > 0 ? `${((100 * contribution.minorUnits) / net.minorUnits).toFixed(2)}% · proposed definition` : "Proposed definition · cost incomplete"} testId="metric-contribution"><MetricText value={data.contribution} format={usd} /></KpiCard>
        <KpiCard label="Blended CAC" context={`${spendText} ÷ ${customerCount === null ? "unknown" : count(customerCount)} new retained customers`} testId="metric-cac">{cac.value === null ? "N/A" : usdExact({ minorUnits: cac.value, currency: "USD" })}{caveat(cac) && <span className={styles.small} title={caveat(cac)!}> · Provisional</span>}</KpiCard>
        <KpiCard label="MER" context="Net receipts ÷ marketing cost" testId="metric-mer">{merResult.value === null ? "N/A" : multiple(merResult.value)}{caveat(merResult) && <span className={styles.small} title={caveat(merResult)!}> · Provisional</span>}</KpiCard>
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
          {week ? <div className={styles.tooltip} role="status" aria-live="polite">
            <strong>{week.label}</strong>
            <span>Shopify  {usd(week.shopify)}</span>
            <span>TikTok Shop  {usd(week.tiktok)}</span>
            <strong>Total  {usd({ minorUnits: week.shopify.minorUnits + week.tiktok.minorUnits, currency: "USD" })}</strong>
          </div> : <p role="status">Weekly receipt observations unavailable.</p>}
          <p className={styles.small}>Source: {data.provenance.source}{demo && " as of 29 Oct 2026 · week 5 has two days."}</p>
        </Card>
        <Card labelledBy="cost-title">
          <SectionHeading id="cost-title" title="What does a customer cost?" note="Compare acquisition with contribution." />
          <DetailRow label="Blended CAC" value={cacMinor === null ? "N/A" : usdExact({ minorUnits: cacMinor, currency: "USD" })} />
          <div className={styles.track} aria-hidden="true">{cacMinor !== null && <span className={styles.fill} data-testid="cac-bar" style={{ width: "100%" }} />}</div>
          <DetailRow label="Contribution / order¹" value={perOrderMinor === null ? "N/A" : usdExact({ minorUnits: perOrderMinor, currency: "USD" })} />
          <div className={styles.track} aria-hidden="true">{perOrderMinor !== null && perOrderMinor >= 0 && cacMinor !== null && <span className={styles.fill} data-testid="contribution-bar" style={{ width: `${(ratio(perOrderMinor, cacMinor) * 100).toFixed(2)}%` }} />}</div>
          {cacMinor !== null && perOrderMinor !== null && <div className={styles.btnRow}><Badge tone="warning" width={160}>Different bases</Badge></div>}
          <p className={styles.small} data-testid="cac-basis-note">¹ Before marketing. CAC is per new retained customer; contribution is per valid order, so the two are not a profit per customer.</p>
          <hr className={styles.divider} />
          <p className={styles.metric} data-testid="metric-platform-roas"><MetricText value={data.tiktokPlatformRoas} format={multiple} /></p>
          <p className={styles.label}>TikTok platform ROAS{data.tiktokPlatformRoas.value !== null && !data.tiktokRoasWindow ? " · Provisional" : ""}</p>
          <p className={styles.small}>Platform-reported value ÷ spend. {data.tiktokRoasWindow ? `Window: ${data.tiktokRoasWindow.label} (${data.tiktokRoasWindow.sourceRef}).` : "Provisional · attribution window unknown."}</p>
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
          <SectionHeading id="coverage-title" title={unattributed === undefined ? "Unattributed order count unknown" : `${count(unattributed)} orders need attribution review`} note="One winning method per order: code → UTM → platform." />
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
          <p className={styles.small}>Anonymous customer aggregates supply CAC. Weekly snapshots are versioned; a late refund revises the figure for the period it lands in. No customer identities enter this dashboard.</p>
        </Card>
      </div>
      <HandoffDialog
        open={reviewing}
        onClose={() => setReviewing(false)}
        title="Unattributed orders"
        rows={[
          { label: "Orders", value: unattributed === undefined ? "Unknown" : `${count(unattributed)} of ${count(attributed)} (${percent(unattributed, attributed, 0)})` },
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

