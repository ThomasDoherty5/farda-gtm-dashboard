import { z } from "zod";

/** Public wire schemas and pure summaries. Safe to import in the browser; no source access happens here. */
const id = z.string().trim().min(1).max(240);
const reason = z.string().trim().min(1).max(1_000);
const sourceRef = z.string().trim().min(1).max(1_000);
const instant = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().safe();
const seconds = z.number().finite().nonnegative();
const rating = z.number().int().min(0).max(5).nullable();

export const nativeLikesSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: count, exact: z.boolean(), sourceRef }).strict(),
  z.object({ status: z.literal("unknown"), reason }).strict(),
  z.object({ status: z.literal("unavailable"), reason }).strict(),
]);
export type NativeLikes = z.infer<typeof nativeLikesSchema>;

const viewsSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("known"), value: count, definition: reason, window: reason }).strict(),
  z.object({ status: z.literal("unknown"), reason }).strict(),
  z.object({ status: z.literal("unavailable"), reason }).strict(),
]);

export const commentCategorySchema = z.enum([
  "generalReaction", "routineApplication", "productUnderstanding", "practicalObjection",
  "purchaseEvaluation", "promptedKeyword", "selfReportedOwnership",
]);
export type CommentCategory = z.infer<typeof commentCategorySchema>;

const commentRowSchema = z.object({
  commentId: id,
  /** An opaque/de-identified author reference for deduplication, never a health-profile inference. */
  authorRef: id.nullable(),
  creator: z.boolean(),
  promotional: z.boolean(),
  prompted: z.boolean(),
  categories: z.array(commentCategorySchema).min(1).max(7),
  text: z.string().trim().min(1).max(2_000),
}).strict().superRefine((row, ctx) => {
  if (new Set(row.categories).size !== row.categories.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["categories"], message: "Category tags must be unique." });
  if (row.categories.includes("promptedKeyword") && !row.prompted)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["prompted"], message: "A prompted-keyword reply must retain its prompted flag." });
});

export const commentsSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("observed"),
    ordering: reason,
    observedAt: instant,
    rows: z.array(commentRowSchema).max(20),
  }).strict(),
  z.object({ status: z.literal("unknown"), reason }).strict(),
  z.object({ status: z.literal("unavailable"), reason }).strict(),
]).superRefine((sample, ctx) => {
  if (sample.status === "observed" && new Set(sample.rows.map((row) => row.commentId)).size !== sample.rows.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows"], message: "Comment IDs must be unique within the sample." });
});
export type CommentSample = z.infer<typeof commentsSchema>;

const intervalSchema = z.object({ startSec: seconds, endSec: seconds }).strict()
  .refine((interval) => interval.endSec > interval.startSec, { path: ["endSec"], message: "An interval must end after it starts." });

export const reviewSchema = z.object({
  status: z.enum(["complete", "partial", "blocked", "unassessed"]),
  visualMethod: z.enum(["continuous", "sampledFrames", "unassessed"]),
  audioMethod: z.enum(["heard", "asr", "nativeCaptions", "silent", "unassessed"]),
  sampledPoints: z.array(seconds).max(5_000),
  watchedIntervals: z.array(intervalSchema).max(500),
  observedActions: z.array(z.object({ atSec: seconds, action: reason, meaningfulUse: z.boolean() }).strict()).max(500),
  claims: z.array(z.object({ atSec: seconds, text: reason, method: z.enum(["heard", "asr", "nativeCaptions"]) }).strict()).max(500),
  inferences: z.array(reason).max(100),
  sourceRef: sourceRef.nullable(),
}).strict().superRefine((review, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (new Set(review.sampledPoints).size !== review.sampledPoints.length) fail("sampledPoints", "Sampled points must be unique.");
  if (review.visualMethod === "sampledFrames" && review.watchedIntervals.length)
    fail("watchedIntervals", "Sampled frame points cannot be represented as continuously watched intervals.");
  if (review.visualMethod === "continuous" && review.sampledPoints.length)
    fail("sampledPoints", "Record the continuous method's watched intervals separately from sampled frames.");
  if (review.visualMethod === "unassessed" && (review.sampledPoints.length || review.watchedIntervals.length || review.observedActions.length))
    fail("visualMethod", "Unassessed visuals cannot carry observed visual actions or coverage.");
  if (review.status === "complete") {
    if (!review.sourceRef) fail("sourceRef", "A completed review needs its source review receipt.");
    if (review.visualMethod === "unassessed") fail("visualMethod", "Audio or a saved draft alone cannot complete a visual review.");
    if (review.visualMethod === "sampledFrames" && !review.sampledPoints.length) fail("sampledPoints", "Record the actual sampled points.");
    if (review.visualMethod === "continuous" && !review.watchedIntervals.length) fail("watchedIntervals", "Record the actual watched intervals.");
  }
  if (review.status === "unassessed" && (review.visualMethod !== "unassessed" || review.audioMethod !== "unassessed" || review.claims.length))
    fail("status", "Assessed material must be labeled partial rather than unassessed.");
  for (const [index, claim] of review.claims.entries()) {
    if ((claim.method === "heard" && review.audioMethod !== "heard") || (claim.method === "asr" && review.audioMethod !== "asr"))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["claims", index, "method"], message: "The claim's source must match the declared audio assessment method." });
  }
});
export type EvidenceReview = z.infer<typeof reviewSchema>;

