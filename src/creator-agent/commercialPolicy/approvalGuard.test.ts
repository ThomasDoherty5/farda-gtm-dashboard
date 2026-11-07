// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture, approvalTestScope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import { offerPolicyFixture } from "../offers/policyFixture.testkit.ts";
import { acquisitionTermsOf } from "./evaluate.ts";
import { withCommercialOffers } from "./approvalGuard.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const a = approvalFixture(), o = offerPolicyFixture(":memory:", approvalTestScope);
  cleanup.push(() => a.db.close(), () => o.store.close());
  const saved = o.save(); a.state.now = o.now();
  a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  for (const person of a.humans.values()) { person.observedAt = a.at(); person.validUntil = a.until(); }
  const d = a.draft;
  d.expiresAt = a.until(); d.sourceValidUntil = a.until();
  for (const gate of Object.values(d.gates)) if (gate?.state === "satisfied") gate.validUntil = a.until();
  d.providerAccountRef = saved.provider!.providerAccountRef!;
  d.productVersion = { state: "required", version: saved.terms.manifest.productRevision! };
  d.termsVersion = { state: "required", version: saved.version };
  d.acquisitionTerms = acquisitionTermsOf(saved.terms);
  d.gates.sampleAuthority = structuredClone(d.gates.providerTerms);
  d.items[0]!.targetRef = saved.terms.creatorId;
  d.commercialOffers = [{ itemRef: d.items[0]!.itemRef, offerRef: saved.offerId }];
  const registry = withCommercialOffers(a.options.registry, o.repo, o.now);
  const repo = new ApprovalRepository(a.db, { ...a.options, registry });
  async function approved() {
    const preview = await repo.preparePreview(a.command, { principalRef: "synthetic:requester" }, "synthetic-preview");
    const requested = await repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "synthetic-request");
    const event = a.event(requested);
    return repo.observeDecision(event.locator, { ingressRef: "synthetic-native-relay" });
  }
  return { a, o, repo, registry, approved };
}

describe("actual saved commercial offers in the shared J04 registry", () => {
  it("hashes the source-backed offer and yields current J04 proof without equating independent policy versions", async () => {
    const f = fixture(), approved = await f.approved();
    expect(approved.current.state).toBe("approved");
    expect(approved.manifest.draft.commercialOffers?.[0]?.basisHash).toMatch(/^[a-f0-9]{64}$/);
    expect(approved.manifest.draft.policyVersion).not.toBe(f.o.terms.policyVersion);
    const result = await f.repo.resolveCurrentProof(approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef));
    expect(result.state).toBe("verified");
    if (result.state === "verified") expect(() => f.repo.assertCurrentProof(result.proof, f.a.state.now)).not.toThrow();
  });
  it.each(["missing", "recipient", "account", "terms", "product"])("rejects a %s offer binding before approval", async kind => {
    const f = fixture(), d = f.a.draft;
    if (kind === "missing") delete d.commercialOffers;
    if (kind === "recipient") d.items[0]!.targetRef = "synthetic-wrong-creator";
    if (kind === "account") d.providerAccountRef = "synthetic-wrong-account";
    if (kind === "terms") d.acquisitionTerms!.commissionPct = 19;
    if (kind === "product") d.productVersion = { state: "required", version: "synthetic-wrong-product" };
    await expect(f.repo.preparePreview(f.a.command, { principalRef: "synthetic:requester" }, "synthetic-refusal")).rejects.toThrow();
  });
  it.each(["suppression", "fee-reply", "policy"])("withdraws existing current proof on %s before dispatch", async kind => {
    const f = fixture(), approved = await f.approved();
    const binding = approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef);
    const result = await f.repo.resolveCurrentProof(binding); expect(result.state).toBe("verified");
    if (kind === "suppression") f.o.suppress();
    if (kind === "policy") f.o.source.state.permitted = false;
    if (kind === "fee-reply") { const reply = f.o.reply(); f.o.repo.observeReply("synthetic-offer", f.o.repo.readOffer("synthetic-offer")!.version, reply.sourceRef, "synthetic-fee-observation", "synthetic-reader"); }
    if (result.state === "verified") expect(() => f.repo.assertCurrentProof(result.proof, f.a.state.now)).toThrow();
    expect((await f.repo.resolveCurrentProof(binding)).state).toBe("held");
  });
  it.each(["units", "money", "unit-ceiling", "money-ceiling"])("rejects %s beyond the saved per-creator sample allocation", async kind => {
    const f = fixture(), d = f.a.draft;
    if (kind === "units") { d.items[0]!.units = 999; d.bounds.maxUnits = 999; }
    if (kind === "money") { d.items[0]!.spendMinor = 2201; d.bounds.maxSpendMinor = 2201; d.effects.spendsMoney = true; d.exposure = { state: "known", minor: 2201, currency: "USD" }; }
    if (kind === "unit-ceiling") d.bounds.maxUnits = 999;
    if (kind === "money-ceiling") d.bounds.maxSpendMinor = 2201;
    await expect(f.repo.preparePreview(f.a.command, { principalRef: "synthetic:requester" }, "synthetic-bound-refusal")).rejects.toThrow("COMMERCIAL_SAMPLE_BOUND_MISMATCH");
  });
  it("holds source withdrawal during awaited Linear proof readback", async () => {
    const f = fixture(), approved = await f.approved();
    f.a.state.readHook = async () => { f.o.revoke(); };
    expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef))).state).toBe("held");
  });
  it("does not reinterpret a historical earned reward as acquisition", async () => {
    const f = fixture(); f.a.draft.phase = "rewardRedemption"; f.a.draft.acquisitionTerms = null;
    delete f.a.draft.commercialOffers;
    f.o.revoke();
    const draft = await f.registry.resolvePreview(f.a.command, { principalRef: "synthetic:requester" }, approvalTestScope);
    expect(draft).toMatchObject({ phase: "rewardRedemption", acquisitionTerms: null });
  });
});
