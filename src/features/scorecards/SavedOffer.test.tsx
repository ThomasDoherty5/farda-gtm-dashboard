import { cleanup, screen, within } from "@testing-library/react";
import type { FardaAdapter } from "@/adapter/adapter";
import { SCHEMA_VERSION, type ReadRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import type { OfferRecord } from "@/creator-agent/offers/contract";
import { offerPolicyFixture } from "@/creator-agent/offers/policyFixture.testkit";
import { renderRoute } from "@/test/renderWithAdapter";

afterEach(cleanup);
function sourceRecord() {
  const fixture = offerPolicyFixture();
  try {
    fixture.terms.pricingVersion = "synthetic-price-v7";
    fixture.source.state.current.pricing.version = "synthetic-price-v7";
    fixture.source.state.current.pricing.bundles[0]!.merchandiseMinor = 4512;
    return fixture.save();
  } finally { fixture.store.close(); }
}
function open(record: OfferRecord) {
  const adapter: FardaAdapter = { ...createDemoAdapter(), kind: "live", environment: "sandbox",
    readView: (async (request: ReadRequest<unknown>) => ({ schemaVersion: SCHEMA_VERSION, requestId: request.requestId,
      scope: { workspaceId: "w", accountIds: ["a"], environment: "sandbox", authorizationScopeVersion: "synthetic-ui-scope" },
      dataVersion: record.version, dataState: "ready", data: record, sourceFreshness: [],
      coverage: { complete: true, expectedCount: 1, observedCount: 1, missingCount: 0, reasonCodes: [] },
      capabilities: [], page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } })) as FardaAdapter["readView"] };
  renderRoute(`/offers/${record.offerId}`, adapter);
}
describe("saved source offer prices", () => {
  it("renders the immutable source catalogue and version without relabeling candidate prices as adopted", async () => {
    open(sourceRecord());
    expect(await screen.findByText(/Saved source buyer prices · synthetic-price-v7/)).toBeInTheDocument();
    const prices = screen.getByRole("table", { name: "Buyer prices" });
    expect(within(prices).getByText("$45.12")).toBeInTheDocument();
    expect(within(prices).queryByText("$34.99")).not.toBeInTheDocument();
    expect(screen.queryByText(/Candidate CEO-v1 buyer prices/)).not.toBeInTheDocument();
  });
  it("shows missing saved source catalogue explicitly rather than falling back to candidate numbers", async () => {
    const record = sourceRecord(); delete record.commercial!.bundles; open(record);
    expect(await screen.findByText(/saved source price catalogue is unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Buyer prices" })).not.toBeInTheDocument();
    expect(screen.queryByText("$34.99")).not.toBeInTheDocument();
  });
  it("labels old unbound draft prices as candidates and retains their pending owner decision", async () => {
    const record = sourceRecord(); delete record.commercial; record.terms.pricingVersion = "CEO-v1"; open(record);
    expect(await screen.findByText(/Candidate CEO-v1 buyer prices · owner approval pending/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Buyer prices" })).getByText("$34.99")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send|publish|purchase/i })).not.toBeInTheDocument();
  });
  it("does not guess a candidate catalogue for an unknown saved price version", async () => {
    const record = sourceRecord(); delete record.commercial; open(record);
    expect(await screen.findByText(/Buyer price catalogue unverified · synthetic-price-v7/)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Buyer prices" })).not.toBeInTheDocument();
  });
});
