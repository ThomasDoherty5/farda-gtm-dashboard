import { useState } from "react";
import { useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Card, DetailRow, HandoffDialog, KpiCard, KpiGrid, ViewShell, usd, useIsDemo } from "@/features/analytics/parts";
import type { PostGmv, PostPerformanceData } from "@/fixtures/monitor";
import { count, deltaHeight, interactionsOf, ratePct } from "./monitorMath";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";
import type { NativePost } from "@/creator-agent/monitor/contract";
import { NativePostBody } from "./NativeMonitorViews";

/** Post performance (Figma source 25:481, owner THO-299). Preserves the original receipts and metric scope; TikTok GMV is never retained net sales. */
export function PostPage() {
  const { postId = "" } = useParams();
  const query = useView<{ postId: string }, PostPerformanceData | NativePost>("postPerformance", { postId });
  const record = query.data?.data ?? null;
  const wrongPost = record !== null && ("kind" in record ? record.post.id : record.postId) !== postId;
  return (
    <section aria-labelledby="post-title" data-figma-source="25:481" className={a.page}>
      {(!record || wrongPost) && <h1 id="post-title" style={{ font: "var(--text-h1)", margin: 0 }}>Post performance</h1>}
      {wrongPost ? <EmptyState state="Error" title="Post reference mismatch" alert>
        <p>The source returned a different post. Refresh to request the selected post again.</p>
        <Button variant="secondary" onClick={() => { void query.refetch(); }}>Refresh post</Button>
      </EmptyState> : <ViewShell query={query} subject="The post" emptyTitle="No post record" emptyBody="The source responded, but there is no post to show.">
        {(data) => "kind" in data ? <NativePostBody data={data}/> : <Post data={data} />}
      </ViewShell>}
    </section>
  );
}

/** GMV states are different facts: a reported figure, a TikTok post whose source gave none, and an Instagram post where TikTok Shop GMV does not apply. */
export function gmvSentence(gmv: PostGmv): string {
  switch (gmv.state) {
    case "reported": return `TikTok-reported GMV ${usd(gmv.amount)} (${gmv.definition}, ${gmv.window}) is retained separately.`;
    case "not-reported": return "TikTok has not reported GMV for this post. That is unknown, not $0, and it is retained separately from net sales.";
    case "unknown": return "Platform GMV is unknown because this record has no GMV observation.";
    case "unavailable": return `Platform GMV is unavailable. ${gmv.reason}`;
    case "not-applicable": return "TikTok Shop GMV does not apply to an Instagram post. It is retained separately from net sales.";
  }
}

