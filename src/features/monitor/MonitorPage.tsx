import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { MonitorFilters } from "@/adapter/demoMonitor";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { SearchField } from "@/components/Search";
import { SectionTabs } from "@/components/SectionTabs";
import { Card, ChoiceButton, HandoffDialog, KpiCard, KpiGrid, SectionHeading, Table, ViewShell, usd } from "@/features/analytics/parts";
import { DEMO_RUN_HOURLY_ID, type ContentMonitorData } from "@/fixtures/monitor";
import { count, curvePoints, engagement, interactionsOf, ratePct, sumKnown, thousands } from "./monitorMath";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";

const SOURCES = [{ value: "all", label: "All creator sources" }, { value: "tiktok-affiliate", label: "TikTok affiliate" }, { value: "social-cat", label: "Social Cat" }];
const NETWORKS = [{ value: "all", label: "All post networks" }, { value: "tiktok", label: "TikTok" }, { value: "instagram", label: "Instagram" }];
const WINDOWS = [{ value: "last-30", label: "Last 30 days" }, { value: "last-7", label: "Last 7 days" }];
const allowed = (options: { value: string }[], raw: string | null, fallback: string) => (options.some((o) => o.value === raw) ? (raw as string) : fallback);
const NETWORK_LABEL = { tiktok: "TikTok", instagram: "Instagram" } as const;

/** Content monitor (Figma source 23:73, owner THO-299, CTRL-048 to CTRL-051, CTRL-222). Read-only: no monitor result authorizes outbound. */
export function MonitorPage() {
  const [search, setSearch] = useSearchParams();
  const filters: MonitorFilters = {
    source: allowed(SOURCES, search.get("source"), "all") as MonitorFilters["source"],
    network: allowed(NETWORKS, search.get("network"), "all") as MonitorFilters["network"],
    window: allowed(WINDOWS, search.get("window"), "last-30") as MonitorFilters["window"],
    q: (search.get("q") ?? "").slice(0, 80),
  };
  const query = useView<MonitorFilters, ContentMonitorData>("contentMonitor", filters, null, { keepPrevious: true });
  const set = (key: string, value: string, fallback = "all", replace = false) =>
    setSearch((prev) => { const next = new URLSearchParams(prev); if (value === fallback || value === "") next.delete(key); else next.set(key, value); return next; }, { replace });
  return (
    <section aria-labelledby="monitor-title" data-figma-source="23:73" className={a.page}>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="monitor-title">Creator content, without the blind spots.</h1>
          <p>Track published posts, creator replies, and measurable results from one watchlist.</p>
        </div>
        <LinkButton variant="secondary" to="/creators/watchlist" style={{ minWidth: 172 }}>Open watchlist</LinkButton>
        <LinkButton to={`/runs/${DEMO_RUN_HOURLY_ID}`} style={{ minWidth: 166 }}>View hourly runs</LinkButton>
      </div>
      <div className={m.tabsRow}>
        <SectionTabs label="Creator workspace" tabs={[
          { label: "Social Cat", to: "/creators/social-cat?view=dashboard", width: 164 },
          { label: "TikTok Shop", to: "/creators/tiktok?view=dashboard", width: 164 },
          { label: "Content monitor", to: "/content", width: 164, current: true },
          { label: "Watchlist", to: "/creators/watchlist", width: 164 },
        ]} />
        <span style={{ flex: "0 1 110px" }} />
        <Badge tone="warning" width={264}>Demo · hourly plan not live</Badge>
      </div>
      <section className={a.notice} style={{ background: "var(--color-violetSoft)", border: "1px solid var(--color-border)" }} aria-label="Current acquisition policy">
        <p className={a.label}>Hourly monitoring · enrolled creators</p>
        <p className={a.small}>Monitor posted content and inbox changes hourly when authorized. New-creator discovery and lifestyle evidence review are separate daily workflows.</p>
        <div className={a.actions} style={{ gap: 10 }}>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 209 }}>Full acquisition funnel</LinkButton>
        </div>
      </section>
      <div className={m.filtersRow}>
        <Badge tone="violet" width={256}>Launch cohort A · 12 creators</Badge>
        <ChoiceButton legend="Creator source" title="Filter by creator source" options={SOURCES} value={filters.source} onChange={(v) => set("source", v)} width={192} buttonLabel={(c) => c.label} />
        <ChoiceButton legend="Post network" title="Filter by post network" options={NETWORKS} value={filters.network} onChange={(v) => set("network", v)} width={184} buttonLabel={(c) => c.label} />
        <ChoiceButton legend="Observation window" title="Choose an observation window" options={WINDOWS} value={filters.window} onChange={(v) => set("window", v, "last-30")} width={156} buttonLabel={(c) => c.label} />
        <span style={{ flex: "0 1 160px" }} />
        <p className={a.small}>Snapshot · 29 Oct</p>
      </div>
      <ViewShell query={query} subject="The content monitor" emptyTitle="No monitored content yet" emptyBody="The source responded, but no posts are monitored for this cohort. That is not zero views.">
        {(data) => <Body data={data} filters={filters} setQ={(v) => set("q", v, "", true)} clear={() => setSearch({})} />}
      </ViewShell>
    </section>
  );
}

