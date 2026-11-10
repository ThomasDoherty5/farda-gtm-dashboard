import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type ReadRequest } from "@/adapter/contract";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { TransportFailure, type Transport } from "@/adapter/transport";
import { AdapterError, mustClearProtectedData } from "@/adapter/errors";
import { AgentStore } from "@/creator-agent/store";
import { apiErrorEnvelope } from "@/creator-agent/apiErrorEnvelope";
import { createSourcingPlanReader } from "@/creator-agent/sourcing/reader";
import type { SourcingSnapshot } from "@/creator-agent/sourcing/source";
import { sourcingSourceFixture, sourcingTestSecret as secret, sourcingTestTime } from "@/creator-agent/sourcing/fixtures.testkit";
import { renderRoute, scopeFor } from "@/test/renderWithAdapter";
import { SourcingError } from "@/creator-agent/sourcing/source";

const stores: AgentStore[] = [];
const { workspaceId, accountIds } = scopeFor("sandbox");
const serviceScope = { workspaceId, accountId: accountIds[0]!, environment: "sandbox" as const };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

/**
 * The service's own `/v1/read` handling (`respond`): the exact envelope, or the refusal rendered through the server's shared error
 * envelope with its status, delivered as the HTTP transport would, so the live adapter checks scope, status and schema. The test scope is the service scope.
 */
function served(snapshot: SourcingSnapshot | null | (() => Promise<unknown>), at = sourcingTestTime, role: "reader" | "reviewer" = "reviewer") {
  const store = new AgentStore(":memory:", serviceScope); stores.push(store);
  const source = snapshot === null ? undefined : typeof snapshot === "function" ? snapshot : async () => structuredClone(snapshot);
  const reader = createSourcingPlanReader({ db: store.database, scope: serviceScope, secret, now: () => at, source });
  const requests: ReadRequest<unknown>[] = [];
  const transport: Transport = { send: async ({ envelope }) => {
    requests.push(envelope as ReadRequest<unknown>);
    try { return await reader.respond(JSON.parse(JSON.stringify(envelope)) as ReadRequest<Record<string, never>>, role, SCHEMA_VERSION); }
    catch (error) {
      if (!(error instanceof SourcingError)) throw error;
      throw new TransportFailure("http", { status: error.status, body: apiErrorEnvelope(error.status,
        { code: error.code, executionCertainty: "notApplied", fieldErrors: error.fieldErrors }, (envelope as ReadRequest<unknown>).requestId) });
    }
  } };
  return { adapter: createLiveAdapter("sandbox", { transport }), requests };
}
const table = (name: string) => screen.getByRole("table", { name });
const row = (name: string, label: string) => within(table(name)).getByRole("row", { name: new RegExp(`^${label}`) });

