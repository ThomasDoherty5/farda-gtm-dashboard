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

describe("configurable, versioned post-age checkpoints with tolerance", () => {
  const slots = [{ hours: 24, toleranceHours: 2 }, { hours: 168, toleranceHours: 12 }, { hours: 720, toleranceHours: 24 }];
  const published = "2026-11-01T00:00:00Z", at = (hours: number) => new Date(Date.parse(published) + hours * 3600_000).toISOString();
  it("captures a checkpoint only inside its tolerance", () => {
    expect(checkpointCapture(published, at(23), slots, [])).toBeNull();
    expect(checkpointCapture(published, at(25), slots, [])).toEqual({ state: "captured", hours: 24, actualAgeHours: 25 });
    expect(checkpointCapture(published, at(170), slots, [24])).toEqual({ state: "captured", hours: 168, actualAgeHours: 170 });
    expect(checkpointCapture(published, at(171), slots, [24, 168])).toBeNull();
  });
  it("labels a late fetch with its actual age once, never as a captured or backfilled checkpoint", () => {
    expect(checkpointCapture(published, at(719), slots, [])).toEqual({ state: "late", hours: 168, actualAgeHours: 719 });
    expect(checkpointCapture(published, at(192.06), slots, [24])).toEqual({ state: "late", hours: 168, actualAgeHours: 192.1 });
    expect(checkpointCapture(published, at(193), slots, [24, 168])).toBeNull();
    expect(checkpointCapture(published, at(721), slots, [24, 168])).toEqual({ state: "captured", hours: 720, actualAgeHours: 721 });
    expect(checkpointCapture(null, at(30), slots, [])).toBeNull();
  });
  it("requires an explicit version, tolerance and approval state, with no implied default", () => {
    const policy = { version: "p1", approval: { state: "unapprovedFixture", reason: "synthetic" }, eligibilityPolicyVersion: "e1",
      checkpoints: { version: "c1", slots }, attributionWindows: [{ attributionVersion: "v1", hours: 168 }], attributionRule: "reviewed-campaign-evidence.v1" };
    expect(j08PolicySchema.safeParse(policy).success).toBe(true);
    expect(j08PolicySchema.safeParse({ ...policy, checkpoints: { version: "c1", slots: [{ hours: 24, toleranceHours: 200 }, { hours: 168, toleranceHours: 2 }] } }).success).toBe(false);
    expect(j08PolicySchema.safeParse({ ...policy, checkpoints: { version: "c1", slots: [{ hours: 24 }] } }).success).toBe(false);
    expect(j08PolicySchema.safeParse({ ...policy, approval: undefined }).success).toBe(false);
    expect(j08PolicySchema.safeParse({ ...policy, attributionRule: "creator-identity" }).success).toBe(false);
  });
});

