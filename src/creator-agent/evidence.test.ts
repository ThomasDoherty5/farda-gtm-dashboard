import { describe, expect, it } from "vitest";
import {
  commentStatsSchema, commentsSchema, deriveCommentStats, deriveMetadataBaseline, evidencePacketSchema,
  metadataBaselineSchema, postEvidenceSchema, reviewSchema,
  type CommentSample, type EvidencePacket, type EvidenceReview, type PostEvidence, type RecentPostMetadata,
} from "./evidence";

/** Fictional records only. These are not source footage, a private handoff or creator performance claims. */
const observedAt = "2026-11-04T12:00:00.000Z";
const knownLikes = (value = 201) => ({ status: "known" as const, value, exact: true, sourceRef: "synthetic:metric-receipt" });
const review = (): EvidenceReview => ({
  status: "complete", visualMethod: "sampledFrames", audioMethod: "unassessed",
  sampledPoints: [0, 2, 4], watchedIntervals: [],
  observedActions: [{ atSec: 2, action: "Opens and closes a fictional travel case.", meaningfulUse: true }],
  claims: [], inferences: [], sourceRef: "synthetic:review-receipt",
});
const post = (n = 1): PostEvidence => ({
  postId: `synthetic-post-${n}`, canonicalMediaId: `synthetic-media-${n}`, network: "tiktok",
  sourceUrl: `https://www.tiktok.com/@synthetic_example/video/${9000000000 + n}`,
  publishedAt: `2026-10-${String((n - 1) % 28 + 1).padStart(2, "0")}T12:00:00.000Z`, observedAt,
  relevant: true, nativeLikes: knownLikes(), review: review(), comments: { status: "unknown", reason: "Source comments not inspected." },
});
const packet = (): EvidencePacket => ({
  creatorId: "synthetic-creator", briefId: "synthetic-travel-brief", checkoutRoute: "website",
  evidenceRevision: "synthetic-evidence-v1", termsRevision: "synthetic-terms-v1", posts: [post()], recentPosts: [],
  ratings: { routine: 3, demo: 3 }, criterionRatings: {}, invitationGates: [], activationGates: [],
});
const metadata = (n: number): RecentPostMetadata => ({
  postId: `synthetic-metadata-${n}`, canonicalMediaId: `synthetic-media-${n}`,
  publishedAt: `2026-10-${String((n - 1) % 28 + 1).padStart(2, "0")}T12:00:00.000Z`, relevant: true, pinned: false,
  nativeLikes: knownLikes(n % 2 ? 8 : 500),
  views: { status: "known", value: n * 100, definition: "native video views", window: "lifetime at the stated snapshot" }, paid: "no",
});
type ObservedComments = Extract<CommentSample, { status: "observed" }>;
const comment = (n: number): ObservedComments["rows"][number] => ({
  commentId: `synthetic-comment-${n}`, authorRef: `synthetic-author-${n}`,
  creator: false, promotional: false, prompted: false, categories: ["generalReaction"], text: "A fictional sample reaction.",
});
const comments = (): ObservedComments => ({ status: "observed", ordering: "First visible top-level rows in source order", observedAt, rows: [] });

