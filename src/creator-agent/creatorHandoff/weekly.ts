import { z } from "zod";
import { analyticsRefSchema as ref, analyticsScopeSchema } from "../analytics/contract.ts";
import { ownedOrderRows } from "../analytics/ownedOrderRows.ts";
import { instantSchema as instant, ordersSnapshotSchema } from "../analytics/sources.ts";
import { digest } from "../config.ts";
import { previousWeeklyDate, weeklySnapshotWindow, type WeeklyWindow } from "../weeklySnapshots/schedule.ts";
import { creatorStage, creatorStages, creatorWeeklyContextSchema, type CreatorWeeklyContext } from "./contract.ts";

const collaboration = z.object({
  collaborationId: ref.max(120), creatorId: ref, campaignId: ref.max(120), stage: creatorStage,
  posting: z.enum(["committed", "voluntary", "unknown"]),
  delivery: z.object({ at: instant, receiptRef: ref }).strict().nullable(),
  reviewClock: z.object({ reviewAfter: instant, deliveryReceiptRef: ref }).strict().nullable(),
  publication: z.object({ firstPublicPostAt: instant.nullable(), completeThrough: instant }).strict().nullable(),
}).strict().refine(row => !row.reviewClock || row.posting === "committed" && row.delivery &&
  row.reviewClock.deliveryReceiptRef === row.delivery.receiptRef &&
  Date.parse(row.reviewClock.reviewAfter) >= Date.parse(row.delivery.at));

export const creatorWeeklySourceSchema = z.object({
  scope: analyticsScopeSchema, sourceVersion: ref, asOf: instant, periodClosedAt: instant,
  lifecycle: z.object({ coverage: z.enum(["complete", "partial"]), rows: z.array(collaboration).max(2000) }).strict().nullable(),
  attributedOrders: z.object({
    definition: z.literal("creator-attributed-retained-units.v1"),
    coverage: z.enum(["complete", "partial"]), orders: ordersSnapshotSchema,
    assignments: z.array(z.object({ canonicalOrderId: ref, collaborationId: ref.max(120) }).strict()).max(50_000),
  }).strict().nullable(),
}).strict();
type CreatorWeeklySource = z.infer<typeof creatorWeeklySourceSchema>;
type Collaboration = z.infer<typeof collaboration>;
type Scope = z.infer<typeof analyticsScopeSchema>;

function postingByCampaign(rows: readonly Collaboration[], start: number, end: number) {
  const campaigns = new Map<string, { campaignId: string; eligible: number; published: number }>();
  for (const row of rows) {
    const counts = campaigns.get(row.campaignId) ?? { campaignId: row.campaignId, eligible: 0, published: 0 };
    campaigns.set(row.campaignId, counts);
    if (!row.delivery || Date.parse(row.delivery.at) >= end || row.posting === "voluntary") continue;
    if (!row.reviewClock) return null;
    const matureAt = Date.parse(row.reviewClock.reviewAfter);
    if (matureAt < start || matureAt >= end) continue;
    const publishedAt = row.publication?.firstPublicPostAt;
    if (!row.publication || !publishedAt && Date.parse(row.publication.completeThrough) < end) return null;
    counts.eligible++;
    if (publishedAt && Date.parse(publishedAt) < end) counts.published++;
  }
  return campaigns.size <= 200 ? [...campaigns.values()].sort((a, b) => a.campaignId.localeCompare(b.campaignId, "en")) : null;
}