describe("J08-05 source pages keep unknown distinct from zero", () => {
  const page = { requestDigest: "a".repeat(64), receiptRef: "synthetic-page", evidenceStage: "synthetic", method: "native-api", observedAt: "2026-11-07T11:00:00Z",
    access: "authorized", retryAfterMs: null, inbox: [], nextCursor: null };
  const metric = (value: number | null, missingReason: string | null) => ({ metricKey: "shares", value, unit: "count", definition: "Synthetic shares",
    semantics: "cumulative", window: { start: "2026-11-07T00:00:00Z", end: "2026-11-07T11:00:00Z" }, missingReason });
  const post = (metrics: unknown[], access = "authorized", visibility: string | null = "public") => ({ ref: { provider: "instagram", accountId: "synthetic-account", sourceId: "SYNTH", url: null },
    creative: null, publishedAt: "2026-11-07T00:00:00Z", sourceUpdatedAt: null, access, visibility, context: "organic", fardaEvidence: [], metrics });
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
    maturationAt?: string; window?: string; opportunity?: string; type?: "retainedOrder" | "refund"; day?: number }): FunnelEvent => evt(name, opts.type ?? "retainedOrder", opts.opportunity ?? "opp", opts.day ?? 5, {
    creatorRef: ref("creator-1"), campaignCohortRef: ref("spring"), network: opts.network ?? "instagram", checkout: opts.checkout ?? "website",
    maturationAt: opts.maturationAt ?? "2026-01-09T00:00:00.000Z", evidenceRef: { provenanceRef: "proof:" + name, version: "1", method: "source read", access: "verified",
      url: null, definition: "order", unit: "order", window: "w" },
    details: { orderId: opts.orderId, ...(opts.postId ? { postId: opts.postId } : {}), retainedMinor: opts.retained ?? 1000, currency: "USD", attributionVersion: "v1",
      attributionWindow: opts.window ?? "7-day click", blockers: [] } });
  const windows = [{ attributionVersion: "v1", hours: 168 }];
  const matured = "2026-01-01T00:00:00.000Z", asOf = "2026-01-10T00:00:00.000Z";
  const post = { network: "instagram" as const, postId: "POST1", creatorId: "creator-1", campaignId: "spring", publishedAt: matured };
  it("counts a TikTok Shop order imported into Shopify once", () => {
    const tiktok = { ...post, network: "tiktok" as const, postId: "777" };
    const events = [order("tt", { orderId: "o1", postId: "777", network: "tiktok", checkout: "tiktok-shop", retained: 2500 }),
      order("import", { orderId: "o1", postId: "777", network: "tiktok", checkout: "website", retained: 2500 })];
    expect(orderAttribution(tiktok, events, asOf, windows).attribution).toMatchObject({ level: "post", orders: 1, net: { minorUnits: 2500, currency: "USD" }, complete: true });
  });
  it("M9: a refund without a post ID inherits its order's post instead of poisoning the cohort", () => {
    const events = [order("sale", { orderId: "o9", postId: "POST1", retained: 3000 }), order("refund", { orderId: "o9", type: "refund", retained: 1000, day: 6 }),
      order("other", { orderId: "o10", postId: "POST2", retained: 500 })];
    expect(orderAttribution(post, events, asOf, windows)).toMatchObject({ reason: "POST_ASSIGNED_ORDER_EVIDENCE",
      attribution: { level: "post", orders: 1, net: { minorUnits: 1000 }, complete: true } });
    expect(orderAttribution({ ...post, postId: "POST2" }, events, asOf, windows).attribution).toMatchObject({ level: "post", orders: 1, net: { minorUnits: 500 } });
  });
  it("keeps a creator-wide code at creator level, never allocated to a post", () => {
    expect(orderAttribution(post, [order("code", { orderId: "o2" })], asOf, windows)).toMatchObject({ reason: "CREATOR_WIDE_ORDER_EVIDENCE", attribution: { level: "creator", orders: 1 } });
  });
  it("M4: a post-level zero needs the post's own matured window and complete evidence; absence alone is unknown", () => {
    const other = [order("other", { orderId: "o3", postId: "POST2" })];
    expect(orderAttribution(post, other, asOf, windows).attribution).toMatchObject({ level: "post", orders: 0, net: { minorUnits: 0 }, complete: true });
    const young = { ...post, publishedAt: "2026-01-09T21:00:00.000Z" };
    expect(orderAttribution(young, other, asOf, windows)).toMatchObject({ reason: "POST_ATTRIBUTION_WINDOW_OPEN", attribution: { orders: null, net: null, complete: false } });
    expect(orderAttribution(post, other, asOf, [])).toMatchObject({ reason: "ATTRIBUTION_WINDOW_UNCONFIGURED", attribution: { orders: null, complete: false } });
    expect(orderAttribution(post, [], asOf, windows)).toEqual({ attribution: null, reason: "NO_AUTHORITATIVE_ORDER_EVIDENCE" });
  });
  it("leaves conflicting, mixed-basis and immature evidence unresolved", () => {
    expect(orderAttribution(post, [order("a", { orderId: "o4", postId: "POST1" }), order("b", { orderId: "o4", postId: "POST2" })], asOf, windows).reason).toBe("ORDER_ASSIGNMENT_CONFLICT");
    expect(orderAttribution(post, [order("a", { orderId: "o5", postId: "POST1" }), order("b", { orderId: "o6", postId: "POST1", window: "1-day view" })], asOf, windows).reason).toBe("ATTRIBUTION_BASIS_MIXED");
    expect(orderAttribution(post, [order("late", { orderId: "o7", postId: "POST1", maturationAt: "2026-02-01T00:00:00.000Z" })], asOf, windows).attribution)
      .toMatchObject({ complete: false, orders: null, net: null });
  });
});
