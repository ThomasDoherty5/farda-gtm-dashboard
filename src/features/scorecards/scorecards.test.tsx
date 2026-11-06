import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SCHEMA_VERSION, type SaveResourceRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createDemoOffers } from "@/adapter/demoScorecards";
import { AdapterError } from "@/adapter/errors";
import { commerceScorecard, contentScorecard, offerDraftSeed, tiktokScorecard, type OfferDraftPayload } from "@/fixtures/scorecards";
import type { OverviewFixtureKey } from "@/fixtures/overview";
import { renderRoute } from "@/test/renderWithAdapter";
import { bandOf, economics, parseCommission, parseDollars, pointsOf, scoreOf } from "./scorecardMath";
import { waterfallBars } from "./waterfall";

const open = (path: string, fixture: OverviewFixtureKey = "FX-01-happy-read") => renderRoute(path, createDemoAdapter({ fixture }));
const CONTENT = "/creators/demo-creator-1/assessments/demo-assessment-content";
const TIKTOK = "/creators/demo-creator-1/assessments/demo-assessment-tiktok";
const COMMERCE = "/creators/demo-creator-1/assessments/demo-assessment-sc-commerce";
const OFFER = "/offers/demo-offer-1";
const metric = (id: string) => screen.findByTestId(`metric-${id}`);
/** jsdom has no modal dialog, so an open dialog counts as hidden. Closed dialogs render no heading, so the open one has a title. */
const openDialog = async () => {
  await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true }).some((d) => d.querySelector("h2"))).toBe(true));
  return screen.getAllByRole("dialog", { hidden: true }).find((d) => d.querySelector("h2"))!;
};

describe("scores and economics", () => {
  it("points are weight × rating ÷ 5 and the totals are the design's 84, 86 and 82", () => {
    expect(scoreOf(contentScorecard.criteria)).toMatchObject({ total: 84, max: 100, complete: true });
    expect(scoreOf(tiktokScorecard.criteria).total).toBe(86);
    expect(scoreOf(commerceScorecard.criteria).total).toBe(82);
    expect(pointsOf({ label: "x", rating: 4, weight: 25 })).toBe(20);
  });

  it("the independent content score beside commerce is the content scorecard's own total, never an average", () => {
    expect(commerceScorecard.contentScore).toBe(scoreOf(contentScorecard.criteria).total);
  });

  it("an unrated criterion is unknown, is not zero and is never rescaled", () => {
    const partial = contentScorecard.criteria.map((c, i) => (i === 0 ? { ...c, rating: null } : c));
    const s = scoreOf(partial);
    expect(s.total).toBeNull();
    expect(s.complete).toBe(false);
    expect(s.unknownCount).toBe(1);
    expect(pointsOf(partial[0]!)).toBeNull();
    expect(bandOf(s.total)).toBe("Needs data");
  });

  it("proposed historical bands are 80, 65 and below", () => {
    expect([bandOf(80), bandOf(79), bandOf(65), bandOf(64)]).toEqual(["Priority review", "Manual review", "Manual review", "Hold"]);
  });

  it("the draft economics are the design's: $608.04 at 40 orders, $133.26 at 10, break-even 2 orders", () => {
    const e = economics(offerDraftSeed.assumptions, offerDraftSeed.payload);
    expect(e.unit).toBeCloseTo(15.826, 6);
    expect(e.base).toMatchObject({ netSales: 1600, commerceCosts: 720, commission: 240, contribution: 608.04 });
    expect(e.base.providerFee).toBeCloseTo(6.96, 6);
    expect(e.downside.contribution).toBe(133.26);
    expect(e.breakEven).toBe(2);
  });

  it("an order that loses money has no break-even, and the waterfall keeps one scale", () => {
    expect(economics({ ...offerDraftSeed.assumptions, commerceCostMinor: 4000 }, offerDraftSeed.payload).breakEven).toBeNull();
    const bars = waterfallBars(economics(offerDraftSeed.assumptions, offerDraftSeed.payload).base);
    expect(bars.map((b) => b.height)).toEqual([244, 110, 37, 1, 1, 4, 93]);
    expect(bars.map((b) => b.value)).toEqual(["$1,600", "−$720", "−$240", "−$6.96", "$0", "−$25", "$608.04"]);
  });

  it("commission and sample inputs reject out-of-range and non-numeric text", () => {
    expect(parseCommission("15% of eligible merchandise")).toEqual({ pct: 15, error: null });
    expect(parseCommission("0%").pct).toBeNull();
    expect(parseCommission("101%").pct).toBeNull();
    expect(parseCommission("fifteen").error).toMatch(/percentage/);
    expect(parseDollars("$25")).toEqual({ minor: 2500, error: null });
    expect(parseDollars("-5").minor).toBeNull();
    expect(parseDollars("$25.999").minor).toBeNull();
  });
});

