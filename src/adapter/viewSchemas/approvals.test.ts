import { z } from "zod";
import { SCHEMA_VERSION, actionResponseSchema, readResponseSchema, type ActionRequest, type ReadRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import type { ApprovalDetail, RunDetail } from "@/features/approvals/types";
import { demoScenarios } from "@/fixtures/approvals";
import {
  approvalActionSchemas,
  approvalDetailSchema,
  approvalViewSchemas,
  decideApprovalResponseSchema,
  receiptBackedResponse,
  runDetailSchema,
} from "./approvals";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let seq = 0;

const readRequest = (viewKey: string, filters: unknown): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: scope,
  filters,
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: `r-${++seq}`,
});

const actionRequest = <P>(operation: ActionRequest<P>["operation"], actionKind: string, approvalRef: string | null, expectedVersion: string, payload: P, runRef?: string): ActionRequest<P> => ({
  schemaVersion: SCHEMA_VERSION,
  operation,
  requestedScope: scope,
  actionKind,
  entityRefs: [],
  expectedVersion,
  approvalRef,
  manifestRef: null,
  ...(runRef === undefined ? {} : { runRef }),
  idempotencyKey: `key-${++seq}`,
  payload,
  requestId: `req-${++seq}`,
});

type Adapter = ReturnType<typeof createDemoAdapter>;
const clone = <T>(v: T): T => structuredClone(v);
/** A copy of the object without one key: how the "missing required field" cases are built. */
const omit = <T extends object>(value: T, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));


async function approval(adapter: Adapter, approvalId: string) {
  const res = await adapter.readView<unknown, ApprovalDetail>(readRequest("approvalDetail", { approvalId }));
  const parsed = readResponseSchema(approvalDetailSchema).safeParse(res);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 1)).toBe(true);
  return res.data!;
}
async function run(adapter: Adapter, runId: string) {
  const res = await adapter.readView<unknown, RunDetail>(readRequest("runDetail", { runId }));
  const parsed = readResponseSchema(runDetailSchema).safeParse(res);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues, null, 1)).toBe(true);
  return res.data!;
}

/** Submits an action, asserts the payload and the response parse, and returns the response. */
async function act<P>(adapter: Adapter, kind: string, request: ActionRequest<P>) {
  expect(approvalActionSchemas[kind]!.payload.safeParse(request.payload).success, `${kind} payload`).toBe(true);
  const response = await adapter.submitAction(request);
  expect(actionResponseSchema.safeParse(response).success).toBe(true);
  const parsed = receiptBackedResponse.safeParse(response);
  expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  return response;
}

const decide = (adapter: Adapter, id: string, version: string, payload: Record<string, unknown>) =>
  act(adapter, "decideApproval", actionRequest("decideApproval", "decideApproval", id, version, payload));
const dispatch = (adapter: Adapter, id: string, version = "v1") => act(adapter, "dispatchApprovedAction", actionRequest("dispatchApprovedAction", "dispatchApprovedAction", id, version, {}));
const reconcileRun = async (adapter: Adapter, runRef: string, request: "lookup" | "recordConfirmedSent" | "freshAttempt") => {
  const r = await run(adapter, runRef);
  return act(adapter, request, actionRequest("reconcileRun", request, r.approvalRef, r.version, { request }, runRef));
};
const expectError = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(() => null, (x: unknown) => x as AdapterError);
  expect(e).toBeInstanceOf(AdapterError);
  expect(e!.body.code).toBe(code);
};

const approvalIds = demoScenarios.approvals.map(([id]) => id);
const runIds = demoScenarios.runs.map(([id]) => id);

describe("the registry", () => {
  it("has exactly these view keys and action kinds", () => {
    expect(Object.keys(approvalViewSchemas).sort()).toEqual(["approvalDetail", "runDetail"]);
    expect(Object.keys(approvalActionSchemas).sort()).toEqual(["cancelUnsent", "decideApproval", "dispatchApprovedAction", "exportLedger", "freshAttempt", "lookup", "pauseRun", "previewAction", "reconcileApproval", "recordConfirmedSent", "recordLaunchReadiness", "requestApproval", "resumeRun"]);
  });
});

