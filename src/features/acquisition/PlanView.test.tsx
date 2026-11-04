import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { respondWith } from "@/adapter/demoViews";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { DISCOVERY_VERSION } from "@/adapter/demoDiscovery";
import { heldReasons, seedItems } from "@/fixtures/batch";
import { discoveryDemo, RUN_STATES } from "@/fixtures/discovery";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";
import { heldTotal, identityCounts, runStateCounts, scheduleLabel } from "./PlanView";

const PLAN = "/creators/discovery?view=plan";
const open = async (path = PLAN, adapter = createDemoAdapter()) => {
  const router = renderRoute(path, adapter);
  await screen.findByTestId("plan-versions");
  return { router, adapter, user: userEvent.setup() };
};
const rows = (testId: string) => within(screen.getByTestId(testId)).getAllByRole("row").slice(1);

describe("DS-01 versions, source account and schedule", () => {
  it("shows the schedule as a draft, the source account as unknown, and the ICP, policy and access versions", async () => {
    await open();
    expect(screen.getByTestId("plan-schedule")).toHaveTextContent("Draft · not active");
    expect(screen.getByTestId("plan-source-account")).toHaveTextContent("N/A · account not read");
    expect(screen.getByText("ICP draft v0 · not approved")).toBeInTheDocument();
    expect(within(screen.getByTestId("plan-versions")).getByText("commission-only policy · policy-2026-10")).toBeInTheDocument();
    expect(screen.getByText("Unverified")).toBeInTheDocument();
  });

  it("an unconfigured schedule is never active, even if the source says so", () => {
    const base = discoveryDemo.versions;
    expect(scheduleLabel({ ...base, scheduleStatus: "active" })).toBe("Draft · not active");
    expect(scheduleLabel({ ...base, scheduleStatus: "active", sourceAccount: { ...base.sourceAccount, state: "known", value: "acct-demo" }, accessStatus: "Unverified" })).toBe("Draft · not active");
    expect(scheduleLabel({ ...base, scheduleStatus: "active", sourceAccount: { ...base.sourceAccount, state: "known", value: "acct-demo" }, accessStatus: "Verified" })).toBe("Active");
  });

  it("the daily page links to the plan detail and back", async () => {
    renderRoute("/creators/discovery", createDemoAdapter());
    expect(await screen.findByRole("link", { name: "Plan detail" })).toHaveAttribute("href", "/creators/discovery?view=plan");
  });
});

describe("DS-02 each step has a count, owner, evidence and next action", () => {
  it("lists the six steps with all four", async () => {
    await open();
    const r = rows("plan-steps");
    expect(r).toHaveLength(6);
    expect(r[0]).toHaveTextContent("Discover80 profiles surfacedCreator agent");
    expect(r[2]).toHaveTextContent("Qualify24 eligible, 26 heldThomas");
    expect(r[2]).toHaveTextContent("Resolve held reasons");
    for (const row of r) expect(within(row).getAllByRole("cell").every((c) => (c.textContent ?? "").trim() !== "")).toBe(true);
  });

  it("an unreached step is N/A, not zero", async () => {
    await open();
    expect(rows("plan-steps")[5]).toHaveTextContent("N/A · confirmed · N/A until a send");
    expect(rows("plan-steps")[4]).toHaveTextContent("0 approved · none requested yet");
  });
});

describe("DS-04 deduplication and suppression", () => {
  it("reconciles from surfaced profiles to the selected 50, then to eligible and held", async () => {
    const i = discoveryDemo.identity;
    expect(identityCounts(i)).toEqual({ suppressed: 12, unique: 62, remaining: 50 });
    expect(identityCounts(i).remaining).toBe(i.selected);
    expect(i.selected).toBe(discoveryDemo.batch.selected);
    expect(discoveryDemo.batch.eligible + heldTotal()).toBe(i.selected);
    expect(heldReasons.reduce((a, r) => a + r.byOwner.Thomas + r.byOwner.Operations + r.byOwner["Creator agent"] + r.byOwner.Operator, 0)).toBe(26);
    await open();
    const r = rows("identity-table");
    expect(r[1]).toHaveTextContent("Merged as duplicates−18");
    expect(r[2]).toHaveTextContent("Opted out−3Suppressed permanently");
    expect(r[5]).toHaveTextContent("Selected for review5062 unique identities − 12 suppressed");
  });

  it("separates identity duplicates from a duplicate offer", async () => {
    await open();
    expect(screen.getByText(/including 6 for a duplicate offer/)).toBeInTheDocument();
  });
});