function Post({ data }: { data: PostPerformanceData }) {
  const demo = useIsDemo();
  const [dialog, setDialog] = useState<"source" | "attribution" | null>(null);
  const inter = data.interactions ? interactionsOf(data.interactions) : null;
  const proof = data.publicationProof;
  const reportingWindow = data.attributionWindow;
  const windowLabel = reportingWindow
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).formatRange(new Date(reportingWindow.startDate), new Date(reportingWindow.endDate))
    : "Unknown · no attribution window supplied";
  const publicationLabel = proof
    ? `published ${new Date(proof.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`
    : "Publication unverified";
  const deltas = data.dailyDeltas;
  const peak = Math.max(0, ...deltas.map((d) => d.thousands));
  const gained = deltas.reduce((s, d) => s + d.thousands, 0);
  return (
    <>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="post-title">One post. Its evidence and impact.</h1>
          <p>{data.handle} · {data.network} · {data.cohort} · {publicationLabel}</p>
        </div>
        <LinkButton variant="secondary" to="/content" style={{ minWidth: 176 }}>Back to monitor</LinkButton>
        <Button style={{ minWidth: 184 }} aria-haspopup="dialog" onClick={() => setDialog("source")}>Open source post</Button>
      </div>
      <div className={m.ctx}>
        <Badge tone="violet" width={200}>{demo ? "Illustrative post data" : "Post data"}</Badge>
        <p className={a.small}>{data.context}</p>
      </div>
      <KpiGrid>
        <KpiCard label="Views" context="Post view count; not unique reach" testId="metric-views">{data.views === null ? "N/A" : count(data.views)}</KpiCard>
        <KpiCard label="Engagement rate" context={inter !== null && data.views ? `${count(inter)} interactions / ${count(data.views)} views` : "Needs both interactions and views"} testId="metric-engagement">{inter !== null && data.views ? ratePct(inter, data.views) : "N/A"}</KpiCard>
        <KpiCard label="Attributed orders" context="Distinct matched paid orders" testId="metric-orders">{data.orders === null ? "N/A" : count(data.orders)}</KpiCard>
        <KpiCard label="Attributed net sales" context="After discounts and refunds; USD · not GMV" testId="metric-net-sales">{data.netSales === null ? "N/A" : usd(data.netSales)}</KpiCard>
      </KpiGrid>
      <div className={a.split} style={{ gridTemplateColumns: "832fr 440fr", gap: 24 }}>
        <Card labelledBy="growth-title" className={a.card20}>
          <h2 id="growth-title" className={a.cardH2} style={{ margin: 0 }}>Views gained since publication</h2>
          <p className={a.small}>Daily deltas from consecutive snapshots · {deltas.length ? `${demo ? "Oct " : ""}${deltas[0]!.label}–${deltas.at(-1)!.label} · ${count(gained * 1000)} total` : "not available for this post"}</p>
          {deltas.length === 0 ? <p className={a.label} role="status">Daily snapshots aren't available for this post{demo ? " in the demo" : ""}. The views above are its latest count, not a series.</p> : (
            <div className={a.tableWrap} role="region" aria-label="Daily view growth chart" tabIndex={0}>
              <div className={m.bars} role="img" aria-label={`Daily views gained: ${deltas.map((d) => `${demo ? "Oct " : ""}${d.label} ${d.thousands}k`).join(", ")}`}>
                {deltas.map((d) => (
                  <div key={d.label} className={m.barCol}><div className={m.bar} style={{ height: deltaHeight(d.thousands, peak) }} /><span className={m.n}>{d.thousands}k</span><span className={m.d}>{d.label}</span></div>
                ))}
              </div>
            </div>
          )}
          <p className={a.small}>Views are cumulative source observations; delta bars may be corrected when a platform revises its counts.</p>
        </Card>
        <Card labelledBy="evidence-title" className={a.card20}>
          <h2 id="evidence-title" className={a.cardH2} style={{ margin: 0 }}>Known, sourced and traceable</h2>
          <DetailRow label="Network" value={data.network} />
          <DetailRow label="Intake source" value={data.details.intake} />
          <DetailRow label="Creator ID" value={data.details.creatorId} />
          <DetailRow label="Content ID" value={data.details.contentId} />
          <DetailRow label="Metric source" value={data.details.metricSource} />
          <DetailRow label="Sales source" value={data.details.salesSource} />
          <hr className={a.divider} />
          <p className={a.small}>{data.interactions ? `Likes ${count(data.interactions.likes)} + comments ${count(data.interactions.comments)} + shares ${count(data.interactions.shares)} = ${count(inter ?? 0)} interactions. Saves and unique reach are unavailable in this example.` : "Interactions are unavailable for this post. They stay unknown, not zero."}</p>
        </Card>
      </div>
      <div className={a.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
        <Card labelledBy="attribution-title" className={a.card20}>
          <h2 id="attribution-title" className={a.cardH2} style={{ margin: 0 }}>Sales require an order match</h2>
          <p className={a.small}>{data.orders === null ? "No order match is available for this post." : data.orders === 0 ? "The source reports 0 attributed orders." : `${data.orders} distinct paid order IDs join to this content through the recorded affiliate attribution.`} The net-sales calculation deducts discounts and refunds using the order ledger.{!reportingWindow && " The attribution window is unknown."}</p>
          <p className={a.small} data-testid="gmv-note">{gmvSentence(data.gmv)} It is never relabeled as net sales.</p>
          <div className={a.btnRow}><Button variant="secondary" style={{ minWidth: 280 }} aria-haspopup="dialog" onClick={() => setDialog("attribution")}>View attribution evidence</Button></div>
        </Card>
        <Card labelledBy="status-title" className={a.card20}>
          <h2 id="status-title" className={a.cardH2} style={{ margin: 0 }}>The conversation explains the next step</h2>
          <div className={a.btnRow}><Badge tone={proof ? "success" : "warning"} width={200}>{proof ? "Publication verified" : "Publication unverified"}</Badge></div>
          <p className={a.small}>{proof ? `Native post ${proof.nativePostRef} and its publish time were verified at ${proof.observedAt}.` : "No verified native publication record is available."} The source links this post to collaboration {data.collaborationId}.</p>
          <p className={a.small}>Next: review reuse rights before republishing. Message claims alone cannot approve payment or confirm an order.</p>
          <div className={a.btnRow}><LinkButton variant="secondary" to={`/collaborations/${data.collaborationId}?tab=overview`} style={{ minWidth: 280 }}>Open collaboration</LinkButton></div>
        </Card>
      </div>
      <p className={m.footer}>{demo ? "Demo · no live account or order data used · post reporting is a subset of the shared 240,000-view / 180-order creator cohort." : "Post reporting · publication and sales use their respective source records."}</p>
      <HandoffDialog open={dialog === "source"} onClose={() => setDialog(null)} title="Source post" rows={[{ label: "Post", value: `${data.handle} · ${data.network} · ${data.postId}` }, { label: "Link", value: "No verified source URL in this build" }, ...(proof ? [{ label: "Native post", value: proof.nativePostRef }, { label: "Published", value: proof.publishedAt }, { label: "Observed", value: proof.observedAt }, { label: "Source reference", value: proof.sourceRef }] : [{ label: "Publication", value: "Unknown · source proof unavailable" }])]}>
        <p>Source links come from the adapter, never from a guess. This opens nothing, and the post's counts are unchanged.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "attribution"} onClose={() => setDialog(null)} title="Attribution evidence"
        rows={[{ label: "Matched orders", value: data.orders === null ? "Unknown" : `${data.orders} distinct paid order IDs` }, { label: "Net sales", value: data.netSales === null ? "Unknown" : `${usd(data.netSales)} after discounts and refunds` }, { label: "Window", value: windowLabel }, ...(reportingWindow ? [{ label: "Window source", value: reportingWindow.sourceRef }] : []), { label: "Source", value: data.details.salesSource }, { label: "GMV", value: `${gmvSentence(data.gmv)} Never net sales.` }]}>
        <p>Order IDs aren't listed in this build. Reading this evidence doesn't assign or change an attribution.</p>
      </HandoffDialog>
    </>
  );
}