describe("the live daily plan detail", () => {
  it("reads the served plan and shows schedule, steps, native-unit capacity, identity and run states", async () => {
    const { adapter, requests } = served(sourcingSourceFixture(serviceScope));
    renderRoute("/creators/discovery?view=plan", adapter);
    expect(await screen.findByTestId("live-plan-schedule")).toHaveTextContent("Active");
    expect(requests.map((r) => [r.viewKey, r.filters])).toEqual([["sourcingPlan", {}]]);
    expect(screen.getByTestId("live-plan-account-social-cat")).toHaveTextContent("Account read · Access verified · session open");
    expect(row("Daily plan steps", "Qualification")).toHaveTextContent("Unknown · direct video review incomplete");
    expect(row("Daily plan steps", "Discovery")).toHaveTextContent("Resolve identities");
    expect(row("Daily plan steps", "Invitation planning")).toHaveTextContent(/Invitation planning0Operator/);
    expect(row("Source capacity in native units", "TikTok Shop · Invitations")).toHaveTextContent("Unknown · source limit not published");
    expect(row("Source capacity in native units", "Shared · Approved sample units")).toHaveTextContent("12 units");
    expect(row("Source capacity in native units", "TikTok Shop · Invitations")).toHaveTextContent("Blocked · CAPACITY_UNKNOWN");
    expect(row("Source capacity in native units", "Social Cat · Invitations")).toHaveTextContent("30 invitations");
    expect(row("Source capacity in native units", "Shared · Authorized cost")).toHaveTextContent("$300");
    expect(row("Identity, duplicates and suppression", "Existing relationship")).toHaveTextContent("Unknown · relationship ledger not read");
    expect(row("Latest run states", "Uncertain")).toHaveTextContent("Unknown · receipt not reconciled");
    expect(screen.getByTestId("live-plan-run-totals")).toHaveTextContent("Confirmed unique invitations2 · 2 receipts");
    expect(screen.getByTestId("view-partial")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request approval for a batch/ })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Batch approval is not connected yet. It belongs to the approvals work, not this plan view.")).toBeInTheDocument();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    expect([...document.querySelectorAll("a")].map((a) => a.getAttribute("href")).filter((h) => /demo-/.test(h ?? ""))).toEqual([]);
  });

  it("never shows a schedule as active when a browser session is closed", async () => {
    const snapshot = sourcingSourceFixture(serviceScope); snapshot.sources[1]!.session = "closed";
    renderRoute("/creators/discovery?view=plan", served(snapshot).adapter);
    expect(await screen.findByTestId("live-plan-schedule")).toHaveTextContent("Draft · not active · source claims active");
    expect(screen.getByTestId("live-plan-schedule-holds")).toHaveTextContent("BROWSER_SESSION_CLOSED:tiktok-shop");
  });

  it("labels a lapsed source as stale and every capacity row as blocked", async () => {
    renderRoute("/creators/discovery?view=plan", served(sourcingSourceFixture(serviceScope), sourcingTestTime + 2 * 3600_000).adapter);
    expect(await screen.findByTestId("view-stale")).toBeInTheDocument();
    const rows = within(table("Source capacity in native units")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    // An unknown row stays unknown when the lease lapses; every row is blocked either way.
    for (const r of rows) expect(r).toHaveTextContent(/Blocked · CAPACITY_(LEASE_EXPIRED|UNKNOWN|NOT_REPORTED)/);
    expect(rows.filter((r) => /CAPACITY_LEASE_EXPIRED/.test(r.textContent ?? ""))).toHaveLength(3);
    expect(rows.filter((r) => /CAPACITY_NOT_REPORTED/.test(r.textContent ?? ""))).toHaveLength(6);
  });

  it("says an unconfigured source is not connected, with no plan and no zeros", async () => {
    renderRoute("/creators/discovery?view=plan", served(null).adapter);
    expect(await screen.findByText("Daily sourcing source not connected")).toBeInTheDocument();
    expect(screen.getByText(/SOURCING_SOURCE_UNCONFIGURED/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("treats the source refusing the server's credential as unavailable data, not as the user having no access", async () => {
    const { adapter } = served(async () => { throw new SourcingError("UPSTREAM_DENIED", 403); });
    const failure = await adapter.readView({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-denied-read", viewKey: "sourcingPlan",
      requestedScope: { workspaceId, accountIds, environment: "sandbox" }, filters: {}, period: null, sort: [], page: { cursor: null, limit: 50 } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).category).toBe("unavailable");
    expect(mustClearProtectedData((failure as AdapterError).category)).toBe(false);
    renderRoute("/creators/discovery?view=plan", adapter);
    expect(await screen.findByText("Data unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No access to this account")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-plan-versions")).not.toBeInTheDocument();
  });

  it("shows a remaining allowance with an unknown limit as Unknown and blocked, keeping the remaining value", async () => {
    const snapshot = sourcingSourceFixture(serviceScope);
    snapshot.capacity[0]!.limit = { value: null, missingReason: "SOURCE_LIMIT_NOT_PUBLISHED" };
    renderRoute("/creators/discovery?view=plan", served(snapshot).adapter);
    await screen.findByTestId("live-plan-schedule");
    const social = row("Source capacity in native units", "Social Cat · Invitations");
    expect(social).toHaveTextContent("30 invitations");
    expect(social).toHaveTextContent("Unknown");
    expect(social).toHaveTextContent("Blocked · CAPACITY_DIMENSION_UNKNOWN");
    expect(social).not.toHaveTextContent("Current");
    expect(social).not.toHaveTextContent("Not blocked by this row");
  });

  it("tells a reader that the reviewer role is required, without implying a reviewer could request approval now", async () => {
    renderRoute("/creators/discovery?view=plan", served(sourcingSourceFixture(serviceScope), sourcingTestTime, "reader").adapter);
    expect(await screen.findByText("Requires the reviewer role. Batch approval is also not connected yet, so no role can request it here today.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Request approval for a batch/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps the demo's labeled synthetic plan on the demo adapter", async () => {
    renderRoute("/creators/discovery?view=plan", createDemoAdapter({ latencyMs: 0 }));
    expect(await screen.findByTestId("plan-versions")).toBeInTheDocument();
    expect(screen.queryByTestId("live-plan-versions")).not.toBeInTheDocument();
  });
});
