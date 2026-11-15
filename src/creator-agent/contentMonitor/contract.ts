import { z } from "zod";
import { runtimeInstant, runtimeRef } from "../jobs/runtimeSchema.ts";
import type { OperationsScope } from "../operations.ts";

/**
 * J08 hourly creator content and Inbox monitoring: normalized internal types. These are server-only. Raw provider account,
 * post and message identifiers never leave the agent unaliased; the monitor reader projects them to scoped aliases.
 */
const sourceId = z.string().trim().min(1).max(240);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
export const j08Reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
export const j08Networks = ["instagram", "tiktok"] as const;
export type J08Network = typeof j08Networks[number];
const network = z.enum(j08Networks);

/** Ref = {provider, accountId, sourceId, url|null}. The provider is the native publishing network. */
export const j08RefSchema = z.object({ provider: network, accountId: sourceId, sourceId, url: z.string().url().max(1000).nullable() }).strict();
export type J08Ref = z.infer<typeof j08RefSchema>;
/** Money = {minorUnits:integer, currency:ISO4217}. */
export const j08MoneySchema = z.object({ minorUnits: z.number().int().safe(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export type J08Money = z.infer<typeof j08MoneySchema>;

/**
 * Versioned J08 policy. There are no code defaults: the server supplies the exact current policy, whose version must equal the
 * registration's pinned policy version. A changed policy holds the next item instead of being silently adopted.
 */
export const j08PolicySchema = z.object({
  version: runtimeRef,
  /** Comparable post-age checkpoints, in hours since native publication. */
  checkpoints: z.object({ version: runtimeRef, hours: z.array(z.number().int().min(1).max(8760)).min(1).max(12) }).strict()
    .refine(c => c.hours.every((h, i) => i === 0 || h > c.hours[i - 1]!), "Checkpoints must be strictly increasing."),
  /** The only implemented rule: reviewed, campaign-specific evidence naming exactly one enrolled campaign. */
  attributionRule: z.literal("reviewed-campaign-evidence.v1"),
}).strict();
export type J08Policy = z.infer<typeof j08PolicySchema>;

export type J08Stage = "posts" | "inbox";
/** A frozen watchlist row: one enrolled, eligible J01 profile. */
export type J08Subject = { subjectRef: string; creatorId: string; network: J08Network; accountId: string; profileId: string };
export type J08ReadRequest = {
  scope: OperationsScope; registrationRef: string; registrationVersion: number; policyVersion: string; watchlistVersion: string;
  window: { windowRef: string; start: string; end: string };
  subject: { creatorId: string; profile: J08Ref; campaigns: string[] };
  stage: J08Stage; cursor: string | null; maxRecords: number;
  /** Prior canonical content in this profile, so a source can page incrementally. Bounded; never a write instruction. */
  priorObservationRefs: J08Ref[];
};

export const j08AccessSchema = z.enum(["authorized", "denied", "loginRequired", "mfaRequired", "captcha", "termsChanged", "uiDrift", "throttled", "unavailable"]);
export type J08Access = z.infer<typeof j08AccessSchema>;
export const j08MetricKeys = ["views", "likes", "comments", "shares", "saves", "reach", "watchTimeSeconds"] as const;
const metricSchema = z.object({
  metricKey: z.enum(j08MetricKeys), value: count.nullable(), unit: z.enum(["count", "seconds"]),
  definition: z.string().trim().min(1).max(200), semantics: z.enum(["cumulative", "interval"]),
  window: z.object({ start: runtimeInstant, end: runtimeInstant }).strict(), missingReason: j08Reason.nullable(),
}).strict()
  .refine(m => (m.value === null) === (m.missingReason !== null), "A missing metric needs its reason; a known value has none.")
  .refine(m => Date.parse(m.window.start) <= Date.parse(m.window.end), "Reversed metric window.")
  .refine(m => (m.metricKey === "watchTimeSeconds") === (m.unit === "seconds"), "Metric unit mismatch.");
export type J08Metric = z.infer<typeof metricSchema>;
export const j08EvidenceKinds = ["collaborationTag", "brandMention", "productLink", "discountCode", "reviewedLink"] as const;
const fardaEvidenceSchema = z.object({ kind: z.enum(j08EvidenceKinds), campaignId: sourceId.nullable(), reviewed: z.boolean(), receiptRef: runtimeRef }).strict();
export type J08FardaEvidence = z.infer<typeof fardaEvidenceSchema>;
const postSchema = z.object({
  ref: j08RefSchema, creativeRef: sourceId.nullable(), publishedAt: runtimeInstant.nullable(), sourceUpdatedAt: runtimeInstant.nullable(),
  access: z.enum(["authorized", "denied", "unavailable"]), visibility: z.enum(["public", "private", "deleted", "expired"]).nullable(),
  context: z.enum(["organic", "paid", "mixed", "unknown"]), fardaEvidence: z.array(fardaEvidenceSchema).max(10), metrics: z.array(metricSchema).max(12),
}).strict().superRefine((p, ctx) => {
  if ((p.access === "authorized") !== (p.visibility !== null)) ctx.addIssue({ code: "custom", message: "Confirmed visibility requires authorized access." });
  if (p.access !== "authorized" && p.metrics.length) ctx.addIssue({ code: "custom", message: "An inaccessible post has no current metrics." });
  if (new Set(p.metrics.map(m => m.metricKey)).size !== p.metrics.length) ctx.addIssue({ code: "custom", message: "One value per metric." });
});
export type J08Post = z.infer<typeof postSchema>;
const messageSchema = z.object({
  ref: j08RefSchema, conversationId: sourceId, at: runtimeInstant, sourceUpdatedAt: runtimeInstant.nullable(),
  kind: z.enum(["reply", "statusChange", "post"]), direction: z.enum(["inbound", "outbound"]), receiptRef: runtimeRef,
}).strict();
export type J08Message = z.infer<typeof messageSchema>;

/** One bounded source page for one watchlist row and stage. Source text is data; it cannot carry an action or destination. */
export const j08PageSchema = z.object({
  requestDigest: hash, receiptRef: runtimeRef, evidenceStage: z.enum(["synthetic", "source"]),
  /** Native API, an authorized creator insight export or an authorized browser read. A mirror is never a J08 metric source. */
  method: z.enum(["native-api", "authorized-export", "authorized-browser"]),
  /** The source's own observation time for this page: the freshness watermark. Never the poll or mirror time. */
  observedAt: runtimeInstant, access: j08AccessSchema, retryAfterMs: z.number().int().min(0).max(3_600_000).nullable(),
  posts: z.array(postSchema).max(100), inbox: z.array(messageSchema).max(100), nextCursor: z.string().min(1).max(2000).nullable(),
}).strict().superRefine((page, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (page.access !== "authorized" && (page.posts.length || page.inbox.length || page.nextCursor !== null)) fail("A denied or failed read has no records.");
  if (page.retryAfterMs !== null && !["throttled", "unavailable"].includes(page.access)) fail("Only a transient read carries Retry-After.");
  const at = Date.parse(page.observedAt), after = (value: string | null) => value !== null && Date.parse(value) > at;
  if (page.posts.some(p => after(p.publishedAt) || after(p.sourceUpdatedAt) || p.metrics.some(m => after(m.window.end)))) fail("Post facts cannot follow the page observation.");
  if (page.inbox.some(m => after(m.at) || after(m.sourceUpdatedAt))) fail("Inbox facts cannot follow the page observation.");
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (!unique(page.posts.map(p => JSON.stringify([p.ref.provider, p.ref.accountId, p.ref.sourceId])))) fail("Duplicate post identity.");
  if (!unique(page.inbox.map(m => JSON.stringify([m.ref.provider, m.ref.accountId, m.ref.sourceId])))) fail("Duplicate Inbox identity.");
});
export type J08Page = z.infer<typeof j08PageSchema>;

export type J08SourceReader = {
  read(request: J08ReadRequest): Promise<unknown>;
  /** Synchronous source-owned fence after the awaited read and inside the final store transaction. */
  assertCurrent(page: J08Page, request: J08ReadRequest, now: number): void;
};

/** freshnessCoverage. The five leaf categories partition the frozen snapshot; `scanned` is the completely read subtotal. */
export type J08Coverage = {
  snapshotCount: number; scanned: number; unchanged: number; newContent: number; inaccessible: number; deferred: number; failed: number;
  lastSourceSuccess: string | null; complete: boolean; noNewContent: boolean | null; allClear: boolean | null;
};
export type J08Category = "unchanged" | "newContent" | "inaccessible" | "deferred" | "failed";
export type J08NextAction = { itemRef: J08Ref | { provider: "j01"; accountId: string; sourceId: string; url: null }; reason: string; owner: "J09" | "J14" };
export const j08Owners = { J09: "owner:j09-creator-follow-up", J14: "owner:j14-provider-health" } as const;
export const j08CountSchema = count;
