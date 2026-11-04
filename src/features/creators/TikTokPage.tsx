import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatCompact, formatCount, formatMoney } from "@/components/MetricValue";
import type { TikTokBoardData, TikTokDashboardData } from "@/fixtures/creators";
import { DEMO_ASSESSMENT_ID, DEMO_BATCH_ID, DEMO_CREATOR_ID, DEMO_SETTLEMENT_ID } from "@/fixtures/ids";
import { cumulativeSeries, pad2, rate } from "./creatorMetrics";
import { BoardContext, BoardPlatforms, CommissionContext, CumulativeChart, DashboardTabs, FunnelStrip, PageTitle, Pending, QueuePanel, SourceButton, StaleNotice } from "./creatorsShared";
import acquisition from "@/features/acquisition/Acquisition.module.css";
import styles from "./Creators.module.css";

/** TikTok Shop: the current funnel board (9:143, view=board) and the dashboard (23:440, view=dashboard). Owner THO-294. Read work only. */
export function TikTokPage() {
  const [search] = useSearchParams();
  return search.get("view") === "board" ? <Board /> : <Dashboard />;
}

/* ---------------------------------- Board ---------------------------------- */

function Board() {
  const [search, setSearch] = useSearchParams();
  const q = search.get("q") ?? "";
  const query = useView<{ q: string }, TikTokBoardData>("tiktokBoard", { q }, null, { keepPrevious: true });
  const setQuery = (value: string) => {
    const next = new URLSearchParams(search);
    if (value) next.set("q", value);
    else next.delete("q");
    setSearch(next, { replace: true });
  };
  return (
    <section aria-labelledby="tt-board-title" data-figma-source="9:143" className={acquisition.page}>
      <PageTitle id="tt-board-title" title="TikTok Shop, built on relationships." subtitle="Creator funnel · every outbound action is approved in Slack before execution.">
        <SourceButton label="Open source" title="Open the TikTok source" width={172} />
        <LinkButton to="/approvals" style={{ minWidth: 166 }}>Review proposals</LinkButton>
      </PageTitle>
      <BoardPlatforms current="TikTok Shop">
        <Badge tone="violet" width={246}>Approved API route preferred</Badge>
        <span className={acquisition.small}>Demo data</span>
      </BoardPlatforms>
      <BoardContext />
      <Pending query={query} subject="the TikTok funnel">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? <BoardBody res={query.data as ReadResponse<TikTokBoardData>} data={query.data.data} q={q} onQuery={setQuery} /> : <EmptyState state="Empty" title="No TikTok creators yet"><p>The source responded, but no creator is in this funnel.</p></EmptyState>)}
      </Pending>
      <p className={styles.footnote}>Illustrative funnel · canonical stages from the creator-agent specification. Extended terminal states are proposed product coverage.</p>
    </section>
  );
}

