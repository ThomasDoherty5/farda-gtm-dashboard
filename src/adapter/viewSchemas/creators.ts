/**
 * Runtime schemas for the Social Cat and TikTok boards and dashboards (view keys socialCatBoard,
 * socialCatDashboard, tiktokBoard, tiktokDashboard).
 *
 * Strictness: objects are loose (unknown keys are stripped) except where a stripped key would change
 * meaning. `.strict()` is used for the per-owner counts (a stray owner would vanish from totals) and for the
 * "unknown" markers (costPerLiveVideo, attributedSales): those carry no value on purpose, so a `value: 0`
 * must be refused rather than silently dropped, which would turn a known figure into an unknown one.
 *
 * `datasetKey` is a demo label that no screen reads, so it is any non-empty string here, not the demo literal.
 */
import { z } from "zod";
import { count, countsByOwner, labelCount, money, owner, text, tone, unknownMarker } from "./acquisitionPrimitives";

const card = z.object({ id: text, handle: text, detail: text, status: z.object({ label: text, tone }), note: text, owner });
const stage = z.object({ key: text, title: text, note: text, byOwner: countsByOwner, cards: z.array(card) });

const socialCatBoard = z.object({
  datasetKey: text,
  owner: z.union([z.literal("all"), owner]),
  stages: z.array(stage).min(1),
  needsDecision: countsByOwner,
  contentReady: countsByOwner,
  /** Unknown until a live post and a complete cost set exist. A numeric cost is not accepted by this shape. */
  costPerLiveVideo: unknownMarker,
  nextDecision: z.object({ handle: text, subject: text, approvalId: text }),
});

const tiktokBoard = z.object({
  datasetKey: text,
  query: z.string(),
  stages: z.array(z.object({ key: text, label: text, count })).min(1),
  awaitingApproval: count,
  postsPublishedStages: z.array(text),
  rows: z.array(z.object({ id: text, handle: text, stage: text, next: text, due: text, owner })),
  attributedSales: unknownMarker,
});

const network = z.enum(["instagram", "tiktok"]);
const networkFacts = z.object({ posts: count, measurablePosts: count, views: count, interactions: count, orders: count, net: money })
  .refine((n) => n.measurablePosts <= n.posts, { message: "Measurable posts cannot exceed posts", path: ["measurablePosts"] });

const socialCatDashboard = z.object({
  datasetKey: text,
  network: z.union([z.literal("all"), network]),
  cohort: z.object({ label: text, creators: count }),
  networks: z.object({ instagram: networkFacts, tiktok: networkFacts }),
  actions: z.array(labelCount),
  queue: z.array(labelCount),
  upcoming: z.array(z.object({ id: text, handle: text, deliverable: text, status: text, due: text })),
  samples: z.object({ total: count, inTransit: count, delivered: count })
    .refine((s) => s.inTransit + s.delivered <= s.total, { message: "In transit plus delivered cannot exceed total", path: ["total"] }),
  /** Affiliate pilot: a separate cohort. Never added to the launch cohort's totals. */
  pilot: z.object({ netEligibleSales: money, refunds: money, grossCommission: money, reversedCommission: money, cashCommissionPaid: money, estimatedContribution: money }),
});

const tiktokDashboard = z.object({
  datasetKey: text,
  cohort: z.object({ label: text, creators: count, posts: count, measurablePosts: count })
    .refine((c) => c.measurablePosts <= c.posts, { message: "Measurable posts cannot exceed posts", path: ["measurablePosts"] }),
  views: count,
  interactions: count,
  orders: count,
  net: money,
  shopOrders: count,
  actions: z.array(labelCount),
  watchlist: z.array(labelCount),
  posts: z.array(z.object({ id: text, handle: text, views: count, orders: count, net: money })),
}).refine((d) => d.orders <= d.shopOrders, { message: "Measured creators' orders cannot exceed all shop orders", path: ["orders"] });

export const creatorsViewSchemas: Record<string, z.ZodTypeAny> = {
  socialCatBoard,
  socialCatDashboard,
  tiktokBoard,
  tiktokDashboard,
};
