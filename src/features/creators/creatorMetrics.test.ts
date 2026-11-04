import { CUMULATIVE_SHARE, OWNERS, filterSocialCatBoard, filterSocialCatDashboard, searchTikTokBoard, socialCatBoardDemo, socialCatDashboardDemo, tiktokBoardDemo, tiktokDashboardDemo } from "@/fixtures/creators";
import { pipelineSources } from "@/fixtures/pipeline";
import { boardTotal, cumulativeSeries, ownerSum, pad2, rate, socialCatTotals, stageTotal } from "./creatorMetrics";

describe("Social Cat lifecycle fixture", () => {
  it("adds the five stages up to the active collaborations", () => {
    expect(socialCatBoardDemo.stages.map(stageTotal)).toEqual([24, 12, 8, 16, 6]);
    expect(boardTotal(socialCatBoardDemo)).toBe(66);
    expect(ownerSum(socialCatBoardDemo.needsDecision)).toBe(8);
    expect(ownerSum(socialCatBoardDemo.contentReady)).toBe(6);
  });

  it("filters by owner: counts follow the owner, and a sample card never outnumbers its owner's count", () => {
    for (const owner of OWNERS) {
      const data = filterSocialCatBoard(owner);
      expect(boardTotal(data)).toBe(socialCatBoardDemo.stages.reduce((a, s) => a + s.byOwner[owner], 0));
      data.stages.forEach((s) => expect(s.cards.length).toBeLessThanOrEqual(stageTotal(s)));
    }
    expect(OWNERS.reduce((a, o) => a + boardTotal(filterSocialCatBoard(o)), 0)).toBe(66);
  });

  it("keeps the cost per live video unknown, never zero", () => {
    expect(socialCatBoardDemo.costPerLiveVideo).toEqual({ state: "unknown", reasonCode: "NO_LIVE_POSTS" });
  });

  it("proposes no new upfront fee on any card", () => {
    const text = JSON.stringify(socialCatBoardDemo.stages);
    expect(text).not.toMatch(/Paid UGC|\$150 proposed/);
  });
});

describe("TikTok funnel fixture", () => {
  it("adds the nine stages up to the creators in the funnel, with posts from the posted and first-sale stages", () => {
    expect(tiktokBoardDemo.stages).toHaveLength(9);
    expect(tiktokBoardDemo.stages.reduce((a, s) => a + s.count, 0)).toBe(62);
    expect(tiktokBoardDemo.stages.filter((s) => tiktokBoardDemo.postsPublishedStages.includes(s.key)).reduce((a, s) => a + s.count, 0)).toBe(3);
  });

  it("searches every worklist column, and an empty search returns the whole list", () => {
    expect(searchTikTokBoard("").rows).toHaveLength(5);
    expect(searchTikTokBoard("operations").rows.map((r) => r.handle)).toEqual(["@dailywithjo"]);
    expect(searchTikTokBoard("  DELIVERED ").rows).toHaveLength(2);
    expect(searchTikTokBoard("nobody").rows).toEqual([]);
  });
});

describe("dashboard metrics", () => {
  it("sums the two publishing networks into the cohort totals", () => {
    const all = socialCatTotals(socialCatDashboardDemo);
    expect(all).toMatchObject({ posts: 4, measurable: 2, views: 90_000, interactions: 4_200, engagementRate: "4.67%", orders: 68 });
    expect(all.net.minorUnits).toBe(217_600);
    const instagram = socialCatTotals(filterSocialCatDashboard("instagram"));
    const tiktok = socialCatTotals(filterSocialCatDashboard("tiktok"));
    expect((instagram.views ?? 0) + (tiktok.views ?? 0)).toBe(all.views);
    expect(instagram.orders + tiktok.orders).toBe(all.orders);
    expect(instagram.net.minorUnits + tiktok.net.minorUnits).toBe(all.net.minorUnits);
    expect(instagram.engagementRate).toBe("5.00%");
  });

  it("shows no views or rate when no post is measurable, but keeps a known order count", () => {
    const none = socialCatTotals({ ...socialCatDashboardDemo, networks: { instagram: { ...socialCatDashboardDemo.networks.instagram, measurablePosts: 0 }, tiktok: { ...socialCatDashboardDemo.networks.tiktok, measurablePosts: 0 } } });
    expect(none).toMatchObject({ views: null, engagementRate: null, orders: 68 });
  });

  it("reconciles the TikTok posts with the cohort totals", () => {
    const d = tiktokDashboardDemo;
    expect(d.posts.reduce((a, p) => a + p.views, 0)).toBe(d.views);
    expect(d.posts.reduce((a, p) => a + p.orders, 0)).toBe(d.orders);
    expect(d.posts.reduce((a, p) => a + p.net.minorUnits, 0)).toBe(d.net.minorUnits);
    expect(rate(d.interactions, d.views, 1)).toBe("5.2%");
    expect(d.watchlist.reduce((a, w) => a + w.count, 0)).toBe(16);
  });

  it("scales the cumulative curve to its total, never decreasing", () => {
    const series = cumulativeSeries(90_000);
    expect(series).toHaveLength(CUMULATIVE_SHARE.length);
    expect(series.at(-1)).toBe(90_000);
    series.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(series[i]!));
    expect(cumulativeSeries(0).every((v) => v === 0)).toBe(true);
  });

  it("formats counts, and treats a missing denominator as no rate", () => {
    expect(pad2(8)).toBe("08");
    expect(pad2(24)).toBe("24");
    expect(rate(1, 0)).toBeNull();
    expect(rate(0, 5, 2)).toBe("0.00%");
  });

  it("reads the strip's figures from the pipeline fixture, so the two never drift", () => {
    expect(pipelineSources.map((s) => s.reached.slice(4))).toEqual([[27, 18, 15, 12, 9, 6], [27, 18, 15, 12, 9, 6]]);
  });
});