function BoardBody({ res, data, q, onQuery }: { res: ReadResponse<TikTokBoardData>; data: TikTokBoardData; q: string; onQuery: (v: string) => void }) {
  const total = data.stages.reduce((a, s) => a + s.count, 0);
  const posts = data.stages.filter((s) => data.postsPublishedStages.includes(s.key)).reduce((a, s) => a + s.count, 0);
  return (
    <>
      <StaleNotice res={res} />
      <KpiRow align="start">
        <Kpi label="Creators in funnel" context="Sample records across active stages" testId="metric-Creators in funnel">{total}</Kpi>
        <Kpi label="Awaiting approval" context="Pitch · follow-up · sample proposals" testId="metric-Awaiting approval">{pad2(data.awaitingApproval)}</Kpi>
        <Kpi label="Posts published" context="Posted + first-sale stages in this cohort" testId="metric-Posts published">{pad2(posts)}</Kpi>
        <Kpi label="Attributed sales" context="Requires verified order attribution" testId="metric-Attributed sales">N/A</Kpi>
      </KpiRow>
      <section className={`${styles.panel} ${styles.panelWide}`} aria-labelledby="tt-funnel-title">
        <h2 id="tt-funnel-title" className={acquisition.h2}>From discovery to first sale</h2>
        <p className={styles.lead}>One relationship, with explicit handoffs and evidence at each stage.</p>
        <ol className={`${styles.tiles} ${styles.top}`} style={{ "--tiles": data.stages.length } as React.CSSProperties} data-testid="tiktok-stages">
          {data.stages.map((s) => (
            <li key={s.key} className={styles.tile}><span className={styles.num}>{pad2(s.count)}</span><span className={styles.label}>{s.label}</span></li>
          ))}
        </ol>
      </section>
      <section className={styles.panel} aria-labelledby="tt-worklist-title">
        <div className={`${styles.sectionRow} ${styles.top}`}>
          <h2 id="tt-worklist-title" className={acquisition.h2}>Creator worklist</h2>
          <span className={styles.spacer} style={{ "--spacer": "490px" } as React.CSSProperties} aria-hidden="true" />
          <input className={styles.search} type="search" aria-label="Search TikTok creators" placeholder="Search TikTok creators" value={q} onChange={(e) => onQuery(e.target.value)} />
        </div>
        {data.rows.length === 0 ? (
          <p className={acquisition.small} role="status">No creator matches “{q}”. Clear the search to see the full worklist.</p>
        ) : (
          <DataTable caption="Creator worklist" columns={[{ label: "CREATOR", width: "16.8%" }, { label: "STAGE", width: "15.2%" }, { label: "NEXT ACTION", width: "32.9%" }, { label: "DUE / REVIEW", width: "21.6%" }, { label: "OWNER" }]} rows={data.rows.map((r) => [r.handle, r.stage, r.next, r.due, r.owner])} variant="list" testId="worklist" minWidth={720} />
        )}
        {q && data.rows.length > 0 && <p className={acquisition.small} role="status">{data.rows.length} of 5 sample records match “{q}”.</p>}
      </section>
      <div className={styles.pairEven}>
        <section className={`${styles.panel} ${styles.panelSubtle}`} aria-labelledby="tt-agreement-title">
          <h2 id="tt-agreement-title" className={acquisition.h2}>Follow the agreement.</h2>
          <dl className={`${styles.details} ${styles.detailsWide} ${styles.detailsLoose}`}>
            <div><dt>Paid / agreed post</dt><dd>Due − 2 check-in</dd></div>
            <div><dt>No-post review</dt><dd>Posting due + grace</dd></div>
            <div><dt>Voluntary gift</dt><dd>Observation due only</dd></div>
          </dl>
          <p className={acquisition.small}>Published content ends no-post reminders. Voluntary gifts have no contractual posting obligation.</p>
        </section>
        <section className={`${styles.panel} ${styles.panelDark}`} aria-labelledby="tt-boundary-title">
          <h2 id="tt-boundary-title" className={acquisition.h2} style={{ color: "var(--color-onDark)" }}>Approval comes before action.</h2>
          <p>Zapier tracks the work. Use an approved TikTok integration where available; browser tasks require validated access and capability.</p>
          <Badge tone="violet" width={220}>Source receipt required</Badge>
          <p className={acquisition.small}>Declined, opt-out, canceled and completed outcomes stop active outreach. Start a new collaboration only after eligibility is reviewed.</p>
        </section>
      </div>
    </>
  );
}

/* -------------------------------- Dashboard -------------------------------- */

function Dashboard() {
  const query = useView<Record<string, never>, TikTokDashboardData>("tiktokDashboard", {});
  return (
    <section aria-labelledby="tt-dash-title" data-figma-source="23:440" className={acquisition.page}>
      <PageTitle id="tt-dash-title" title="TikTok Shop" subtitle="Grow the affiliate program. See the posts and sales behind it.">
        <SourceButton label="Open TikTok Shop" title="Open TikTok Shop" width={172} />
        <LinkButton to="/creators/tiktok?view=board" style={{ minWidth: 166, paddingInline: 8 }}>Review affiliate queue</LinkButton>
      </PageTitle>
      <DashboardTabs current="TikTok Shop" />
      <CommissionContext />
      <Pending query={query} subject="the TikTok Shop dashboard">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? <DashboardBody res={query.data as ReadResponse<TikTokDashboardData>} data={query.data.data} /> : <EmptyState state="Empty" title="No TikTok Shop data yet"><p>The source responded, but this cohort has no posts or orders.</p></EmptyState>)}
      </Pending>
    </section>
  );
}

