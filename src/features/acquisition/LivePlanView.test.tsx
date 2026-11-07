import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReadRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { TransportFailure, type Transport } from "@/adapter/transport";
import { AgentStore } from "@/creator-agent/store";
import { createSourcingPlanReader } from "@/creator-agent/sourcing/reader";
import type { SourcingSnapshot } from "@/creator-agent/sourcing/source";
import { sourcingSourceFixture, sourcingTestScope as scope, sourcingTestSecret as secret, sourcingTestTime } from "@/creator-agent/sourcing/fixtures.testkit";
import { renderRoute } from "@/test/renderWithAdapter";

const stores: AgentStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

/** The real server-side projection, wrapped in the envelope the service sends, so the live adapter checks it against the registry. */
function served(snapshot: SourcingSnapshot | null, at = sourcingTestTime, role: "reader" | "reviewer" = "reviewer") {
  const store = new AgentStore(":memory:", scope); stores.push(store);
  const reader = createSourcingPlanReader({ db: store.database, scope, secret, now: () => at, source: snapshot ? async () => structuredClone(snapshot) : undefined });
  const requests: ReadRequest<unknown>[] = [];
  const transport: Transport = { send: async ({ envelope }) => {
    const request = envelope as ReadRequest<unknown>;
    requests.push(request);
    const result = await reader.read(request.filters, role);
    return { schemaVersion: request.schemaVersion, requestId: request.requestId, scope: { ...request.requestedScope, authorizationScopeVersion: "synthetic-scope-v1" },
      dataVersion: result.version, dataState: result.dataState, data: result.data, sourceFreshness: [], coverage: result.coverage,
      capabilities: result.capabilities, page: { nextCursor: null, hasMore: false }, refresh: { nextPollAfterMs: null } };
  } };
  return { adapter: createLiveAdapter("sandbox", { transport }), requests };
}
const table = (name: string) => screen.getByRole("table", { name });
const row = (name: string, label: string) => within(table(name)).getByRole("row", { name: new RegExp(`^${label}`) });

describe("the live daily plan detail", () => {
  it("reads the served plan and shows schedule, steps, native-unit capacity, identity and run states", async () => {
    const { adapter, requests } = served(sourcingSourceFixture());
    renderRoute("/creators/discovery?view=plan", adapter);
    expect(await screen.findByTestId("live-plan-schedule")).toHaveTextContent("Active");
    expect(requests.map((r) => [r.viewKey, r.filters])).toEqual([["sourcingPlan", {}]]);
    expect(screen.getByTestId("live-plan-account-social-cat")).toHaveTextContent("Account read · Access verified · session open");
    expect(row("Daily plan steps", "Qualification")).toHaveTextContent("Unknown · J20_REVIEW_INCOMPLETE");
    expect(row("Daily plan steps", "Invitation planning")).toHaveTextContent(/Invitation planning0Operator/);
    expect(row("Source capacity in native units", "TikTok Shop · Invitations")).toHaveTextContent("Unknown · SOURCE_LIMIT_NOT_PUBLISHED");
    expect(row("Source capacity in native units", "TikTok Shop · Invitations")).toHaveTextContent("Blocked · CAPACITY_UNKNOWN");
    expect(row("Source capacity in native units", "Social Cat · Invitations")).toHaveTextContent("30 invitations");
    expect(row("Source capacity in native units", "Shared · Authorized cost")).toHaveTextContent("$300");
    expect(row("Identity, duplicates and suppression", "Existing relationship")).toHaveTextContent("Unknown · RELATIONSHIP_LEDGER_NOT_READ");
    expect(row("Latest run states", "Uncertain")).toHaveTextContent("Unknown · RECEIPT_NOT_RECONCILED");
    expect(screen.getByTestId("live-plan-run-totals")).toHaveTextContent("Confirmed unique invitations2 · 2 receipts");
    expect(screen.getByTestId("view-partial")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request approval for a batch/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => /demo-/.test(h ?? ""))).toEqual([]);
  });

  it("never shows a schedule as active when a browser session is closed", async () => {
    const snapshot = sourcingSourceFixture(); snapshot.sources[1]!.session = "closed";
    renderRoute("/creators/discovery?view=plan", served(snapshot).adapter);
    expect(await screen.findByTestId("live-plan-schedule")).toHaveTextContent("Draft · not active · source claims active");
    expect(screen.getByTestId("live-plan-schedule-holds")).toHaveTextContent("BROWSER_SESSION_CLOSED:tiktok-shop");
  });

  it("labels a lapsed source as stale and every capacity row as blocked", async () => {
    renderRoute("/creators/discovery?view=plan", served(sourcingSourceFixture(), sourcingTestTime + 2 * 3600_000).adapter);
    expect(await screen.findByTestId("view-stale")).toBeInTheDocument();
    const rows = within(table("Source capacity in native units")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    // An unknown row stays unknown when the lease lapses; every row is blocked either way.
    for (const r of rows) expect(r).toHaveTextContent(/Blocked · CAPACITY_(LEASE_EXPIRED|UNKNOWN)/);
    expect(rows.filter((r) => /CAPACITY_LEASE_EXPIRED/.test(r.textContent ?? ""))).toHaveLength(3);
  });

  it("says an unconfigured source is not connected, with no plan and no zeros", async () => {
    renderRoute("/creators/discovery?view=plan", served(null).adapter);
    expect(await screen.findByText("Daily sourcing source not connected")).toBeInTheDocument();
    expect(screen.getByText(/SOURCING_SOURCE_UNCONFIGURED/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows a denial and no plan data", async () => {
    const transport: Transport = { send: () => Promise.reject(new TransportFailure("http", { status: 403, body: { code: "FORBIDDEN", message: "This scope is not available.", requestId: "r", correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" } })) };
    renderRoute("/creators/discovery?view=plan", createLiveAdapter("sandbox", { transport }));
    await waitFor(() => expect(screen.queryByText("Loading the daily sourcing plan…")).not.toBeInTheDocument());
    expect(screen.queryByTestId("live-plan-versions")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps the demo's labeled synthetic plan on the demo adapter", async () => {
    renderRoute("/creators/discovery?view=plan", createDemoAdapter({ latencyMs: 0 }));
    expect(await screen.findByTestId("plan-versions")).toBeInTheDocument();
    expect(screen.queryByTestId("live-plan-versions")).not.toBeInTheDocument();
  });
});
