import { useState } from "react";
import type { NativeAttribution as Attribution, NativeMetricDictionary } from "@/creator-agent/analytics/views";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Fact, NativeAnalyticsEvidence, factText, nativeCount, nativeMoney, nativeMultiple, nativePercent, nativePeriod } from "./NativeAnalyticsEvidence";
import { BarList, Card, DetailRow, KpiCard, KpiGrid, SectionHeading, Table } from "./parts";
import styles from "./Analytics.module.css";

const money = (value: number) => nativeMoney({ minorUnits: value, currency: "USD" });
const label = (key: string) => key === "shopify" ? "Shopify" : "TikTok Shop";
const methods = { creatorCode: "Creator code", sitewideCode: "Sitewide code", unknownCode: "Unresolved code owner", utm: "UTM", platform: "Platform-reported", unattributed: "Unattributed" };
export function NativeAttribution({ data, refresh, refreshing, definitions }: { data: Attribution; refresh: () => void; refreshing: boolean; definitions: () => void }) {
  const [selected, setSelected] = useState(0), [review, setReview] = useState(false);
  const measure = (id: string) => data.measures.find(row => row.metricId === id)?.result;
  const scale = Math.max(1, ...data.weeks.flatMap(week => week.channels.map(channel => Math.max(0, channel.netReceipts.value?.minorUnits ?? 0))));
  const week = data.weeks[Math.min(selected, Math.max(0, data.weeks.length - 1))];
  const tiktokWindow = data.platformReports.find(row => row.platform === "tiktok")?.attributionWindow;
  const cac = measure("blendedCac"), contribution = measure("contributionPerOrder"), economyScale = Math.max(1, cac?.value ?? 0, contribution?.value ?? 0);
  const share = (key: string) => measure(`shareNetReceipts.${key}`);
  const unattributed = data.attribution.find(row => row.method === "unattributed")?.orders;
  return <>
    <NativeAnalyticsEvidence data={data} refresh={refresh} refreshing={refreshing} />
    <KpiGrid>
      <KpiCard label="Net receipts" context={`${factText(data.orders, nativeCount)} orders · AOV ${factText(measure("aov"), money)}`} testId="metric-net-receipts"><Fact fact={data.netReceipts} format={nativeMoney} /></KpiCard>
      <KpiCard label="Contribution before marketing" context={`${factText(measure("contributionMargin"), nativePercent)} · source definition`} testId="metric-contribution"><Fact fact={data.contribution} format={nativeMoney} /></KpiCard>
      <KpiCard label="Blended CAC" context={`${factText(data.marketingSpend, nativeMoney)} ÷ ${factText(data.newRetainedCustomers, nativeCount)} new retained customers`} testId="metric-cac"><Fact fact={cac} format={money} /></KpiCard>
      <KpiCard label="MER" context="Net receipts ÷ marketing cost" testId="metric-mer"><Fact fact={measure("mer")} format={nativeMultiple} /></KpiCard>
    </KpiGrid>
    <div className={styles.split} style={{ gridTemplateColumns: "864fr 408fr" }}>
      <Card labelledBy="weekly-title"><SectionHeading id="weekly-title" title="Net receipts by week and channel" note="Channel receipts after refunds · USD · zero-baseline comparison" />
        <div className={styles.legend}><Badge tone="violet" width={132}>Shopify</Badge><Badge width={146}>TikTok Shop</Badge><p className={styles.small}>Totals: {data.channels.map(channel => factText(channel.netReceipts, nativeMoney)).join(" / ")}</p></div>
        <div className={styles.weekly}><div className={styles.yAxis} aria-hidden="true">{[scale, scale / 2, 0].map((value, index) => <span key={index} style={{ top: 35 + 90 * index }}>{money(value)}</span>)}</div>
          <ul className={styles.weeks} aria-label="Weekly net receipts by channel. Select a week for its totals.">{data.weeks.map((row, index) => <li key={row.startDay}><button className={styles.weekButton} aria-pressed={index === selected} onClick={() => setSelected(index)} aria-label={`${row.startDay} to ${row.endDayExclusive} exclusive: ${row.channels.map(channel => `${label(channel.channel)} ${factText(channel.netReceipts, nativeMoney)}`).join(", ")}${row.snapshotVersion ? `, snapshot ${row.snapshotVersion}` : ""}`}><span className={styles.channelBars}>{row.channels.map(channel => <span key={channel.channel} className={styles.valueBar} style={{ justifyContent: "flex-end" }}><Fact fact={channel.netReceipts} format={nativeMoney} /><span aria-hidden="true" className={`${styles.receiptBar} ${channel.channel === "shopify" ? styles.receiptBarShopify : ""}`} style={{ height: Math.max(0, channel.netReceipts.value?.minorUnits ?? 0) / scale * 180 }} /></span>)}</span><span>Wk {index + 1}</span></button></li>)}</ul>
        </div>
        {week ? <p className={styles.small} role="status">{week.startDay} to {week.endDayExclusive} exclusive · {week.channels.map(channel => `${label(channel.channel)} ${factText(channel.netReceipts, nativeMoney)}`).join(" · ")}{week.snapshotVersion ? ` · Snapshot ${week.snapshotVersion}` : ""}</p> : <p>Weekly observations Unknown.</p>}
        <p className={styles.small}>Weeks partition the selected source calendar. The final week may be partial. Negative receipts remain labeled; no negative bar is drawn below this zero-baseline chart.</p>
      </Card>
      <Card><SectionHeading title="What does a customer cost?" note="Compare acquisition with contribution." />
        <BarList label="Acquisition and contribution" rows={[{ key: "cac", label: "Blended CAC", value: factText(cac, money), share: Math.max(0, cac?.value ?? 0) / economyScale }, { key: "contribution", label: "Contribution / order", value: factText(contribution, money), share: Math.max(0, contribution?.value ?? 0) / economyScale }]} />
        <Badge tone="warning">Different denominators</Badge><p className={styles.small}>CAC uses new retained customers; contribution uses all valid orders. The source definition and cost qualification remain attached.</p>
        <hr className={styles.divider} /><p className={styles.metric}><Fact fact={measure("platformRoas.tiktok")} format={nativeMultiple} /></p><p>TikTok platform ROAS</p><p className={styles.small}>Matched standard-campaign purchase value ÷ spend. {tiktokWindow ? `${tiktokWindow.clickDays}-day click / ${tiktokWindow.viewDays}-day view.` : "Attribution window Unknown."} Never added to storefront orders.</p><Button variant="ghost" onClick={definitions}>View definitions</Button>
      </Card>
    </div>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card><SectionHeading title="Two channels, one reconciled total" note="Revenue share · net receipts after refunds" /><p className={styles.metric}><Fact fact={data.netReceipts} format={nativeMoney} /></p>
        <div className={styles.stack} aria-hidden="true">{data.channels.map(channel => <span key={channel.channel} className={channel.channel === "shopify" ? styles.stackShopify : styles.stackTiktok} style={{ width: `${Math.max(0, Math.min(100, share(channel.channel)?.value ?? 0))}%` }} />)}</div>
        {data.channels.map(channel => <DetailRow key={channel.channel} label={`${label(channel.channel)} · ${factText(share(channel.channel), nativePercent)}`} value={<Fact fact={channel.netReceipts} format={nativeMoney} />} />)}<hr className={styles.divider} /><p><Fact fact={data.orders} format={nativeCount} /> orders · <Fact fact={data.retainedUnits} format={nativeCount} /> retained units</p><p className={styles.small}>Attribution is a second view of these same orders, not additional revenue.</p><LinkButton variant="secondary" to="/operations">View channel orders</LinkButton>
      </Card>
      <Card><SectionHeading title="Creator efficiency, on a common basis" note="Source-qualified attributed contribution ÷ total creator cost" />
        {data.creators.length ? <BarList label="Creator return on cost" cols="160px minmax(0, 1fr) 64px" gap={12} rows={data.creators.map((row, index) => ({ key: row.creatorRef, label: `Creator ${index + 1}`, value: factText(row.roi, nativeMultiple), share: Math.min(1, Math.max(0, row.roi.value ?? 0) / 3) }))} /> : <p>Creator economics Unknown · no qualified rows supplied.</p>}
        <div className={`${styles.axis} ${styles.nativeRoiAxis}`} aria-hidden="true" data-testid="native-creator-roi-axis"><span /><span>0×</span><span>1×</span><span>2×</span><span>3×</span></div><p className={styles.small}>Commission, accepted historical fees, landed sample costs and shipping retain their separate evidence. Missing costs never produce a favorable ranking.</p><Button variant="ghost" onClick={definitions}>Open creator economics evidence</Button>
      </Card>
    </div>
    <div className={styles.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
      <Card><SectionHeading title={`${factText(unattributed, nativeCount)} source-reported unattributed orders`} note="One winning method per order: code → UTM → platform." /><BarList label="Orders by attribution method" cols="176px minmax(0, 1fr) 124px" gap={12} rows={data.attribution.map(row => ({ key: row.method, label: methods[row.method], value: `${factText(row.orders, nativeCount)} · ${factText(measure(`shareAttribution.${row.method}`), nativePercent)}`, share: Math.min(1, Math.max(0, measure(`shareAttribution.${row.method}`)?.value ?? 0) / 100), ...(row.method === "unattributed" ? { tone: "warning" as const } : {}) }))} /><Button variant="secondary" onClick={() => setReview(true)}>Review unattributed</Button></Card>
      <Card><SectionHeading title="When a number needs context" note="Definitions remain available alongside the current source evidence." /><DetailRow label="Zero denominator" value="N/A" /><DetailRow label="No source data" value="Unknown" /><DetailRow label="Missing landed cost" value="Cost incomplete" /><DetailRow label="Unqualified or estimated cost" value="Provisional / Unknown ratio" /><DetailRow label="Forecast" value="Pending rebaseline" /><hr className={styles.divider} /><p className={styles.small}>Anonymous aggregates supply CAC. Late refunds revise the original cohort using a bound source revision; no customer identities enter this dashboard.</p></Card>
    </div>
    <Dialog open={review} focusHeading onClose={() => setReview(false)} title="Unattributed orders">
      <DetailRow label="Source-reported unattributed" value={factText(unattributed, nativeCount)} />
      <NativeUnattributedReview data={data} />
      <Button variant="secondary" onClick={() => setReview(false)}>Close order review</Button>
    </Dialog>
  </>;
}

function NativeUnattributedReview({ data }: { data: Attribution }) {
  const detail = data.unattributedReview;
  const [page, setPage] = useState(0);
  if (!detail) return <p>Exact order review evidence is unavailable. Missing rows do not mean zero unattributed orders.</p>;
  const pageSize = 10, last = Math.max(0, Math.ceil(detail.rows.length / pageSize) - 1), current = Math.min(page, last);
  const rows = detail.rows.slice(current * pageSize, (current + 1) * pageSize);
  const names = { unattributed: "Unattributed", unknownCodeOwner: "Code owner unknown", notEvaluated: "Not evaluated" };
  const reasons = { SOURCE_REPORTED_UNATTRIBUTED: "Source reported no winning attribution", CODE_OWNER_UNKNOWN: "Source has a code but its owner is unresolved", ATTRIBUTION_NOT_EVALUATED: "Source has not evaluated attribution" };
  const sourceReasons = { noMatchingSignal: "No matching signal", conflictingSignals: "Conflicting signals", unrecognizedCode: "Unrecognized code", missingTracking: "Missing tracking", notEvaluated: "Not evaluated", sourceUnresolved: "Unresolved by source" };
  return <section aria-label="Source order review" style={{ width: "100%", minWidth: 0, overflowWrap: "anywhere" }}>
    <p>{detail.period ? `${detail.period.startAt} to ${detail.period.endAt} (end exclusive) · ${detail.period.timezone}.` : "Reporting period unavailable."}</p>
    <p>Cohort {detail.cohortRef ?? "N/A"}. Precedence: code, then UTM, then platform. Reviewing never assigns a creator or changes source attribution.</p>
    <p>Review evidence {detail.state}. {detail.reasonCodes.join(" · ")}</p>
    <p>Total needing review: <Fact fact={detail.total} format={nativeCount} />. Unresolved code owners and orders not yet evaluated are listed separately from source-reported unattributed orders.</p>
    {detail.rows.length ? <>
      <p role="status">Rows {current * pageSize + 1}–{Math.min((current + 1) * pageSize, detail.rows.length)} of {detail.rows.length} supplied. {detail.truncated ? `Source detail is capped at ${detail.limit}; further orders remain with the source owner.` : "All supplied detail is available below."}</p>
      <Table caption="Unmatched source orders" columns={[{ label: "Order", width: 200 }, { label: "Classification", width: 180 }, { label: "Reason", width: 250 }, { label: "Placed / channel", width: 230 }, { label: "Provenance", width: 300 }]}
        rows={rows.map(row => ({ key: row.orderRef, cells: [row.orderRef, names[row.classification], reasons[row.reason], `${row.placedAt} · ${row.channel}`,
          <details key="proof"><summary>Source provenance</summary><dl className={styles.defs}>
            <div><dt>Canonical order</dt><dd>{row.canonicalOrderRef ?? "Identity unavailable"}</dd></div>
            <div><dt>Source assignment / code owner</dt><dd>{row.sourceAttribution ?? "Not evaluated"} · {row.codeOwner ?? "Not applicable"}</dd></div>
            <div><dt>Source-specific reason</dt><dd>{row.sourceReason ? sourceReasons[row.sourceReason] : "No source-specific reason supplied"}</dd></div>
            <div><dt>Reason evidence / observed</dt><dd>{row.evidenceRefs.length ? row.evidenceRefs.join(" · ") : "No reason evidence supplied"} · {row.reasonObservedAt ?? "N/A"}</dd></div>
            <div><dt>Feed / proof</dt><dd>{row.feedRef} · {row.proofRef}</dd></div>
            <div><dt>Source / definition version</dt><dd>{row.sourceVersion} · {row.definitionVersion}</dd></div>
            <div><dt>Source as of / observed</dt><dd>{row.sourceAsOf ?? "N/A"} · {row.observedAt}</dd></div>
            <div><dt>Qualification</dt><dd>{row.provisional ? "Provisional source evidence" : "Current source evidence"}</dd></div>
          </dl></details>] }))} />
      {last > 0 && <div className={styles.reviewPager} role="group" aria-label="Source review pages"><div><Button variant="secondary" disabledReason={current === 0 ? "First supplied review page" : undefined} onClick={() => setPage(current - 1)}>Previous review rows</Button></div><div><Button variant="secondary" disabledReason={current === last ? "Last supplied review page" : undefined} onClick={() => setPage(current + 1)}>Next review rows</Button></div></div>}
    </> : <p>{detail.total.state === "known" && detail.total.value === 0 ? "No orders need review in this complete source selection." : "Exact review rows are unavailable. No clean attribution result is inferred."}</p>}
  </section>;
}

const costNames = {
  creatorCommission: "Creator commission", historicalCreatorFee: "Previously accepted creator fee",
  sample: "Sample landed cost", shipping: "Sample shipping", paidMedia: "Paid media",
  platformFee: "Applicable platform fee", otherAcquisition: "Other included acquisition cost",
};

export function NativeEconomicEvidence({ evidence }: { evidence: Attribution["economicEvidence"] }) {
  return <section data-testid="period-economic-evidence">
    <h3>Reporting-period evidence</h3>
    {evidence ? <>
      <p className={styles.small} style={{ overflowWrap: "anywhere" }}>
        {evidence.period.startAt} to {evidence.period.endAt} exclusive ({evidence.period.timezone}) · cohort {evidence.cohortRef}.
        Coverage {evidence.coverage} · retention {evidence.retention} · landed cost {evidence.landedCost} · allocation {evidence.allocationVersion}.
      </p>
      <p>Refund revision <span style={{ overflowWrap: "anywhere" }}>{evidence.refundRevision ?? "None supplied"}</span>.</p>
      <details>
        <summary>Cost observations ({evidence.costs.length})</summary>
        <Table caption="Qualified economic cost observations"
          columns={[{ label: "Category", width: 190 }, { label: "Basis", width: 120 }, { label: "Economic amount", width: 175 }, { label: "Cash linkage", width: 180 }]}
          rows={evidence.costs.map((row, index) => ({ key: row.evidenceRef + index, cells: [
            costNames[row.key], row.basis, row.minorUnits === null ? "Unknown" : money(row.minorUnits),
            row.cashRef ? "Linked cash receipt" : "Economic observation",
          ] }))} />
      </details>
    </> : <p>Source and cost coverage Unknown.</p>}
  </section>;
}

const metricDetails = {
  aov: {
    label: "AOV", formula: "Reconciled net receipts ÷ valid orders",
    basis: "USD in the selected order cohort. Valid orders with a full refund remain in the denominator with zero net receipts.",
    sources: ["commerceOrders"], cost: "The calculation uses the reconciled receipts basis.",
  },
  blendedCac: {
    label: "Blended CAC", formula: "Included acquisition cost ÷ new retained customers",
    basis: "USD per new retained customer in the same mature cohort and reporting period.",
    sources: ["economicCosts", "retainedCustomers"],
    cost: "Include approved media, sample shipping, landed sample economics, applicable fees and commission once per obligation. Previously accepted creator fees remain historical.",
  },
  mer: {
    label: "MER", formula: "Reconciled net receipts ÷ total marketing cost",
    basis: "USD inputs from the same cohort, currency and period. Late refunds revise the original cohort.",
    sources: ["commerceOrders", "economicCosts"],
    cost: "Uses the scoped economic cost allocation, with separately linked cash receipts.",
  },
  platformRoas: {
    label: "Platform ROAS", formula: "Platform-reported purchase value ÷ matching platform spend",
    basis: "One platform's standard campaigns and its reported click and view attribution window. Read the current window in Paid media.",
    sources: ["adReporting"], cost: "Uses that platform's reported USD spend and refund treatment. GMV Max is tracked separately.",
  },
  contributionPerOrder: {
    label: "Contribution per valid order", formula: "Contribution before marketing ÷ valid orders",
    basis: "USD per valid order in the same period. Blended CAC uses new retained customers as its denominator.",
    sources: ["commerceOrders", "economicCosts"], cost: "Requires the scoped product, shipping, transaction and variable fulfillment cost evidence.",
  },
};
const metricSourceNames: Record<string, string> = {
  commerceOrders: "Orders and refunds", economicCosts: "Economic cost ledger",
  retainedCustomers: "Retained-customer source", adReporting: "Platform ad reporting",
};

export function NativeRetainedCosts({ data }: { data: Attribution }) {
  return <dl className={styles.defs} data-testid="native-retained-costs">
    {([["costPerRetainedOrder", "Cost per retained order", "retained orders"], ["costPerRetainedUnit", "Cost per retained unit", "retained units"]] as const).map(([key, label, denominator]) => {
      const metric = data.measures.find(row => row.metricId === key);
      return <div key={key}><dt>{label}</dt><dd><Fact fact={metric?.result} format={money} />
        <p className={styles.small}>Included acquisition cost ÷ {factText(metric?.denominator ?? undefined, nativeCount)} {denominator} in the same cohort.</p>
      </dd></div>;
    })}
  </dl>;
}

export function NativeDictionary({ data }: { data: NativeMetricDictionary }) {
  return <div data-testid="metric-dictionary">
    <p className={styles.small} style={{ overflowWrap: "anywhere" }}>
      Dictionary {data.definitionVersion} · effective {data.effectiveAt} · {data.formulaVersion} · {data.allocationVersion} · {data.provenance.synthetic ? "Synthetic sandbox evidence" : "Source evidence"}.
    </p>
    <p className={styles.small}>{nativePeriod(data)}. Zero denominator shows N/A. Missing input shows Unknown.</p>
    <dl className={styles.defs}>{data.entries.map(row => {
      const definition = metricDetails[row.metricId];
      const owners = data.sources.filter(source => definition.sources.includes(source.owner));
      return <div key={row.metricId} data-testid={`definition-${row.metricId}`}>
        <dt>{definition.label}</dt>
        <dd>
          <p>{definition.formula}. {definition.basis}</p>
          <p className={styles.small}>{definition.cost}</p>
          <p className={styles.small} style={{ overflowWrap: "anywhere" }}>{owners.length ? owners.map(source =>
            `${metricSourceNames[source.owner] ?? source.owner} · ${source.coverage} · as of ${source.sourceAsOf ?? "Unknown"} · definition ${source.definitionVersion}`).join(" / ") : "Source evidence unavailable."}</p>
        </dd>
      </div>;
    })}</dl>
  </div>;
}