const networkSchema = z.enum(["instagram", "tiktok"]);

function isOriginalVideoUrl(value: string, network: z.infer<typeof networkSchema>): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.replace(/^www\./, "");
  if (network === "tiktok") return (host === "tiktok.com" || host === "m.tiktok.com") && /^\/@[\w.]+\/video\/\d+\/?$/.test(url.pathname);
  return host === "instagram.com" && (/^\/(?:p|reel|reels|tv)\/[\w-]+\/?$/.test(url.pathname) || /^\/[\w.]+\/reels?\/[\w-]+\/?$/.test(url.pathname));
}

/** Stable native asset identity, independent of query strings, aliases and caller-assigned record IDs. */
export function nativePostIdentity(post: { sourceUrl: string; network: "instagram" | "tiktok" }): string {
  // Refinements can still run on a dirty nested URL; preserve Zod validation instead of throwing.
  let path: string;
  try { path = new URL(post.sourceUrl).pathname; } catch { return `${post.network}:invalid:${post.sourceUrl}`; }
  const nativeId = post.network === "tiktok" ? /\/video\/(\d+)/.exec(path)?.[1] : /\/(?:p|reel|reels|tv)\/([\w-]+)/.exec(path)?.[1];
  return `${post.network}:${nativeId ?? path}`;
}

export const postEvidenceSchema = z.object({
  postId: id,
  canonicalMediaId: id,
  network: networkSchema,
  sourceUrl: z.string().url().max(2_000),
  publishedAt: instant.nullable(),
  observedAt: instant,
  relevant: z.boolean(),
  nativeLikes: nativeLikesSchema,
  review: reviewSchema,
  comments: commentsSchema,
}).strict().superRefine((post, ctx) => {
  if (!isOriginalVideoUrl(post.sourceUrl, post.network))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["sourceUrl"], message: "Use the original HTTPS Instagram or TikTok video URL for this network, without embedded credentials." });
});
export type PostEvidence = z.infer<typeof postEvidenceSchema>;

export const recentPostMetadataSchema = z.object({
  postId: id,
  canonicalMediaId: id,
  publishedAt: instant.nullable(),
  relevant: z.boolean(),
  pinned: z.boolean().nullable(),
  nativeLikes: nativeLikesSchema,
  views: viewsSchema,
  paid: z.enum(["yes", "no", "unknown"]),
}).strict();
export type RecentPostMetadata = z.infer<typeof recentPostMetadataSchema>;

const gateSchema = z.object({ id, status: z.enum(["pass", "fail", "unknown"]), sourceRef: sourceRef.nullable() }).strict();