describe("historical scorecards (37:74, 37:251)", () => {
  it("shows the content scorecard as a read-only historical snapshot with the weighted breakdown", async () => {
    open(CONTENT);
    expect(await screen.findByRole("heading", { level: 1, name: "A good fit should be easy to explain." })).toBeInTheDocument();
    expect(await screen.findByTestId("score")).toHaveTextContent("84");
    expect(screen.getByText("Historical model snapshot")).toBeInTheDocument();
    expect(screen.getByText("Rating 4 / 5 · weight 25")).toBeInTheDocument();
    expect(screen.getByText("20 / 25")).toBeInTheDocument();
    expect(screen.getByText("Recommend priority review. Keep the human gate.")).toBeInTheDocument();
    expect(screen.getByText("Not approved to send")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "SC scorecard" })).toHaveAttribute("aria-current", "page");
  });

  it("the TikTok record picks its own layout from the returned kind", async () => {
    open(TIKTOK);
    expect(await screen.findByRole("heading", { level: 1, name: "Commerce potential, with proof." })).toBeInTheDocument();
    expect(await screen.findByTestId("score")).toHaveTextContent("86");
    expect(screen.getByRole("link", { name: "TT scorecard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText(/current TikTok Shop assessment uses its own published configuration/)).toBeInTheDocument();
  });

  it("FX-04: a missing rating shows Needs data and no total, instead of a rescaled score", async () => {
    open(CONTENT, "FX-04-missing-metric");
    expect(await screen.findByTestId("score")).toHaveTextContent("N/A");
    expect(screen.getAllByText("Needs data").length).toBeGreaterThan(0);
    expect(screen.getByText(/there is no total\. Unknown is not zero/)).toBeInTheDocument();
    expect(screen.getByText("Needs data. Keep the human gate.")).toBeInTheDocument();
  });

  it("CTRL-064: Hold candidate is read-only, with its reason", async () => {
    const user = userEvent.setup();
    open(CONTENT);
    const hold = await screen.findByRole("button", { name: "Hold candidate" });
    expect(hold).toHaveAttribute("aria-disabled", "true");
    expect(hold).toHaveAccessibleDescription(/read-only: no current opportunity/);
    await user.click(hold);
    expect(screen.queryByRole("dialog", { name: /hold/i, hidden: true })).not.toBeInTheDocument();
  });

  it("CTRL-066 and CTRL-067: anchors and history are read-only dialogs labeled proposed and immutable", async () => {
    const user = userEvent.setup();
    open(CONTENT);
    await user.click(await screen.findByRole("button", { name: "Rating anchors" }));
    let dialog = await openDialog();
    expect(within(dialog).getByText(/These anchors describe the historical model/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Close", hidden: true }));
    await user.click(screen.getByRole("button", { name: "Assessment history" }));
    await waitFor(async () => expect(within(await openDialog()).getByText(/Earlier versions are immutable/)).toBeInTheDocument());
    dialog = await openDialog();
    expect(within(dialog).getByText(/Model SC-v1/)).toBeInTheDocument();
  });

  it("evidence opens read-only with unknowns kept, and links to the current evidence review", async () => {
    const user = userEvent.setup();
    open(CONTENT);
    await user.click(await screen.findByRole("button", { name: "View evidence: Audience & response" }));
    const dialog = await openDialog();
    expect(within(dialog).getByText(/Metric window and source URL/)).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open lifestyle evidence review", hidden: true })).toHaveAttribute("href", "/creators/demo-creator-1/evidence/demo-evidence-1");
  });

  it("an unknown assessment shows a not-found state, not an empty scorecard", async () => {
    open("/creators/demo-creator-1/assessments/nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("Record not found");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
  });

  it("a forbidden account shows no scorecard data", async () => {
    open(CONTENT, "FX-08-forbidden-account");
    expect(await screen.findByRole("alert")).toHaveTextContent("No access to this account");
    expect(screen.queryByTestId("score")).not.toBeInTheDocument();
  });
});

describe("Social Cat commerce scorecard (65:814)", () => {
  it("keeps commerce and content scores separate, derived from the rows", async () => {
    open(COMMERCE);
    expect(await metric("commerce-fit")).toHaveTextContent("82 / 100");
    expect(await metric("content-score")).toHaveTextContent("84 / 100");
    expect(screen.getByText("CONTENT-v2 · independent score, never averaged with commerce")).toBeInTheDocument();
    expect(screen.getByText(/forecast contribution \$608\.04 at 40 orders \/ \$133\.26 at 10 orders/)).toBeInTheDocument();
    expect(screen.getByText(/New upfront-fee offers are blocked under the current policy/)).toBeInTheDocument();
  });

  it("CTRL-115 and CTRL-116: evidence and cohort open read-only with their unknowns", async () => {
    const user = userEvent.setup();
    open(COMMERCE);
    await user.click(await screen.findByRole("button", { name: "Inspect evidence" }));
    expect(within(await openDialog()).getByText(/Native order records aren't in this fixture/)).toBeInTheDocument();
    await user.click(within(await openDialog()).getByRole("button", { name: "Close", hidden: true }));
    await user.click(screen.getByRole("button", { name: "Inspect cohort" }));
    await waitFor(async () => expect(within(await openDialog()).getByText(/not current-stage exclusive counts/)).toBeInTheDocument());
  });

  it("the model tabs expose the current one", async () => {
    open(COMMERCE);
    expect(await screen.findByRole("link", { name: "Website commerce" })).toHaveAttribute("aria-current", "page");
  });
});

describe("offer and economics (65:634)", () => {
  it("shows the commission-only draft with a locked $0 upfront fee and no approved rate", async () => {
    open(OFFER);
    expect(await screen.findByRole("heading", { level: 1, name: "Terms that make sense." })).toBeInTheDocument();
    expect(await metric("base-contribution")).toHaveTextContent("$608.04");
    expect(await metric("break-even")).toHaveTextContent("2 orders");
    expect(await metric("downside")).toHaveTextContent("$133.26");
    expect(screen.getByLabelText("Upfront content fee")).toHaveValue("$0 · locked by policy");
    expect(screen.getByLabelText("Upfront content fee")).toHaveAttribute("readonly");
    expect(screen.getByText("Commission-only draft · no Farda rate is approved")).toBeInTheDocument();
    expect(screen.getByLabelText("Objective")).toHaveValue("Website affiliate sales");
    expect(screen.getByText("WEBSITE-AFFILIATE-v3 · historical draft preview")).toBeInTheDocument();
  });

  it("CTRL-103 to CTRL-105: the historical offer types are disabled, with their reason", async () => {
    open(OFFER);
    for (const name of ["Gifted · history", "Paid · history", "Hybrid · history"]) {
      const tab = await screen.findByRole("tab", { name });
      expect(tab).toHaveAttribute("aria-disabled", "true");
      expect(tab).toHaveAccessibleDescription(/editing or duplicating them cannot create a new upfront fee offer/);
    }
    expect(screen.getByRole("tab", { name: "Affiliate · current" })).toHaveAttribute("aria-selected", "true");
  });

  it("CTRL-113: fixed per qualified sale is gated with a visible reason", async () => {
    open(OFFER);
    const fixed = await screen.findByRole("button", { name: "Fixed per qualified sale" });
    expect(fixed).toHaveAttribute("aria-disabled", "true");
    expect(fixed).toHaveAccessibleDescription(/requires a verified compatible provider/);
  });

  it("CTRL-106 and CTRL-108: the objective follows the verified checkout, not a free choice", async () => {
    const user = userEvent.setup();
    open(OFFER);
    await user.selectOptions(await screen.findByLabelText("Checkout and commission provider"), "tiktok-shop");
    expect(screen.getByLabelText("Objective")).toHaveValue("TikTok Shop affiliate sales");
    expect(screen.getByText("TIKTOK-SHOP-AFFILIATE-v3 · historical draft preview")).toBeInTheDocument();
  });

  it("CTRL-109: editing the commission recomputes the economics and marks the draft as edited", async () => {
    const user = userEvent.setup();
    open(OFFER);
    const field = await screen.findByLabelText("Commission type");
    await user.clear(field);
    await user.type(field, "20% of eligible merchandise");
    // 40 − 18 − 8 − 0.232 = 13.768 per order; 40 orders less the $25 sample is $525.72.
    expect(await metric("base-contribution")).toHaveTextContent("$525.72");
    expect(screen.getByText(/Approval readiness is cleared until the draft is saved/)).toBeInTheDocument();
  });

  it("CTRL-101: an invalid draft is not saved, and the errors stay on the fields", async () => {
    const user = userEvent.setup();
    open(OFFER);
    const field = await screen.findByLabelText("Commission type");
    await user.clear(field);
    await user.type(field, "150%");
    await user.click(screen.getByRole("button", { name: "Save offer draft" }));
    expect(await screen.findByText("The percentage must be above 0 and at most 100.")).toBeInTheDocument();
    expect(screen.queryByText(/Draft saved as version/)).not.toBeInTheDocument();
    expect(field).toHaveValue("150%");
  });

  it("CTRL-101: a valid save shows the version the server acknowledged and activates nothing", async () => {
    const user = userEvent.setup();
    open(OFFER);
    const field = await screen.findByLabelText("Commission type");
    await user.clear(field);
    await user.type(field, "12% of eligible merchandise");
    await user.click(screen.getByRole("button", { name: "Save offer draft" }));
    expect(await screen.findByText(/Draft saved as version v2, as acknowledged by the offer service\. Nothing was activated or sent\./)).toBeInTheDocument();
    expect(field).toHaveValue("12% of eligible merchandise");
  });

  it("CTRL-102 and CTRL-114: the previews are read-only and name what blocks readiness", async () => {
    const user = userEvent.setup();
    open(OFFER);
    await user.click(await screen.findByRole("button", { name: "Review commitment" }));
    const preview = await openDialog();
    expect(within(preview).getByText("Blocked: native eligible base is unverified")).toBeInTheDocument();
    expect(within(preview).getByText(/doesn't approve, invite or reserve stock/)).toBeInTheDocument();
    await user.click(within(preview).getByRole("button", { name: "Close", hidden: true }));
    await user.click(screen.getByRole("button", { name: "Review approval payload" }));
    await waitFor(async () => expect(within(await openDialog()).getByText(/an old approval is never reused/)).toBeInTheDocument());
  });

  it("an unknown offer shows not found with a heading and no terms", async () => {
    open("/offers/nope");
    expect(await screen.findByRole("alert")).toHaveTextContent("Record not found");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByLabelText("Commission type")).not.toBeInTheDocument();
  });
});

describe("the offer service rejects what the UI would never send", () => {
  const request = (payload: Partial<OfferDraftPayload>, expectedVersion = "v1", key = "k1"): SaveResourceRequest<OfferDraftPayload> => ({
    schemaVersion: SCHEMA_VERSION,
    operation: "saveResource",
    requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" },
    resourceKind: "actionDraft",
    resourceRef: "demo-offer-1",
    expectedVersion,
    idempotencyKey: key,
    requestId: "r",
    payload: { ...offerDraftSeed.payload, ...payload },
  });
  const failure = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AdapterError; } throw new Error("expected a failure"); };

  it("CTRL-110: a manipulated nonzero upfront fee is refused and nothing is saved", async () => {
    const offers = createDemoOffers();
    const error = await failure(offers.save(request({ upfrontFeeMinor: 50_000 })));
    expect(error.body.code).toBe("POLICY_VIOLATION");
    expect(error.body.fieldErrors?.upfrontFee).toMatch(/not permitted/);
    expect(error.body.executionCertainty).toBe("notApplied");
  });

  it("CTRL-113: fixed per qualified sale is refused until a provider contract allows it", async () => {
    const error = await failure(createDemoOffers().save(request({ compensation: "fixedPerSale" })));
    expect(error.body.fieldErrors?.compensation).toMatch(/verified compatible provider/);
  });

  it("a stale version is a conflict that carries the current version, and the same key returns the first result", async () => {
    const offers = createDemoOffers();
    const first = await offers.save(request({ commissionPct: 18 }));
    expect(first.resourceVersion).toBe("v2");
    expect((await offers.save(request({ commissionPct: 18 }))).resourceVersion).toBe("v2");
    const conflict = await failure(offers.save(request({ commissionPct: 19 }, "v1", "k2")));
    expect(conflict.category).toBe("conflict");
    expect(conflict.body.currentVersion).toBe("v2");
    const changed = await failure(offers.save(request({ commissionPct: 20 }, "v1", "k1")));
    expect(changed.body.code).toBe("MANIFEST_CHANGED");
  });
});
