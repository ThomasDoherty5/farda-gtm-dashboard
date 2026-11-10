// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { digest } from "../config.ts";
import { BASELINE_VERSION_REF, baselineEvidencePolicy } from "./contract.ts";
import { CalibrationRepository } from "./repository.ts";
import { approvalTestScope } from "../approvals/fixtures.testkit.ts";
import { calibrationFixture, packetChangeInput, proposed, syntheticCandidateSet } from "./fixtures.testkit.ts";

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });
function fixture() { const f = calibrationFixture(); closers.push(() => f.a.db.close()); return f; }
const requester = { principalRef: "synthetic:requester" };

describe("promotion requires a named human approval through J04 and never mutates the baseline", () => {
  it("does not auto-promote: an observed approval leaves the head on the baseline until promote is called", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "p1"));
    const { read, binding } = await f.decide(proposal);
    expect(read.current.state).toBe("approved");
    expect(read.manifest.draft).toMatchObject({ phase: "policyChange", effects: { changesPolicy: true, spendsMoney: false, sendsCreator: false }, payloadHash: proposal.proposalHash });
    expect(f.calibration.head().versionRef).toBe(BASELINE_VERSION_REF);
    expect(f.calibration.readProposal(proposal.proposalRef)!.state).toBe("open");

    const receipt = await f.calibration.promote({ proposalRef: proposal.proposalRef, approval: binding }, "promote-1");
    expect(receipt).toMatchObject({ status: "promoted", versionRef: "evidence-policy.rev-2", seq: 2, parentVersionRef: BASELINE_VERSION_REF, configHash: proposal.proposedConfigHash,
      approval: { principalRef: "synthetic:founder", personRef: "synthetic:founder", approvalRef: read.manifest.approvalRef } });
    const head = f.calibration.head();
    expect(head.config.packet.minIndependentPosts).toBe(2);
    expect(head.numericBindings).toEqual(f.calibration.version(BASELINE_VERSION_REF)!.numericBindings);
    expect(head.origin).toMatchObject({ kind: "promotion", proposalRef: proposal.proposalRef, rollbackOf: null });
    expect(f.calibration.version(BASELINE_VERSION_REF)!.config).toEqual(baselineEvidencePolicy());
    expect(f.calibration.readProposal(proposal.proposalRef)).toMatchObject({ state: "promoted", events: [{ kind: "promoted", versionRef: "evidence-policy.rev-2", principalRef: "synthetic:founder" }] });

    expect(await f.calibration.promote({ proposalRef: proposal.proposalRef, approval: binding }, "promote-1")).toEqual(receipt);
    expect(f.calibration.history()).toHaveLength(2);
    await expect(f.calibration.promote({ proposalRef: proposal.proposalRef, approval: binding }, "promote-2")).rejects.toMatchObject({ code: "APPROVAL_HELD", reasonCodes: ["PROPOSAL_PROMOTED"] });
    expect(f.calibration.history()).toHaveLength(2);
  });

  it("holds promotion without an approved decision, from a non-founder, or from the proposer approving their own change", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "p2"));
    await expect(f.decide(proposal, "approved", "synthetic:reviewer")).rejects.toThrow("FOUNDER_REQUIRED");
    const self = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { rationale: "Second fictional proposal for self-approval." }), { principalRef: "synthetic:founder" }, "p3"));
    await expect(f.decide(self, "approved", "synthetic:founder", "synthetic:founder")).rejects.toThrow("SECOND_PERSON_REQUIRED");
    const other = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { rationale: "Third fictional proposal previewed by someone else." }), requester, "p4"));
    await expect(f.decide(other, "approved", "synthetic:founder", "synthetic:reviewer")).rejects.toThrow("PROPOSER_MISMATCH");
    expect(f.calibration.head().versionRef).toBe(BASELINE_VERSION_REF);
  });

  it("refuses a binding for a different proposal and an unconfigured approval authority", async () => {
    const f = fixture();
    const first = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "pa"));
    const second = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { rationale: "Another fictional proposal." }), requester, "pb"));
    const { binding } = await f.decide(first);
    await expect(f.calibration.promote({ proposalRef: second.proposalRef, approval: binding }, "wrong")).rejects.toThrow("APPROVAL_BINDING_MISMATCH");
    const unconfigured = new CalibrationRepository(f.a.db, { scope: approvalTestScope, now: () => f.a.state.now });
    await expect(unconfigured.promote({ proposalRef: first.proposalRef, approval: binding }, "none")).rejects.toThrow("APPROVAL_AUTHORITY_UNCONFIGURED");
    expect(f.calibration.head().versionRef).toBe(BASELINE_VERSION_REF);
  });

  it("makes a sibling proposal stale once another promotion moves the head", async () => {
    const f = fixture();
    const first = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "s1"));
    const second = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { changes: [{ path: "criticalFloors.routineFit", before: 3, after: 4, rationale: "Fictional stricter floor." }] }), requester, "s2"));
    const a = await f.decide(first), b = await f.decide(second);
    await f.calibration.promote({ proposalRef: first.proposalRef, approval: a.binding }, "s1-promote");
    expect(f.calibration.readProposal(second.proposalRef)!.state).toBe("stale");
    await expect(f.calibration.promote({ proposalRef: second.proposalRef, approval: b.binding }, "s2-promote")).rejects.toMatchObject({ code: "APPROVAL_HELD", reasonCodes: ["BASE_NOT_CURRENT"] });
    expect(f.calibration.head().versionRef).toBe("evidence-policy.rev-2");
  });
});