const packetShapeSchema = z.object({
  creatorId: id,
  briefId: id,
  checkoutRoute: z.enum(["website", "tiktok-shop"]),
  evidenceRevision: id,
  termsRevision: id,
  posts: z.array(postEvidenceSchema).max(50),
  recentPosts: z.array(recentPostMetadataSchema).max(100),
  ratings: z.object({ routine: rating, demo: rating }).strict(),
  /** Extra configured criteria remain absent/unknown unless supplied; these never invent missing weights. */
  criterionRatings: z.record(id, rating).default({}),
  invitationGates: z.array(gateSchema).max(100),
  activationGates: z.array(gateSchema).max(100),
}).strict().superRefine((packet, ctx) => {
  for (const key of ["posts", "recentPosts"] as const)
    if (new Set(packet[key].map((post) => post.postId)).size !== packet[key].length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Post IDs must be unique within each record set." });
  if (new Set(packet.posts.map(nativePostIdentity)).size !== packet.posts.length)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["posts"], message: "The same native asset cannot be submitted under different record IDs." });
  for (const key of ["invitationGates", "activationGates"] as const)
    if (new Set(packet[key].map((gate) => gate.id)).size !== packet[key].length)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "Gate IDs must be unique within each phase." });
});
export type EvidencePacket = z.infer<typeof packetShapeSchema>;
export const evidencePacketSchema: z.ZodType<EvidencePacket, z.ZodTypeDef, z.input<typeof packetShapeSchema>> = packetShapeSchema;

const viewGroupSchema = z.object({
  definition: reason, window: reason, paid: z.enum(["yes", "no", "unknown"]), count: count.positive(),
  median: z.number().finite().nonnegative(), min: count, max: count, spread: count,
}).strict().refine((group) => group.min <= group.median && group.median <= group.max && group.spread === group.max - group.min,
  { message: "View distribution bounds and spread must agree." });

export const metadataBaselineSchema = z.object({
  requestedCount: z.literal(10),
  selected: z.array(recentPostMetadataSchema).max(10),
  totalProvided: count.max(100),
  relevantCount: count.max(100),
  unknownDateCount: count.max(100),
  unknownPinnedCount: count.max(100),
  coverage: z.enum(["complete", "partial"]),
  coverageReasons: z.array(reason),
  viewStats: z.object({
    status: z.enum(["known", "partial", "incomparable", "unknown"]),
    knownCount: count,
    missingCount: count,
    definition: reason.nullable(),
    window: reason.nullable(),
    paid: z.enum(["yes", "no", "unknown"]).nullable(),
    median: z.number().finite().nonnegative().nullable(),
    min: count.nullable(), max: count.nullable(), spread: count.nullable(),
    groups: z.array(viewGroupSchema).max(10),
  }).strict(),
}).strict().superRefine((baseline, ctx) => {
  const fail = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  if (baseline.selected.some((post) => !post.relevant || post.pinned !== false || post.publishedAt === null))
    fail(["selected"], "Selected baseline rows must have known dates, be relevant and be unpinned.");
  if (baseline.totalProvided < baseline.relevantCount || baseline.relevantCount < baseline.selected.length || baseline.unknownDateCount > baseline.relevantCount || baseline.unknownPinnedCount > baseline.relevantCount)
    fail(["totalProvided"], "Baseline selection counts cannot exceed supplied records.");
  const complete = baseline.selected.length === 10 && baseline.unknownDateCount === 0 && baseline.unknownPinnedCount === 0 && baseline.coverageReasons.length === 0;
  if ((baseline.coverage === "complete") !== complete) fail(["coverage"], "Coverage must retain missing rows and uncertain dates/pinned states.");
  const views = baseline.viewStats;
  if (views.knownCount + views.missingCount !== baseline.selected.length || views.groups.reduce((sum, group) => sum + group.count, 0) !== views.knownCount)
    fail(["viewStats"], "View counts must reconcile to the selected rows and compatible groups.");
  const only = views.groups.length === 1 ? views.groups[0]! : null;
  if (only) {
    const keys = ["definition", "window", "paid", "median", "min", "max", "spread"] as const;
    if (keys.some((key) => views[key] !== only[key])) fail(["viewStats"], "A comparable summary must use its one group's exact basis and statistics.");
    const expected = views.missingCount || baseline.coverage === "partial" ? "partial" : "known";
    if (views.status !== expected) fail(["viewStats", "status"], "The summary must retain incomplete view/baseline coverage.");
  } else {
    if ([views.definition, views.window, views.paid, views.median, views.min, views.max, views.spread].some((value) => value !== null))
      fail(["viewStats"], "Do not combine unknown or incompatible view groups into one statistic.");
    if (views.status !== (views.knownCount ? "incomparable" : "unknown")) fail(["viewStats", "status"], "Unavailable or incompatible views must stay explicit.");
  }
});
export type MetadataBaseline = z.infer<typeof metadataBaselineSchema>;

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! / 2 + sorted[mid]! / 2;
  return { median, min: sorted[0]!, max: sorted[sorted.length - 1]!, spread: sorted[sorted.length - 1]! - sorted[0]! };
}

