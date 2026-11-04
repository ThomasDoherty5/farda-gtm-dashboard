import { z } from "zod";
import { SCHEMA_VERSION, actionResponseSchema, readResponseSchema, type ActionRequest, type ReadRequest } from "./contract";
import { createDemoApprovals } from "./demoApprovals";
import { AdapterError } from "./errors";
import type { ApprovalDetail, DecidePayload, ReconcilePayload, RunDetail } from "@/features/approvals/types";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
let keySeq = 0;

const action = <P>(operation: ActionRequest<P>["operation"], approvalRef: string | null, expectedVersion: string, payload: P, idempotencyKey = `key-${++keySeq}`): ActionRequest<P> => ({
  schemaVersion: SCHEMA_VERSION,
  operation,
  requestedScope: scope,
  actionKind: operation,
  entityRefs: [],
  expectedVersion,
  approvalRef,
  manifestRef: null,
  idempotencyKey,
  payload,
  requestId: `req-${keySeq}`,
});

const read = <F>(viewKey: string, filters: F): ReadRequest<F> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: scope,
  filters,
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: "r",
});

const errorFrom = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e as AdapterError);

function setup() {
  const store = createDemoApprovals();
  const approval = (id: string) => store.readApproval(read("approvalDetail", { approvalId: id }));
  const data = (id: string) => approval(id).data as ApprovalDetail;
  const run = (id: string) => store.readRun(read("runDetail", { runId: id }));
  const decide = (id: string, version: string, payload: DecidePayload, key?: string) => store.submit(action("decideApproval", id, version, payload, key));
  const send = (id: string, version = "v1", key?: string) => store.submit(action("dispatchApprovedAction", id, version, {}, key));
  const reconcile = (id: string, request: ReconcilePayload["request"]) => {
    const r = run(id).data as RunDetail;
    return store.submit(action<ReconcilePayload>("reconcileRun", r.approvalRef, r.version, { runRef: id, request }));
  };
  return { store, approval, data, run, decide, send, reconcile };
}

describe("exact approval (FX-12)", () => {
  it("keeps approval and dispatch separate, and only a source receipt reads as succeeded", async () => {
    const { store, data, decide, send } = setup();
    const decided = await decide("demo-approval-exact", "v1", { decision: "approved" });
    expect(actionResponseSchema.safeParse(decided).success).toBe(true);
    expect(decided.state).not.toBe("succeeded");
    expect(decided.receiptRefs).toEqual([]);
    expect(store.stats.dispatches).toBe(0);
    expect(data("demo-approval-exact")).toMatchObject({ status: "approved", execution: null });

    const sent = await send("demo-approval-exact");
    expect(sent.state).toBe("succeeded");
    expect(sent.receiptRefs).toHaveLength(1);
    expect(store.stats.dispatches).toBe(1);
  });

  it("can't dispatch without an approval, and doesn't loop back to approval once approved", async () => {
    const { store, decide, send } = setup();
    expect((await errorFrom(send("demo-approval-exact"))).body.code).toBe("APPROVAL_REQUIRED");
    expect(store.stats.dispatches).toBe(0);
    await decide("demo-approval-exact", "v1", { decision: "approved" });
    await send("demo-approval-exact");
    expect((await errorFrom(decide("demo-approval-exact", "v1", { decision: "approved" }))).body.code).toBe("APPROVAL_INVALID");
  });

  it("returns read responses that match the contract", () => {
    const { approval, run } = setup();
    expect(readResponseSchema(z.unknown()).safeParse(approval("demo-approval-exact")).success).toBe(true);
    expect(readResponseSchema(z.unknown()).safeParse(run("demo-run-batch")).success).toBe(true);
  });

  it("hands out copies, so a client can't alter server state by mutating a response", () => {
    const { data } = setup();
    data("demo-approval-exact").status = "approved";
    expect(data("demo-approval-exact").status).toBe("pending");
  });
});

