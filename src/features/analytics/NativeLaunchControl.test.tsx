import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createLiveAdapter } from "@/adapter/liveAdapter";
import { respondWith } from "@/adapter/demoViews";
import { SCHEMA_VERSION, type ActionRequest, type ActionResponse } from "@/adapter/contract";
import { TransportFailure } from "@/adapter/transport";
import { renderRoute, testClient } from "@/test/renderWithAdapter";
import type { NativeReadinessView } from "@/creator-agent/actions/views";
import type { ReadinessPayload } from "@/creator-agent/actions/contract";
import { launchPayloadDigest, nativeGoHold } from "./NativeLaunchDecision";

beforeEach(() => { window.sessionStorage.clear(); });
afterEach(() => { cleanup(); window.sessionStorage.clear(); vi.restoreAllMocks(); });

const requestKey = "24362b64-8e8c-498d-a0e5-dc304d539370";
const fixture = (): NativeReadinessView => ({ kind: "native-launch-readiness", actorRef: "person-synthetic", targetRef: "launch-synthetic", version: "view-v1", observedAt: "2026-11-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z", launchDate: "2027-02-04", launchDateApproved: true, phase: "effective-l-minus-4", phaseAllowed: true, policyVersion: "policy-synthetic", gates: [{ id: "gate-synthetic", required: true, state: "pass", evidenceRef: "evidence-synthetic" }], evidenceRefs: ["evidence-synthetic"], confersRelease: false, requestRecovery: null });
function ack(req: ActionRequest<unknown>): ActionResponse { return { schemaVersion: SCHEMA_VERSION, requestId: req.requestId, scope: { ...req.requestedScope, authorizationScopeVersion: "synthetic-scope-v1" }, actionRef: "launch-synthetic", state: "succeeded", runRef: null, approvalRef: null, manifestRef: null, payloadVersion: "recorded-v2", policyVersion: "readiness-record-only.v1", modelVersion: null, offerVersion: null, reasonCodes: ["READINESS_RECORDED_RELEASE_NOT_GRANTED"], receiptRefs: ["notion-receipt-synthetic"], nextAction: null, nextPollAfterMs: null, executionCertainty: "applied" }; }
async function recovery(d: NativeReadinessView, req: ActionRequest<ReadinessPayload>, state: "recorded" | "pending" | "notApplied" = "recorded") {
  const payloadDigest = await launchPayloadDigest(req.payload);
  return { requestKey: req.idempotencyKey, state, intent: { operation: "recordSourceDecision" as const, actionKind: "recordLaunchReadiness" as const, requestKey: req.idempotencyKey, actorRef: d.actorRef, targetRef: d.targetRef, expectedVersion: req.expectedVersion, entityRefs: req.entityRefs as NonNullable<NonNullable<NativeReadinessView["requestRecovery"]>["intent"]>["entityRefs"], payload: req.payload, payloadDigest }, receipt: state === "recorded" ? { kind: "launch-readiness-record" as const, receiptRef: "notion-receipt-synthetic", recordedVersion: "recorded-v2", recordedAt: "2026-11-02T00:00:00Z", provider: "notion" as const, requestKey: req.idempotencyKey, actorRef: d.actorRef, targetRef: d.targetRef, expectedVersion: req.expectedVersion, payloadDigest, confersRelease: false as const } : null, terminalProof: state === "notApplied" ? { receiptRef: "closed-original", observedAt: "2026-11-02T00:00:00Z" } : null, reasonCodes: [] };
}
function harness(d = fixture(), action?: (req: ActionRequest<ReadinessPayload>) => Promise<ActionResponse>, path = "/launch?view=control") {
  const requests: ActionRequest<ReadinessPayload>[] = [], state = { denied: false, partial: false, available: true };
  const client = testClient();
  const adapter = createLiveAdapter("sandbox", { transport: { async send(req) {
    if (req.kind === "read") {
      if (state.denied) throw new TransportFailure("http", { status: 403, body: { code: "FORBIDDEN", executionCertainty: "notApplied" } });
      return respondWith(req.envelope, d, { dataVersion: d.version, dataState: state.partial ? "partial" : "ready", capabilities: [{ actionKind: "recordLaunchReadiness", state: state.available ? "available" : "denied", reasonCodes: state.available ? [] : ["AUTHORITY_REQUIRED"] }] });
    }
    if (req.kind !== "action") throw new Error("Unexpected save");
    const r = req.envelope as ActionRequest<ReadinessPayload>; requests.push(r);
    if (action) return action(r);
    d.requestRecovery = await recovery(d, r); return ack(r);
  } } });
  const router = renderRoute(path, adapter, client); return { requests, state, client, router, d };
}
async function editor() { await userEvent.click(await screen.findByRole("button", { name: "Record in Notion" })); return within(screen.getByText("Record a launch-readiness decision", { selector: "h2" }).closest("dialog")!); }
const pendingError = () => new TransportFailure("http", { status: 502, body: { code: "OUTCOME_UNCERTAIN", executionCertainty: "uncertain" } });