/** Latest known unpinned relevant metadata, including ordinary/low-like posts. No video review or qualification occurs here. */
export function deriveMetadataBaseline(input: readonly RecentPostMetadata[]): MetadataBaseline {
  const posts = z.array(recentPostMetadataSchema).max(100).parse(input);
  if (new Set(posts.map((post) => post.postId)).size !== posts.length) throw new Error("Duplicate metadata post IDs.");
  const relevant = posts.filter((post) => post.relevant);
  const unknownPinnedCount = relevant.filter((post) => post.pinned === null).length;
  const unknownDateCount = relevant.filter((post) => post.pinned !== true && post.publishedAt === null).length;
  const selected = relevant.filter((post) => post.pinned === false && post.publishedAt !== null)
    .sort((a, b) => Date.parse(b.publishedAt!) - Date.parse(a.publishedAt!) || a.postId.localeCompare(b.postId)).slice(0, 10);
  const coverageReasons: string[] = [];
  if (selected.length < 10) coverageReasons.push("INSUFFICIENT_KNOWN_POSTS");
  if (unknownDateCount) coverageReasons.push("UNKNOWN_PUBLICATION_DATE");
  if (unknownPinnedCount) coverageReasons.push("UNKNOWN_PINNED_STATE");
  const buckets = new Map<string, { definition: string; window: string; paid: RecentPostMetadata["paid"]; values: number[] }>();
  for (const post of selected) {
    if (post.views.status !== "known") continue;
    const { definition, window, value } = post.views;
    const key = JSON.stringify([definition, window, post.paid]);
    const group = buckets.get(key) ?? { definition, window, paid: post.paid, values: [] };
    group.values.push(value);
    buckets.set(key, group);
  }
  const groups = [...buckets.values()].map(({ values, ...basis }) => ({ ...basis, count: values.length, ...distribution(values) }));
  const knownCount = groups.reduce((sum, group) => sum + group.count, 0);
  const missingCount = selected.length - knownCount;
  const only = groups.length === 1 ? groups[0]! : null;
  return metadataBaselineSchema.parse({
    requestedCount: 10, selected, totalProvided: posts.length, relevantCount: relevant.length,
    unknownDateCount, unknownPinnedCount, coverage: coverageReasons.length ? "partial" : "complete", coverageReasons,
    viewStats: {
      status: !knownCount ? "unknown" : !only ? "incomparable" : missingCount || coverageReasons.length ? "partial" : "known",
      knownCount, missingCount, definition: only?.definition ?? null, window: only?.window ?? null, paid: only?.paid ?? null,
      median: only?.median ?? null, min: only?.min ?? null, max: only?.max ?? null, spread: only?.spread ?? null, groups,
    },
  });
}

const categoryCountsSchema = z.object({
  generalReaction: count, routineApplication: count, productUnderstanding: count, practicalObjection: count,
  purchaseEvaluation: count, promptedKeyword: count, selfReportedOwnership: count,
}).strict();
export type CommentCategoryCounts = z.infer<typeof categoryCountsSchema>;

