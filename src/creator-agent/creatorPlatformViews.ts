import { z } from "zod";

export const creatorPlatformKeys = ["socialCatBoard", "tiktokBoard", "socialCatDashboard", "tiktokDashboard"] as const;
export type CreatorPlatformKey = (typeof creatorPlatformKeys)[number];
const day = z.string().date();
export const creatorPlatformFilterSchema = z.object({
  owner: z.string().max(80).optional(), q: z.string().max(100).optional(),
  network: z.enum(["all", "instagram", "tiktok", "other", "unknown"]).optional(),
  start: day.optional(), end: day.optional(),
}).strict().refine(f => !f.start || !f.end || f.start < f.end, "End must follow cohort start.");
export type CreatorPlatformFilters = z.infer<typeof creatorPlatformFilterSchema>;
const instant = z.string().datetime();
const count = z.number().int().nonnegative().safe();
const reference = z.string().max(760);
const eventState = z.string().max(80);
const measure = z.object({ label: z.enum(["Views", "Engagement rate", "Attributed orders", "Attributed net sales"]),
  value: z.number().finite().nullable(), unit: z.string().max(80), denominator: count.nullable(), window: z.string().max(160).nullable(),
  reason: z.string().max(260).nullable() }).strict();
const row = z.object({
  id: reference, creator: reference, account: reference, opportunity: z.enum(["inbound", "outbound"]),
  stage: eventState, owner: z.string().max(100).nullable(), dueAt: instant.nullable(), ageDays: z.number().nonnegative().nullable(), observedAt: instant,
  blockers: z.array(z.string().max(140)), nextAction: z.string().max(220), networks: z.array(z.string().max(20)),
  checkouts: z.array(z.string().max(40)), payouts: z.array(z.string().max(60)),
  collaborations: z.array(reference), deliveries: z.array(z.object({ id: reference, state: eventState, observedAt: instant }).strict()),
  evidence: z.array(z.object({ state: eventState, observedAt: instant }).strict()),
  historyTotal: count, policyVersion: reference, qualification: z.string().max(60),
  terms: z.enum(["accepted", "no saved acceptance"]), historicalPayable: z.boolean(),
}).strict();
const stageCount = z.object({ state: eventState, count }).strict();
export const savedCreatorPlatformSchema = z.object({
  kind: z.literal("saved-creator-platform"), viewKey: z.enum(creatorPlatformKeys), platform: z.enum(["Social Cat", "TikTok"]),
  asOf: instant, cohortStart: day.nullable(), cohortEnd: day.nullable(), providerCoverage: z.literal("unknown"),
  total: count, offset: count, records: z.array(row), stages: z.array(stageCount), achievements: z.array(stageCount),
  metrics: z.array(measure).length(4), observedEvents: count, observedCreators: count, sourceOutages: count, unknownStates: count,
  postSamples: z.array(z.object({ post: reference, network: z.string().max(20), observedAt: instant, views: count.nullable(),
    engagements: count.nullable(), window: z.string().max(160).nullable(), sourceVerified: z.boolean() }).strict()),
  postSampleTotal: count, checkoutLanes: z.array(z.object({ checkout: z.string().max(80), payout: z.string().max(120), opportunities: count }).strict()),
  latestObservation: instant.nullable(), sourceWindows: z.array(z.string().max(160)), sourceNetworks: z.array(z.string().max(20)),
}).strict();
export type SavedCreatorPlatform = z.infer<typeof savedCreatorPlatformSchema>;
export type PlatformRow = z.infer<typeof row>;
export type PlatformMetric = z.infer<typeof measure>;
