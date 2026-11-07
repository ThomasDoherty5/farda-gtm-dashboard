// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture } from "./fixtures.testkit.ts";
import { draftPolicyReasons, decisionAuthorityReasons } from "./policy.ts";
import { approvalDraftSchema } from "./contract.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(phase: "mediaStageRelease" | "mediaSafetyPause") {
  const f = approvalFixture(); cleanup.push(() => f.db.close());
  const d = f.draft; d.phase = phase; d.acquisitionTerms = null; d.effects = { spendsMoney: false, sendsCreator: false, changesPolicy: false };
  d.actionKind = phase === "mediaStageRelease" ? "media.stageRelease" : "media.pause"; f.command.actionKind = d.actionKind;
  d.items[0]!.units = 0; d.items[0]!.spendMinor = 0; d.bounds.maxItems = 1; d.bounds.maxUnits = 0;
  if (phase === "mediaStageRelease") {
    d.mediaAuthorization = { kind: "stageCap", accountKind: "internalGovernance", poolRef: "synthetic-internal-stage-pool", poolVersion: "synthetic-pool-v1",
      allocationHash: "b".repeat(64), capMinor: 30000, currency: "USD" };
    d.exposure = { state: "known", minor: 30000, currency: "USD" }; d.bounds.maxSpendMinor = 30000;
    d.gates.launchReadiness = structuredClone(d.gates.providerTerms);
  } else { d.exposure = { state: "known", minor: 0, currency: "USD" }; d.bounds.maxSpendMinor = 0; }
  approvalDraftSchema.parse(d);
  return f;
}
describe("canonical media authority phases", () => {
  it.each(["mediaStageRelease", "mediaSafetyPause"] as const)("requires a genuine distinct founder decision for %s even below $500", async phase => {
    const f = fixture(phase), requested = await f.requested();
    const nonFounder = f.event(requested);
    await expect(f.repo.observeDecision(nonFounder.locator, { ingressRef: "synthetic-verified-relay" })).rejects.toThrow("FOUNDER_REQUIRED");
    const founder = f.event(requested, "approved", "synthetic:founder", "synthetic-founder-event");
    const result = await f.repo.observeDecision(founder.locator, { ingressRef: "synthetic-verified-relay" });
    expect(result.current.state).toBe("approved");
    const samePerson = { ...f.humans.get("synthetic:founder")!, personRef: result.manifest.proposer.personRef };
    expect(decisionAuthorityReasons(result.manifest, samePerson, f.policy, f.state.now)).toContain("SECOND_PERSON_REQUIRED");
  });
  it("previews the full stage authorization without treating its local record as provider spending", () => {
    const f = fixture("mediaStageRelease");
    expect(draftPolicyReasons(f.draft, f.policy, f.state.now)).toEqual([]);
    expect(f.draft).toMatchObject({ exposure: { minor: 30000 }, bounds: { maxSpendMinor: 30000 },
      effects: { spendsMoney: false }, items: [{ spendMinor: 0, units: 0 }] });
  });
  it.each(["missing-cap", "wrong-cap", "immediate-spend", "units", "mixed-items", "creator", "policy-change", "growth-gate"])("holds invalid stage %s", kind => {
    const f = fixture("mediaStageRelease"), d = f.draft;
    if (kind === "missing-cap") delete d.mediaAuthorization;
    if (kind === "wrong-cap") d.mediaAuthorization!.capMinor++;
    if (kind === "immediate-spend") { d.items[0]!.spendMinor = 1; d.effects.spendsMoney = true; }
    if (kind === "units") { d.items[0]!.units = 1; d.bounds.maxUnits = 1; }
    if (kind === "mixed-items") { d.items.push({ ...d.items[0]!, itemRef: "synthetic-second-item", targetRef: "synthetic-second-stage" }); d.bounds.maxItems = 2; }
    if (kind === "creator") d.effects.sendsCreator = true;
    if (kind === "policy-change") d.effects.changesPolicy = true;
    if (kind === "growth-gate") d.gates.launchReadiness = { state: "notApplicable", policyVersion: f.policy.version, reason: "Synthetic attempt to waive the launch gates." };
    expect(draftPolicyReasons(d, f.policy, f.state.now).length).toBeGreaterThan(0);
  });
  it.each(["mediaStageRelease", "mediaSafetyPause"] as const)("rejects downgrading %s to a generic phase", phase => {
    const f = fixture(phase); f.draft.phase = "other";
    expect(draftPolicyReasons(f.draft, f.policy, f.state.now)).toContain("MEDIA_APPROVAL_PHASE_REQUIRED");
  });
  it("does not block a previously authorized status-only pause on failed growth gates", () => {
    const f = fixture("mediaSafetyPause");
    for (const name of ["launchReadiness", "acceptedTerms", "sampleAuthority", "providerTerms"] as const)
      f.draft.gates[name] = { state: "notApplicable", policyVersion: f.policy.version, reason: "This finite pause can only reduce delivery; it cannot authorize growth." };
    expect(draftPolicyReasons(f.draft, f.policy, f.state.now)).toEqual([]);
    f.draft.gates.sourcePermission = { state: "unknown", reason: "Current permission unavailable" };
    expect(draftPolicyReasons(f.draft, f.policy, f.state.now)).toContain("GATE_SOURCEPERMISSION_UNKNOWN");
  });
  it.each(["spend", "units", "exposure", "acquisition", "stage-cap", "different-action"])("rejects safety authority repurposed for %s", kind => {
    const f = fixture("mediaSafetyPause"), d = f.draft;
    if (kind === "spend") { d.bounds.maxSpendMinor = 1; d.items[0]!.spendMinor = 1; }
    if (kind === "units") { d.bounds.maxUnits = 1; d.items[0]!.units = 1; }
    if (kind === "exposure") { d.bounds.maxSpendMinor = 1; d.exposure = { state: "known", minor: 1, currency: "USD" }; }
    if (kind === "acquisition") d.acquisitionTerms = { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: 20, perSaleFixedMinor: 0, sampleCostMinor: 0 };
    if (kind === "stage-cap") d.mediaAuthorization = { kind: "stageCap", accountKind: "internalGovernance", poolRef: "synthetic-pool", poolVersion: "v1", allocationHash: "a".repeat(64), capMinor: 1, currency: "USD" };
    if (kind === "different-action") d.actionKind = "media.publish";
    expect(draftPolicyReasons(d, f.policy, f.state.now)).toContain(kind === "stage-cap" ? "MEDIA_AUTHORIZATION_OUTSIDE_STAGE" : "MEDIA_SAFETY_PAUSE_INVALID");
  });
  it("preserves the old policy and manifest structure when media fields are absent", () => {
    const f = approvalFixture(); cleanup.push(() => f.db.close());
    const parsed = approvalDraftSchema.parse(f.draft);
    expect(parsed).not.toHaveProperty("mediaAuthorization");
    expect(draftPolicyReasons(parsed, f.policy, f.state.now)).toEqual([]);
  });
});
