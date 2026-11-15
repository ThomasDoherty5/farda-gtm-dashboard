// @vitest-environment node
import { describe, expect, it } from "vitest";
import { evt, fixtureRef } from "../funnelFixtures.testkit.ts";
import type { FunnelEvent } from "../funnelContract.ts";
import { j08PageSchema, j08PolicySchema } from "./contract.ts";
import { checkpointCapture, fardaAssignment, orderAttribution } from "./rules.ts";

const evidence = (kind: "collaborationTag" | "brandMention" | "productLink" | "discountCode" | "reviewedLink", campaignId: string | null, reviewed = true) =>
  ({ kind, campaignId, reviewed, receiptRef: `synthetic-${kind}-${campaignId ?? "brand"}` });

describe("J08-04 Farda attribution from reviewed evidence only", () => {
  it("attributes only reviewed campaign-specific evidence naming exactly one enrolled campaign", () => {
    expect(fardaAssignment([evidence("productLink", "spring")], ["spring"])).toMatchObject({ state: "attributed", campaignId: "spring" });
    expect(fardaAssignment([evidence("discountCode", "spring"), evidence("brandMention", null)], ["spring", "autumn"])).toMatchObject({ state: "attributed", campaignId: "spring" });
  });
  it.each([
    [[], ["spring"], "unrelated", "NO_FARDA_EVIDENCE"],
    [[evidence("productLink", "spring", false)], ["spring"], "review", "FARDA_EVIDENCE_UNREVIEWED"],
    [[evidence("brandMention", null)], ["spring"], "review", "BRAND_ONLY_EVIDENCE"],
    [[evidence("collaborationTag", null)], ["spring", "autumn"], "review", "BRAND_ONLY_CONCURRENT_CAMPAIGNS"],
    [[evidence("reviewedLink", "spring"), evidence("discountCode", "autumn")], ["spring", "autumn"], "review", "MULTIPLE_CAMPAIGNS_EVIDENCED"],
    [[evidence("reviewedLink", "winter")], ["spring"], "review", "CAMPAIGN_NOT_ENROLLED"],
  ] as const)("keeps %j for %j as %s (%s)", (items, campaigns, state, reason) => {
    expect(fardaAssignment([...items], campaigns)).toMatchObject({ state, reason, campaignId: null });
  });
});

describe("configurable, versioned post-age checkpoints", () => {
  const hours = [24, 168, 720];
  it("labels a late fetch with its actual age and never backfills an earlier checkpoint", () => {
    const published = "2026-11-01T00:00:00Z";
    expect(checkpointCapture(published, "2026-11-01T23:00:00Z", hours, [])).toBeNull();
    expect(checkpointCapture(published, "2026-11-02T02:06:00Z", hours, [])).toEqual({ hours: 24, actualAgeHours: 26.1 });
    expect(checkpointCapture(published, "2026-11-09T00:00:00Z", hours, [])).toEqual({ hours: 168, actualAgeHours: 192 });
    expect(checkpointCapture(published, "2026-11-09T01:00:00Z", hours, [168])).toBeNull();
    expect(checkpointCapture(published, "2026-11-09T01:00:00Z", hours, [24])).toEqual({ hours: 168, actualAgeHours: 193 });
    expect(checkpointCapture(null, "2026-11-09T01:00:00Z", hours, [])).toBeNull();
  });
  it("requires an explicit version and strictly increasing checkpoints, with no implied default", () => {
    const policy = { version: "p1", checkpoints: { version: "c1", hours }, attributionRule: "reviewed-campaign-evidence.v1" };
    expect(j08PolicySchema.safeParse(policy).success).toBe(true);
    expect(j08PolicySchema.safeParse({ ...policy, checkpoints: { version: "c1", hours: [168, 24] } }).success).toBe(false);
    expect(j08PolicySchema.safeParse({ ...policy, checkpoints: undefined }).success).toBe(false);
    expect(j08PolicySchema.safeParse({ ...policy, attributionRule: "creator-identity" }).success).toBe(false);
  });
});

