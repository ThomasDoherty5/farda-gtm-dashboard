/**
 * Runtime schemas for the monitor view data: contentMonitor, watchlist, hourlyRun, postPerformance.
 * They validate `ReadResponse.data` only; the envelope is `readResponseSchema(...)` in contract.ts.
 *
 * Choices:
 * - Post counts, interactions, orders and net sales are `null` when the source gave none. Null is unknown, never
 *   zero, so the schema accepts null and a number but never turns one into the other. Two cross-field rules make that
 *   hold: when `windowAvailable` is false the window has no snapshot, so no post carries counts and the attributed
 *   totals are null; and a post's interactions are all-or-nothing.
 * - `postPerformance.interactions.saves` and `.uniqueReach` are typed as `null` in the fixture because the demo has no
 *   such source. The schema accepts a non-negative count or null, so a real source that reports them is not refused.
 * - Monitoring is read-only, so no field here carries an outbound action; the `next.kind`, `kind` and `state` enums are
 *   closed lists and an unknown value is rejected.
 * - Objects are not `.strict()`: these are display read models. The `datasetKey` literal refuses another dataset.
 * - The helpers below are repeated in the sibling files on purpose, so each file stands alone.
 */
import { z } from "zod";
import { moneySchema } from "../contract";

const count = z.number().int().nonnegative();
const nonNegativeMoney = moneySchema.extend({ minorUnits: z.number().int().nonnegative() });

const network = z.enum(["tiktok", "instagram"]);
const intakeSource = z.enum(["tiktok-affiliate", "social-cat"]);
const interactions = z.object({ likes: count, comments: count, shares: count });

const monitorPost = z.object({
  postId: z.string(),
  handle: z.string(),
  network,
  source: intakeSource,
  views: count.nullable(),
  interactions: interactions.nullable(),
  orders: count.nullable(),
  netSales: nonNegativeMoney.nullable(),
  lastCheck: z.string(),
});

export const contentMonitorSchema = z
  .object({
    datasetKey: z.literal("monitor-demo"),
    snapshotLabel: z.string(),
    cohort: z.object({ label: z.string(), creators: count }),
    posts: z.array(monitorPost),
    postTotal: count,
    windowLabel: z.string(),
    windowAvailable: z.boolean(),
    attributedOrders: count.nullable(),
    attributedNetSales: nonNegativeMoney.nullable(),
    coverage: z.object({ cohortCreators: count, verifiedPosts: count, measurable: count, unavailable: count }),
    signals: z.array(z.object({ initial: z.string(), handle: z.string(), text: z.string(), badge: z.string(), tone: z.enum(["violet", "warning"]), to: z.string() })),
    curve: z.object({ startDate: z.string(), labels: z.array(z.string()), thousands: z.array(z.number().finite().nonnegative()) }),
  })
  .superRefine((d, ctx) => {
    if (d.windowAvailable) return;
    // A window with no snapshot has no counts. They are unknown, never zero.
    if (d.attributedOrders !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attributedOrders"], message: "A window with no snapshot cannot carry an order total" });
    if (d.attributedNetSales !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attributedNetSales"], message: "A window with no snapshot cannot carry a sales total" });
    d.posts.forEach((p, i) => {
      if (p.views !== null || p.interactions !== null || p.orders !== null || p.netSales !== null)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["posts", i], message: "A window with no snapshot cannot carry post counts" });
    });
  });

export const watchlistSchema = z.object({
  datasetKey: z.literal("watchlist-demo"),
  totals: z.object({ tracked: count, socialCat: count, tiktok: count, active: count, identityReview: count, excluded: count }),
  rows: z.array(
    z.object({
      id: z.string(),
      handle: z.string(),
      network: z.enum(["TikTok", "Instagram"]),
      intake: intakeSource,
      signup: z.string(),
      state: z.enum(["active", "identity-review", "excluded"]),
      lastCheck: z.string(),
      next: z.object({ label: z.string(), kind: z.enum(["post", "message", "deliverable", "identity", "reconnect", "exclusion"]) }),
      cohort: z.enum(["launch-a", "other"]),
      note: z.string(),
    }),
  ),
  cohortCreators: count,
  scheduleLabel: z.string(),
});