describe("rejection and expiry are recorded", () => {
  it("records a verified J04 rejection with the named decider and then refuses promotion", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "r1"));
    const { read, binding } = await f.decide(proposal, "rejected");
    expect(() => f.calibration.recordDecision(proposal.proposalRef, "j04:approval:unknown")).toThrow("APPROVAL_BINDING_MISMATCH");
    const recorded = f.calibration.recordDecision(proposal.proposalRef, read.manifest.approvalRef);
    expect(recorded).toMatchObject({ state: "rejected", events: [{ kind: "rejected", principalRef: "synthetic:founder", personRef: "synthetic:founder", approvalRef: read.manifest.approvalRef }] });
    expect(f.calibration.recordDecision(proposal.proposalRef, read.manifest.approvalRef)).toEqual(recorded);
    await expect(f.calibration.promote({ proposalRef: proposal.proposalRef, approval: binding }, "after-reject")).rejects.toThrow("APPROVAL_HELD");
    expect(f.calibration.head().versionRef).toBe(BASELINE_VERSION_REF);
  });

  it("does not treat an approval as a terminal decision outside promote", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "r2"));
    const { read } = await f.decide(proposal);
    expect(() => f.calibration.recordDecision(proposal.proposalRef, read.manifest.approvalRef)).toThrow("DECISION_NOT_TERMINAL");
  });

  it("records expiry once the deadline passes and keeps the head unchanged", () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { expiresAt: new Date(f.a.state.now + 60_000).toISOString() }), requester, "e1"));
    expect(f.calibration.expireDue()).toEqual([]);
    f.a.state.now += 60_000;
    expect(f.calibration.readProposal(proposal.proposalRef)!.state).toBe("expired");
    expect(f.calibration.expireDue()).toEqual([proposal.proposalRef]);
    expect(f.calibration.readProposal(proposal.proposalRef)).toMatchObject({ state: "expired", events: [{ kind: "expired", expiresAt: proposal.expiresAt }] });
    expect(f.calibration.expireDue()).toEqual([]);
    expect(() => f.calibration.approvableProposal(proposal.proposalRef, f.a.state.now)).toThrow("PROPOSAL_EXPIRED");
    expect(f.calibration.head().versionRef).toBe(BASELINE_VERSION_REF);
  });
});

describe("the injected clock is read after awaits", () => {
  it("records expiry inside the final transaction when the deadline passes while the approval proof is resolving", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now, { expiresAt: new Date(f.a.state.now + 60_000).toISOString() }), requester, "late"));
    const { binding } = await f.decide(proposal);
    let asserted = 0;
    const slow = new CalibrationRepository(f.a.db, { scope: approvalTestScope, now: () => f.a.state.now, approvals: {
      resolveCurrentProof: async b => { const current = await f.approvals.resolveCurrentProof(b); f.a.state.now += 60_000; return current; },
      assertCurrentProof: (proof, now) => { asserted++; f.approvals.assertCurrentProof(proof, now); }, readApproval: (ref, v) => f.approvals.readApproval(ref, v) } });
    await expect(slow.promote({ proposalRef: proposal.proposalRef, approval: binding }, "late-promote")).rejects.toThrow("PROPOSAL_EXPIRED");
    expect(asserted).toBe(0);
    expect(slow.readProposal(proposal.proposalRef)).toMatchObject({ state: "expired", events: [{ kind: "expired" }] });
    expect(slow.head().versionRef).toBe(BASELINE_VERSION_REF);
  });
});

