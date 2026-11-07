// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture } from "./fixtures.testkit.ts";
import { approvalDispatchBinding, ApprovalRepository } from "./repository.ts";
const opened: ReturnType<typeof approvalFixture>[] = [];
const make = () => { const f = approvalFixture(); opened.push(f); return f; };
afterEach(() => opened.splice(0).forEach(f => f.db.close()));
async function proof(f: ReturnType<typeof make>) { const read = await f.approved(), result = await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1")); if (result.state !== "verified") throw new Error("Expected synthetic proof"); return { read, proof: result.proof }; }

describe("source-owned final fences and durable negative observations", () => {
  it("a known request readback loss permanently fences the previously issued proof across repository restart", async () => {
    const f = make(), issued = await proof(f); f.state.linearUnavailable = true;
    const current = await f.repo.requestDecision({ approvalRef: issued.read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose");
    expect(current.current.reasonCodes).toContain("APPROVAL_REQUEST_UNVERIFIED");
    f.state.linearUnavailable = false; const reopened = new ApprovalRepository(f.db, f.options);
    expect(() => reopened.assertCurrentProof(issued.proof, f.state.now)).toThrow("APPROVAL_VERSION_CHANGED");
    const refreshed = await reopened.resolveCurrentProof(issued.proof.binding); expect(refreshed.state).toBe("verified"); expect(f.state.writes).toBe(2);
    expect(reopened.readApproval(issued.read.manifest.approvalRef)?.decisionReceipt).toEqual(issued.read.decisionReceipt);
  });
  it.each(["edited", "deleted", "revoked", "ambiguous"] as const)("a known %s Slack event fences its current authorization without erasing the original receipt", async state => {
    const f = make(), issued = await proof(f), event = f.events.get("synthetic:event-1")!; event.state = state; event.sourceVersion = "slack-v2";
    await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:trusted-ingress" })).rejects.toThrow("SLACK_DECISION_UNVERIFIED");
    expect(() => f.repo.assertCurrentProof(issued.proof, f.state.now)).toThrow("APPROVAL_VERSION_CHANGED");
    expect(f.repo.readApproval(issued.read.manifest.approvalRef)?.current.state).toBe("held"); expect(f.repo.readApproval(issued.read.manifest.approvalRef)?.decisionReceipt).toEqual(issued.read.decisionReceipt);
  });
  it("an unrelated invalid locator cannot fence a different recorded authorization", async () => {
    const f = make(), issued = await proof(f); const wrong = { ...issued.proof.decisionReceipt.slack, eventRef: "synthetic:unrelated-event" };
    await expect(f.repo.observeDecision(wrong, { ingressRef: "synthetic:trusted-ingress" })).rejects.toThrow("SLACK_DECISION_UNVERIFIED");
    expect(() => f.repo.assertCurrentProof(issued.proof, f.state.now)).not.toThrow();
  });
  it.each(["actor", "draft"] as const)("the source-owned synchronous fence catches %s change in the final awaited source read", async kind => {
    const f = make(), approved = await f.approved(), original = f.sources.readSlackDecision!;
    f.sources.readSlackDecision = async (...args) => { if (kind === "actor") f.humans.get("synthetic:reviewer")!.active = false; else { f.draft.sourceBasisVersion = "packet-v2"; f.draft.items[0]!.targetVersion = "identity-v2"; } return original(...args); };
    const result = await f.repo.resolveCurrentProof(approvalDispatchBinding(approved.manifest, "synthetic:item-1"));
    expect(result).toMatchObject({ state: "held", reasonCodes: [kind === "actor" ? "AUTHORITY_REQUIRED" : "APPROVAL_SOURCE_CHANGED"] });
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM approval_verifications").get()?.n).toBe(0);
  });
  it("the final dispatch assertion reads current source versions rather than accepting the proof's copied observations", async () => {
    const f = make(), issued = await proof(f); f.humans.get("synthetic:reviewer")!.directoryVersion = "directory-v2";
    expect(() => f.repo.assertCurrentProof(issued.proof, f.state.now)).toThrow("AUTHORITY_REQUIRED");
  });
  it("missing final source fences cannot issue authority even with otherwise valid historical source objects", async () => {
    const f = make(), read = await f.approved(); f.sources.assertCurrent = undefined;
    expect(await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1"))).toMatchObject({ state: "held", reasonCodes: ["APPROVAL_CURRENT_AUTHORITY_UNAVAILABLE"] });
  });
  it("retains positive source readback history alongside a later explicit denial", async () => {
    const f = make(), issued = await proof(f); f.state.denied = true;
    await f.repo.requestDecision({ approvalRef: issued.read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose");
    const observations = f.db.prepare("SELECT body FROM approval_source_observations WHERE source='linear'").all().map(row => JSON.parse(String(row.body)));
    expect(observations.some(value => value.state === "recorded" && value.recordRef === issued.read.request.record?.recordRef)).toBe(true);
    expect(observations.some(value => value.state === "denied" && value.reasonCode === "LINEAR_SOURCE_DENIED")).toBe(true);
    expect(() => f.repo.assertCurrentProof(issued.proof, f.state.now)).toThrow("APPROVAL_VERSION_CHANGED");
  });
});