export const hourlyRunSchema = z.object({
  datasetKey: z.literal("hourly-run-demo"),
  runId: z.string(),
  runLabel: z.string(),
  context: z.string(),
  version: z.string(),
  profiles: z.object({ checked: count, total: count, failed: z.object({ handle: z.string(), network: z.string(), reason: z.string() }).nullable() }),
  newPostLinks: count,
  inboxChanges: count,
  statusReviews: count,
  stages: z.array(z.object({ n: z.string(), title: z.string(), detail: z.string(), state: z.enum(["complete", "partial"]) })),
  policy: z.object({ schedule: z.string(), scheduleNote: z.string(), nextRun: z.string(), nextRunNote: z.string(), retry: z.string(), retryNote: z.string() }),
  evidence: z.array(z.object({ evidence: z.string(), source: z.string(), result: z.string(), action: z.string(), kind: z.enum(["post", "suggestion", "delivery", "reconnect"]) })),
});

export const postPerformanceSchema = z.object({
  datasetKey: z.enum(["post-demo", "post-performance"]),
  postId: z.string(),
  handle: z.string(),
  network: z.enum(["TikTok", "Instagram"]),
  cohort: z.string(),
  publishedLabel: z.string(),
  context: z.string(),
  views: count.nullable(),
  interactions: interactions.extend({ saves: count.nullable(), uniqueReach: count.nullable() }).nullable(),
  orders: count.nullable(),
  netSales: nonNegativeMoney.nullable(),
  gmv: z.discriminatedUnion("state", [
    z.object({ state: z.literal("reported"), amount: nonNegativeMoney, window: z.string().trim().min(1), definition: z.string().trim().min(1) }).strict(),
    z.object({ state: z.literal("not-reported") }).strict(),
    z.object({ state: z.literal("not-applicable") }).strict(),
    z.object({ state: z.literal("unknown") }).strict(),
    z.object({ state: z.literal("unavailable"), reason: z.string().trim().min(1) }).strict(),
  ]).nullish().transform(value => value ?? { state: "unknown" as const }),
  publicationProof: z.object({
    postId: z.string().trim().min(1), network: z.enum(["TikTok", "Instagram"]), nativePostRef: z.string().trim().min(1),
    publishedAt: z.string().datetime({ offset: true }), observedAt: z.string().datetime({ offset: true }),
    sourceRef: z.string().trim().min(1),
  }).strict().nullish(),
  attributionWindow: z.object({
    startDate: z.string().date(), endDate: z.string().date(), sourceRef: z.string().trim().min(1),
  }).strict().refine(window => window.startDate <= window.endDate, "Invalid attribution window").nullish(),
  dailyDeltas: z.array(z.object({ label: z.string(), thousands: z.number().finite().nonnegative() })),
  details: z.object({ creatorId: z.string(), contentId: z.string(), intake: z.string(), metricSource: z.string(), salesSource: z.string() }),
  collaborationId: z.string(),
}).superRefine((post, context) => {
  const proof = post.publicationProof;
  if (proof) {
    const published = Date.parse(proof.publishedAt);
    const observed = Date.parse(proof.observedAt);
    if (proof.postId !== post.postId || proof.network !== post.network || !Number.isFinite(published) || !Number.isFinite(observed) || published > observed || observed > Date.now()) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["publicationProof"], message: "Publication evidence requires this post's identity and a completed observation after publication." });
    }
  }
  if (post.gmv.state === "reported" && post.network !== "TikTok") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["gmv"], message: "Reported TikTok GMV requires a TikTok post." });
  }
});

/** View key to the schema of `ReadResponse.data` for that view. */
export const monitorViewSchemas: Record<string, z.ZodTypeAny> = {
  contentMonitor: contentMonitorSchema,
  watchlist: watchlistSchema,
  hourlyRun: hourlyRunSchema,
  postPerformance: postPerformanceSchema,
};