describe("validation and policy (FX-10)", () => {
  it("refuses to approve an upfront fee on new acquisition, with no dispatch", async () => {
    const { store, data, decide } = setup();
    const error = await errorFrom(decide("demo-approval-fee", "v1", { decision: "approved" }));
    expect(error.body.code).toBe("POLICY_VIOLATION");
    expect(error.body.fieldErrors?.upfrontFee).toBeDefined();
    expect(data("demo-approval-fee").status).toBe("pending");
    expect(store.stats.dispatches).toBe(0);
  });

  it("requires a reason to reject", async () => {
    const { decide } = setup();
    const error = await errorFrom(decide("demo-approval-exact", "v1", { decision: "rejected", reason: "   " }));
    expect(error.category).toBe("validation");
    expect(error.body.fieldErrors?.reason).toBeDefined();
  });

  it.each(["", "Hi, this is a synthetic invitation with a per-sale commission and no upfront fee."])("rejects an edit that is blank or unchanged: %j", async (editedMessage) => {
    const { decide } = setup();
    expect((await errorFrom(decide("demo-approval-exact", "v1", { decision: "editRequired", editedMessage }))).body.fieldErrors?.editedMessage).toBeDefined();
  });

  it("makes an edit a new version that needs its own approval", async () => {
    const { data, decide, send } = setup();
    const edited = await decide("demo-approval-exact", "v1", { decision: "editRequired", editedMessage: "New words." });
    expect(edited.state).toBe("approvalPending");
    const after = data("demo-approval-exact");
    expect(after).toMatchObject({ status: "pending", currentVersion: "v2" });
    expect(after.versions[0]).toMatchObject({ decision: "editRequired", payload: { message: expect.not.stringContaining("New words.") } });
    expect(after.versions[1]).toMatchObject({ decision: null, payload: { message: "New words." } });
    expect((await errorFrom(send("demo-approval-exact", "v2"))).body.code).toBe("APPROVAL_REQUIRED");
    expect((await errorFrom(decide("demo-approval-exact", "v1", { decision: "approved" }))).body.code).toBe("STALE_VERSION");
  });
});

describe("version conflict (FX-11)", () => {
  it("rejects a decision on an old version and reports the current one", async () => {
    const { data, decide } = setup();
    const error = await errorFrom(decide("demo-approval-conflict", "v1", { decision: "approved" }));
    expect(error.category).toBe("conflict");
    expect(error.body.currentVersion).toBe("v2");
    expect(data("demo-approval-conflict").status).toBe("pending");
    await expect(decide("demo-approval-conflict", "v2", { decision: "approved" })).resolves.toMatchObject({ state: "blocked" });
  });
});

describe("invalid approvals (FX-13)", () => {
  it("rejects an expired approval", async () => {
    const { approval, decide } = setup();
    expect(approval("demo-approval-expired").capabilities[0]).toMatchObject({ state: "held" });
    expect((await errorFrom(decide("demo-approval-expired", "v1", { decision: "approved" }))).category).toBe("approvalHold");
  });

  it("ignores a forged role or approved flag in the client payload", async () => {
    const { store, data, approval } = setup();
    expect(approval("demo-approval-founder").capabilities[0]).toMatchObject({ state: "denied" });
    const forged = { decision: "approved", actorRole: "founder", approved: true } as DecidePayload;
    const error = await errorFrom(store.submit(action("decideApproval", "demo-approval-founder", "v1", forged)));
    expect(error.body.code).toBe("SOURCE_AUTHORITY_DENIED");
    expect(data("demo-approval-founder").status).toBe("pending");
  });
});

