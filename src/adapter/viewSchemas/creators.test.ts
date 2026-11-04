import { creatorsViewSchemas as schemas } from "./creators";
import { REMOVE, expectAllParse, expectRejections, readVariants } from "./acquisitionTestKit";
import { OWNERS, socialCatBoardDemo, socialCatDashboardDemo, tiktokBoardDemo, tiktokDashboardDemo } from "@/fixtures/creators";

const owners = ["all", ...OWNERS];
const networks = ["all", "instagram", "tiktok"];

describe("creators view schemas", () => {
  it("covers exactly the four creators view keys", () => {
    expect(Object.keys(schemas).sort()).toEqual(["socialCatBoard", "socialCatDashboard", "tiktokBoard", "tiktokDashboard"]);
  });

  describe("every demo variant parses unchanged", () => {
    it("socialCatBoard for all owners and every ?fixture= switch", async () => {
      const variants = await readVariants("socialCatBoard", owners.map((owner) => ({ owner })));
      expect(expectAllParse(schemas.socialCatBoard!, variants)).toBe(owners.length * 9);
    });
    it("socialCatDashboard for every network and fixture", async () => {
      const variants = await readVariants("socialCatDashboard", networks.map((network) => ({ network })));
      expect(expectAllParse(schemas.socialCatDashboard!, variants)).toBe(networks.length * 9);
    });
    it("tiktokBoard for no query, matches, an empty result and a padded query", async () => {
      const queries = ["", "mira", "today", "operator", "  Delivered  ", "no-such-creator"];
      const variants = await readVariants("tiktokBoard", queries.map((q) => ({ q })));
      expect(expectAllParse(schemas.tiktokBoard!, variants)).toBe(queries.length * 9);
      expect((variants.find((v) => v.label.includes("no-such-creator"))!.response!.data as { rows: unknown[] }).rows).toHaveLength(0);
    });
    it("tiktokDashboard for every fixture", async () => {
      expect(expectAllParse(schemas.tiktokDashboard!, await readVariants("tiktokDashboard", [{}]))).toBe(9);
    });
  });

  describe("socialCatBoard rejects", () => {
    expectRejections(schemas.socialCatBoard!, socialCatBoardDemo, [
      ["a missing stages list", "stages", REMOVE],
      ["a missing next decision", "nextDecision", REMOVE],
      ["a text count", "needsDecision.Thomas", "3"],
      ["a fractional count", "stages.0.byOwner.Thomas", 1.5],
      ["a negative count", "contentReady.Operator", -1],
      ["a missing owner in the counts", "needsDecision.Operator", REMOVE],
      ["an unknown badge tone", "stages.0.cards.0.status.tone", "red"],
      ["an unknown card owner", "stages.0.cards.0.owner", "Everyone"],
      ["an unknown owner filter", "owner", "Everyone"],
      ["a known zero cost per live video", "costPerLiveVideo", { state: "known", value: 0, reasonCode: null }],
      ["a value smuggled into the unknown cost", "costPerLiveVideo", { state: "unknown", reasonCode: "NO_LIVE_POSTS", value: 0 }],
      ["an unknown cost with no reason", "costPerLiveVideo.reasonCode", ""],
      ["an extra owner in the counts", "needsDecision", { ...socialCatBoardDemo.needsDecision, Everyone: 4 }],
    ]);
  });

  describe("socialCatDashboard rejects", () => {
    expectRejections(schemas.socialCatDashboard!, socialCatDashboardDemo, [
      ["a missing cohort", "cohort", REMOVE],
      ["a missing TikTok network", "networks.tiktok", REMOVE],
      ["a text view count", "networks.instagram.views", "50000"],
      ["a null order count (unknown is not an order count here)", "networks.instagram.orders", null],
      ["negative net minor units", "networks.instagram.net.minorUnits", -1],
      ["fractional net minor units", "networks.tiktok.net.minorUnits", 88_000.5],
      ["a currency code of the wrong length", "networks.tiktok.net.currency", "US"],
      ["negative pilot refunds", "pilot.refunds.minorUnits", -20_000],
      ["fractional pilot commission", "pilot.grossCommission.minorUnits", 30_000.25],
      ["a pilot amount without minor units", "pilot.cashCommissionPaid", { currency: "USD" }],
      ["an unknown network", "network", "facebook"],
      ["more measurable posts than posts", "networks.instagram.measurablePosts", 3],
      ["more samples in transit and delivered than in total", "samples.total", 7],
    ]);
  });

  describe("tiktokBoard rejects", () => {
    expectRejections(schemas.tiktokBoard!, tiktokBoardDemo, [
      ["missing rows", "rows", REMOVE],
      ["a text stage count", "stages.0.count", "24"],
      ["a null stage count", "stages.0.count", null],
      ["a negative awaiting-approval count", "awaitingApproval", -7],
      ["an unknown row owner", "rows.0.owner", "Nobody"],
      ["known attributed sales of zero", "attributedSales", { state: "known", value: 0, reasonCode: null }],
      ["a value smuggled into unknown attributed sales", "attributedSales", { state: "unknown", reasonCode: "ATTRIBUTION_NOT_VERIFIED", value: 0 }],
      ["unknown attributed sales with no state", "attributedSales.state", "pending"],
      ["a non-text query echo", "query", 5],
    ]);
  });

  describe("tiktokDashboard rejects", () => {
    expectRejections(schemas.tiktokDashboard!, tiktokDashboardDemo, [
      ["a missing cohort", "cohort", REMOVE],
      ["a missing net amount", "net", REMOVE],
      ["a text order count", "orders", "112"],
      ["fractional net minor units", "net.minorUnits", 362_000.5],
      ["negative net minor units", "net.minorUnits", -362_000],
      ["negative post net minor units", "posts.0.net.minorUnits", -1],
      ["fractional post net minor units", "posts.1.net.minorUnits", 99_500.1],
      ["more measured orders than all shop orders", "orders", 141],
      ["more measurable posts than posts", "cohort.measurablePosts", 6],
      ["a watchlist entry with a text count", "watchlist.0.count", "4"],
    ]);
  });
});
