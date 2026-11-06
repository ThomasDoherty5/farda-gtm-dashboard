import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { REWARD_LADDER, REWARD_SCENARIOS, rewardScenario, rewardsRecord, type RewardScenario } from "@/fixtures/rewards";
import type { OverviewFixtureKey } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { summarize, tierStatusText } from "./rewardLadder";
import { changedBasis, invalidationText } from "./readiness";

const scenario = (id: string): RewardScenario => rewardScenario(id)!;
const open = (path: string, fixture: OverviewFixtureKey = "FX-01-happy-read") => renderRoute(path, createDemoAdapter({ fixture }));
const REWARDS = (id: string) => `/offers/demo-offer-1/rewards?scenario=${id}`;
/** Names of every button, link or button-like control inside `root` other than the single allowed way back. */
const unexpectedControls = (root: Element) =>
  [...root.querySelectorAll<HTMLElement>("button, a[href], input[type=submit], input[type=button], [role=button], [role=link]")]
    .map((el) => (el instanceof HTMLInputElement ? el.value : (el.getAttribute("aria-label") ?? el.textContent ?? "")).trim())
    .filter((name) => name !== "Back to the offer");
const text = async (testId: string) => (await screen.findByTestId(testId)).textContent ?? "";

describe("CEO-v1 reward ladder (Offer Economics v1)", () => {
  it("ladder: $300 at $6,000, $1,200 more at $30,000, $5,000 more at $130,000; caps $300, $1,500, $6,500", () => {
    expect(REWARD_LADDER.map((t) => [t.thresholdMinor / 100, t.additionalMinor / 100, t.cumulativeCapMinor / 100])).toEqual([
      [6000, 300, 300],
      [30000, 1200, 1500],
      [130000, 5000, 6500],
    ]);
    let running = 0;
    for (const t of REWARD_LADDER) {
      running += t.additionalMinor;
      expect(t.cumulativeCapMinor).toBe(running);
    }
  });

  it("zero sales: matured revenue is a known $0, nothing is earned and progress is 0%", () => {
    const sum = summarize(scenario("zero-sales"));
    expect(sum.maturedMinor).toBe(0);
    expect(sum.earnedMinor).toBe(0);
    expect(sum.outstanding).toEqual({ state: "known", minor: 0 });
    expect(sum.next).toMatchObject({ remainingMinor: 600_000, progressPct: 0 });
    expect(sum.fardaContribution).toEqual({ state: "known", minor: 0 });
  });

  it("pending qualification: pending orders are shown but never count toward a milestone", () => {
    const sum = summarize(scenario("pending-qualification"));
    expect(sum).toMatchObject({ maturedMinor: 0, pendingMinor: 520_000, pendingOrders: 130, earnedMinor: 0 });
  });

  it("partial refund: gross over $6,000 but net under it earns nothing", () => {
    const sum = summarize(scenario("partial-refund"));
    expect(sum).toMatchObject({ grossMaturedMinor: 640_000, refundedMinor: 60_000, maturedMinor: 580_000, earnedMinor: 0 });
    expect(sum.next?.remainingMinor).toBe(20_000);
  });

  it("milestone unlock: $300 is earned and outstanding until redeemed", () => {
    const sum = summarize(scenario("milestone-unlock"));
    expect(sum.earnedMinor).toBe(30_000);
    expect(sum.outstanding).toEqual({ state: "known", minor: 30_000 });
    expect(sum.tiers[0]).toMatchObject({ earned: true, selection: "notSelected" });
    expect(sum.next?.tier.id).toBe("phone");
  });

  it("replay: the same unlock event delivered three times is claimed once", () => {
    const sum = summarize(scenario("replay"));
    expect(sum.tiers[0]).toMatchObject({ earned: true, replays: 2, claimedAt: "2026-10-30T16:00:00Z" });
    expect(sum.earnedMinor).toBe(30_000);
  });

  it("existing redemption: earned $1,500 cumulative, $300 redeemed, $1,200 outstanding", () => {
    const sum = summarize(scenario("existing-redemption"));
    expect(sum.earnedMinor).toBe(150_000);
    expect(sum.redeemed).toEqual({ state: "known", minor: 30_000 });
    expect(sum.outstanding).toEqual({ state: "known", minor: 120_000 });
  });

  it("source mirror duplicate: the same canonical orders count once, so the total stays under the threshold", () => {
    const sum = summarize(scenario("source-mirror-duplicate"));
    expect(sum.duplicateRowIds).toEqual(["TEST-BATCH-M1-MIRROR"]);
    expect(sum.maturedMinor).toBe(480_000);
    expect(sum.earnedMinor).toBe(0);
  });

  it("delayed selection: the earned obligation stays outstanding with no reward picked, and excluded orders do not count", () => {
    const sum = summarize(scenario("delayed-selection"));
    expect(sum).toMatchObject({ maturedMinor: 680_000, excludedMinor: 120_000, earnedMinor: 30_000 });
    expect(sum.tiers[0]!.selection).toBe("notSelected");
    expect(sum.outstanding).toEqual({ state: "known", minor: 30_000 });
  });

  it("incomplete cost evidence: redeemed, outstanding and contribution are unknown, never $0", () => {
    const sum = summarize(scenario("incomplete-evidence"));
    expect(sum.earnedMinor).toBe(30_000);
    expect(sum.redeemed.state).toBe("unknown");
    expect(sum.outstanding.state).toBe("unknown");
    expect(sum.fardaContribution.state).toBe("unknown");
  });

  it("the largest tier caps earned obligations at $6,500, with no monthly reset", () => {
    const sum = summarize({ ...scenario("zero-sales"), batches: [{ rowId: "TEST-BIG", canonicalId: "TEST-CAN-BIG", source: "shopify", orders: 4000, netMinor: 14_000_000, refundedMinor: 0, status: "matured" }] });
    expect(sum.earnedMinor).toBe(650_000);
    expect(sum.next).toBeNull();
    expect(JSON.stringify(REWARD_LADDER)).not.toMatch(/month/i);
  });

  describe("a refund after a claim (earned obligations are preserved)", () => {
    const base = scenario("zero-sales");
    const batch = (rowId: string, net: number, refunded: number) => ({ rowId, canonicalId: `CAN-${rowId}`, source: "shopify" as const, orders: 1, netMinor: net, refundedMinor: refunded, status: "matured" as const });
    const claimed = { eventId: "TEST-EVT-C1", tier: "tech" as const, at: "2026-10-30T16:00:00Z" };

    it("a claimed milestone stays earned when a later refund drops matured revenue under the threshold", () => {
      const sum = summarize({ ...base, batches: [batch("A", 640_000, 60_000)], events: [claimed], selections: [] });
      expect(sum.maturedMinor).toBe(580_000);
      expect(sum.tiers[0]).toMatchObject({ earned: true, claimedAt: claimed.at });
      expect(sum.earnedMinor).toBe(30_000);
      expect(sum.outstanding).toEqual({ state: "known", minor: 30_000 });
    });

    it("the refund is a separate adjustment naming the shortfall, not a deduction from earned or outstanding", () => {
      const sum = summarize({ ...base, batches: [batch("A", 640_000, 60_000)], events: [claimed], selections: [] });
      expect(sum.tiers[0]).toMatchObject({ belowThreshold: true, shortfallMinor: 20_000 });
      expect(sum.refundAdjustments).toEqual([{ tier: "tech", shortfallMinor: 20_000 }]);
    });

    it("a redeemed milestone refunded below the threshold keeps its obligation and never shows a negative outstanding", () => {
      const sum = summarize({ ...base, batches: [batch("A", 640_000, 300_000)], events: [claimed], selections: [{ tier: "tech", state: "selected", item: "AirPods (example)", selectedAt: null }], redemptions: [{ tier: "tech", amountMinor: 30_000, at: "2026-11-01T00:00:00Z" }] });
      expect(sum.earnedMinor).toBe(30_000);
      expect(sum.redeemed).toEqual({ state: "known", minor: 30_000 });
      expect(sum.outstanding).toEqual({ state: "known", minor: 0 });
    });

    it("a redemption with no claim event is still an earned milestone after a refund", () => {
      const sum = summarize({ ...base, batches: [batch("A", 640_000, 300_000)], events: [], redemptions: [{ tier: "tech", amountMinor: 30_000, at: "2026-11-01T00:00:00Z" }] });
      expect(sum.tiers[0]).toMatchObject({ earned: true, belowThreshold: true });
      expect(sum.outstanding).toEqual({ state: "known", minor: 0 });
    });

    it("an unclaimed milestone is still not earned when a refund keeps it under the threshold (the existing partial-refund case)", () => {
      const sum = summarize({ ...base, batches: [batch("A", 640_000, 60_000)], events: [], selections: [] });
      expect(sum.earnedMinor).toBe(0);
      expect(sum.refundAdjustments).toEqual([]);
    });

    it("outstanding is never negative for any refund size", () => {
      for (const refund of [0, 60_000, 300_000, 640_000, 900_000]) {
        const sum = summarize({ ...base, batches: [batch("A", 640_000, refund)], events: [claimed], selections: [], redemptions: [{ tier: "tech", amountMinor: 30_000, at: "2026-11-01T00:00:00Z" }] });
        expect(sum.outstanding.state === "known" && sum.outstanding.minor).toBeGreaterThanOrEqual(0);
        expect(sum.earnedMinor).toBe(30_000);
      }
    });
  });

  describe("source mirrors are resolved the same way in either order", () => {
    const base = scenario("zero-sales");
    const source = { rowId: "ROW-SRC", canonicalId: "CAN-1", source: "shopify" as const, orders: 5, netMinor: 400_000, refundedMinor: 0, status: "pending" as const };
    const mirror = { rowId: "ROW-MIRROR", canonicalId: "CAN-1", source: "shopify-mirror" as const, orders: 5, netMinor: 400_000, refundedMinor: 0, status: "matured" as const };

    it("a pending source row and a matured mirror give the same result whichever comes first", () => {
      const a = summarize({ ...base, batches: [source, mirror] });
      const b = summarize({ ...base, batches: [mirror, source] });
      expect(a).toEqual(b);
      expect(a.maturedMinor).toBe(0);
      expect(a.pendingMinor).toBe(400_000);
      expect(a.duplicateRowIds).toEqual(["ROW-MIRROR"]);
    });

    it("two source rows with one canonical id also resolve independently of order", () => {
      const x = { ...mirror, rowId: "ROW-B", source: "tiktok-shop" as const, netMinor: 100_000 };
      const y = { ...mirror, rowId: "ROW-A", source: "tiktok-shop" as const, netMinor: 200_000 };
      expect(summarize({ ...base, batches: [x, y] })).toEqual(summarize({ ...base, batches: [y, x] }));
    });
  });

  it("matured revenue never goes negative when refunds exceed it, and the excess is reported", () => {
    const sum = summarize({ ...scenario("zero-sales"), batches: [{ rowId: "A", canonicalId: "CAN-A", source: "shopify", orders: 1, netMinor: 100_000, refundedMinor: 250_000, status: "matured" }] });
    expect(sum.maturedMinor).toBe(0);
    expect(sum.refundExcessMinor).toBe(150_000);
    expect(sum.next!.progressPct).toBe(0);
    expect(sum.next!.remainingMinor).toBe(600_000);
  });

  it("a redeemed tier with no selection record reads Redeemed, not 'not selected'", () => {
    const sum = summarize({ ...scenario("zero-sales"), batches: [{ rowId: "A", canonicalId: "CAN-A", source: "shopify", orders: 1, netMinor: 700_000, refundedMinor: 0, status: "matured" }], selections: [], redemptions: [{ tier: "tech", amountMinor: 30_000, at: "2026-11-01T00:00:00Z" }] });
    expect(sum.tiers[0]!.selection).toBe("selected");
    expect(tierStatusText(sum.tiers[0]!, (m) => `$${m / 100}`)).toBe("Redeemed $300");
  });

  it("tier status wording: Redeemed wins over not-selected, unknown cost is said, and a locked tier says nothing more", () => {
    const money = (m: number) => `$${m / 100}`;
    const withTier = (over: object) => ({ ...summarize(scenario("milestone-unlock")).tiers[0]!, ...over });
    expect(tierStatusText(withTier({ selection: "notSelected", redeemed: null }), money)).toBe("Reward not selected yet");
    expect(tierStatusText(withTier({ selection: "notSelected", redeemed: { state: "known", minor: 30_000 } }), money)).toBe("Redeemed $300");
    expect(tierStatusText(withTier({ selection: "notSelected", redeemed: { state: "unknown", reason: "x" } }), money)).toBe("Redeemed · cost unknown");
    expect(tierStatusText(withTier({ selection: "selected", redeemed: null }), money)).toBe("Selected, not redeemed");
    expect(tierStatusText(withTier({ earned: false, selection: "locked" }), money)).toBe("");
  });

  it("covers every fixture the ticket lists", () => {
    expect(REWARD_SCENARIOS.map((s) => s.scenarioId).sort()).toEqual(["delayed-selection", "existing-redemption", "incomplete-evidence", "milestone-unlock", "partial-refund", "pending-qualification", "refund-after-claim", "replay", "source-mirror-duplicate", "zero-sales"]);
  });
});

