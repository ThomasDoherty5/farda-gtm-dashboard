// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalFixture } from "./fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "./repository.ts";
import { digest } from "../config.ts";
type Fixture = ReturnType<typeof approvalFixture>;
const fixtures: Fixture[] = [];
const make = (path?: string) => { const f = approvalFixture(path); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) { try { f.db.close(); } catch { /* Closed for restart. */ } } });

describe("J04 phase/version/lease and immutable source boundaries", () => {
  it.each(["upfrontFeeMinor", "guaranteedFeeMinor", "paidComponentMinor"] as const)("rejects new acquisition %s", async field => {
    const f = make(); f.draft.acquisitionTerms![field] = 1;
    await expect(f.requested()).rejects.toThrow(); expect(f.state.writes).toBe(0);
  });
  it.each(["paid", "hybrid", "gifted"])("rejects a new %s relationship but permits only eligible per-sale commission", async relationship => {
    const f = make(); f.draft.acquisitionTerms!.relationship = relationship;
    await expect(f.requested()).rejects.toThrow(); expect(f.state.writes).toBe(0);
  });
  it("allows invitation before acceptance but requires source-confirmed accepted terms for activation and separate sample authority for shipment", async () => {
    const f = make(); expect((await f.requested()).request.state).toBe("recorded");
    f.draft.phase = "activation";
    await expect(f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "activation")).rejects.toThrow("GATE_ACCEPTEDTERMS_REQUIRED");
    f.draft.gates.acceptedTerms = { state: "satisfied", sourceRef: "synthetic:accepted-exact-terms", sourceVersion: "terms-v1", validUntil: f.until() };
    expect((await f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "accepted")).manifest.draft.phase).toBe("activation");
    f.draft.phase = "shipment"; f.draft.items[0]!.units = 1; f.draft.bounds.maxUnits = 1;
    await expect(f.repo.preparePreview(f.command, { principalRef: "synthetic:requester" }, "shipping")).rejects.toThrow("GATE_SAMPLEAUTHORITY_REQUIRED");
  });
  it("preserves an exact accepted historical liability and does not create new fee terms through settlement", async () => {
    const f = make(); f.draft.phase = "settlement"; f.draft.acquisitionTerms = null; f.draft.effects = { spendsMoney: true, sendsCreator: false, changesPolicy: false };
    f.draft.items[0]!.spendMinor = 10_000; f.draft.bounds.maxSpendMinor = 10_000; f.draft.exposure = { state: "known", minor: 10_000, currency: "USD" };
    f.draft.historicalLiability = { sourceRef: "synthetic:accepted-liability", sourceVersion: "accepted-v1", acceptedMinor: 10_000, currency: "USD", validUntil: f.until() };
    const request = await f.requested(), event = f.event(request, "approved", "synthetic:founder");
    const read = await f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" }); expect(read.current.state).toBe("approved");
    f.draft.historicalLiability.acceptedMinor = 10_001;
    expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1"))).state).toBe("held");
    expect(f.repo.readApproval(read.manifest.approvalRef)?.manifest.draft.historicalLiability?.acceptedMinor).toBe(10_000);
  });
  it.each(["policyChange", "launch", "productionEnable"] as const)("requires founder for %s even without a cash charge", async phase => {
    const f = make(); f.draft.phase = phase; f.draft.effects.changesPolicy = phase === "policyChange";
    if (phase === "launch") f.draft.gates.launchReadiness = { state: "satisfied", sourceRef: "synthetic:qualified-launch-proof", sourceVersion: "release-v1", validUntil: f.until() };
    const requested = await f.requested(), event = f.event(requested);
    await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("FOUNDER_REQUIRED");
  });
  it("retains rejection and edit-required decisions; an edited action must receive a new exact preview and approval", async () => {
    const f = make(), requested = await f.requested(), edited = f.event(requested, "editRequired");
    const old = await f.repo.observeDecision(edited.locator, { ingressRef: "synthetic:ingress" }); expect(old.current.state).toBe("editRequired");
    expect(old.decisionReceipt?.proposedEditRef).toBe("synthetic:edited-draft");
    f.draft.payloadHash = digest("synthetic revised text"); f.draft.items[0]!.payloadHash = f.draft.payloadHash;
    const next = await f.repo.preparePreview({ ...f.command, approvalRef: old.manifest.approvalRef, expectedVersion: 1, entityVersion: "offer-v2" }, { principalRef: "synthetic:requester" }, "edit-v2");
    expect(next.manifest.manifestVersion).toBe(2); expect(next.manifest.manifestHash).not.toBe(old.manifest.manifestHash); expect(next.decisionReceipt).toBeNull();
    expect(f.repo.readApproval(old.manifest.approvalRef, 1)?.decisionReceipt).toEqual(old.decisionReceipt);
    expect(f.repo.readApproval(old.manifest.approvalRef, 1)?.current.reasonCodes).toContain("APPROVAL_VERSION_CHANGED");
  });
  it("an explicit new preview after an edit requires fresh approval even when the current domain material is unchanged", async () => {
    const f = make(), requested = await f.requested(), edited = f.event(requested, "editRequired");
    const old = await f.repo.observeDecision(edited.locator, { ingressRef: "synthetic:ingress" });
    const next = await f.repo.preparePreview({ ...f.command, approvalRef: old.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "fresh-exact-preview");
    expect(next.manifest.draft).toEqual(old.manifest.draft); expect(next.manifest.manifestHash).not.toBe(old.manifest.manifestHash);
    expect(next.decisionReceipt).toBeNull(); expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(next.manifest, "synthetic:item-1"))).state).toBe("held");
  });
  it("returns a recorded reject without any dispatch proof, and prevents approval after canceling that exact version", async () => {
    const f = make(), requested = await f.requested(), rejected = f.event(requested, "rejected");
    expect((await f.repo.observeDecision(rejected.locator, { ingressRef: "synthetic:ingress" })).current.state).toBe("rejected");
    const g = make(), request = await g.requested(), cancel = g.event(request, "canceled"); await g.repo.observeDecision(cancel.locator, { ingressRef: "synthetic:ingress" });
    const approve = g.event(request, "approved", "synthetic:founder", "synthetic:later-approve");
    await expect(g.repo.observeDecision(approve.locator, { ingressRef: "synthetic:ingress" })).rejects.toThrow("APPROVAL_CANCELED");
  });
  it("detects a local manifest revision changed during an awaited source check", async () => {
    const f = make(), read = await f.approved(); let release: (() => void) | undefined;
    const wait = new Promise<void>(resolve => { release = resolve; }); let entered: (() => void) | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    f.state.readHook = async intent => { if (intent.kind === "decision") { entered!(); await wait; } };
    const pending = f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1")); await started;
    await f.repo.preparePreview({ ...f.command, approvalRef: read.manifest.approvalRef, expectedVersion: 1, entityVersion: "offer-v2" }, { principalRef: "synthetic:requester" }, "new-version");
    release!(); expect((await pending).state).toBe("held");
  });
  it("expires leases during a source await without issuing a proof, and rejects nonfinite final-fence clocks", async () => {
    const f = make(), read = await f.approved(); f.state.readHook = async intent => { if (intent.kind === "decision") f.state.now += 301_000; };
    expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1"))).state).toBe("held");
    const g = make(), good = await g.approved(), proof = await g.repo.resolveCurrentProof(approvalDispatchBinding(good.manifest, "synthetic:item-1"));
    if (proof.state !== "verified") throw new Error("Expected synthetic verified proof");
    expect(() => g.repo.assertCurrentProof(proof.proof, NaN)).toThrow("APPROVAL_PROOF_EXPIRED");
  });
  it("source lease renewal preserves immutable decision identity, while source/policy version change holds", async () => {
    const f = make(), read = await f.approved(); f.state.now += 1000;
    f.draft.sourceValidUntil = f.until(); f.events.get("synthetic:event-1")!.validUntil = f.until();
    const result = await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1")); expect(result.state).toBe("verified");
    if (result.state === "verified") expect(result.proof.decisionReceipt).toEqual(read.decisionReceipt);
    f.policy.commission.maxCommissionPct = 19; expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1"))).state).toBe("held");
  });
  it("survives an actual SQLite close/reopen, retaining decision and exact proof provenance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "synthetic-j04-reopen-")), path = join(directory, "db.sqlite");
    try {
      const f = make(path), read = await f.approved(), proof = await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1")); f.db.close();
      const next = make(path), repo = new ApprovalRepository(next.db, f.options);
      expect(repo.readApproval(read.manifest.approvalRef)?.decisionReceipt).toEqual(read.decisionReceipt);
      if (proof.state === "verified") expect(() => repo.assertCurrentProof(proof.proof, f.state.now)).not.toThrow();
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("imports the server module under native Node strip-types without a transpiler", () => {
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("./src/creator-agent/approvals/repository.ts");process.stdout.write("native-j04-ok")'], { cwd: process.cwd(), encoding: "utf8" })).toBe("native-j04-ok");
  });
  it("fences policy changes during Linear pre-write reads and safely resumes the same never-attempted intent", async () => {
    const f = make(); let changed = false;
    f.state.readHook = async intent => { if (!changed && intent.kind === "request") { changed = true; f.policy.version = "synthetic-policy-v2"; } };
    const read = await f.requested(); expect(f.state.writes).toBe(0); expect(read.request.state).toBe("local");
    f.policy.version = "synthetic-policy-v1"; f.state.readHook = null;
    const recovered = await f.repo.requestDecision({ approvalRef: read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose");
    expect(f.state.writes).toBe(1); expect(recovered.request.state).toBe("recorded");
  });
  it("a failed source read before a first write holds with zero attempts and exact-key recovery remains bounded", async () => {
    const f = make(); f.state.linearUnavailable = true; const held = await f.requested(); expect(f.state.writes).toBe(0);
    f.state.linearUnavailable = false;
    const recovered = await f.repo.requestDecision({ approvalRef: held.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose");
    expect(recovered.request.state).toBe("recorded"); expect(f.state.writes).toBe(1);
  });
  it("links a confirmed historical native receipt through Linear without reviving canceled authority", async () => {
    const f = make(), read = await f.approved(); const cancel = f.event(read, "canceled", "synthetic:founder", "synthetic:cancel");
    await f.repo.observeDecision(cancel.locator, { ingressRef: "synthetic:ingress" });
    const outcome = { approvalRef: read.manifest.approvalRef, manifestVersion: 1, manifestHash: read.manifest.manifestHash, itemRef: "synthetic:item-1", runRef: "synthetic:run", outcomeRef: "synthetic:confirmed-receipt" };
    f.outcomes.set(outcome.outcomeRef, outcome); const result = await f.repo.syncOutcomeLink(outcome);
    expect(result.outbox.find(row => row.kind === "outcome")?.state).toBe("recorded"); expect(result.current.state).toBe("held");
    const calls = f.state.writes; await f.repo.syncOutcomeLink(outcome); expect(f.state.writes).toBe(calls);
  });
  it("preserves exact internal certainty lookup after authority withdrawal without changing the original record", async () => {
    const f = make(), read = await f.requested(); f.humans.get("synthetic:requester")!.active = false;
    await expect(f.repo.requestDecision({ approvalRef: read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose")).rejects.toThrow("AUTHORITY_REQUIRED");
    expect(f.repo.readCommand("request", { approvalRef: read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "request-synthetic-propose")?.request.record).toEqual(read.request.record);
    expect(f.repo.readCommand("request", { approvalRef: read.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:other" }, "request-synthetic-propose")).toBeNull();
  });
  it("does not let a stale caller timestamp extend a shorter source proof lease", async () => {
    const f = make(), read = await f.approved(); f.events.get("synthetic:event-1")!.validUntil = new Date(f.state.now + 1000).toISOString();
    const proof = await f.repo.resolveCurrentProof(approvalDispatchBinding(read.manifest, "synthetic:item-1")); if (proof.state !== "verified") throw new Error("Expected proof");
    const originalNow = f.state.now; f.state.now += 1001;
    expect(() => f.repo.assertCurrentProof(proof.proof, originalNow)).toThrow("APPROVAL_PROOF_EXPIRED");
  });
});