describe("archived records", () => {
  it("can't be decided or sent, and offers no capabilities", async () => {
    const { store, approval, data, decide, send } = setup();
    expect(approval("demo-approval-042").capabilities).toEqual([]);
    expect((await errorFrom(decide("demo-approval-042", "v3", { decision: "approved" }))).body.code).toBe("APPROVAL_INVALID");
    expect((await errorFrom(send("demo-approval-042", "v3"))).body.code).toBe("APPROVAL_REQUIRED");
    expect(data("demo-approval-042").status).toBe("pending");
    expect(store.stats.dispatches).toBe(0);
  });
});

describe("idempotency", () => {
  it("resolves concurrent duplicates to one dispatch and one receipt (FX-14)", async () => {
    const { store, decide, send } = setup();
    await decide("demo-approval-exact", "v1", { decision: "approved" });
    const [a, b] = await Promise.all([send("demo-approval-exact", "v1", "same-key"), send("demo-approval-exact", "v1", "same-key")]);
    expect(store.stats.dispatches).toBe(1);
    expect(a.receiptRefs).toEqual(b.receiptRefs);
    expect(a.actionRef).toBe(b.actionRef);
  });

  it("doesn't dispatch twice even under a new key", async () => {
    const { store, decide, send } = setup();
    await decide("demo-approval-exact", "v1", { decision: "approved" });
    const first = await send("demo-approval-exact");
    const second = await send("demo-approval-exact");
    expect(store.stats.dispatches).toBe(1);
    expect(second.receiptRefs).toEqual(first.receiptRefs);
  });

  it("refuses the same key with a changed payload (FX-15)", async () => {
    const { data, decide } = setup();
    await decide("demo-approval-exact", "v1", { decision: "editRequired", editedMessage: "First." }, "reused");
    const error = await errorFrom(decide("demo-approval-exact", "v1", { decision: "editRequired", editedMessage: "Second." }, "reused"));
    expect(error.body.code).toBe("MANIFEST_CHANGED");
    expect(data("demo-approval-exact").versions).toHaveLength(2);
  });

  it("lets a known failure be retried under its key", async () => {
    const { decide } = setup();
    await errorFrom(decide("demo-approval-fee", "v1", { decision: "approved" }, "retry"));
    expect((await errorFrom(decide("demo-approval-fee", "v1", { decision: "approved" }, "retry"))).body.code).toBe("POLICY_VIOLATION");
  });
});

describe("unknown outcome (FX-16, FX-17)", () => {
  it("reports an uncertain send as uncertain, and won't send it again", async () => {
    const { store, data, decide, send } = setup();
    await decide("demo-approval-uncertain", "v1", { decision: "approved" });
    const first = await send("demo-approval-uncertain");
    expect(first).toMatchObject({ state: "outcomeUncertain", receiptRefs: [], runRef: "demo-run-uncertain" });
    const second = await send("demo-approval-uncertain");
    expect(second.state).toBe("outcomeUncertain");
    expect(store.stats.dispatches).toBe(1);
    expect(data("demo-approval-uncertain").execution?.state).toBe("outcomeUncertain");
  });

  it("can't record sent or retry on assertion alone (CTRL-044, CTRL-045)", async () => {
    const { run, reconcile } = setup();
    expect((await errorFrom(reconcile("demo-run-uncertain", "recordConfirmedSent"))).body.executionCertainty).toBe("uncertain");
    expect((await errorFrom(reconcile("demo-run-uncertain", "freshAttempt"))).category).toBe("outcomeUncertain");
    expect((run("demo-run-uncertain").data as RunDetail).state).toBe("outcomeUncertain");
  });

  it("records a found receipt once, and repeating recovery changes nothing (FX-17)", async () => {
    const { run, reconcile, store } = setup();
    await reconcile("demo-run-uncertain", "lookup");
    expect(run("demo-run-uncertain").capabilities.find((c) => c.actionKind === "recordConfirmedSent")?.state).toBe("available");
    const first = await reconcile("demo-run-uncertain", "recordConfirmedSent");
    expect(first.receiptRefs).toEqual(["demo-source-receipt-prior"]);
    const again = await reconcile("demo-run-uncertain", "recordConfirmedSent");
    expect(again.receiptRefs).toEqual(first.receiptRefs);
    expect((run("demo-run-uncertain").data as RunDetail).counts.confirmed).toBe(1);
    expect(store.stats.dispatches).toBe(0);
  });

  it("allows a fresh attempt only when the source proves the first never ran, and that isn't sent", async () => {
    const { run, reconcile } = setup();
    await reconcile("demo-run-unsent", "lookup");
    const fresh = await reconcile("demo-run-unsent", "freshAttempt");
    expect(fresh.state).toBe("queued");
    expect(fresh.receiptRefs).toEqual([]);
    expect(run("demo-run-unsent").data).toMatchObject({ attempt: 2, state: "queued", counts: { unsent: 1, uncertain: 0 } });
  });

  it("leaves both paths blocked when the source shows nothing", async () => {
    const { run, reconcile } = setup();
    await reconcile("demo-run-noevidence", "lookup");
    expect(run("demo-run-noevidence").capabilities.filter((c) => c.state === "held").map((c) => c.actionKind)).toEqual(expect.arrayContaining(["recordConfirmedSent", "requestFreshAttempt"]));
    await errorFrom(reconcile("demo-run-noevidence", "freshAttempt"));
  });
});