describe("DS-07 run states", () => {
  it("names every state, with counts from the batch's own items", async () => {
    await open();
    const r = rows("run-states");
    expect(r.map((x) => x.firstElementChild!.textContent)).toEqual(RUN_STATES.map((s) => s.label));
    const byLabel = Object.fromEntries(runStateCounts().map((s) => [s.label, s.count]));
    expect(byLabel).toMatchObject({ Queued: 3, Running: 2, "Login / MFA": 1, Confirmed: 16, Uncertain: 2, Paused: 0, Deferred: 0, Denied: 0, Failed: 0 });
    expect(Object.values(byLabel).reduce((a, b) => a + b, 0)).toBe(seedItems().length);
    expect(screen.getByText(/Reconcile before any retry/)).toBeInTheDocument();
    expect(screen.getByText(/Owner handoff; never retried blindly/)).toBeInTheDocument();
  });
});

describe("DS-06 approval intent through the adapter", () => {
  it("submits a finite, commission-only request and shows approval pending, never approved or sent", async () => {
    const adapter = createDemoAdapter();
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PLAN, adapter);
    await user.click(screen.getByRole("button", { name: "Request approval for this batch" }));
    const ack = await screen.findByTestId("approval-ack");
    expect(ack).toHaveTextContent("Approval pending");
    expect(ack).toHaveTextContent("Not approved and not sent");
    expect(ack).not.toHaveTextContent(/Approved\b(?! )/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({
      operation: "requestApproval",
      actionKind: "requestBatchApproval",
      expectedVersion: DISCOVERY_VERSION,
      payload: { batchId: "BATCH-TT-DEMO-024", recipients: 24, upfrontFeeMinor: 0, sampleUnits: 12 },
    });
  });

  it("does not double-submit on a double click", async () => {
    const adapter = createDemoAdapter({ latencyMs: 5 });
    const spy = vi.spyOn(adapter, "submitAction");
    const { user } = await open(PLAN, adapter);
    await user.dblClick(screen.getByRole("button", { name: "Request approval for this batch" }));
    await screen.findByTestId("approval-ack");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("the service refuses an upfront fee and an open-ended or oversized batch, and a stale plan", async () => {
    const adapter = createDemoAdapter();
    const base = { operation: "requestApproval" as const, actionKind: "requestBatchApproval", entityRefs: [], approvalRef: null, manifestRef: null, schemaVersion: "x", requestId: "r", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "demo" as const } };
    const payload = { batchId: "BATCH-TT-DEMO-024", recipients: 24, rateLabel: "12% standard-rate", sampleUnits: 12, sampleUnitCostMinor: 2500, upfrontFeeMinor: 0, policyVersion: discoveryDemo.versions.policyVersion };
    const send = (over: object, key: string, version = DISCOVERY_VERSION) => adapter.submitAction({ ...base, expectedVersion: version, idempotencyKey: key, payload: { ...payload, ...over } });
    await expect(send({ upfrontFeeMinor: 5000 }, "k1")).rejects.toMatchObject({ body: { code: "POLICY_VIOLATION", executionCertainty: "notApplied" } });
    await expect(send({ recipients: 25 }, "k2")).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED" } });
    await expect(send({ recipients: 0 }, "k3")).rejects.toMatchObject({ body: { code: "VALIDATION_FAILED" } });
    await expect(send({}, "k4", "old")).rejects.toMatchObject({ body: { code: "STALE_VERSION" } });
    await expect(send({}, "k5")).resolves.toMatchObject({ state: "approvalPending", receiptRefs: [] });
    await expect(send({ recipients: 20 }, "k5")).rejects.toMatchObject({ body: { code: "MANIFEST_CHANGED" } });
  });

  it("is disabled with its reason when the server does not offer the action", async () => {
    const adapter = scriptedAdapter(async (request) => respondWith(request, discoveryDemo, { dataVersion: DISCOVERY_VERSION, capabilities: [{ actionKind: "requestBatchApproval", state: "held", reasonCodes: ["APPROVAL_REQUIRED"] }] }));
    await open(PLAN, adapter);
    expect(screen.getByRole("button", { name: "Request approval for this batch" })).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a pending state and no plan numbers on the live adapter", async () => {
    renderRoute(PLAN, createLiveAdapter("sandbox"));
    expect(await screen.findByRole("heading", { name: "Data unavailable" })).toBeInTheDocument();
    expect(screen.queryByTestId("plan-versions")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("plan-steps")).not.toBeInTheDocument());
  });
});