export const commentStatsSchema = z.object({
  status: z.enum(["observed", "unknown", "unavailable"]),
  reason: reason.nullable(), ordering: reason.nullable(), observedAt: instant.nullable(),
  observedRows: count.max(20).nullable(), knownUniqueAuthors: count.nullable(), uniqueAuthors: count.nullable(), unknownAuthorRows: count.nullable(),
  audienceRows: count.nullable(), creatorRows: count.nullable(), promotionalRows: count.nullable(), promptedRows: count.nullable(),
  categoryCounts: categoryCountsSchema.nullable(),
  categoryKnownAuthorCounts: categoryCountsSchema.nullable(),
  unpromptedAudienceCategoryCounts: categoryCountsSchema.nullable(),
}).strict().superRefine((stats, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  const counts = [stats.observedRows, stats.knownUniqueAuthors, stats.unknownAuthorRows, stats.audienceRows, stats.creatorRows, stats.promotionalRows, stats.promptedRows];
  if (stats.status !== "observed") {
    if (!stats.reason || [stats.ordering, stats.observedAt, stats.uniqueAuthors, ...counts, stats.categoryCounts, stats.categoryKnownAuthorCounts, stats.unpromptedAudienceCategoryCounts].some((value) => value !== null))
      fail("Unavailable comment evidence needs a reason and unknown counts, never fabricated zeroes.");
    return;
  }
  if (stats.reason !== null || !stats.ordering || !stats.observedAt || counts.some((value) => value === null) || !stats.categoryCounts || !stats.categoryKnownAuthorCounts || !stats.unpromptedAudienceCategoryCounts) {
    fail("Observed comment summaries need their actual sample, denominators and category counts.");
    return;
  }
  const rows = stats.observedRows!;
  if (counts.some((value) => value! > rows) || stats.knownUniqueAuthors! > rows - stats.unknownAuthorRows!) fail("Comment sample counts must reconcile to observed rows.");
  if (stats.uniqueAuthors !== (stats.unknownAuthorRows ? null : stats.knownUniqueAuthors)) fail("Unique authors remain unknown when any author reference is missing.");
  for (const category of commentCategorySchema.options) {
    if (stats.categoryCounts[category] > rows || stats.categoryKnownAuthorCounts[category] > Math.min(stats.knownUniqueAuthors!, stats.categoryCounts[category]) || stats.unpromptedAudienceCategoryCounts[category] > Math.min(stats.audienceRows!, stats.categoryCounts[category]))
      fail("Category counts use observed rows and known authors; overlapping tags are not additional buyers.");
  }
});
export type CommentStats = z.infer<typeof commentStatsSchema>;

const emptyCategories = (): CommentCategoryCounts => ({
  generalReaction: 0, routineApplication: 0, productUnderstanding: 0, practicalObjection: 0,
  purchaseEvaluation: 0, promptedKeyword: 0, selfReportedOwnership: 0,
});

/** Overlapping descriptive counts, never a buyer probability, conversion rate or attributed order count. */
export function deriveCommentStats(input: CommentSample): CommentStats {
  const sample = commentsSchema.parse(input);
  if (sample.status !== "observed") return commentStatsSchema.parse({
    status: sample.status, reason: sample.reason, ordering: null, observedAt: null,
    observedRows: null, knownUniqueAuthors: null, uniqueAuthors: null, unknownAuthorRows: null,
    audienceRows: null, creatorRows: null, promotionalRows: null, promptedRows: null,
    categoryCounts: null, categoryKnownAuthorCounts: null, unpromptedAudienceCategoryCounts: null,
  });
  const categoryCounts = emptyCategories();
  const categoryKnownAuthorCounts = emptyCategories();
  const unpromptedAudienceCategoryCounts = emptyCategories();
  const authors = new Set<string>();
  const categoryAuthors = new Map<CommentCategory, Set<string>>(commentCategorySchema.options.map((category) => [category, new Set<string>()]));
  let unknownAuthorRows = 0;
  for (const row of sample.rows) {
    if (row.authorRef === null) unknownAuthorRows++;
    else authors.add(row.authorRef);
    for (const category of row.categories) {
      categoryCounts[category]++;
      if (row.authorRef !== null) categoryAuthors.get(category)!.add(row.authorRef);
      if (!row.creator && !row.promotional && !row.prompted) unpromptedAudienceCategoryCounts[category]++;
    }
  }
  for (const category of commentCategorySchema.options) categoryKnownAuthorCounts[category] = categoryAuthors.get(category)!.size;
  return commentStatsSchema.parse({
    status: "observed", reason: null, ordering: sample.ordering, observedAt: sample.observedAt,
    observedRows: sample.rows.length, knownUniqueAuthors: authors.size, uniqueAuthors: unknownAuthorRows ? null : authors.size, unknownAuthorRows,
    audienceRows: sample.rows.filter((row) => !row.creator && !row.promotional).length,
    creatorRows: sample.rows.filter((row) => row.creator).length,
    promotionalRows: sample.rows.filter((row) => row.promotional).length,
    promptedRows: sample.rows.filter((row) => row.prompted).length,
    categoryCounts, categoryKnownAuthorCounts, unpromptedAudienceCategoryCounts,
  });
}