describe("approvalDetail", () => {
  it.each(approvalIds)("parses the seeded demo approval %s", async (id) => {
    await approval(createDemoAdapter(), id);
  });

  it("parses the removed-access and missing records as errors, not data", async () => {
    const adapter = createDemoAdapter();
    await expectError(adapter.readView(readRequest("approvalDetail", { approvalId: "demo-approval-forbidden" })), "FORBIDDEN");
    await expectError(adapter.readView(readRequest("approvalDetail", { approvalId: "nope" })), "RECORD_NOT_FOUND");
  });

  it("parses an approval after approve (approved, not sent), after dispatch (succeeded with a receipt), and after an unknown-outcome send", async () => {
    const adapter = createDemoAdapter();
    const decided = await decide(adapter, "demo-approval-exact", "v1", { decision: "approved" });
    expect(decided.state).not.toBe("succeeded");
    expect(decideApprovalResponseSchema.safeParse(decided).success).toBe(true);
    const approved = await approval(adapter, "demo-approval-exact");
    expect(approved).toMatchObject({ status: "approved", execution: null });

    const sent = await dispatch(adapter, "demo-approval-exact");
    expect(sent.receiptRefs).toHaveLength(1);
    expect((await approval(adapter, "demo-approval-exact")).execution).toMatchObject({ state: "succeeded" });

    await decide(adapter, "demo-approval-uncertain", "v1", { decision: "approved" });
    const uncertain = await dispatch(adapter, "demo-approval-uncertain");
    expect(uncertain.state).toBe("outcomeUncertain");
    expect((await approval(adapter, "demo-approval-uncertain")).execution).toMatchObject({ state: "outcomeUncertain", receiptRefs: [] });
  });

  it("parses an approval after reject, after an edit creates a new version, and after the terms change under the reviewer", async () => {
    const adapter = createDemoAdapter();
    const rejected = await decide(adapter, "demo-approval-exact", "v1", { decision: "rejected", reason: "Not this creator" });
    expect(rejected.state).toBe("canceled");
    expect((await approval(adapter, "demo-approval-exact")).status).toBe("rejected");

    const before = await approval(adapter, "demo-approval-founder");
    expect(before.versions).toHaveLength(1);

    const edit = createDemoAdapter();
    const original = await approval(edit, "demo-approval-exact");
    await decide(edit, "demo-approval-exact", "v1", { decision: "editRequired", editedMessage: `${original.versions[0]!.payload.message} (edited)` });
    const edited = await approval(edit, "demo-approval-exact");
    expect(edited.versions).toHaveLength(2);
    expect(edited.currentVersion).toBe("v2");

    const conflict = createDemoAdapter();
    await expectError(conflict.submitAction(actionRequest("decideApproval", "decideApproval", "demo-approval-conflict", "v1", { decision: "approved" })), "STALE_VERSION");
    expect((await approval(conflict, "demo-approval-conflict")).currentVersion).toBe("v2");
  });

  it("the decided history approval carries its decision receipt", async () => {
    const data = await approval(createDemoAdapter(), "demo-approval-history");
    expect(data.versions.every((v) => v.decision === null || v.decisionReceiptRef)).toBe(true);
    expect(data.execution).toMatchObject({ state: "partiallySucceeded" });
  });

  describe("rejects", () => {
    const base = async (id = "demo-approval-exact") => clone(await approval(createDemoAdapter(), id));
    const bad = (data: unknown) => expect(approvalDetailSchema.safeParse(data).success).toBe(false);

    it("a missing required field", async () => {
      const rest = omit(await base(), "manifestRef");
      bad(rest);
    });
    it("a wrong type", async () => bad({ ...(await base()), versions: "v1" }));
    it("an unknown status or decision", async () => {
      const d = await base();
      bad({ ...d, status: "sent" });
      bad({ ...d, versions: [{ ...d.versions[0], decision: "sent" }] });
    });
    it("negative or fractional minor units in the terms", async () => {
      const d = await base();
      const terms = d.versions[0]!.payload.terms;
      bad({ ...d, versions: [{ ...d.versions[0], payload: { ...d.versions[0]!.payload, terms: { ...terms, upfrontFee: { minorUnits: -100, currency: "USD" } } } }] });
      bad({ ...d, versions: [{ ...d.versions[0], payload: { ...d.versions[0]!.payload, terms: { ...terms, sampleCost: { minorUnits: 12.5, currency: "USD" } } } }] });
    });
    it("a commission rate over 100", async () => {
      const d = await base();
      const p = d.versions[0]!.payload;
      bad({ ...d, versions: [{ ...d.versions[0], payload: { ...p, terms: { ...p.terms, commissionRatePct: 150 } } }] });
    });
    it("a term or payload key that is not part of the approved payload", async () => {
      const d = await base();
      const p = d.versions[0]!.payload;
      bad({ ...d, versions: [{ ...d.versions[0], payload: { ...p, bonus: "hidden" } }] });
      bad({ ...d, versions: [{ ...d.versions[0], payload: { ...p, terms: { ...p.terms, kickback: 1 } } }] });
    });
    it("a decided version with no decision receipt, and an undecided one that has one", async () => {
      const d = await base("demo-approval-history");
      bad({ ...d, versions: [{ ...d.versions[0], decisionReceiptRef: null }, d.versions[1]] });
      const open = await base();
      bad({ ...open, versions: [{ ...open.versions[0], decisionReceiptRef: "demo-receipt" }] });
    });
    it("an approved approval whose current version is not approved", async () => {
      const d = await base("demo-approval-history");
      bad({ ...d, currentVersion: "v1" });
      bad({ ...d, versions: [d.versions[0], { ...d.versions[1], decision: "rejected" }] });
    });
    it("a current version that isn't in the history", async () => bad({ ...(await base()), currentVersion: "v9" }));
    it("an approval that reads as sent with no source receipt", async () => {
      const d = await base("demo-approval-history");
      bad({ ...d, execution: { ...d.execution, state: "succeeded", receiptRefs: [] } });
      bad({ ...d, execution: { ...d.execution, receiptRefs: [] } });
    });
    it("a pending approval that has already been dispatched", async () => {
      const d = await base();
      bad({ ...d, execution: { runRef: "demo-run-x", state: "succeeded", receiptRefs: ["demo-source-receipt-x"] } });
    });
    it("an unknown execution state", async () => {
      const d = await base("demo-approval-history");
      bad({ ...d, execution: { ...d.execution, state: "sent" } });
    });
  });
});

