// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture } from "./fixtures.testkit.ts";
import { approvalDraftSchema } from "./contract.ts";
import { approvalDispatchBinding, stableApprovalDraft } from "./repository.ts";
import { digest } from "../config.ts";

type Fixture = ReturnType<typeof approvalFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.db.close(); });
function make(amount = 30_000, units = 1) {
  const f = approvalFixture(); fixtures.push(f);
  const na = () => ({ state: "notApplicable" as const, policyVersion: f.policy.version, reason: "Fictional earned reward is separate from new creator acquisition." });
  f.command.actionKind = f.draft.actionKind = "reward.redeem";
  f.draft.phase = "rewardRedemption";
  f.draft.acquisitionTerms = null; f.draft.historicalLiability = null; f.draft.termsVersion = na();
  f.draft.effects = { spendsMoney: amount > 0, sendsCreator: true, changesPolicy: false };
  f.draft.items[0]!.units = units; f.draft.items[0]!.spendMinor = amount;
  f.draft.bounds.maxUnits = units; f.draft.bounds.maxSpendMinor = amount;
  f.draft.exposure = { state: "known", minor: amount, currency: "USD" };
  f.draft.gates.acceptedTerms = na(); f.draft.gates.sampleAuthority = na(); f.draft.gates.providerTerms = na();
  f.draft.gates.rewardStockAuthority = units ? { state: "satisfied", sourceRef: "synthetic:j15-reward-purpose-allocation", sourceVersion: "reward-allocation-v1", validUntil: f.until() } : na();
  return f;
}
async function founderApproved(f: Fixture) {
  const request = await f.requested(), event = f.event(request, "approved", "synthetic:founder");
  return f.repo.observeDecision(event.locator, { ingressRef: "synthetic:trusted-source-ingress" });
}
describe("canonical earned-reward approval phase; fictional sources with actual SQLite", () => {
  it.each([0, 30_000, 50_000])("requires a distinct founder for a reward of %i minor units", async amount => {
    const f = make(amount, 0), request = await f.requested(), event = f.event(request);
    await expect(f.repo.observeDecision(event.locator, { ingressRef: "synthetic:trusted-source-ingress" })).rejects.toThrow("FOUNDER_REQUIRED");
    expect(f.state.writes).toBe(1); // The request is recorded; no decision is authorized.
  });
  it("uses reward-purpose stock authority, preserves the source receipt and rechecks the current founder role", async () => {
    const f = make(), read = await founderApproved(f);
    expect(read.current.state).toBe("approved");
    expect(read.manifest.draft.gates.sampleAuthority.state).toBe("notApplicable");
    const binding = approvalDispatchBinding(read.manifest, "synthetic:item-1"), proof = await f.repo.resolveCurrentProof(binding);
    expect(proof.state).toBe("verified");
    if (proof.state !== "verified") throw new Error("Expected fictional canonical approval proof");
    expect(() => f.repo.assertCurrentProof(proof.proof, f.state.now)).not.toThrow();
    f.humans.get("synthetic:founder")!.roles = ["reviewer"];
    expect(() => f.repo.assertCurrentProof(proof.proof, f.state.now)).toThrow();
    const held = await f.repo.resolveCurrentProof(binding);
    expect(held.state).toBe("held");
    if (held.state === "held") expect(held.reasonCodes).toContain("FOUNDER_REQUIRED");
    expect(f.repo.readApproval(read.manifest.approvalRef)?.decisionReceipt).toEqual(read.decisionReceipt);
  });
  it.each(["missing", "sample-only", "unknown", "notApplicable", "stale"] as const)("cannot substitute %s evidence for reward stock", async state => {
    const f = make();
    if (state === "missing" || state === "sample-only") delete f.draft.gates.rewardStockAuthority;
    if (state === "sample-only") f.draft.gates.sampleAuthority = { state: "satisfied", sourceRef: "synthetic:sample-allocation", sourceVersion: "sample-v1", validUntil: f.until() };
    if (state === "unknown") f.draft.gates.rewardStockAuthority = { state: "unknown", reason: "No reward-purpose allocation observed" };
    if (state === "notApplicable") f.draft.gates.rewardStockAuthority = { state: "notApplicable", policyVersion: f.policy.version, reason: "An invalid N/A claim for this physical reward" };
    if (state === "stale") f.draft.gates.rewardStockAuthority = { state: "satisfied", sourceRef: "synthetic:expired-reward-allocation", sourceVersion: "reward-v1", validUntil: f.at() };
    await expect(f.requested()).rejects.toThrow(/GATE_REWARDSTOCKAUTHORITY_/);
    expect(f.state.writes).toBe(0);
  });
  it("binds the exact reward allocation version and cannot reuse its old proof after material change", async () => {
    const f = make(), read = await founderApproved(f), binding = approvalDispatchBinding(read.manifest, "synthetic:item-1");
    const proof = await f.repo.resolveCurrentProof(binding);
    if (proof.state !== "verified") throw new Error("Expected fictional canonical approval proof");
    f.draft.gates.rewardStockAuthority = { state: "satisfied", sourceRef: "synthetic:j15-reward-purpose-allocation", sourceVersion: "reward-allocation-v2", validUntil: f.until() };
    expect(() => f.repo.assertCurrentProof(proof.proof, f.state.now)).toThrow();
    expect((await f.repo.resolveCurrentProof(binding)).state).toBe("held");
    expect(f.repo.readApproval(read.manifest.approvalRef)?.decisionReceipt).toEqual(read.decisionReceipt);
  });
  it("cannot lower reward approval authority by choosing the generic phase or reuse acquisition fee terms", async () => {
    const f = make(); f.draft.phase = "other";
    await expect(f.requested()).rejects.toThrow("REWARD_APPROVAL_PHASE_REQUIRED");
    const g = make(); g.draft.acquisitionTerms = { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0,
      commissionPct: 20, perSaleFixedMinor: 0, sampleCostMinor: 0 };
    await expect(g.requested()).rejects.toThrow("REWARD_ACQUISITION_TERMS_NOT_APPLICABLE");
  });
  it("leaves existing five-gate manifest material unchanged when parsing the extended schema", () => {
    const f = approvalFixture(); fixtures.push(f);
    const before = digest(stableApprovalDraft(f.draft)), parsed = approvalDraftSchema.parse(JSON.parse(JSON.stringify(f.draft)));
    expect(Object.hasOwn(parsed.gates, "rewardStockAuthority")).toBe(false);
    expect(digest(stableApprovalDraft(parsed))).toBe(before);
  });
});