describe("partial batch (FX-18)", () => {
  it("has counts that reconcile to items, and a pause touches only unsent work", async () => {
    const { store, run } = setup();
    const before = run("demo-run-batch").data as RunDetail;
    expect(Object.values(before.counts).reduce((s, n) => s + n, 0)).toBe(before.items.length);
    expect(before.counts).toMatchObject({ confirmed: 1, failed: 1, held: 1, unsent: 2 });

    const paused = await store.submit(action("controlRun", before.approvalRef, before.version, { runRef: "demo-run-batch", control: "pause" }));
    expect(paused.state).toBe("paused");
    const after = run("demo-run-batch").data as RunDetail;
    expect(after.counts).toMatchObject({ confirmed: 1, failed: 1, held: 1, unsent: 0, paused: 2 });
    expect(after.items.find((i) => i.state === "confirmed")?.receiptRef).toBe("demo-source-receipt-a");
  });
});

describe("reads", () => {
  it("reports missing and forbidden records distinctly", () => {
    const { approval, run } = setup();
    expect(() => approval("nope")).toThrow(AdapterError);
    try { approval("nope"); } catch (e) { expect((e as AdapterError).category).toBe("notFound"); }
    try { approval("demo-approval-forbidden"); } catch (e) { expect((e as AdapterError).category).toBe("forbidden"); }
    try { run("nope"); } catch (e) { expect((e as AdapterError).category).toBe("notFound"); }
  });
});