describe("J08-05 source pages keep unknown distinct from zero", () => {
  const page = { requestDigest: "a".repeat(64), receiptRef: "synthetic-page", evidenceStage: "synthetic", method: "native-api", observedAt: "2026-11-07T11:00:00Z",
    access: "authorized", retryAfterMs: null, inbox: [], nextCursor: null };
  const metric = (value: number | null, missingReason: string | null) => ({ metricKey: "shares", value, unit: "count", definition: "Synthetic shares",
    semantics: "cumulative", window: { start: "2026-11-07T00:00:00Z", end: "2026-11-07T11:00:00Z" }, missingReason });
  const post = (metrics: unknown[], access = "authorized", visibility: string | null = "public") => ({ ref: { provider: "instagram", accountId: "synthetic-account", sourceId: "SYNTH", url: null },
    creativeRef: null, publishedAt: "2026-11-07T00:00:00Z", sourceUpdatedAt: null, access, visibility, context: "organic", fardaEvidence: [], metrics });
  it("requires a reason for a missing metric and forbids a reason on a known zero", () => {
    expect(j08PageSchema.safeParse({ ...page, posts: [post([metric(null, "SHARES_NOT_EXPOSED")])] }).success).toBe(true);
    expect(j08PageSchema.safeParse({ ...page, posts: [post([metric(0, null)])] }).success).toBe(true);
    expect(j08PageSchema.safeParse({ ...page, posts: [post([metric(null, null)])] }).success).toBe(false);
    expect(j08PageSchema.safeParse({ ...page, posts: [post([metric(0, "SHARES_NOT_EXPOSED")])] }).success).toBe(false);
  });
  it("keeps private distinct from inaccessible, and a failed read carries no records", () => {
    expect(j08PageSchema.safeParse({ ...page, posts: [post([], "authorized", "private")] }).success).toBe(true);
    expect(j08PageSchema.safeParse({ ...page, posts: [post([], "denied", "private")] }).success).toBe(false);
    expect(j08PageSchema.safeParse({ ...page, posts: [post([metric(1, null)], "denied", null)] }).success).toBe(false);
    expect(j08PageSchema.safeParse({ ...page, access: "loginRequired", posts: [post([])] }).success).toBe(false);
    expect(j08PageSchema.safeParse({ ...page, access: "loginRequired", posts: [] }).success).toBe(true);
    expect(j08PageSchema.safeParse({ ...page, method: "mirror", posts: [] }).success).toBe(false);
  });
});

describe("J08-06 order attribution at the best proven level through the canonical order ledger", () => {
  const ref = (id: string) => ({ ...fixtureRef("notion", id) });
  const order = (name: string, opts: { orderId: string; postId?: string; network?: "instagram" | "tiktok"; checkout?: "website" | "tiktok-shop"; retained?: number;
    maturationAt?: string; window?: string; opportunity?: string }): FunnelEvent => evt(name, "retainedOrder", opts.opportunity ?? "opp", 5, {
    creatorRef: ref("creator-1"), campaignCohortRef: ref("spring"), network: opts.network ?? "instagram", checkout: opts.checkout ?? "website",
    maturationAt: opts.maturationAt ?? "2026-01-09T00:00:00.000Z", evidenceRef: { provenanceRef: "proof:" + name, version: "1", method: "source read", access: "verified",
      url: null, definition: "order", unit: "order", window: "w" },
    details: { orderId: opts.orderId, ...(opts.postId ? { postId: opts.postId } : {}), retainedMinor: opts.retained ?? 1000, currency: "USD", attributionVersion: "v1",
      attributionWindow: opts.window ?? "7-day click", blockers: [] } });
  const post = { network: "instagram" as const, postId: "POST1", creatorId: "creator-1", campaignId: "spring" };
  const asOf = "2026-01-10T00:00:00.000Z";
  it("counts a TikTok Shop order imported into Shopify once", () => {
    const tiktok = { ...post, network: "tiktok" as const, postId: "777" };
    const events = [order("tt", { orderId: "o1", postId: "777", network: "tiktok", checkout: "tiktok-shop", retained: 2500 }),
      order("import", { orderId: "o1", postId: "777", network: "tiktok", checkout: "website", retained: 2500 })];
    expect(orderAttribution(tiktok, events, asOf).attribution).toMatchObject({ level: "post", orders: 1, net: { minorUnits: 2500, currency: "USD" }, complete: true });
  });
  it("keeps a creator-wide code at creator level, never allocated to a post", () => {
    const result = orderAttribution(post, [order("code", { orderId: "o2" })], asOf);
    expect(result).toMatchObject({ reason: "CREATOR_WIDE_ORDER_EVIDENCE", attribution: { level: "creator", orders: 1 } });
  });
  it("reports a known post-level zero only when every cohort order is post-assigned elsewhere", () => {
    expect(orderAttribution(post, [order("other", { orderId: "o3", postId: "POST2" })], asOf).attribution).toMatchObject({ level: "post", orders: 0, net: { minorUnits: 0 } });
    expect(orderAttribution(post, [], asOf)).toEqual({ attribution: null, reason: "NO_AUTHORITATIVE_ORDER_EVIDENCE" });
  });
  it("leaves conflicting, mixed-basis and immature evidence unresolved", () => {
    expect(orderAttribution(post, [order("a", { orderId: "o4", postId: "POST1" }), order("b", { orderId: "o4", postId: "POST2" })], asOf).reason).toBe("ORDER_ASSIGNMENT_CONFLICT");
    expect(orderAttribution(post, [order("a", { orderId: "o5", postId: "POST1" }), order("b", { orderId: "o6", postId: "POST1", window: "1-day view" })], asOf).reason).toBe("ATTRIBUTION_BASIS_MIXED");
    expect(orderAttribution(post, [order("late", { orderId: "o7", postId: "POST1", maturationAt: "2026-02-01T00:00:00.000Z" })], asOf).attribution)
      .toMatchObject({ complete: false, orders: null, net: null });
  });
});
