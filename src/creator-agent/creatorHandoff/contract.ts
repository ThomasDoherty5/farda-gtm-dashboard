import { z } from "zod";
import { analyticsCountSchema as count, analyticsRefSchema as ref } from "../analytics/contract.ts";
import { instantSchema as instant } from "../analytics/sources.ts";
import { originalPostUrl } from "../monitor/contract.ts";
import { weeklyWindowSchema } from "../weeklySnapshots/contract.ts";

export const creatorHandoffPrefix = "creator-handoff:";
export const creatorWeeklyPrefix = "creator-weekly:";
export const creatorPipelinePath = "/creators/pipeline";
export const creatorHandoffIdentitySchema = z.object({
  kind: z.literal("creatorHandoff"), collaborationId: ref.max(120), sequence: count.positive(),
  previousEventRef: ref.max(180).nullable(),
}).strict().refine(identity => (identity.sequence === 1) === (identity.previousEventRef === null));

export const creatorHandoffRef = (collaborationId: string, sequence: number) =>
  creatorHandoffPrefix + collaborationId + ":" + sequence;

const dashboardLink = z.string().url().max(550).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash &&
      !/[<>|\s]/.test(value) && (!url.search || url.search === "?tab=overview");
  } catch { return false; }
});
const proof = {
  creatorId: ref, receiptRef: ref, observedAt: instant, dashboardLink,
};
const withBasis = { ...proof, basisReceiptRef: ref };
const deliveryClock = z.object({ receiptRef: ref, reviewAfter: instant }).strict();
const carrier = z.enum(["USPS", "UPS", "FedEx", "DHL", "Other"]);
export const creatorHandoffSchema = z.discriminatedUnion("kind", [
  z.object({ ...proof, kind: z.literal("agreement"), campaignId: ref.max(120),
    deliverableCount: count.max(100), postingTerms: z.enum(["committed", "voluntary"]), postingDeadline: instant.nullable() }).strict(),
  z.object({ ...withBasis, kind: z.literal("sampleReserved"), reservationId: ref }).strict(),
  z.object({ ...withBasis, kind: z.literal("sampleShipped"), shipmentId: ref, carrier,
    source: z.literal("shippo"), purpose: z.literal("creatorSample"), status: z.literal("inTransit") }).strict(),
  z.object({ ...withBasis, kind: z.literal("sampleDelivered"), shipmentId: ref,
    source: z.literal("shippo"), purpose: z.literal("creatorSample"), status: z.literal("delivered"),
    clock: deliveryClock.nullable() }).strict(),
  z.object({ ...withBasis, kind: z.literal("sampleException"), shipmentId: ref,
    source: z.literal("shippo"), purpose: z.literal("creatorSample"), status: z.enum(["lost", "returned"]) }).strict(),
  z.object({ ...withBasis, kind: z.literal("noPostReview"), clock: deliveryClock,
    absence: z.literal("completeSourceRead") }).strict(),
  z.object({ ...withBasis, kind: z.literal("postLive"), network: z.enum(["instagram", "tiktok"]),
    postId: ref, liveUrl: z.string().url().max(400), visibility: z.literal("public") }).strict(),
]).superRefine((value, ctx) => {
  if (value.kind === "agreement" && (value.postingTerms === "committed" ? !value.deliverableCount : value.postingDeadline !== null)) {
    ctx.addIssue({ code: "custom", message: "Only committed posting terms can supply a posting deadline." });
  }
  if (value.kind === "postLive" && originalPostUrl(value.network, value.postId, value.liveUrl) !== value.liveUrl) {
    ctx.addIssue({ code: "custom", message: "Use the exact native post permalink without tracking parameters." });
  }
});
export type CreatorHandoff = z.infer<typeof creatorHandoffSchema>;

export const creatorStages = ["qualified", "contacted", "replied", "agreed", "reserved", "shipped",
  "delivered", "published", "review", "exception"] as const;
export const creatorStage = z.enum(creatorStages);
export const creatorWeeklyContextSchema = z.object({
  window: weeklyWindowSchema, dashboardLink, sourceVersion: ref, asOf: instant,
  stages: z.array(z.object({ stage: creatorStage, creators: count }).strict()).max(creatorStages.length).nullable(),
  posting: z.array(z.object({ campaignId: ref.max(120), eligible: count, published: count }).strict()
    .refine(row => row.published <= row.eligible)).max(200).nullable(),
  ranked: z.array(z.object({ collaborationId: ref.max(120), retainedUnits: count.positive() }).strict()).max(5).nullable(),
}).strict().superRefine((value, ctx) => {
  const unique = (keys: readonly string[]) => new Set(keys).size === keys.length;
  if (value.stages && (!unique(value.stages.map(row => row.stage)) || value.stages.length !== creatorStages.length) ||
      value.posting && !unique(value.posting.map(row => row.campaignId)) ||
      value.ranked && !unique(value.ranked.map(row => row.collaborationId))) {
    ctx.addIssue({ code: "custom", message: "The creator summary requires unique canonical source groups." });
  }
});
export type CreatorWeeklyContext = z.infer<typeof creatorWeeklyContextSchema>;

export function creatorDashboardPath(link: string, collaborationId?: string) {
  try {
    const path = new URL(link).pathname;
    return collaborationId ? path === "/collaborations/" + encodeURIComponent(collaborationId) : path === creatorPipelinePath;
  } catch { return false; }
}