describe("reward ladder page", () => {
  it("labels itself a recommendation pending owner approval and offers no purchase or payout control", async () => {
    open(REWARDS("milestone-unlock"));
    expect(await screen.findByTestId("rewards-recommendation")).toHaveTextContent(/Pending owner approval/);
    expect(screen.getByTestId("rewards-recommendation")).toHaveTextContent(/no purchase or payout control/);
    const page = screen.getByRole("region", { name: /Milestone rewards/ });
    // The only control the page may have is the way back; any other button or link, in any scenario, fails here.
    expect(unexpectedControls(page)).toEqual([]);
  });

  it("the control check does fail when a purchase, payout or claim control is added", () => {
    const host = document.createElement("section");
    host.innerHTML = '<a href="/offers/x">Back to the offer</a><button>Redeem reward</button><input type="submit" value="Pay creator"><div role="button">Claim</div><a href="/p">Buy now</a>';
    expect(unexpectedControls(host)).toEqual(["Redeem reward", "Pay creator", "Claim", "Buy now"]);
    const quiet = document.createElement("section");
    quiet.innerHTML = '<a href="/offers/x">Back to the offer</a>';
    expect(unexpectedControls(quiet)).toEqual([]);
  });

  it("has no purchase or payout control in any scenario", async () => {
    for (const { scenarioId } of REWARD_SCENARIOS) {
      open(REWARDS(scenarioId));
      const page = await screen.findByRole("region", { name: /Milestone rewards/ });
      await screen.findByTestId("reward-ladder");
      expect(unexpectedControls(page), scenarioId).toEqual([]);
      cleanup();
    }
  });

  it("shows the ladder with thresholds, caps, example order counts, all-in allowance and no monthly reset", async () => {
    open(REWARDS("milestone-unlock"));
    const table = await screen.findByTestId("reward-ladder");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("AirPods / tech$6,000$300$300≈ 150");
    expect(rows[1]).toHaveTextContent("Phone$30,000$1,200$1,500≈ 750");
    expect(rows[2]).toHaveTextContent("Vacation$130,000$5,000$6,500≈ 3,250");
    expect(screen.getAllByText(/all-in/).length).toBeGreaterThan(0);
    expect(screen.getByText(/no monthly reset/)).toBeInTheDocument();
  });

  it("shows canonical matured revenue, progress to the next tier and obligations beside commission and contribution", async () => {
    open(REWARDS("existing-redemption"));
    expect(await text("metric-matured")).toBe("$30,300");
    expect(await text("next-progress")).toMatch(/\$30,300 of \$130,000 toward Vacation/);
    expect(await text("obl-earned")).toBe("$1,500");
    expect(await text("obl-redeemed")).toBe("$300");
    expect(await text("obl-outstanding")).toBe("$1,200");
    expect(await text("obl-commission")).toMatch(/\$6,060\.00/);
    expect(await text("obl-contribution")).toMatch(/^\$/);
    expect(screen.getByTestId("rewards-paused")).toHaveTextContent(/Earned obligations are preserved/);
  });

  it("distinguishes guaranteed earned rewards from prohibited upfront content fees", async () => {
    open(REWARDS("milestone-unlock"));
    const panel = await screen.findByRole("region", { name: /Earned rewards are not upfront fees/ });
    expect(within(panel).getByText("Guaranteed earned reward")).toBeInTheDocument();
    expect(within(panel).getByText("Prohibited")).toBeInTheDocument();
    expect(within(panel).getByText(/historical fees stay read-only/)).toBeInTheDocument();
  });

  it("incomplete evidence shows N/A with a reason, not $0", async () => {
    open(REWARDS("incomplete-evidence"));
    expect(await text("obl-contribution")).toMatch(/^N\/A/);
    expect(await text("obl-redeemed")).toMatch(/^N\/A/);
    expect(await text("obl-outstanding")).toMatch(/^N\/A/);
    expect(screen.getByTestId("obl-contribution")).not.toHaveTextContent("$0");
  });

  it("a refund after a claim reads as a kept obligation with a separate adjustment, never a negative outstanding", async () => {
    open(REWARDS("refund-after-claim"));
    expect(await text("obl-earned")).toBe("$300");
    expect(await text("obl-outstanding")).toBe("$300");
    expect(screen.getByTestId("rewards-refund-adjustment")).toHaveTextContent(/\$200 under the \$6,000 threshold/);
    expect(screen.getByTestId("rewards-refund-adjustment")).toHaveTextContent(/preserved/);
    expect(screen.getByTestId("tier-tech")).toHaveTextContent(/Earned/);
    expect(screen.getByTestId("obl-outstanding").textContent).not.toMatch(/-/);
  });

  it("the refunded scenario still reports canonical matured revenue net of the refund", async () => {
    open(REWARDS("refund-after-claim"));
    expect(await text("metric-matured")).toBe("$5,800");
  });

  it("replay and mirror duplicates are called out as ignored", async () => {
    open(REWARDS("replay"));
    expect(await screen.findByTestId("rewards-replay")).toHaveTextContent(/2 repeated deliveries/);
  });

  it("switching the demo scenario changes the data and the address", async () => {
    const user = userEvent.setup();
    const router = open(REWARDS("zero-sales"));
    expect(await text("metric-matured")).toBe("$0");
    await user.selectOptions(await screen.findByLabelText("Fixture scenario"), "partial-refund");
    await waitFor(() => expect(router.state.location.search).toBe("?scenario=partial-refund"));
    await waitFor(async () => expect(await text("metric-matured")).toBe("$5,800"));
  });

  it("an unknown scenario is a not-found state, not an empty ladder", async () => {
    open(REWARDS("nope"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Record not found|does not exist/i);
    expect(screen.queryByTestId("reward-ladder")).not.toBeInTheDocument();
  });

  it("the live adapter shows an honest pending state and no demo data", async () => {
    renderRoute(REWARDS("milestone-unlock"), createLiveAdapter("sandbox"));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("reward-ladder")).not.toBeInTheDocument();
    expect(screen.queryByTestId("metric-matured")).not.toBeInTheDocument();
  });

  it("a forbidden account shows no reward data", async () => {
    open(REWARDS("milestone-unlock"), "FX-08-forbidden-account");
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to this account");
    expect(screen.queryByTestId("metric-matured")).not.toBeInTheDocument();
  });
});