describe("runDetail", () => {
  it.each(runIds)("parses the seeded demo run %s", async (id) => {
    await run(createDemoAdapter(), id);
  });

  it("a missing run is an error, not data", async () => {
    await expectError(createDemoAdapter().readView(readRequest("runDetail", { runId: "nope" })), "RECORD_NOT_FOUND");
  });

  it("parses the run that a successful dispatch creates, with its receipt", async () => {
    const adapter = createDemoAdapter();
    await decide(adapter, "demo-approval-exact", "v1", { decision: "approved" });
    const sent = await dispatch(adapter, "demo-approval-exact");
    const created = await run(adapter, sent.runRef!);
    expect(created).toMatchObject({ state: "succeeded", counts: { confirmed: 1 } });
    expect(created.items[0]!.receiptRef).toBe(sent.receiptRefs[0]);
  });

  describe("every recovery state", () => {
    it("unknown outcome, source receipt found: lookup, then record as sent", async () => {
      const adapter = createDemoAdapter();
      const start = await run(adapter, "demo-run-uncertain");
      expect(start).toMatchObject({ state: "outcomeUncertain", reconciliation: { result: "notChecked", evidence: null } });
      await reconcileRun(adapter, "demo-run-uncertain", "lookup");
      const found = await run(adapter, "demo-run-uncertain");
      expect(found.reconciliation).toMatchObject({ result: "sourceReceiptFound" });
      expect(found.reconciliation.evidence).not.toBeNull();
      const recorded = await reconcileRun(adapter, "demo-run-uncertain", "recordConfirmedSent");
      expect(recorded.state).toBe("succeeded");
      expect(recorded.receiptRefs.length).toBeGreaterThan(0);
      const done = await run(adapter, "demo-run-uncertain");
      expect(done).toMatchObject({ state: "succeeded", counts: { confirmed: 1, uncertain: 0 } });
    });

    it("unknown outcome, source shows it never ran: lookup, then a fresh attempt", async () => {
      const adapter = createDemoAdapter();
      await reconcileRun(adapter, "demo-run-unsent", "lookup");
      expect((await run(adapter, "demo-run-unsent")).reconciliation.result).toBe("confirmedNotExecuted");
      const fresh = await reconcileRun(adapter, "demo-run-unsent", "freshAttempt");
      expect(fresh.state).toBe("queued");
      expect(await run(adapter, "demo-run-unsent")).toMatchObject({ state: "queued", attempt: 2, reconciliation: { result: "notChecked" } });
    });

    it("unknown outcome, no evidence: lookup stays unknown and a send is refused", async () => {
      const adapter = createDemoAdapter();
      await reconcileRun(adapter, "demo-run-noevidence", "lookup");
      expect((await run(adapter, "demo-run-noevidence")).reconciliation).toEqual({ result: "stillUnknown", evidence: null });
      const r = await run(adapter, "demo-run-noevidence");
      await expectError(adapter.submitAction(actionRequest("reconcileRun", "recordConfirmedSent", r.approvalRef, r.version, { request: "recordConfirmedSent" }, r.runRef)), "OUTCOME_UNCERTAIN");
      expect((await run(adapter, "demo-run-noevidence")).state).toBe("outcomeUncertain");
    });
  });

  it("parses a paused uncertain run and a paused partial batch", async () => {
    const adapter = createDemoAdapter();
    for (const runRef of ["demo-run-uncertain", "demo-run-batch"]) {
      const r = await run(adapter, runRef);
      const paused = await act(adapter, "pauseRun", actionRequest("controlRun", "pauseRun", r.approvalRef, r.version, { control: "pause" }, runRef));
      expect(paused.runRef).toBe(runRef);
      const after = await run(adapter, runRef);
      expect(after.pausedAt).not.toBeNull();
    }
    expect((await run(adapter, "demo-run-batch")).counts).toMatchObject({ paused: 2, unsent: 0 });
  });

  it("keeps the partial batch partial: confirmed with a receipt, failed, held and unsent are all different", async () => {
    const batch = await run(createDemoAdapter(), "demo-run-batch");
    expect(batch.counts).toEqual({ confirmed: 1, failed: 1, held: 1, unsent: 2, paused: 0, uncertain: 0 });
    expect(batch.state).toBe("partiallySucceeded");
  });

  describe("rejects", () => {
    const base = async (id = "demo-run-batch") => clone(await run(createDemoAdapter(), id));
    const bad = (data: unknown) => expect(runDetailSchema.safeParse(data).success).toBe(false);

    it("a missing required field", async () => {
      const rest = omit(await base(), "items");
      bad(rest);
    });
    it("a wrong type", async () => bad({ ...(await base()), attempt: "1" }));
    it("an unknown run state, item state, mode, environment or reconciliation result", async () => {
      const d = await base();
      bad({ ...d, state: "sent" });
      bad({ ...d, items: [{ ...d.items[0], state: "delivered" }, ...d.items.slice(1)] });
      bad({ ...d, mode: "autoSend" });
      bad({ ...d, environment: "staging" });
      bad({ ...d, reconciliation: { ...d.reconciliation, result: "assumedSent" } });
    });
    it("a count that is negative, fractional or null", async () => {
      const d = await base();
      bad({ ...d, counts: { ...d.counts, failed: -1 } });
      bad({ ...d, counts: { ...d.counts, failed: 0.5 } });
      bad({ ...d, counts: { ...d.counts, failed: null } });
    });
    it("counts that disagree with the items under them", async () => {
      const d = await base();
      bad({ ...d, counts: { ...d.counts, confirmed: 5 } });
    });
    it("a confirmed item with no source receipt", async () => {
      const d = await base();
      bad({ ...d, items: [{ ...d.items[0], receiptRef: null }, ...d.items.slice(1)] });
    });
    it("a succeeded run that still has an unsent, failed or uncertain item", async () => {
      bad({ ...(await base()), state: "succeeded" });
      const u = await base("demo-run-uncertain");
      bad({ ...u, state: "succeeded" });
    });
    it("a found source receipt without its evidence, and evidence on a run that was never checked", async () => {
      const d = await base("demo-run-uncertain");
      bad({ ...d, reconciliation: { result: "sourceReceiptFound", evidence: null } });
      bad({ ...d, reconciliation: { result: "notChecked", evidence: { receiptRef: "r", provider: "p", accountId: "a", identity: "i", observedAt: "2026-11-02T17:00:00.000Z" } } });
    });
    it("a run attempt that is zero", async () => bad({ ...(await base()), attempt: 0 }));
  });
});

