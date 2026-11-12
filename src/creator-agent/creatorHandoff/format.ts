import type { CreatorHandoff, CreatorWeeklyContext } from "./contract.ts";

function handoffDetail(event: CreatorHandoff) {
  switch (event.kind) {
    case "agreement":
      return `Agreement logged · campaign ${event.campaignId} · ${event.deliverableCount} deliverables · posting deadline ${event.postingDeadline ?? "none recorded"}`;
    case "sampleReserved":
      return "Sample approved and stock reservation confirmed";
    case "sampleShipped":
      return `Sample shipped · ${event.carrier} · Shippo in transit`;
    case "sampleDelivered":
      return `Sample delivered · Shippo confirmed${event.clock ? " · Review after " + event.clock.reviewAfter : " · no posting clock recorded"}`;
    case "sampleException":
      return `Sample shipping exception · Shippo ${event.status}`;
    case "noPostReview":
      return `No-post review reached · review after ${event.clock.reviewAfter} · no public post confirmed at the recorded time`;
    case "postLive":
      return `Post went live · ${event.network === "tiktok" ? "TikTok" : "Instagram"} · <${event.liveUrl}|Open native post>`;
  }
}

export function creatorHandoffBody(event: CreatorHandoff, input: {
  collaborationId: string; handle: string; occurredAt: string; owner: string; sourceLink: string; provenance: string; controlled: boolean;
}) {
  const { collaborationId, handle, occurredAt, owner, sourceLink, provenance, controlled } = input;
  return [
    controlled ? "TEST creator handoff" : "Creator handoff", collaborationId, "@" + handle,
    handoffDetail(event), occurredAt, ...(event.kind === "noPostReview" ? ["Creator desk: " + owner] : []),
    ...(event.dashboardLink ? [`<${event.dashboardLink}|Open collaboration>`] : []),
    `<${sourceLink}|${event.dashboardLink ? "Source evidence" : "Open TEST collaboration evidence"}> ${provenance}`,
    "Read-only report",
  ].join(" · ");
}

export function creatorWeeklyBody(week: CreatorWeeklyContext, sourceLink: string, provenance: string, controlled: boolean) {
  const campaignLimit = 6;
  const stages = week.stages?.map(row => `${row.stage} ${row.creators}`).join(" · ");
  const posting = week.posting?.slice(0, campaignLimit).map(row => {
    const rate = row.eligible ? (100 * row.published / row.eligible).toFixed(1) + "%" : "N/A";
    return `${row.campaignId} · ${row.published}/${row.eligible} (${rate})`;
  });
  const ranked = week.ranked?.map(row => `${row.collaborationId} · ${row.retainedUnits}`);
  return [
    controlled ? "TEST Monday creator summary" : "Monday creator summary",
    `${week.window.start} through ${week.window.end} exclusive · America/Los_Angeles · source as of ${week.asOf}`,
    "Creators by stage at period close (unique per stage)",
    stages ?? "Incomplete lifecycle coverage",
    "Mature posting by campaign (public posts by cutoff / committed, source-delivered collaborations whose review window closed this week)",
    ...(posting?.length ? posting : [posting ? "N/A · no eligible campaign rows" : "Incomplete posting coverage"]),
    ...(week.posting && week.posting.length > campaignLimit ? ["Additional campaigns are in the dashboard."] : []),
    "Top collaborations by retained units after refunds (one winning creator code or UTM assignment per owned order)",
    ...(ranked?.length ? ranked : [ranked ? "No attributed retained units in this period" : "Incomplete attribution or order coverage"]),
    `<${week.dashboardLink}|Creator operations> · <${sourceLink}|Source evidence> ${provenance} · Read-only report`,
  ].join("\n");
}