describe("creator evidence packets", () => {
  it("retains unknown data and defaults unspecified extra criterion ratings without inventing scores", () => {
    const parsed = evidencePacketSchema.parse({ ...packet(), criterionRatings: undefined, ratings: { routine: null, demo: 0 } });
    expect(parsed.criterionRatings).toEqual({});
    expect(parsed.ratings).toEqual({ routine: null, demo: 0 });
  });

  it.each([199, 200, 201])("keeps the native %i boundary value for the policy evaluator rather than rewriting it", (value) => {
    const input = packet();
    input.posts[0]!.nativeLikes = knownLikes(value);
    expect(evidencePacketSchema.parse(input).posts[0]!.nativeLikes).toEqual(knownLikes(value));
  });

  it("rejects forged eligibility, coverage and completion fields at every strict wire layer", () => {
    const input = packet();
    const first = input.posts[0]!;
    for (const candidate of [
      { ...input, eligible: true },
      { ...input, qualification: { state: "activationReady" } },
      { ...input, posts: [{ ...first, completed: true }] },
      { ...input, posts: [{ ...first, review: { ...first.review, watched: true } }] },
      { ...input, posts: [{ ...first, nativeLikes: { ...knownLikes(), sourceVerified: true } }] },
      { ...input, invitationGates: [{ id: "synthetic-gate", status: "pass", sourceRef: null, override: true }] },
      { ...input, ratings: { routine: 3, demo: 3, total: 99 } },
    ]) expect(evidencePacketSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects repeated post IDs but retains canonical-media repeats for the agent's independent-use check", () => {
    expect(evidencePacketSchema.safeParse({ ...packet(), posts: [post(), post()] }).success).toBe(false);
    const repeatedMedia = { ...post(2), canonicalMediaId: post(1).canonicalMediaId };
    expect(evidencePacketSchema.parse({ ...packet(), posts: [post(), repeatedMedia] }).posts).toHaveLength(2);
    expect(evidencePacketSchema.safeParse({ ...packet(), recentPosts: [metadata(1), metadata(1)] }).success).toBe(false);
  });

  it("rejects native-asset aliases even when caller-assigned record and canonical IDs differ", () => {
    const tiktok = post();
    const instagram = { ...post(), network: "instagram" as const, sourceUrl: "https://www.instagram.com/p/SYNTHETIC_NATIVE/" };
    for (const [original, aliasUrl] of [
      [tiktok, "https://m.tiktok.com/@synthetic_alias/video/9000000001/?lang=en"],
      [instagram, "https://www.instagram.com/synthetic_alias/reel/SYNTHETIC_NATIVE/?igsh=synthetic"],
      [instagram, "https://www.instagram.com/reels/SYNTHETIC_NATIVE/"],
    ] as const) {
      const alias = { ...structuredClone(original), postId: "synthetic-alias-record", canonicalMediaId: "synthetic-alias-media", sourceUrl: aliasUrl };
      expect(postEvidenceSchema.safeParse(alias).success).toBe(true);
      expect(evidencePacketSchema.safeParse({ ...packet(), posts: [original, alias] }).success).toBe(false);
    }
  });

  it("rejects profiles, insecure sources, embedded credentials and wrong-network addresses", () => {
    for (const sourceUrl of [
      "https://www.tiktok.com/@synthetic_example", "http://www.tiktok.com/@synthetic_example/video/123",
      "https://username:password@www.tiktok.com/@synthetic_example/video/123",
      "https://www.instagram.com/reel/SYNTHETIC/", "https://www.tiktok.com.evil.example/@synthetic_example/video/123",
    ]) expect(postEvidenceSchema.safeParse({ ...post(), sourceUrl }).success).toBe(false);
    expect(postEvidenceSchema.safeParse({ ...post(), network: "instagram", sourceUrl: "https://www.instagram.com/synthetic_example/reel/SYNTHETIC/" }).success).toBe(true);
    expect(evidencePacketSchema.safeParse({ ...packet(), posts: [{ ...post(), sourceUrl: "not-a-url" }] }).success).toBe(false);
  });

  it("bounds the packet and rejects fractional/out-of-scale ratings and invalid dates", () => {
    expect(evidencePacketSchema.safeParse({ ...packet(), posts: Array.from({ length: 51 }, (_, i) => post(i + 1)) }).success).toBe(false);
    expect(evidencePacketSchema.safeParse({ ...packet(), recentPosts: Array.from({ length: 101 }, (_, i) => metadata(i + 1)) }).success).toBe(false);
    expect(evidencePacketSchema.safeParse({ ...packet(), ratings: { routine: 3.5, demo: 3 } }).success).toBe(false);
    expect(evidencePacketSchema.safeParse({ ...packet(), criterionRatings: { "synthetic-extra": 6 } }).success).toBe(false);
    expect(postEvidenceSchema.safeParse({ ...post(), observedAt: "yesterday" }).success).toBe(false);
  });
});

describe("review method and receipt provenance", () => {
  it("allows a sourced sampled review without calling it continuous watching or heard audio", () => {
    const parsed = reviewSchema.parse(review());
    expect(parsed.sampledPoints).toEqual([0, 2, 4]);
    expect(parsed.watchedIntervals).toEqual([]);
    expect(parsed.audioMethod).toBe("unassessed");
  });

  it("does not let a draft or audio-only assessment become a complete visual review", () => {
    expect(reviewSchema.safeParse({ ...review(), sourceRef: null }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review(), sampledPoints: [] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review(), visualMethod: "unassessed", audioMethod: "asr", sampledPoints: [], observedActions: [] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review(), status: "partial", sourceRef: null }).success).toBe(true);
  });

  it("rejects sample-to-interval forgery and invalid continuous ranges", () => {
    expect(reviewSchema.safeParse({ ...review(), watchedIntervals: [{ startSec: 0, endSec: 10 }] }).success).toBe(false);
    const continuous = { ...review(), visualMethod: "continuous", sampledPoints: [], watchedIntervals: [{ startSec: 0, endSec: 5 }] };
    expect(reviewSchema.safeParse(continuous).success).toBe(true);
    expect(reviewSchema.safeParse({ ...continuous, watchedIntervals: [{ startSec: 5, endSec: 5 }] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...continuous, watchedIntervals: [] }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...continuous, sampledPoints: [0] }).success).toBe(false);
  });

  it("retains ASR as machine evidence and rejects a mismatched claim source", () => {
    const asr = { ...review(), audioMethod: "asr", claims: [{ atSec: 2, text: "Fictional narrated product-purpose claim.", method: "asr" }] };
    expect(reviewSchema.safeParse(asr).success).toBe(true);
    expect(reviewSchema.safeParse({ ...asr, audioMethod: "heard" }).success).toBe(false);
    expect(reviewSchema.safeParse({ ...review(), visualMethod: "unassessed" }).success).toBe(false);
  });
});