describe("action payloads", () => {
  const ok = (kind: string, payload: unknown) => expect(approvalActionSchemas[kind]!.payload.safeParse(payload).success).toBe(true);
  const bad = (kind: string, payload: unknown) => expect(approvalActionSchemas[kind]!.payload.safeParse(payload).success).toBe(false);

  it("accepts the real payloads the approval and run pages send", () => {
    ok("decideApproval", { decision: "approved" });
    ok("decideApproval", { decision: "approved", reason: "" });
    ok("decideApproval", { decision: "rejected", reason: "Wrong creator" });
    ok("decideApproval", { decision: "editRequired", editedMessage: "New text", reason: "" });
    ok("dispatchApprovedAction", {});
    ok("pauseRun", { control: "pause" });
    for (const request of ["lookup", "recordConfirmedSent", "freshAttempt"]) ok(request, { request });
  });

  it("rejects a decision with no reason where one is required", () => {
    bad("decideApproval", { decision: "rejected" });
    bad("decideApproval", { decision: "rejected", reason: "   " });
    bad("decideApproval", { decision: "editRequired", reason: "x" });
    bad("decideApproval", { decision: "editRequired", editedMessage: " " });
  });
  it("rejects an unknown decision, including the states only the server sets", () => {
    for (const decision of ["expired", "canceled", "sent", "approve"]) bad("decideApproval", { decision, reason: "x" });
  });
  it("rejects a wrong type and a missing field", () => {
    bad("decideApproval", { decision: 1 });
    bad("decideApproval", {});
    bad("pauseRun", {});
    bad("pauseRun", { runRef: "demo-run-batch", control: "pause" }); // Q-03: the run is not in the payload
  });
  it("rejects an extra key no approver saw, such as a new message on a dispatch or a different recipient", () => {
    bad("dispatchApprovedAction", { message: "Send this instead" });
    bad("decideApproval", { decision: "approved", editedMessage: "Smuggled text" });
    bad("pauseRun", { control: "pause", force: true });
  });
  it("rejects a control other than pause, and a reconcile request that disagrees with its kind", () => {
    bad("pauseRun", { control: "cancel" });
    bad("lookup", { request: "recordConfirmedSent" });
    bad("freshAttempt", { request: "retry" });
  });
});