describe("native launch readiness source and exact original recovery", () => {
  it("preserves full source sections while missing financial, allocation, gate-owner and milestone evidence remain unknown", async () => {
    harness(); expect(await screen.findByTestId("metric-gates")).toHaveTextContent("1 / 1");
    expect(screen.getByText("Budget ceiling").closest("dl")).toHaveTextContent("Unknown"); expect(screen.getByText("First-wave samples").closest("dl")).toHaveTextContent("Unknown");
    expect(screen.queryByText("$40k")).not.toBeInTheDocument(); expect(screen.getByRole("region", { name: "Relative milestone schedule" })).toHaveTextContent("Not supplied by source");
    await userEvent.click(screen.getByRole("button", { name: "Inspect evidence for gate 1" }));
    expect(screen.getByText("evidence-synthetic")).toBeInTheDocument(); expect(screen.queryByRole("link", { name: "evidence-synthetic" })).not.toBeInTheDocument();
  });
  it.each(["date", "approval", "phase", "gate", "evidence", "expired"])("holds Go when %s authority is missing", kind => {
    const d = fixture(); if (kind === "date") d.launchDate = null; if (kind === "approval") d.launchDateApproved = false; if (kind === "phase") d.phaseAllowed = false; if (kind === "gate") d.gates[0]!.state = "unknown"; if (kind === "evidence") d.gates[0]!.evidenceRef = null; if (kind === "expired") d.validUntil = "2020-01-01T00:00:00Z";
    expect(nativeGoHold(d)).not.toBeNull();
  });
  it("records exact source basis and only confirms the independently read matching source receipt", async () => {
    const h = harness(), e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Synthetic current gate review"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(screen.getByText(/exact Notion readiness receipt is verified/)).toBeInTheDocument());
    expect(h.requests).toHaveLength(1); expect(h.requests[0]).toMatchObject({ operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", expectedVersion: "view-v1", payload: { verdict: "hold", launchDate: "2027-02-04", evidenceRefs: ["evidence-synthetic"] }, entityRefs: [{ canonicalId: "launch-synthetic", provenanceRef: "view-v1" }] });
    expect(JSON.stringify(sessionStorage)).not.toContain("Synthetic current gate review"); expect(JSON.stringify(window.localStorage)).not.toContain("Synthetic current gate review");
    expect(h.router.state.location.search).toMatch(/readinessRequestKey=/);
  });
  it("does not treat a mismatched acknowledgment or absent lookup as saved and retries the exact original body/key", async () => {
    const d = fixture(); const h = harness(d, async req => ({ ...ack(req), actionRef: "different-target" }));
    const e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Original held rationale"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(h.requests).toHaveLength(1)); expect(screen.queryByText(/exact Notion readiness receipt is verified/)).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Retry original request" })); await waitFor(() => expect(h.requests).toHaveLength(2));
    expect(h.requests[1]!.idempotencyKey).toBe(h.requests[0]!.idempotencyKey); expect(h.requests[1]!.payload).toEqual(h.requests[0]!.payload); expect(h.requests[1]!.expectedVersion).toBe(h.requests[0]!.expectedVersion);
  });
  it("reconstructs an original server-owned pending intent after reload without browser-stored rationale", async () => {
    const d = fixture(), original = { schemaVersion: SCHEMA_VERSION, requestId: "old", operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", idempotencyKey: requestKey, expectedVersion: "view-v1", requestedScope: { workspaceId: "w", accountIds: ["a"], environment: "sandbox" }, entityRefs: [{ source: "launch-readiness", accountId: "a", sourceId: null, canonicalId: d.targetRef, url: null, identityState: "resolved", provenanceRef: "view-v1" }], approvalRef: null, manifestRef: null, runRef: null, payload: { verdict: "hold", launchDate: d.launchDate, rationale: "Server-owned original rationale", evidenceRefs: d.evidenceRefs } } as ActionRequest<ReadinessPayload>;
    d.requestRecovery = await recovery(d, original, "pending"); const h = harness(d, async () => { throw pendingError(); }, `/launch?view=control&readinessRequestKey=${requestKey}`);
    await userEvent.click(await screen.findByRole("button", { name: "Retry original request" })); await waitFor(() => expect(h.requests).toHaveLength(1));
    expect(h.requests[0]!.payload).toEqual(original.payload); expect(h.requests[0]!.idempotencyKey).toBe(requestKey); expect(JSON.stringify(sessionStorage)).not.toContain(original.payload.rationale);
  });
  it("holds a reloaded notFound request without its original payload instead of creating a fresh command", async () => {
    const d = fixture(); d.requestRecovery = { requestKey, state: "notFound", intent: null, receipt: null, terminalProof: null, reasonCodes: [] };
    const h = harness(d, undefined, `/launch?view=control&readinessRequestKey=${requestKey}`);
    expect(await screen.findByRole("button", { name: "Retry original request" })).toHaveAttribute("aria-disabled", "true");
    const e = await editor(); expect(e.getByRole("button", { hidden: true, name: "Record decision" })).toHaveAttribute("aria-disabled", "true"); expect(h.requests).toHaveLength(0);
  });
  it("clears protected rationale/source on denied refetch and retains only the opaque recovery key", async () => {
    const h = harness(fixture(), async () => { h.state.denied = true; throw new TransportFailure("http", { status: 403, body: { code: "FORBIDDEN", executionCertainty: "uncertain" } }); });
    const e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Private rationale that must clear"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(screen.queryByLabelText("Rationale")).not.toBeInTheDocument());
    await waitFor(() => expect(h.requests).toHaveLength(1)); await waitFor(() => expect(JSON.stringify(h.client.getQueryCache().getAll().map(q => q.state.data))).not.toContain("Private rationale that must clear")); expect(h.router.state.location.search).toContain("readinessRequestKey");
  });
  it("keeps changed-version edits until explicit rebase and offers no save with denied capability", async () => {
    const h = harness(), e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Review old version"); h.d.version = "view-v2";
    await act(async () => { await h.client.invalidateQueries(); });
    await waitFor(() => expect(e.getByRole("button", { hidden: true, name: "Record decision" })).toHaveAttribute("aria-disabled", "true")); expect(e.getByLabelText("Rationale")).toHaveValue("Review old version");
    await userEvent.click(e.getByRole("button", { hidden: true, name: "Use reviewed current version" })); h.state.partial = true; h.state.available = false; await act(async () => { await h.client.invalidateQueries(); });
    await waitFor(() => expect(e.getByRole("button", { hidden: true, name: "Record decision" })).toHaveAttribute("aria-disabled", "true")); expect(h.requests).toHaveLength(0);
  });
  it("rejects a self-consistent recovered receipt whose body differs from the original in-memory request", async () => {
    const d = fixture(), h = harness(d, async req => { const changed = { ...req, payload: { ...req.payload, rationale: "Different source body" } }; d.requestRecovery = await recovery(d, changed); return ack(req); });
    const e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Original exact decision"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(h.requests).toHaveLength(1)); await waitFor(() => expect(screen.getByRole("button", { name: "Retry original request" })).toHaveAttribute("aria-disabled", "true"));
    expect(screen.queryByRole("button", { name: "Finish reconciliation" })).not.toBeInTheDocument(); expect(screen.queryByText(/exact Notion readiness receipt is verified/)).not.toBeInTheDocument();
  });
  it("permits a new reviewed decision only after source-confirmed terminal nonapplication", async () => {
    const d = fixture(), h = harness(d, async req => { d.requestRecovery = await recovery(d, req, "notApplied"); throw pendingError(); });
    const e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Terminal original decision"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await userEvent.click(await screen.findByRole("button", { name: "Finish reconciliation" }));
    await waitFor(() => expect(h.router.state.location.search).not.toContain("readinessRequestKey")); expect(h.requests).toHaveLength(1);
    const next = await editor(); expect(next.getByLabelText("Rationale")).toHaveValue("");
  });

  it("permits an authorized Hold on current partial unknown gates while Go remains blocked", async () => {
    const d = fixture(); d.gates[0]!.state = "unknown"; d.gates[0]!.evidenceRef = null;
    const h = harness(d); await screen.findByTestId("metric-gates"); h.state.partial = true; await act(async () => { await h.client.invalidateQueries(); });
    const e = await editor(); expect(e.getByRole("radio", { hidden: true, name: "Go" })).toBeDisabled();
    expect(e.getByRole("button", { hidden: true, name: "Record decision" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Partial data")).toBeInTheDocument(); expect(screen.getByTestId("metric-gates")).toHaveTextContent("0 / 1");
    await userEvent.type(e.getByLabelText("Rationale"), "Hold pending the missing gate evidence"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(h.requests).toHaveLength(1)); expect(h.requests[0]!.payload.verdict).toBe("hold");
  });

  it("restores the unresolved original key after same-route marker removal instead of minting another command", async () => {
    const h = harness(fixture(), async () => { throw pendingError(); }), e = await editor();
    await userEvent.type(e.getByLabelText("Rationale"), "Original unresolved key"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(h.requests).toHaveLength(1)); const original = h.requests[0]!.idempotencyKey;
    await act(async () => { await h.router.navigate("/launch?view=control"); });
    await waitFor(() => expect(h.router.state.location.search).toContain(original));
    const reopened = await editor(); expect(reopened.getByRole("button", { hidden: true, name: "Record decision" })).toHaveAttribute("aria-disabled", "true"); expect(h.requests).toHaveLength(1);
    expect(JSON.stringify(window.sessionStorage)).not.toContain("Original unresolved key");
  });
  it("recovers a safe persisted key without its URL or protected payload after reload", async () => {
    const first = harness(fixture(), async () => { throw pendingError(); }), e = await editor();
    await userEvent.type(e.getByLabelText("Rationale"), "Private reload rationale"); await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" }));
    await waitFor(() => expect(first.requests).toHaveLength(1)); const original = first.requests[0]!.idempotencyKey;
    cleanup(); first.client.clear();
    const next = harness(); await waitFor(() => expect(next.router.state.location.search).toContain(original));
    expect(await screen.findByRole("button", { name: "Retry original request" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("Private reload rationale")).not.toBeInTheDocument(); expect(next.requests).toHaveLength(0);
  });
  it.each(["capability", "phase", "expiry", "draft"])("fences a changed %s after asynchronous digest preparation", async changed => {
    const h = harness(), e = await editor(); await userEvent.type(e.getByLabelText("Rationale"), "Prepare under old source");
    const original = crypto.subtle.digest.bind(crypto.subtle); let release!: () => void, started!: () => void;
    const wait = new Promise<void>(r => { release = r; }), seen = new Promise<void>(r => { started = r; });
    vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => { started(); await wait; return original(...args); });
    await userEvent.click(e.getByRole("button", { hidden: true, name: "Record decision" })); await seen;
    if (changed === "capability") h.state.available = false;
    if (changed === "phase") h.d.phaseAllowed = false;
    if (changed === "expiry") h.d.validUntil = "2020-01-01T00:00:00Z";
    if (changed === "draft") h.d.evidenceRefs = ["other-source-evidence"];
    await act(async () => { await h.client.invalidateQueries(); });
    await act(async () => { release(); });
    await waitFor(() => expect(e.getByText(/changed during preparation/)).toBeInTheDocument());
    expect(h.requests).toHaveLength(0); expect(h.router.state.location.search).not.toContain("readinessRequestKey");
  });

  it("holds corrupted persisted recovery metadata instead of forgetting possible uncertainty", async () => {
    const key = "launch-readiness-pending:" + JSON.stringify(["farda", "tester", "sandbox", "w", "a", "launch-readiness-original", "person-synthetic", "launch-synthetic"]);
    window.sessionStorage.setItem(key, JSON.stringify({ requestKey: "broken", payload: { rationale: "Legacy protected text" } }));
    const h = harness(), e = await editor();
    expect(e.getByRole("button", { hidden: true, name: "Record decision" })).toHaveAttribute("aria-disabled", "true");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("Legacy protected text"); expect(h.requests).toHaveLength(0);
  });

});