describe("representative recent metadata baseline", () => {
  it("selects the latest ten unpinned relevant posts including ordinary low-like rows", () => {
    const input = Array.from({ length: 12 }, (_, i) => metadata(i + 1));
    const result = deriveMetadataBaseline(input);
    expect(result.selected.map((row) => row.postId)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `synthetic-metadata-${n}`));
    expect(result.selected.some((row) => row.nativeLikes.status === "known" && row.nativeLikes.value < 200)).toBe(true);
    expect(result.coverage).toBe("complete");
    expect(result.viewStats).toMatchObject({ status: "known", knownCount: 10, missingCount: 0, median: 750, min: 300, max: 1_200, spread: 900 });
  });

  it("keeps unknown pin/date coverage partial and does not silently assume those posts are older or unpinned", () => {
    const input = Array.from({ length: 12 }, (_, i) => metadata(i + 1));
    input[11]!.pinned = true;
    input[10]!.pinned = null;
    input[9]!.publishedAt = null;
    const result = deriveMetadataBaseline(input);
    expect(result.selected).toHaveLength(9);
    expect(result.selected.some((row) => row.pinned !== false || row.publishedAt === null)).toBe(false);
    expect(result.coverage).toBe("partial");
    expect(result.coverageReasons).toEqual(["INSUFFICIENT_KNOWN_POSTS", "UNKNOWN_PUBLICATION_DATE", "UNKNOWN_PINNED_STATE"]);
  });

  it("does not pool incompatible definitions, windows or paid states into one median", () => {
    const input = Array.from({ length: 10 }, (_, i) => metadata(i + 1));
    input[0]!.views = { status: "known", value: 99_999, definition: "impressions", window: "last 7 days" };
    input[1]!.paid = "yes";
    const result = deriveMetadataBaseline(input);
    expect(result.viewStats.status).toBe("incomparable");
    expect(result.viewStats.median).toBeNull();
    expect(result.viewStats.groups).toHaveLength(3);
  });

  it("preserves actual zero views and reports missing values without fabricating them", () => {
    const input = Array.from({ length: 10 }, (_, i) => metadata(i + 1));
    input[0]!.views = { status: "known", value: 0, definition: "native video views", window: "lifetime at the stated snapshot" };
    input[1]!.views = { status: "unknown", reason: "Source counter unavailable." };
    expect(deriveMetadataBaseline(input).viewStats).toMatchObject({ status: "partial", knownCount: 9, missingCount: 1, min: 0, median: 600 });
    expect(deriveMetadataBaseline([]).viewStats).toMatchObject({ status: "unknown", median: null, knownCount: 0 });
  });

  it("rejects duplicates and falsely complete or synthesized summaries", () => {
    expect(() => deriveMetadataBaseline([metadata(1), metadata(1)])).toThrow("Duplicate metadata post IDs");
    const result = deriveMetadataBaseline([metadata(1)]);
    expect(metadataBaselineSchema.safeParse({ ...result, coverage: "complete" }).success).toBe(false);
    expect(metadataBaselineSchema.safeParse({ ...result, viewStats: { ...result.viewStats, knownCount: 2 } }).success).toBe(false);
  });
});