describe("action responses", () => {
  it("accepts every demo response the approval flow produces", async () => {
    const adapter = createDemoAdapter();
    const decided = await decide(adapter, "demo-approval-exact", "v1", { decision: "approved" });
    expect(decideApprovalResponseSchema.safeParse(decided).success).toBe(true);
    expect(decided).toMatchObject({ state: "approved", reasonCodes: ["AWAITING_DISPATCH"], receiptRefs: [], executionCertainty: "applied" });
    const sent = await dispatch(adapter, "demo-approval-exact");
    expect(sent).toMatchObject({ state: "succeeded" });
    expect(sent.receiptRefs.length).toBeGreaterThan(0);
  });

  it("rejects an approval that reads as sent, or a success with no receipt", async () => {
    const adapter = createDemoAdapter();
    const decided = await decide(adapter, "demo-approval-exact", "v1", { decision: "approved" });
    expect(decideApprovalResponseSchema.safeParse({ ...decided, state: "succeeded", receiptRefs: ["demo-decision-receipt"] }).success).toBe(false);
    expect(decideApprovalResponseSchema.safeParse({ ...decided, state: "succeeded" }).success).toBe(false);
    const sent = await dispatch(adapter, "demo-approval-exact");
    expect(receiptBackedResponse.safeParse({ ...sent, receiptRefs: [] }).success).toBe(false);
    expect(receiptBackedResponse.safeParse({ ...sent, state: "partiallySucceeded", receiptRefs: [] }).success).toBe(false);
  });

  it("rejects a response with a missing field, a wrong type or an unknown state", async () => {
    const adapter = createDemoAdapter();
    const decided = await decide(adapter, "demo-approval-exact", "v1", { decision: "approved" });
    const missing = omit(decided, "requestId");
    expect(receiptBackedResponse.safeParse(missing).success).toBe(false);
    expect(receiptBackedResponse.safeParse({ ...decided, receiptRefs: "none" }).success).toBe(false);
    expect(receiptBackedResponse.safeParse({ ...decided, state: "sent" }).success).toBe(false);
    expect(receiptBackedResponse.safeParse(omit(decided, "executionCertainty")).success).toBe(false);
    expect(receiptBackedResponse.safeParse({ ...decided, nextPollAfterMs: "soon" }).success).toBe(false);
  });
});

// Compile-time check: the view types the screens read are accepted by the inferred schema types.
// RunDetail.environment is typed `string`; the schema deliberately narrows it to the contract's Environment enum.
const _accepts = [{} as ApprovalDetail satisfies z.infer<typeof approvalDetailSchema>, {} as Omit<RunDetail, "environment"> satisfies Omit<z.infer<typeof runDetailSchema>, "environment">];
void _accepts;