describe("FE05-05 currency and provider compatibility", () => {
  it("states currency and provider compatibility, with unverified routes left unverified", async () => {
    open(REWARDS("milestone-unlock"));
    const table = await screen.findByTestId("provider-compat");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Shopify website · Collabs candidateUSD onlyDocumentedNot supported on the documented route");
    expect(rows[1]).toHaveTextContent("Unverified in this build");
  });

  it("the offer's commitment preview names rate, base, currency and the chosen provider's compatibility", async () => {
    const user = userEvent.setup();
    open("/offers/demo-offer-1");
    await user.click(await screen.findByRole("button", { name: "Review commitment" }));
    const dialog = (await screen.findAllByRole("dialog", { hidden: true })).find((d) => d.querySelector("h2"))!;
    expect(within(dialog).getByText(/15% of eligible merchandise · USD only, no conversion/)).toBeInTheDocument();
    expect(within(dialog).getByText(/fixed per qualified sale not supported on this route/)).toBeInTheDocument();
  });
});

describe("FE05-03 changed media, terms or policy invalidates readiness", () => {
  it("compares what was assessed with the current basis, and an unknown basis claims nothing", () => {
    const basis = { media: "m1", terms: "t1", policy: "p1" };
    expect(changedBasis({ assessedBasis: basis, currentBasis: basis })).toEqual({ known: true, changed: [] });
    expect(changedBasis({ assessedBasis: basis, currentBasis: { ...basis, terms: "t2", policy: "p2" } }).changed).toEqual(["terms", "policy"]);
    expect(changedBasis({}).known).toBe(false);
    expect(invalidationText(["media"])).toBe("Readiness invalidated: media changed since this was assessed");
  });

  it.each(["media", "terms", "policy"])("a changed %s shows readiness invalidated on the scorecard", async (part) => {
    // Load the route module before timing its adapter invalidation assertion.
    await import("./AssessmentPage");
    open(`/creators/demo-creator-1/assessments/demo-assessment-content--${part}`);
    expect(await screen.findByTestId("readiness-invalidated")).toHaveTextContent(new RegExp(`Readiness invalidated: .*${part === "terms" ? "accepted terms" : part}`));
    expect(screen.queryByText("Not approved to send")).not.toBeInTheDocument();
  });

  it("the commerce scorecard invalidates too, and an unchanged snapshot shows no invalidation", async () => {
    open("/creators/demo-creator-1/assessments/demo-assessment-sc-commerce--terms");
    expect(await screen.findByTestId("readiness-invalidated")).toBeInTheDocument();
  });

  it("an unchanged snapshot shows no invalidation", async () => {
    open("/creators/demo-creator-1/assessments/demo-assessment-content");
    await screen.findByTestId("score");
    expect(screen.queryByTestId("readiness-invalidated")).not.toBeInTheDocument();
  });
});

describe("the live adapter can check the reward view", () => {
  it("every demo scenario parses unchanged against the offerRewards schema", async () => {
    const { scorecardsViewSchemas } = await import("@/adapter/viewSchemas/scorecards");
    const schema = scorecardsViewSchemas.offerRewards!;
    for (const s of REWARD_SCENARIOS) {
      const record = rewardsRecord(s.scenarioId)!;
      expect(schema.parse(record), s.scenarioId).toEqual(record);
    }
  });
  it("a redemption with a missing amount stays null, never 0", async () => {
    const { scorecardsViewSchemas } = await import("@/adapter/viewSchemas/scorecards");
    const parsed = scorecardsViewSchemas.offerRewards!.parse(rewardsRecord("incomplete-evidence")) as { scenario: { redemptions: { amountMinor: number | null }[] } };
    expect(parsed.scenario.redemptions[0]!.amountMinor).toBeNull();
  });
});