describe("buyer versus viewer comment summaries", () => {
  it("counts overlapping categories and known authors without inflating them into people or purchases", () => {
    const sample = comments();
    sample.rows = [
      { ...comment(1), categories: ["purchaseEvaluation", "productUnderstanding"] },
      { ...comment(2), authorRef: comment(1).authorRef, categories: ["purchaseEvaluation"] },
      { ...comment(3), authorRef: null, categories: ["routineApplication"] },
    ];
    const result = deriveCommentStats(sample);
    expect(result).toMatchObject({ observedRows: 3, knownUniqueAuthors: 1, uniqueAuthors: null, unknownAuthorRows: 1 });
    expect(result.categoryCounts).toMatchObject({ purchaseEvaluation: 2, productUnderstanding: 1, routineApplication: 1 });
    expect(result.categoryKnownAuthorCounts?.purchaseEvaluation).toBe(1);
    expect(result).not.toHaveProperty("conversionRate");
    expect(result).not.toHaveProperty("orders");
  });

  it("keeps prompted, creator and promotional responses out of unprompted audience counts", () => {
    const sample = comments();
    sample.rows = [
      { ...comment(1), prompted: true, categories: ["promptedKeyword", "purchaseEvaluation"] },
      { ...comment(2), creator: true, categories: ["purchaseEvaluation"] },
      { ...comment(3), promotional: true, categories: ["purchaseEvaluation"] },
      { ...comment(4), categories: ["purchaseEvaluation", "practicalObjection"] },
    ];
    const result = deriveCommentStats(sample);
    expect(result).toMatchObject({ observedRows: 4, audienceRows: 2, creatorRows: 1, promotionalRows: 1, promptedRows: 1 });
    expect(result.categoryCounts?.purchaseEvaluation).toBe(4);
    expect(result.unpromptedAudienceCategoryCounts).toMatchObject({ purchaseEvaluation: 1, practicalObjection: 1, promptedKeyword: 0 });
  });

  it("distinguishes observed zero rows from unavailable comments and unknown authors", () => {
    expect(deriveCommentStats(comments())).toMatchObject({ status: "observed", observedRows: 0, uniqueAuthors: 0 });
    const result = deriveCommentStats({ status: "unavailable", reason: "Source sign-in gate." });
    expect(result).toMatchObject({ status: "unavailable", observedRows: null, uniqueAuthors: null, categoryCounts: null });
    expect(commentStatsSchema.safeParse({ ...result, observedRows: 0 }).success).toBe(false);
  });

  it("rejects more than20 rows, repeated IDs/tags, forged counts and contradicted prompted status", () => {
    const sample = comments();
    expect(commentsSchema.safeParse({ ...sample, rows: Array.from({ length: 21 }, (_, i) => comment(i)) }).success).toBe(false);
    expect(commentsSchema.safeParse({ ...sample, rows: [comment(1), comment(1)] }).success).toBe(false);
    expect(commentsSchema.safeParse({ ...sample, rows: [{ ...comment(1), categories: ["generalReaction", "generalReaction"] }] }).success).toBe(false);
    expect(commentsSchema.safeParse({ ...sample, rows: [{ ...comment(1), categories: ["promptedKeyword"] }] }).success).toBe(false);
    expect(commentsSchema.safeParse({ ...sample, buyers: 10 }).success).toBe(false);
    const stats = deriveCommentStats({ ...sample, rows: [comment(1)] });
    expect(commentStatsSchema.safeParse({ ...stats, knownUniqueAuthors: 2 }).success).toBe(false);
  });
});