function retainedUnitRanking(source: CreatorWeeklySource, window: WeeklyWindow, rows: readonly Collaboration[], scope: Scope) {
  const input = source.attributedOrders;
  const asOf = Date.parse(source.asOf), start = Date.parse(window.start), end = Date.parse(window.end);
  const lastDay = new Date(Date.parse(window.reportDate + "T00:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  if (!input || input.coverage !== "complete" || digest(input.orders.scope) !== digest(scope) ||
      input.orders.window.start !== previousWeeklyDate(window.reportDate) ||
      input.orders.window.end !== lastDay || input.orders.window.timezone !== window.timezone) return null;
  const { channels, conflict } = ownedOrderRows(input.orders.feeds);
  if (conflict || channels.some(({ feed, mismatch }) => mismatch || !feed || feed.coverage !== "complete" ||
      feed.syncState === "error" || !feed.lastSuccessAt || Date.parse(feed.lastSuccessAt) < end ||
      Date.parse(feed.observedAt) > asOf)) return null;
  const orders = new Map(channels.flatMap(channel => channel.rows).map(order => [order.canonicalOrderId, order]));
  const collaborations = new Set(rows.map(row => row.collaborationId));
  const attributed = new Map<string, string>();
  for (const { canonicalOrderId, collaborationId } of input.assignments) {
    const order = orders.get(canonicalOrderId), earlier = attributed.get(canonicalOrderId);
    if (!order || earlier && earlier !== collaborationId || !collaborations.has(collaborationId) ||
        Date.parse(order.placedAt) < start || Date.parse(order.placedAt) >= end ||
        !(order.attribution === "utm" || order.attribution === "code" && order.codeOwner === "creator") ||
        order.unitsRetained === null) return null;
    attributed.set(canonicalOrderId, collaborationId);
  }
  for (const [orderId, order] of orders) {
    if (orderId && order.attribution === "code" && order.codeOwner === "creator" &&
        Date.parse(order.placedAt) >= start && Date.parse(order.placedAt) < end && !attributed.has(orderId)) return null;
  }
  const units = new Map<string, number>();
  for (const [orderId, collaborationId] of attributed) {
    const total = (units.get(collaborationId) ?? 0) + orders.get(orderId)!.unitsRetained!;
    if (!Number.isSafeInteger(total)) return null;
    units.set(collaborationId, total);
  }
  return [...units].filter(([, retainedUnits]) => retainedUnits > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en")).slice(0, 5)
    .map(([collaborationId, retainedUnits]) => ({ collaborationId, retainedUnits }));
}

/** One completed Pacific week. Source absence never supplies a numerator, denominator or rank. */
export function summarizeCreatorWeek(raw: unknown, window: WeeklyWindow, scope: Scope, dashboardLink: string, now: number): CreatorWeeklyContext | null {
  const parsed = creatorWeeklySourceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const source = parsed.data;
  const start = Date.parse(window.start), end = Date.parse(window.end), asOf = Date.parse(source.asOf);
  if (digest(source.scope) !== digest(scope) || digest(weeklySnapshotWindow(window.reportDate)) !== digest(window) ||
      source.periodClosedAt !== window.end || asOf < end || asOf > now) return null;
  const rows = source.lifecycle?.rows ?? [];
  const stageAtClose = (row: Collaboration) => {
    if (row.stage === "delivered") return !!row.delivery && Date.parse(row.delivery.at) < end;
    const postedAt = row.publication?.firstPublicPostAt;
    if (row.stage === "published") return !!postedAt && Date.parse(postedAt) < end;
    if (row.stage === "review") return !!row.reviewClock && Date.parse(row.reviewClock.reviewAfter) < end &&
      !!row.publication && Date.parse(row.publication.completeThrough) >= end && (!postedAt || Date.parse(postedAt) >= end);
    return true;
  };
  const coherent = source.lifecycle?.coverage === "complete" &&
    new Set(rows.map(row => row.collaborationId)).size === rows.length &&
    rows.every(row => (!row.delivery || Date.parse(row.delivery.at) <= asOf) &&
      (!row.publication || Date.parse(row.publication.completeThrough) <= asOf &&
        (!row.publication.firstPublicPostAt || Date.parse(row.publication.firstPublicPostAt) <= Date.parse(row.publication.completeThrough))));
  return creatorWeeklyContextSchema.parse({ window, dashboardLink, sourceVersion: source.sourceVersion, asOf: source.asOf,
    stages: coherent && rows.every(stageAtClose) ? creatorStages.map(stage => ({ stage,
      creators: new Set(rows.filter(row => row.stage === stage).map(row => row.creatorId)).size })) : null,
    posting: coherent ? postingByCampaign(rows, start, end) : null,
    ranked: coherent ? retainedUnitRanking(source, window, rows, scope) : null,
  });
}
