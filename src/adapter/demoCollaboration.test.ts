import { SCHEMA_VERSION, type ActionRequest, type ReadRequest } from "./contract";
import { createDemoCollaboration } from "./demoCollaboration";
import { COLLABORATION_ID, VOLUNTARY_COLLABORATION_ID, collaborationDemo, postingTiming, reviewAfter, revisionsRemaining, voluntaryCollaborationDemo } from "@/fixtures/collaboration";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const read = (id = COLLABORATION_ID): ReadRequest<unknown> => ({ schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey: "collaborationDetail", requestedScope: scope, filters: { collaborationId: id }, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r1" });
const act = (actionKind: string, expectedVersion: string, key: string, payload: object): ActionRequest<unknown> => ({ schemaVersion: SCHEMA_VERSION, operation: "requestApproval", requestedScope: scope, actionKind, entityRefs: [], expectedVersion, approvalRef: null, manifestRef: null, idempotencyKey: key, payload: { collaborationId: COLLABORATION_ID, ...payload }, requestId: `a-${key}` });

describe("collaboration fixture", () => {
  it("derives the review date from the posting due date and the grace period", () => {
    expect(reviewAfter("2026-11-04", 3)).toBe("2026-11-07");
    expect(reviewAfter("2026-12-30", 3)).toBe("2027-01-02");
  });
  it("counts the revision rounds left, never below zero", () => {
    expect(revisionsRemaining({ allowed: 2, used: 1 })).toBe(1);
    expect(revisionsRemaining({ allowed: 1, used: 3 })).toBe(0);
  });
});

describe("demo collaboration", () => {
  it("reads the record, with every command offered and none queued", () => {
    const res = createDemoCollaboration().read(read());
    expect(res.data).toMatchObject({ ref: "COL-SC-042", requests: [] });
    expect(res.capabilities.map((c) => c.actionKind)).toHaveLength(7);
    expect(res.dataVersion).toBe("collab-v1");
  });

  it("queues feedback for approval, never as sent, and advances the version", async () => {
    const c = createDemoCollaboration();
    const result = await c.submit(act("queueFeedback", "collab-v1", "k1", { text: "Please fix the opening.", submissionVersion: "v2" }));
    expect(result.state).toBe("approvalPending");
    expect(result.receiptRefs).toEqual([]);
    expect(result.payloadVersion).toBe("collab-v2");
    expect(c.read(read()).data!.requests).toEqual([expect.objectContaining({ kind: "queueFeedback", version: "collab-v2", state: "approvalPending" })]);
    expect(c.read(read()).dataVersion).toBe("collab-v2");
  });

  it("is idempotent, and a stale version is a recoverable conflict", async () => {
    const c = createDemoCollaboration();
    const first = await c.submit(act("queueFeedback", "collab-v1", "same", { text: "x", submissionVersion: "v2" }));
    expect(await c.submit(act("queueFeedback", "collab-v1", "same", { text: "x", submissionVersion: "v2" }))).toEqual(first);
    expect(c.read(read()).data!.requests).toHaveLength(1);
    await expect(c.submit(act("queueFeedback", "collab-v1", "other", { text: "y", submissionVersion: "v2" }))).rejects.toMatchObject({ category: "conflict" });
  });

  it("requires the fields each command needs", async () => {
    const c = createDemoCollaboration();
    await expect(c.submit(act("queueFeedback", "collab-v1", "k1", { text: "  ", submissionVersion: "v2" }))).rejects.toMatchObject({ category: "validation" });
    await expect(c.submit(act("rejectContent", "collab-v1", "k2", { reason: "", submissionVersion: "v2" }))).rejects.toMatchObject({ category: "validation" });
    await expect(c.submit(act("suppressOutreach", "collab-v1", "k3", { reason: "" }))).rejects.toMatchObject({ category: "validation" });
    await expect(c.submit(act("closeCollaboration", "collab-v1", "k4", { outcome: "Won", reason: "x" }))).rejects.toMatchObject({ category: "validation" });
    await expect(c.submit(act("queueNextAction", "collab-v1", "k5", { actionKey: "sendMoney" }))).rejects.toMatchObject({ category: "validation" });
    expect(c.read(read()).data!.requests).toEqual([]);
  });

  it("targets the current submission only", async () => {
    const c = createDemoCollaboration();
    await expect(c.submit(act("requestRevision", "collab-v1", "k1", { text: "x", submissionVersion: "v1" }))).rejects.toMatchObject({ category: "conflict" });
  });

  it("asks for fresh terms when proposing a new collaboration", async () => {
    const result = await createDemoCollaboration().submit(act("createCollaboration", "collab-v1", "k1", { reason: "Repeat" }));
    expect(result.reasonCodes).toEqual(["FRESH_TERMS_REQUIRED"]);
    expect(result.state).toBe("approvalPending");
  });

  it("doesn't know a collaboration it doesn't have, or a command it doesn't implement", async () => {
    const c = createDemoCollaboration();
    expect(() => c.read(read("nope"))).toThrow(/does not exist/);
    await expect(c.submit(act("sendNow", "collab-v1", "k1", {}))).rejects.toMatchObject({ category: "unavailable" });
  });
});

describe("posting timing applies only when the accepted terms create the obligation (FE03-04)", () => {
  const committed = collaborationDemo.terms;
  it("a committed post has a due date, a grace period and a review date, and moves through four phases", () => {
    expect(postingTiming(committed, "2026-11-01")).toMatchObject({ obligation: "committed", phase: "before-due", daysRemaining: 3, label: "Due in 3 days", short: "Due in 3 days" });
    expect(postingTiming(committed, "2026-11-03")).toMatchObject({ phase: "before-due", daysRemaining: 1, label: "Due in 1 day" });
    expect(postingTiming(committed, "2026-11-04")).toMatchObject({ phase: "due-today", daysRemaining: 3, due: "2026-11-04", reviewAfter: "2026-11-07" });
    expect(postingTiming(committed, "2026-11-07")).toMatchObject({ phase: "in-grace", daysRemaining: 0 });
    expect(postingTiming(committed, "2026-11-08")).toMatchObject({ phase: "past-grace", label: "Past the grace period · review since 2026-11-07" });
  });

  it("a voluntary post has no due date, grace period or review date, and is never late", () => {
    const voluntary = voluntaryCollaborationDemo.terms;
    for (const asOf of ["2026-10-14", "2026-11-04", "2026-11-13", "2027-03-01"]) {
      const t = postingTiming(voluntary, asOf);
      expect(t.obligation).toBe("voluntary");
      expect(t).not.toHaveProperty("due");
      expect(t).not.toHaveProperty("reviewAfter");
      expect(["observing", "window-ended"]).toContain(t.phase);
    }
  });

  it("a voluntary collaboration is observed for its window, then ready to close, with the sample cost retained", () => {
    const voluntary = voluntaryCollaborationDemo.terms;
    expect(postingTiming(voluntary, "2026-11-04")).toMatchObject({ phase: "observing", observeUntil: "2026-11-13", daysRemaining: 9, sampleCost: { minorUnits: 1_840, currency: "USD" } });
    expect(postingTiming(voluntary, "2026-11-13")).toMatchObject({ phase: "observing", daysRemaining: 0 });
    expect(postingTiming(voluntary, "2026-11-14")).toMatchObject({ phase: "window-ended", label: "Observation ended 2026-11-13 · ready to close" });
  });
});

describe("demo voluntary collaboration", () => {
  it("reads as its own record with no content and no fee", () => {
    const res = createDemoCollaboration().read(read(VOLUNTARY_COLLABORATION_ID));
    expect(res.data).toMatchObject({ ref: "COL-SC-051", content: null, terms: { agreedFee: null, posting: { kind: "voluntary" } }, requests: [] });
  });

  it("refuses a posting reminder, because no posting is owed", async () => {
    const c = createDemoCollaboration();
    await expect(c.submit(act("queueNextAction", "collab-v1", "k1", { collaborationId: VOLUNTARY_COLLABORATION_ID, actionKey: "remindCreator" }))).rejects.toMatchObject({ category: "validation", message: expect.stringContaining("voluntary post is observed, not chased") });
    expect(c.read(read(VOLUNTARY_COLLABORATION_ID)).data!.requests).toEqual([]);
  });

  it("still allows the committed collaboration's reminder", async () => {
    const c = createDemoCollaboration();
    const result = await c.submit(act("queueNextAction", "collab-v1", "k1", { collaborationId: COLLABORATION_ID, actionKey: "remindCreator" }));
    expect(result.state).toBe("approvalPending");
  });

  it("has nothing to give feedback on, revise or reject", async () => {
    const c = createDemoCollaboration();
    for (const [kind, payload] of [["queueFeedback", { text: "x", submissionVersion: "v2" }], ["requestRevision", { text: "x", submissionVersion: "v2" }], ["rejectContent", { reason: "x", submissionVersion: "v2" }]] as const) {
      await expect(c.submit(act(kind, "collab-v1", `k-${kind}`, { collaborationId: VOLUNTARY_COLLABORATION_ID, ...payload }))).rejects.toMatchObject({ category: "validation" });
    }
  });

  it("closes through the observation branch with only its own outcomes, and keeps queued requests per collaboration", async () => {
    const c = createDemoCollaboration();
    await expect(c.submit(act("closeCollaboration", "collab-v1", "k1", { collaborationId: VOLUNTARY_COLLABORATION_ID, outcome: "Declined", reason: "x" }))).rejects.toMatchObject({ category: "validation" });
    await c.submit(act("closeCollaboration", "collab-v1", "k2", { collaborationId: VOLUNTARY_COLLABORATION_ID, outcome: "No response", reason: "Window ended with no post" }));
    expect(c.read(read(VOLUNTARY_COLLABORATION_ID)).data!.requests).toEqual([expect.objectContaining({ summary: "Close as No response" })]);
    expect(c.read(read(COLLABORATION_ID)).data!.requests).toEqual([]);
  });

  it("an unknown collaboration is still not found", () => {
    expect(() => createDemoCollaboration().read(read("demo-collaboration-9"))).toThrow(/does not exist/);
  });
});
