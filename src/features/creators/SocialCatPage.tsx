import { SavedCreatorPlatformPage } from "./SavedCreatorPlatform";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatCompact, formatCount, formatMoney } from "@/components/MetricValue";
import { SectionTabs } from "@/components/SectionTabs";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { OWNERS, CUMULATIVE_DAYS, type Network, type SocialCatBoardData, type SocialCatDashboardData } from "@/fixtures/creators";
import { DEMO_ASSESSMENT_ID, DEMO_CREATOR_ID, DEMO_OFFER_ID } from "@/fixtures/ids";
import { boardTotal, cumulativeSeries, ownerSum, pad2, socialCatTotals, stageTotal } from "./creatorMetrics";
import { BoardContext, BoardPlatforms, Pending, StaleNotice, CollaborationLink, CommissionContext, CumulativeChart, DashboardTabs, FunnelStrip, PageTitle, QueuePanel, SourceButton } from "./creatorsShared";
import acquisition from "@/features/acquisition/Acquisition.module.css";
import styles from "./Creators.module.css";

type View = "board" | "dashboard";
const parseView = (raw: string | null): View => (raw === "board" ? "board" : "dashboard");

/** Social Cat: the current lifecycle board (6:24, view=board) and the dashboard (23:275, view=dashboard). Owner THO-294. Read work only. */
export function SocialCatPage() {
  const [search] = useSearchParams();
  const native = useScope().adapter.kind !== "demo";
  if (native) return <SavedCreatorPlatformPage key={search.get("view")} viewKey={search.get("view") === "board" ? "socialCatBoard" : "socialCatDashboard"} />;
  const view = parseView(search.get("view"));
  return view === "board" ? <Board /> : <Dashboard />;
}

/* ---------------------------------- Board ---------------------------------- */

const OWNER_OPTIONS = [{ value: "all", label: "All owners" }, ...OWNERS.map((o) => ({ value: o, label: o }))];
const LAYOUT_OPTIONS = [{ value: "board", label: "Board view" }, { value: "list", label: "List view" }];

function Board() {
  const demo = useScope().adapter.environment === "demo";
  const [search, setSearch] = useSearchParams();
  const owner = OWNER_OPTIONS.some((o) => o.value === search.get("owner")) ? (search.get("owner") as string) : "all";
  const layout = search.get("layout") === "list" ? "list" : "board";
  const query = useView<{ owner: string }, SocialCatBoardData>("socialCatBoard", { owner }, null, { keepPrevious: true });
  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(search);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };
  return (
    <section aria-labelledby="sc-board-title" data-figma-source="6:24" className={acquisition.page}>
      <PageTitle id="sc-board-title" title="Creators, from hello to impact." subtitle="Social Cat collaborations · live records in Notion · browser execution target">
        <SourceButton label="Open Notion" title="Open Notion" width={172} />
        <LinkButton to="/creators/social-cat?view=board" aria-current="page" style={{ minWidth: 166 }}>Review queue</LinkButton>
      </PageTitle>
      <BoardPlatforms current="Social Cat">
        <Badge tone="warning" width={246}>Browser access: to validate</Badge>
        {demo && <span className={acquisition.small}>Demo data</span>}
      </BoardPlatforms>
      <BoardContext />
      <Pending query={query} subject="the Social Cat lifecycle">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? <BoardBody res={query.data as ReadResponse<SocialCatBoardData>} data={query.data.data} owner={owner} layout={layout} onOwner={(v) => setParam("owner", v, "all")} onLayout={(v) => setParam("layout", v, "board")} /> : <EmptyState state="Empty" title="No collaborations match"><p>The source responded, but no collaboration matches this owner.</p></EmptyState>)}
      </Pending>
      {demo && query.data && <p className={styles.footnote}>Illustrative creator handles and counts · stage changes remain tied to source records and verified actions.</p>}
    </section>
  );
}

