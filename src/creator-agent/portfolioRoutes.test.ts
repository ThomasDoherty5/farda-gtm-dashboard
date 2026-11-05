// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "./store.ts";
import { PortfolioRepository, type StoredPortfolioReview } from "./portfolioStore.ts";
import { handlePortfolioRoute } from "./portfolioRoutes.ts";
import { PORTFOLIO_TEST_SCOPE as scope, syntheticPortfolioPacket } from "./portfolioTestFixtures.ts";

describe("portfolio routes behind the existing authenticated service", () => {
  let store: AgentStore;
  let repository: PortfolioRepository;
  const request = () => ({ method: "POST", path: "/v1/portfolio/reviews", role: "reviewer" as const, idempotencyKey: "synthetic-route-review", body: { scope, expectedVersion: 0, packet: syntheticPortfolioPacket() } });
  beforeEach(() => { store = new AgentStore(":memory:", scope); repository = new PortfolioRepository(store.database, scope); });
  afterEach(() => store.close());
  it("rejects reader writes, absent idempotency, forged scope and unknown fields", async () => {
    expect(await handlePortfolioRoute({ ...request(), role: "reader" }, repository)).toMatchObject({ status: 403, body: { code: "REVIEWER_REQUIRED" } });
    expect(await handlePortfolioRoute({ ...request(), idempotencyKey: "" }, repository)).toMatchObject({ status: 400 });
    expect(await handlePortfolioRoute({ ...request(), body: { ...request().body, scope: { ...scope, accountId: "synthetic-other" } } }, repository)).toMatchObject({ status: 409, body: { code: "PORTFOLIO_SCOPE_MISMATCH" } });
    expect(await handlePortfolioRoute({ ...request(), body: { ...request().body, approved: true } }, repository)).toMatchObject({ status: 400, body: { code: "INVALID_INPUT" } });
  });
  it("returns saved records/history for readers while a default-unverified Linear decision stays blocked", async () => {
    const saved = await handlePortfolioRoute(request(), repository);
    expect(saved!.status).toBe(200);
    const review = saved!.body as StoredPortfolioReview;
    expect(await handlePortfolioRoute({ method: "GET", path: `/v1/portfolio/reviews/${review.reviewKey}`, role: "reader" }, repository)).toEqual(saved);
    expect(await handlePortfolioRoute({ method: "GET", path: `/v1/portfolio/reviews/${review.reviewKey}/history`, role: "reader" }, repository)).toMatchObject({ status: 200, body: { reviews: [review], decisions: [], participation: [] } });
    const blocked = await handlePortfolioRoute({ ...request(), path: `/v1/portfolio/reviews/${review.reviewKey}/decisions`, idempotencyKey: "synthetic-route-decision", body: { scope, expectedVersion: 1, reviewHash: review.reviewHash, linearDecisionRef: "synthetic:unverified-decision" } }, repository);
    expect(blocked).toEqual({ status: 503, body: { code: "LINEAR_DECISION_UNVERIFIED", executionCertainty: "notApplied" } });
  });
  it("distinguishes missing records and unsupported paths without handling another module", async () => {
    expect(await handlePortfolioRoute({ method: "GET", path: `/v1/portfolio/reviews/${"0".repeat(64)}`, role: "reader" }, repository)).toMatchObject({ status: 404, body: { code: "REVIEW_NOT_FOUND" } });
    expect(await handlePortfolioRoute({ ...request(), path: "/v1/portfolio/dispatch" }, repository)).toMatchObject({ status: 404 });
    expect(await handlePortfolioRoute({ ...request(), path: "/v1/creators/synthetic" }, repository)).toBeNull();
  });
});