describe("FE04-02 canonical IDs from approval to receipt", () => {
  it("carries one approval ref through the decision, the run and the source receipt, and approved never loops back", async () => {
    const { data, run, decide, send } = setup();
    const decided = await decide("demo-approval-exact", "v1", { decision: "approved" });
    expect(decided.approvalRef).toBe("demo-approval-exact");
    const approved = data("demo-approval-exact");
    const decision = approved.versions.at(-1)!;
    expect(decision.decisionReceiptRef).toBe("demo-decision-receipt-demo-approval-exact-v1");

    const sent = await send("demo-approval-exact");
    expect(sent.approvalRef).toBe("demo-approval-exact");
    expect(sent.runRef).toBe("demo-run-exact");
    expect(sent.receiptRefs).toEqual(["demo-source-receipt-demo-approval-exact"]);

    const after = data("demo-approval-exact");
    expect(after.execution).toEqual({ runRef: sent.runRef, state: "succeeded", receiptRefs: sent.receiptRefs });
    const r = run(sent.runRef!).data as RunDetail;
    expect(r.approvalRef).toBe("demo-approval-exact");
    expect(r.correlationId).toBe(`corr-${sent.runRef}`);
    expect(r.items.map((i) => i.receiptRef)).toEqual(sent.receiptRefs);

    // Sending again returns the same run and receipt; it neither dispatches twice nor decides again.
    const again = await send("demo-approval-exact");
    expect(again.runRef).toBe(sent.runRef);
    expect(again.receiptRefs).toEqual(sent.receiptRefs);
    const deciding = await errorFrom(decide("demo-approval-exact", "v1", { decision: "approved" }));
    expect(deciding.body.code).toBe("APPROVAL_INVALID");
    expect(data("demo-approval-exact").status).toBe("approved");
  });

  it("an uncertain send keeps the same approval and run refs and carries no receipt", async () => {
    const { data, run, decide, send } = setup();
    await decide("demo-approval-uncertain", "v1", { decision: "approved" });
    const sent = await send("demo-approval-uncertain");
    expect(sent.state).toBe("outcomeUncertain");
    expect(sent.approvalRef).toBe("demo-approval-uncertain");
    expect(sent.receiptRefs).toEqual([]);
    expect(data("demo-approval-uncertain").execution).toMatchObject({ runRef: sent.runRef, receiptRefs: [] });
    expect((run(sent.runRef!).data as RunDetail).approvalRef).toBe("demo-approval-uncertain");
  });
});

describe("FE04-04 founder authority for financial commitments", () => {
  const founder = () => {
    const store = createDemoApprovals({ actorRole: "founder" });
    const decide = (id: string, payload: DecidePayload) => store.submit(action("decideApproval", id, "v1", payload));
    const data = (id: string) => store.readApproval(read("approvalDetail", { approvalId: id })).data as ApprovalDetail;
    const caps = (id: string) => store.readApproval(read("approvalDetail", { approvalId: id })).capabilities;
    return { store, decide, data, caps };
  };

  it("a reviewer is refused on a founder-only commitment and nothing changes", async () => {
    const { data, decide } = setup();
    const err = await errorFrom(decide("demo-approval-founder", "v1", { decision: "approved" }));
    expect(err.body.code).toBe("SOURCE_AUTHORITY_DENIED");
    expect(err.body.message).toMatch(/founder/);
    expect(data("demo-approval-founder").status).toBe("pending");
  });

  it("a founder is offered the decision, and a reviewer is shown it as denied for role", async () => {
    expect(founder().caps("demo-approval-founder")).toEqual([{ actionKind: "decideApproval", state: "available", reasonCodes: [] }]);
    const { approval } = setup();
    expect(approval("demo-approval-founder").capabilities).toEqual([{ actionKind: "decideApproval", state: "denied", reasonCodes: ["ROLE_REQUIRED"] }]);
  });

  it("a founder can approve the historical fee, recorded as the founder's decision, and it is approved not paid", async () => {
    const { decide, data } = founder();
    const res = await decide("demo-approval-founder", { decision: "approved" });
    expect(res.state).not.toBe("succeeded");
    expect(res.receiptRefs).toEqual([]);
    const approved = data("demo-approval-founder");
    expect(approved).toMatchObject({ status: "approved", execution: null });
    expect(approved.versions.at(-1)).toMatchObject({ decision: "approved", decidedByRole: "founder" });
  });

  it("founder authority does not make a new upfront fee approvable", async () => {
    const { decide, data } = founder();
    const err = await errorFrom(decide("demo-approval-fee", { decision: "approved" }));
    expect(err.body.code).toBe("POLICY_VIOLATION");
    expect(data("demo-approval-fee").status).toBe("pending");
  });

  it("a founder also holds the reviewer role", async () => {
    const { decide, data } = founder();
    await decide("demo-approval-exact", { decision: "approved" });
    expect(data("demo-approval-exact").versions.at(-1)).toMatchObject({ decision: "approved", decidedByRole: "founder" });
  });
});