function Body({ data, filters, setQ, clear }: { data: ContentMonitorData; filters: MonitorFilters; setQ: (v: string) => void; clear: () => void }) {
  const [dialog, setDialog] = useState<"coverage" | null>(null);
  const posts = data.posts;
  const views = sumKnown(posts, (p) => p.views);
  const eng = engagement(posts);
  const filtered = filters.source !== "all" || filters.network !== "all" || filters.q !== "";
  const noCounts = !data.windowAvailable;
  const { max, pts } = curvePoints(data.curve.thousands, 732, 204);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
  const total = data.curve.thousands.at(-1) ?? 0;
  const ticks = [max, (max * 2) / 3, max / 3, 0];
  const unavailableReason = noCounts ? "No snapshot for this window" : "A post is missing counts";
  return (
    <>
      {noCounts && <p className={m.status} role="status">No snapshots were taken for {data.windowLabel.toLowerCase()}, so its counts are unknown, not zero.</p>}
      {filtered && !noCounts && <p className={m.status} role="status">Showing {posts.length} of {data.postTotal} posts · {data.windowLabel}. Totals below cover only these posts. <button type="button" className={m.linkBtn} style={{ textDecoration: "underline", color: "var(--color-violet)" }} onClick={clear}>Clear filters</button></p>}
      <KpiGrid>
        <KpiCard label="Cumulative views" context={views === null ? unavailableReason : `${posts.length} measurable posts · snapshot total`} testId="metric-views">{views === null ? "N/A" : thousands(views)}</KpiCard>
        <KpiCard label="Engagement rate" context={eng ? `${count(eng.interactions)} interactions / ${count(eng.views)} views` : unavailableReason} testId="metric-engagement">{eng ? `${eng.ratePct.toFixed(1)}%` : "N/A"}</KpiCard>
        <KpiCard label="Attributed orders" context="Deduplicated creator-attributed orders" testId="metric-orders">{data.attributedOrders === null ? "N/A" : count(data.attributedOrders)}</KpiCard>
        <KpiCard label="Attributed net sales" context="Reconciled orders after refunds" testId="metric-net-sales">{data.attributedNetSales === null ? "N/A" : usd(data.attributedNetSales)}</KpiCard>
      </KpiGrid>
      <div className={a.split} style={{ gridTemplateColumns: "832fr 444fr", gap: 20 }}>
        <Card labelledBy="views-title">
          <div className={m.headRow}>
            <h2 id="views-title">Content finding its audience.</h2>
            <span style={{ flex: "0 1 160px" }} />
            <Badge tone="violet" width={126}>{total}k views</Badge>
          </div>
          <p className={a.small}>Cumulative views · demo baseline 0 on {data.curve.startDate}</p>
          <div className={m.curveWrap} role="region" tabIndex={0} aria-label="Cumulative views chart">
            <div className={m.curve} role="img" aria-label={`Cumulative views grew from ${data.curve.thousands[0]}k on ${data.curve.labels[0]} to ${total}k on ${data.curve.labels.at(-1)}.`}>
              {ticks.map((t, i) => (
                <span key={i}>
                  <span style={{ left: 0, top: 8 + i * 68 }}>{t}k</span>
                  <span style={{ left: 44, top: 16 + i * 68, width: 732, height: 1, background: "var(--color-border)" }} />
                </span>
              ))}
              <svg width="784" height="252" viewBox="0 0 784 252" fill="none" aria-hidden="true">
                <g transform="translate(44 16)">
                  <path d={`${line} L 732 204 L 0 204 Z`} fill="var(--color-violetSoft)" />
                  <path d={line} stroke="var(--color-violet)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                </g>
                <circle cx="776" cy="16" r="5" fill="var(--color-violet)" />
              </svg>
              {data.curve.labels.map((l, i) => {
                const last = i === data.curve.labels.length - 1;
                const idx = i === 0 ? 0 : last ? data.curve.thousands.length - 1 : i * 4;
                return <span key={l} style={{ top: 234, ...(last ? { right: 784 - 770 } : { left: 44 + (idx * 732) / (data.curve.thousands.length - 1) }) }}>{l}</span>;
              })}
            </div>
          </div>
          <p className={a.small}>Post snapshots, not unique reach · missing metrics remain N/A</p>
        </Card>
        <section className={m.coverage} aria-labelledby="coverage-title">
          <h2 id="coverage-title">Keep every creator in view.</h2>
          <p className={m.coverageText}>Sheets owns the watchlist. Notion owns collaborations and approvals.</p>
          <div className={m.numbers}>
            <div><strong>{data.coverage.cohortCreators}</strong><span>Cohort creators</span></div>
            <div><strong>{data.coverage.verifiedPosts}</strong><span>Verified posts</span></div>
            <div><strong>{data.coverage.measurable} / {data.coverage.verifiedPosts}</strong><span>Measurable</span></div>
          </div>
          <div className={m.darkTrack} aria-hidden="true"><span className={m.darkFill} style={{ width: `${(100 * data.coverage.measurable) / data.coverage.verifiedPosts}%` }} /></div>
          <p className={m.darkSmall}>Hourly browser reads are planned; access still needs validation.</p>
          <div><Badge tone="warning" width={252}>{data.coverage.unavailable} posts · metrics unavailable</Badge></div>
          <Button variant="secondary" style={{ width: "100%" }} aria-haspopup="dialog" onClick={() => setDialog("coverage")}>Inspect coverage</Button>
        </section>
      </div>
      <Card labelledBy="posts-title">
        <div className={m.headRow} style={{ alignItems: "flex-start" }}>
          <h2 id="posts-title">Posts worth paying attention to.</h2>
          <span style={{ flex: "0 1 300px" }} />
          <SearchField label="Search handle or post" value={filters.q} onChange={setQ} fluid />
        </div>
        {posts.length === 0 ? (
          <p className={a.label} role="status">{filters.q ? `No posts match “${filters.q}”.` : "No posts match these filters."} That isn't zero posts; the unfiltered set has {data.postTotal}.</p>
        ) : (
          <Table
            caption="Creator post performance"
            columns={[{ label: "CREATOR / POST", width: 260 }, { label: "NETWORK", width: 160 }, { label: "VIEWS", width: 150 }, { label: "ENGAGEMENT", width: 180 }, { label: "ORDERS", width: 140 }, { label: "NET SALES", width: 150 }, { label: "LAST CHECK", width: 208 }]}
            rows={posts.map((p) => {
              const i = interactionsOf(p.interactions);
              return {
                key: p.postId,
                cells: [
                  <Link key="l" className={m.rowLink} to={`/content/${p.postId}`}>{p.handle} · {p.postId}</Link>,
                  NETWORK_LABEL[p.network],
                  p.views === null ? "N/A" : count(p.views),
                  i === null || p.views === null ? "N/A" : ratePct(i, p.views),
                  p.orders === null ? "N/A" : count(p.orders),
                  p.netSales === null ? "N/A" : usd(p.netSales),
                  noCounts ? "No snapshot" : p.lastCheck,
                ],
              };
            })}
          />
        )}
        <p className={a.small}>Engagement = (likes + comments + shares) / views, for comparable posts only. Creator source and post network are separate fields.</p>
      </Card>
      <div className={a.split} style={{ gridTemplateColumns: "832fr 444fr", gap: 20 }}>
        <Card labelledBy="signals-title">
          <SectionHeading id="signals-title" level={3} title="New posts. New replies. A clear next step." />
          <div className={m.signals}>
            {data.signals.map((s) => (
              <div key={s.handle} className={m.signal}>
                <span className={m.avatar} aria-hidden="true">{s.initial}</span>
                <div className={m.signalCopy}><p className={a.label}>{s.handle}</p><p className={a.small}>{s.text}</p><Badge tone={s.tone} width={184} to={s.to}>{s.badge}</Badge></div>
              </div>
            ))}
          </div>
        </Card>
        <section className={m.subtle} aria-labelledby="availability-title">
          <SectionHeading id="availability-title" level={3} title="Know where a number comes from." />
          <p className={a.small}>Social Cat: inbox and collaboration status. Views and engagement: linked posts or creator insights. Net sales: reconciled order records.</p>
          <p style={{ font: "var(--text-small)", color: "var(--color-violet)" }}>Read-only checks · replies stay in the approval queue</p>
        </section>
      </div>
      <HandoffDialog open={dialog === "coverage"} onClose={() => setDialog(null)} title="Monitoring coverage"
        rows={[
          { label: "Cohort creators", value: String(data.coverage.cohortCreators) },
          { label: "Verified posts", value: String(data.coverage.verifiedPosts) },
          { label: "Measurable", value: `${data.coverage.measurable} of ${data.coverage.verifiedPosts}` },
          { label: "Metrics unavailable", value: `${data.coverage.unavailable} posts, kept as N/A, not zero` },
          { label: "Reads", value: "Hourly browser reads are planned; access still needs validation" },
        ]}>
        <p>Coverage is a read-only disclosure. It starts no check and enrolls no one.</p>
      </HandoffDialog>
    </>
  );
}