function BoardBody({ res, data, owner, layout, onOwner, onLayout }: { res: ReadResponse<SocialCatBoardData>; data: SocialCatBoardData; owner: string; layout: string; onOwner: (v: string) => void; onLayout: (v: string) => void }) {
  const total = boardTotal(data);
  const ownerLabel = owner === "all" ? null : owner;
  return (
    <>
      <StaleNotice res={res} />
      <KpiRow align="start">
        <Kpi label="Active collaborations" context={`Across five lifecycle stages${ownerLabel ? ` · ${ownerLabel}` : ""}`} testId="metric-Active collaborations">{total}</Kpi>
        <Kpi label="Needs your decision" context="Every outbound action awaits approval" testId="metric-Needs your decision">{pad2(ownerSum(data.needsDecision))}</Kpi>
        <Kpi label="Content ready" context="Rights checked before use" testId="metric-Content ready">{pad2(ownerSum(data.contentReady))}</Kpi>
        <Kpi label="Cost per live video" context="N/A with zero live posts · costs may be incomplete" testId="metric-Cost per live video">N/A</Kpi>
      </KpiRow>
      <div className={`${styles.sectionRow} ${styles.top}`}>
        <h2 className={acquisition.h2} style={{ margin: 0 }}>Social Cat lifecycle</h2>
        <span className={styles.spacer} style={{ "--spacer": "590px" } as React.CSSProperties} aria-hidden="true" />
        <FilterButton name="Owner" title="Choose an owner" options={OWNER_OPTIONS} value={owner} onChange={onOwner} width={136} bare />
        <FilterButton name="Layout" title="Choose the board layout" options={LAYOUT_OPTIONS} value={layout} onChange={onLayout} width={146} bare />
      </div>
      {ownerLabel && <p className={acquisition.small} role="status">Showing {ownerLabel}'s collaborations: {total} in this view. Stage counts follow the owner; the demo lists up to two sample records per stage.</p>}
      {layout === "list" ? <BoardList data={data} /> : (
        <ol className={styles.board} data-testid="lifecycle-board">
          {data.stages.map((stage, i) => (
            <li key={stage.key} className={styles.stage} data-testid={`stage-${stage.key}`}>
              <div className={styles.stageHead}>
                <span className={styles.stageNo}>{pad2(i + 1)}</span>
                <h3 className={styles.stageTitle}>{stage.title}</h3>
                <Badge width={42} testId={`count-${stage.key}`}>{pad2(stageTotal(stage))}</Badge>
              </div>
              <p className={acquisition.small}>{stage.note}</p>
              {stage.cards.length === 0 ? <p className={styles.empty}>No sample records.</p> : (
                <ul className={styles.cards}>
                  {stage.cards.map((c) => (
                    <li key={c.id} className={styles.card}>
                      <p className={styles.cardName}>{c.handle}</p>
                      <p className={acquisition.small}>{c.detail}</p>
                      <Badge tone={c.status.tone} width={182}>{c.status.label}</Badge>
                      <span className={styles.rule} />
                      <p className={acquisition.small}>{c.note}</p>
                      <CollaborationLink id="demo-collaboration-1" />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.pairWide}>
        <section className={`${styles.panel} ${styles.panelViolet}`} aria-labelledby="agent-title">
          <h2 id="agent-title" className={acquisition.h2}>The browser agent works inside Social Cat.</h2>
          <p style={{ margin: 0 }}>Zapier creates and tracks the task. A person approves the exact action in Slack. The browser agent opens the matching collaboration, executes it, and saves a source receipt.</p>
          <div className={styles.flow}>
            <Badge width={130}>Draft action</Badge><span aria-hidden="true">→</span>
            <Badge tone="warning" width={142}>Slack approval</Badge><span aria-hidden="true">→</span>
            <Badge tone="violet" width={164}>Browser execution</Badge><span aria-hidden="true">→</span>
            <Badge tone="success" width={142}>Receipt + sync</Badge>
          </div>
          <p className={acquisition.small}>Proposed target · access and platform capability must be validated. Manual handoff remains available.</p>
        </section>
        <section className={styles.panel} aria-labelledby="moving-title">
          <h2 id="moving-title" className={acquisition.h2}>Keep work moving.</h2>
          <dl className={`${styles.details} ${styles.detailsLoose}`}>
            <div><dt>Next decision</dt><dd>{data.nextDecision.handle} · {data.nextDecision.subject}</dd></div>
            <div><dt>Source record</dt><dd>Notion · COL-SC-042</dd></div>
            <div><dt>Execution access</dt><dd>Not validated</dd></div>
          </dl>
          <LinkButton to={`/approvals/${data.nextDecision.approvalId}`} style={{ width: "100%" }}>Open approval detail</LinkButton>
        </section>
      </div>
    </>
  );
}

function BoardList({ data }: { data: SocialCatBoardData }) {
  const rows = data.stages.flatMap((s) => s.cards.map((c) => [c.handle, s.title, c.status.label, c.note, c.owner]));
  return <DataTable caption="Sample collaborations by stage" columns={[{ label: "Creator" }, { label: "Stage" }, { label: "Status" }, { label: "Next step" }, { label: "Owner" }]} rows={rows} variant="list" testId="lifecycle-list" minWidth={720} />;
}

/* -------------------------------- Dashboard -------------------------------- */

const NETWORK_BUTTONS: { value: "all" | Network; label: string; width: number }[] = [
  { value: "all", label: "All publishing networks", width: 224 },
  { value: "instagram", label: "Instagram", width: 112 },
  { value: "tiktok", label: "TikTok", width: 100 },
];

function Dashboard() {
  const [search, setSearch] = useSearchParams();
  const raw = search.get("network");
  const network = raw === "instagram" || raw === "tiktok" ? raw : "all";
  const query = useView<{ network: string }, SocialCatDashboardData>("socialCatDashboard", { network }, null, { keepPrevious: true });
  const choose = (value: string) => {
    const next = new URLSearchParams(search);
    if (value === "all") next.delete("network");
    else next.set("network", value);
    setSearch(next);
  };
  return (
    <section aria-labelledby="sc-dash-title" data-figma-source="23:275" className={acquisition.page}>
      <PageTitle id="sc-dash-title" title="Social Cat" subtitle="From the first application to content you can actually use.">
        <SourceButton label="Open Social Cat" title="Open Social Cat" width={172} />
        <LinkButton to="/creators/social-cat/recruitment" style={{ minWidth: 166, paddingInline: 8 }}>Review applications</LinkButton>
      </PageTitle>
      <DashboardTabs current="Social Cat" />
      <CommissionContext />
      <Pending query={query} subject="the Social Cat dashboard">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? <DashboardBody res={query.data as ReadResponse<SocialCatDashboardData>} data={query.data.data} network={network} onNetwork={choose} /> : <EmptyState state="Empty" title="No Social Cat data yet"><p>The source responded, but this cohort has no posts or orders.</p></EmptyState>)}
      </Pending>
    </section>
  );
}

const usd = formatMoney;

function DashboardBody({ res, data, network, onNetwork }: { res: ReadResponse<SocialCatDashboardData>; data: SocialCatDashboardData; network: string; onNetwork: (v: string) => void }) {
  const t = socialCatTotals(data);
  const all = socialCatTotals({ ...data, network: "all" });
  const series = cumulativeSeries(t.views ?? 0);
  const delivered = data.samples.delivered;
  const { pilot } = data;
  const netCommission = { minorUnits: pilot.grossCommission.minorUnits - pilot.reversedCommission.minorUnits, currency: "USD" };
  return (
    <>
      <StaleNotice res={res} />
      <div className={styles.row}>
        <Badge tone="violet" width={246}>{data.cohort.label} · {data.cohort.creators} creators</Badge>
        <span className={acquisition.small}>Linked Instagram + TikTok posts / creator insights</span>
        <span className={styles.spacer} style={{ "--spacer": "290px" } as React.CSSProperties} aria-hidden="true" />
        <Badge tone="warning" width={220}>{t.measurable} of {t.posts} posts measurable</Badge>
      </div>
      <div className={styles.row}>
        <div className={`${styles.row} ${styles.network}`} role="group" aria-label="Publishing network">
          {NETWORK_BUTTONS.map((b) => (
            <Button key={b.value} variant="secondary" aria-pressed={network === b.value} style={{ width: b.width, minWidth: 0, paddingInline: 8 }} onClick={() => onNetwork(b.value)}>{b.label}</Button>
          ))}
        </div>
        <Badge width={168}>Website destination</Badge>
        <span className={styles.spacer} style={{ "--spacer": "116px" } as React.CSSProperties} aria-hidden="true" />
        <LinkButton variant="secondary" to={`/creators/${DEMO_CREATOR_ID}/assessments/${DEMO_ASSESSMENT_ID}`} style={{ minWidth: 180 }}>SC scorecard</LinkButton>
        <LinkButton to="/creators/social-cat/recruitment" style={{ minWidth: 196 }}>Recruitment queue</LinkButton>
      </div>
      {network !== "all" && <p className={acquisition.small} role="status">Showing {network === "instagram" ? "Instagram" : "TikTok"} posts only. The chart keeps the all-network scale ({all.views === null ? "N/A" : formatCompact(all.views)}) so the two stay comparable.</p>}

      <KpiRow align="start">
        <Kpi label="Linked-post views" context={`${t.measurable} measurable posts · snapshot total`} testId="metric-Linked-post views">{t.views === null ? "N/A" : formatCompact(t.views)}</Kpi>
        <Kpi label="Engagement rate" context={t.views === null ? "No measurable post yet" : `${formatCount(t.interactions)} interactions / ${formatCount(t.views)} views`} testId="metric-Engagement rate">{t.engagementRate ?? "N/A"}</Kpi>
        <Kpi label="Attributed orders" context="Creator-attributed Shopify orders" testId="metric-Attributed orders">{t.orders}</Kpi>
        <Kpi label="Attributed net sales" context="After refunds · linked order IDs" testId="metric-Attributed net sales">{usd(t.net)}</Kpi>
      </KpiRow>

      <div className={styles.pairWide}>
        <section className={styles.panel} aria-labelledby="sc-chart-title">
          <h2 id="sc-chart-title" className={acquisition.h2}>Your creators are making an impression.</h2>
          <p className={acquisition.small}>Cumulative linked-post views · demo baseline 0 on {CUMULATIVE_DAYS[0]}</p>
          <CumulativeChart title="Cumulative linked-post views" series={series} unit="views" scaleMax={all.views ?? 90_000} />
          <p className={acquisition.small}>Social Cat does not provide these post metrics; use linked native posts or creator-shared insights.</p>
        </section>
        <QueuePanel title="Start with the next conversation." items={data.actions} buttonLabel="Open action queue" to="/creators/social-cat?view=board" note="Browser agent works inside Social Cat after the exact outbound action is approved." />
      </div>

      <section className={styles.panel} aria-labelledby="sc-queue-title">
        <div className={`${styles.sectionRow} ${styles.top}`}>
          <h2 id="sc-queue-title" className={acquisition.h2}>Keep applications turning into content.</h2>
          <span className={styles.spacer} style={{ "--spacer": "260px" } as React.CSSProperties} aria-hidden="true" />
          <span className={acquisition.small}>Operational queue · separate from {data.cohort.label}</span>
        </div>
        <ul className={styles.tiles} style={{ "--tiles": 5 } as React.CSSProperties}>
          {data.queue.map((q) => (
            <li key={q.label} className={`${styles.tile} ${styles.tileTight}`}><span className={styles.num}>{q.count}</span><span className={styles.label}>{q.label}</span></li>
          ))}
        </ul>
      </section>

      <div className={styles.pairWide}>
        <section className={styles.panel} aria-labelledby="sc-upcoming-title">
          <h2 id="sc-upcoming-title" className={styles.h3}>Upcoming operational work · separate cohort</h2>
          <DataTable caption="Upcoming operational work" columns={[{ label: "CREATOR", width: "25.5%" }, { label: "DELIVERABLE", width: "31.6%" }, { label: "STATUS", width: "28%" }, { label: "DUE" }]} rows={data.upcoming.map((u) => [u.handle, u.deliverable, u.status, u.due])} variant="list" testId="upcoming-table" minWidth={560} />
        </section>
        <section className={`${styles.panel} ${styles.panelViolet}`} aria-labelledby="sc-samples-title">
          <h2 id="sc-samples-title" className={styles.h3}>Samples, on their way.</h2>
          <p className={styles.big}>{delivered} of {data.samples.total}</p>
          <p className={acquisition.small}>Sample shipments delivered in this demo workflow cohort</p>
          <div className={styles.meter} role="img" aria-label={`${delivered} of ${data.samples.total} sample shipments delivered`}><div className={styles.meterFill} style={{ width: `${(100 * delivered) / data.samples.total}%` }} /></div>
          <dl className={`${styles.details} ${styles.detailsLoose}`}>
            <div><dt>In transit</dt><dd>{data.samples.inTransit} shipments</dd></div>
            <div><dt>Delivered</dt><dd>{delivered} shipments</dd></div>
          </dl>
          <LinkButton variant="secondary" to="/creators/social-cat?view=board" style={{ width: "100%" }}>Open creator lifecycle</LinkButton>
        </section>
      </div>

      <FunnelStrip source="social-cat" matchLabel="Native matches" matchContext="Match ≠ signed terms" subtitle="Separate synthetic Sep–Oct cohort · Social Cat intake · one opportunity per creator" />

      <section className={`${styles.panel} ${styles.panelWide}`} aria-labelledby="sc-pilot-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="sc-pilot-title" className={acquisition.h2}>Affiliate pilot · a separate cohort.</h2>
          <p className={acquisition.small}>Synthetic cohort B · never add these values to the 30-day Launch A performance above.</p>
        </div>
        <KpiRow align="start">
          <Kpi label="Net eligible sales" context={`External provider basis · after ${usd(pilot.refunds)} refunds`} testId="metric-Net eligible sales">{usd(pilot.netEligibleSales)}</Kpi>
          <Kpi label="Net accrued commission" context={`${usd(pilot.grossCommission)} gross less ${usd(pilot.reversedCommission)} reversed`} testId="metric-Net accrued commission">{usd(netCommission)}</Kpi>
          <Kpi label="Cash commission paid" context="Provider settlement; not another expense" testId="metric-Cash commission paid">{usd(pilot.cashCommissionPaid)}</Kpi>
          <Kpi label="Estimated contribution" context="Fee estimate included · before shared overhead" testId="metric-Estimated contribution">{formatMoney({ ...pilot.estimatedContribution })}</Kpi>
        </KpiRow>
        <SectionTabs label="Offer type" gap={8} tabs={[
          { label: "Gifted · history", to: "#", width: 165, disabled: true, reasonId: "history-reason" },
          { label: "Paid · history", to: "#", width: 165, disabled: true, reasonId: "history-reason" },
          { label: "Affiliate", to: "#", width: 100, current: true },
          { label: "Hybrid · history", to: "#", width: 165, disabled: true, reasonId: "history-reason" },
        ]} />
        <p className={acquisition.small}>
          <span data-testid="channel-route">
            <span data-field="acquisition-source">Source: Social Cat</span> · <span data-field="publishing-network">Publishing: Instagram + TikTok</span> · <span data-field="checkout">Checkout: Shopify website</span> · <span data-field="payout-owner">Payout: Collabs provider (illustrative)</span>.
          </span>{" "}
          <span data-testid="route-note">A TikTok post is not a TikTok Shop order.</span>{" "}
          <span id="history-reason">Read-only. Past fees payable. New offers commission-only.</span>
        </p>
        <div className={styles.contextActions} style={{ gap: 16 }}>
          <LinkButton to={`/offers/${DEMO_OFFER_ID}`} style={{ minWidth: 204 }}>Configure offer</LinkButton>
          <LinkButton variant="secondary" to="/analytics/customer-journey" style={{ minWidth: 218 }}>Website commerce</LinkButton>
          <LinkButton variant="secondary" to="/finance/commissions" style={{ minWidth: 218 }}>Commission ledger</LinkButton>
          <LinkButton variant="ghost" to="/settings/capabilities" style={{ minWidth: 190 }}>Channel access</LinkButton>
        </div>
      </section>
    </>
  );
}