describe("rollback creates a new version equal to an earlier config and preserves history", () => {
  it("restores the baseline config as rev-3 through the same human approval path", async () => {
    const f = fixture();
    const change = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "rb-change"));
    await f.calibration.promote({ proposalRef: change.proposalRef, approval: (await f.decide(change)).binding }, "rb-promote-1");
    const before = f.calibration.history();

    const rollback = proposed(f.calibration.proposeRollback({ mode: "evidencePolicy", baseVersionRef: "evidence-policy.rev-2",
      basis: { kind: "rollback", targetVersionRef: BASELINE_VERSION_REF, reason: "Fictional review found the smaller packet too permissive.", limits: ["Synthetic rollback drill."] },
      candidateSet: syntheticCandidateSet(), expiresAt: new Date(f.a.state.now + 3_600_000).toISOString() }, requester, "rb-propose"));
    expect(rollback).toMatchObject({ kind: "rollback", rollbackTargetVersionRef: BASELINE_VERSION_REF, sufficiency: { status: "notRequired" },
      changes: [{ path: "packet.minIndependentPosts", before: 2, after: 3 }] });
    expect(rollback.comparison.summary).toEqual({ changed: 2, unchanged: 4, transitions: { "pass->reviewNeeded": 2 } });
    expect(f.calibration.head().versionRef).toBe("evidence-policy.rev-2");

    const receipt = await f.calibration.promote({ proposalRef: rollback.proposalRef, approval: (await f.decide(rollback)).binding }, "rb-promote-2");
    expect(receipt).toMatchObject({ versionRef: "evidence-policy.rev-3", parentVersionRef: "evidence-policy.rev-2" });
    const history = f.calibration.history();
    expect(history.map(v => v.versionRef)).toEqual([BASELINE_VERSION_REF, "evidence-policy.rev-2", "evidence-policy.rev-3"]);
    expect(history.slice(0, 2)).toEqual(before);
    expect(history[2]!.config).toEqual(history[0]!.config);
    expect(history[2]!.configHash).toBe(digest(baselineEvidencePolicy()));
    expect(history[2]!.origin).toMatchObject({ kind: "promotion", proposalKind: "rollback", rollbackOf: BASELINE_VERSION_REF });
    expect(new Set(history.map(v => v.numericBindingsHash)).size).toBe(1);
  });

  it("refuses a rollback to a later or identical version", () => {
    const f = fixture();
    const input = { mode: "evidencePolicy" as const, baseVersionRef: BASELINE_VERSION_REF,
      basis: { kind: "rollback" as const, targetVersionRef: BASELINE_VERSION_REF, reason: "Fictional no-op.", limits: ["Synthetic."] },
      candidateSet: syntheticCandidateSet(), expiresAt: new Date(f.a.state.now + 3_600_000).toISOString() };
    expect(f.calibration.proposeRollback(input, requester, "rb-noop")).toMatchObject({ status: "refused", reasonCodes: ["ROLLBACK_TARGET_INVALID"] });
  });
});

describe("persistence is append-only and restart-safe", () => {
  it("rejects direct edits to versions, proposals and outcomes, and re-verifies the baseline on restart", async () => {
    const f = fixture();
    const proposal = proposed(f.calibration.createProposal(packetChangeInput(f.a.state.now), requester, "imm"));
    await f.calibration.promote({ proposalRef: proposal.proposalRef, approval: (await f.decide(proposal)).binding }, "imm-promote");
    expect(() => f.a.db.exec("UPDATE calibration_versions SET body='{}' WHERE seq=1")).toThrow("CALIBRATION_VERSION_IMMUTABLE");
    expect(() => f.a.db.exec("DELETE FROM calibration_versions WHERE seq=2")).toThrow("CALIBRATION_VERSION_IMMUTABLE");
    expect(() => f.a.db.exec("UPDATE calibration_proposals SET body='{}'")).toThrow("CALIBRATION_PROPOSAL_IMMUTABLE");
    expect(() => f.a.db.exec("DELETE FROM calibration_outcomes")).toThrow("CALIBRATION_OUTCOME_IMMUTABLE");
    const restarted = new CalibrationRepository(f.a.db, { scope: approvalTestScope, now: () => f.a.state.now });
    expect(restarted.history()).toEqual(f.calibration.history());
    expect(restarted.readProposal(proposal.proposalRef)!.state).toBe("promoted");
    const changedNumeric = f.calibration.head().numericBindings.map(b => ({ ...b, numericHash: "f".repeat(64) }));
    expect(() => new CalibrationRepository(f.a.db, { scope: approvalTestScope, now: () => f.a.state.now, numericBindings: changedNumeric })).toThrow("NUMERIC_BASELINE_CHANGED");
  });

  it("rejects a non-finite clock", () => {
    const f = fixture();
    const broken = new CalibrationRepository(f.a.db, { scope: approvalTestScope, now: () => f.a.state.now });
    f.a.state.now = Number.NaN;
    expect(() => broken.expireDue()).toThrow("INVALID_CLOCK");
  });
});
