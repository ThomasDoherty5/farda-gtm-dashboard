import { axisMax, engagementRate, weeklyTotals, type PostCounters } from "./metrics";

const post = (over: Partial<PostCounters> = {}): PostCounters => ({ postId: "p", views: 100, likes: 5, comments: 3, shares: 2, ...over });

describe("engagementRate", () => {
  it("sums engagements and views before dividing, instead of averaging per-post rates", () => {
    const result = engagementRate([post({ views: 1_000, likes: 10, comments: 0, shares: 0 }), post({ views: 10, likes: 5, comments: 0, shares: 0 })]);
    expect(result).toMatchObject({ state: "known", engagements: 15, views: 1_010 });
    if (result.state === "known") expect(result.ratePct).toBeCloseTo((100 * 15) / 1_010);
  });

  it("excludes incomplete posts from both numerator and denominator and reports the coverage", () => {
    const result = engagementRate([post({ views: 100, likes: 10, comments: 0, shares: 0 }), post({ views: 900, shares: null })]);
    expect(result).toMatchObject({ state: "known", views: 100, engagements: 10, ratePct: 10, includedPosts: 1, excludedPosts: 1 });
  });

  it("is N/A, not zero, when no post has complete counters", () => {
    expect(engagementRate([post({ shares: null }), post({ likes: null })])).toEqual({ state: "notApplicable", reasonCode: "NO_COMPLETE_POSTS", includedPosts: 0, excludedPosts: 2 });
  });

  it("is N/A, not zero or infinity, when the denominator is zero", () => {
    expect(engagementRate([post({ views: 0 })])).toMatchObject({ state: "notApplicable", reasonCode: "ZERO_VIEWS" });
  });

  it("is N/A with no posts at all", () => {
    expect(engagementRate([])).toMatchObject({ state: "notApplicable", reasonCode: "NO_COMPLETE_POSTS" });
  });

  it("gives a measured 0% when counters are known zeros and views are positive", () => {
    expect(engagementRate([post({ likes: 0, comments: 0, shares: 0 })])).toMatchObject({ state: "known", ratePct: 0 });
  });
});

describe("weeklyTotals", () => {
  it("buckets by seven days and keeps the remainder as a short final bucket", () => {
    const day = { shopify: 100, tiktok: 50 };
    expect(weeklyTotals(Array(9).fill(day))).toEqual([1_050, 300]);
    expect(weeklyTotals([])).toEqual([]);
  });
});

describe("axisMax", () => {
  it("rounds up to the step, and never collapses to zero", () => {
    expect(axisMax([44_000, 10_000], 20_000)).toBe(60_000);
    expect(axisMax([60_000], 20_000)).toBe(60_000);
    expect(axisMax([0], 20_000)).toBe(20_000);
    expect(axisMax([], 20_000)).toBe(20_000);
  });
});
