import { SCHEMA_VERSION, type ActionRequest, type ReadRequest } from "./contract";
import { createDemoCollaboration } from "./demoCollaboration";
import { COLLABORATION_ID, reviewAfter, revisionsRemaining } from "@/fixtures/collaboration";

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