function DashboardBody({ res, data }: { res: ReadResponse<TikTokDashboardData>; data: TikTokDashboardData }) {
  const { cohort } = data;
  const measurable = cohort.measurablePosts > 0;
  const share = (100 * data.orders) / data.shopOrders;
  return (
    <>
      <StaleNotice res={res} />
      <div className={styles.row}>
        <Badge tone="violet" width={246}>{cohort.label} · {cohort.creators} creators</Badge>
        <span className={acquisition.small}>TikTok posts + reconciled shop orders</span>
        <span className={styles.spacer} style={{ "--spacer": "300px" } as React.CSSProperties} aria-hidden="true" />
        <Badge tone="warning" width={220}>{cohort.measurablePosts} of {cohort.posts} posts measurable</Badge>
      </div>
      <div className={styles.row}>
        <Badge tone="violet" width={232}>Source: Affiliate Center</Badge>
        <Badge width={180}>Publishing: TikTok</Badge>
        <Badge tone="warning" width={250}>Shop eligibility: to validate</Badge>
        <span className={styles.spacer} style={{ "--spacer": "170px" } as React.CSSProperties} aria-hidden="true" />
        <LinkButton variant="secondary" to={`/creators/${DEMO_CREATOR_ID}/assessments/${DEMO_ASSESSMENT_ID}?model=tt`} style={{ minWidth: 172 }}>TT scorecard</LinkButton>
        <LinkButton to="/creators/tiktok/invitations/new" style={{ minWidth: 204 }}>Prepare invitation</LinkButton>
      </div>
      <KpiRow align="start">
        <Kpi label="Post views" context={`${cohort.measurablePosts} measurable posts · snapshot total`} testId="metric-Post views">{measurable ? formatCompact(data.views) : "N/A"}</Kpi>
        <Kpi label="Engagement rate" context={measurable ? `${formatCount(data.interactions)} interactions / ${formatCount(data.views)} views` : "No measurable post yet"} testId="metric-Engagement rate">{measurable ? (rate(data.interactions, data.views, 1) ?? "N/A") : "N/A"}</Kpi>
        <Kpi label="Attributed orders" context="Deduplicated TikTok Shop orders" testId="metric-Attributed orders">{data.orders}</Kpi>
        <Kpi label="Attributed net sales" context="Reconciled after refunds · not GMV" testId="metric-Attributed net sales">{formatMoney(data.net)}</Kpi>
      </KpiRow>
      <div className={styles.pairWide}>
        <section className={styles.panel} aria-labelledby="tt-chart-title">
          <h2 id="tt-chart-title" className={acquisition.h2}>Attention that turns into action.</h2>
          <p className={acquisition.small}>Cumulative post views · demo baseline 0 on Oct 16</p>
          <CumulativeChart title="Cumulative post views" series={cumulativeSeries(data.views)} unit="views" scaleMax={data.views} />
          <p className={acquisition.small}>Attributed orders are joined by approved code, URL, and platform references without double counting.</p>
        </section>
        <QueuePanel title="Move the right creators forward." items={data.actions} buttonLabel="Open affiliate queue" to="/creators/tiktok?view=board" note="Use an approved integration where available; browser access remains to validate." />
      </div>
      <section className={styles.panel} aria-labelledby="tt-watch-title">
        <div className={`${styles.sectionRow} ${styles.top}`}>
          <h2 id="tt-watch-title" className={acquisition.h2}>A clear path into the program.</h2>
          <span className={styles.spacer} style={{ "--spacer": "360px" } as React.CSSProperties} aria-hidden="true" />
          <span className={acquisition.small}>{data.watchlist.reduce((a, w) => a + w.count, 0)} watchlist profiles · demo</span>
        </div>
        <ul className={styles.tiles} style={{ "--tiles": 5 } as React.CSSProperties}>
          {data.watchlist.map((w) => <li key={w.label} className={`${styles.tile} ${styles.tileTight}`}><span className={styles.num}>{w.count}</span><span className={styles.label}>{w.label}</span></li>)}
        </ul>
      </section>
      <div className={styles.pairWide}>
        <section className={styles.panel} aria-labelledby="tt-posts-title">
          <h2 id="tt-posts-title" className={styles.h3}>The posts driving this cohort.</h2>
          <DataTable caption="Posts driving this cohort" columns={[{ label: "CREATOR", width: "34.4%" }, { label: "VIEWS", width: "23%" }, { label: "ORDERS", width: "19.1%" }, { label: "NET SALES" }]} rows={data.posts.map((p) => [p.handle, formatCount(p.views), p.orders, formatMoney(p.net)])} variant="list" testId="posts-table" minWidth={560} />
        </section>
        <section className={`${styles.panel} ${styles.panelViolet}`} aria-labelledby="tt-trace-title">
          <h2 id="tt-trace-title" className={styles.h3}>Make the sales traceable.</h2>
          <p className={styles.big}>{data.orders}</p>
          <p className={acquisition.small}>Attributed orders in this measured creator cohort</p>
          <div className={styles.meter} role="img" aria-label={`${data.orders} of ${data.shopOrders} TikTok Shop orders attributed`}><div className={styles.meterFill} style={{ width: `${share}%` }} /></div>
          <p className={acquisition.small}>{Math.round(share)}% of the demo’s {data.shopOrders} TikTok Shop orders</p>
          <LinkButton variant="secondary" to="/creators/tiktok?view=board" style={{ width: "100%" }}>Open TikTok lifecycle</LinkButton>
        </section>
      </div>
      <FunnelStrip source="tiktok-shop" matchLabel="Native matches" matchContext="Preserve native acceptance" subtitle="Separate synthetic Sep–Oct cohort · TikTok Shop intake · one opportunity per creator" />
      <section className={`${styles.panel} ${styles.panelWide}`} aria-labelledby="tt-native-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="tt-native-title" className={acquisition.h2}>Native commerce, native settlement.</h2>
          <p className={acquisition.small} data-testid="channel-route">
            <span data-field="acquisition-source">Source: Affiliate Center</span> · <span data-field="publishing-network">Publishing: TikTok</span> · <span data-field="checkout">Checkout: TikTok Shop</span> · <span data-field="payout-owner">Payout: TikTok native settlement</span>. Kept apart from the monitoring above; live data is unverified.
          </p>
        </div>
        <ul className={styles.settle}>
          <li><Badge tone="violet" width={140}>Read native rates</Badge><p className={styles.settleName}>Standard / Shop Ads commission</p><p className={acquisition.small}>Capture active, proposed and effective terms; source determines the winning rate</p></li>
          <li><Badge width={140}>Provider-owned</Badge><p className={styles.settleName}>Refunds and settlement</p><p className={acquisition.small}>Reconcile native adjustments and cash; no second manual commission payment</p></li>
          <li><Badge tone="violet" width={140}>Approval-bound</Badge><p className={styles.settleName}>Finite invitation batches</p><p className={acquisition.small}>Frozen recipients, rate/payload versions, sample allocation and native capacity</p></li>
        </ul>
        <div className={styles.contextActions}>
          <LinkButton to={`/finance/settlements/${DEMO_SETTLEMENT_ID}`} style={{ minWidth: 262 }}>Native settlement & rates</LinkButton>
          <LinkButton variant="secondary" to={`/batches/${DEMO_BATCH_ID}`} style={{ minWidth: 208 }}>Bulk operations</LinkButton>
          <LinkButton variant="secondary" to="/settings/capabilities" style={{ minWidth: 190 }}>Channel access</LinkButton>
        </div>
      </section>
    </>
  );
}
