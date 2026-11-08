// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { approvalFixture } from "./fixtures.testkit.ts";
import { approvalDispatchBinding } from "./repository.ts";
import { digest } from "../config.ts";

const opened: ReturnType<typeof approvalFixture>[] = [];
const make = () => { const f = approvalFixture(); opened.push(f); return f; };
afterEach(() => { for (const f of opened.splice(0)) f.db.close(); });

function commercial(phase: "invitation" | "activation", amount = 0) {
  const f = make(); f.draft.phase = phase;
  if (phase === "activation") f.draft.gates.acceptedTerms = {
    state: "satisfied", sourceRef: "synthetic:accepted-terms", sourceVersion: "terms-v1", validUntil: f.until(),
  };
  f.draft.items[0]!.spendMinor = amount; f.draft.bounds.maxSpendMinor = amount;
  f.draft.exposure = { state: "known", minor: amount, currency: "USD" };
  f.draft.effects.spendsMoney = amount > 0;
  return f;
}

describe("founder approval of exact commercial commitments", () => {
  it.each([["invitation", 0], ["activation", 0], ["invitation", 49_999], ["activation", 50_000]] as const)(
    "requires a distinct founder for %s at %i cents, independently of the cash threshold", async (phase, amount) => {
      const f = commercial(phase, amount), requested = await f.requested();
      const reviewer = f.event(requested);
      await expect(f.repo.observeDecision(reviewer.locator, { ingressRef: "synthetic:verified-ingress" })).rejects.toThrow("FOUNDER_REQUIRED");
      expect(f.state.writes).toBe(1); expect(f.repo.readApproval(requested.manifest.approvalRef)?.decisionReceipt).toBeNull();
      const founder = f.event(requested, "approved", "synthetic:founder", "synthetic:founder-decision");
      const approved = await f.repo.observeDecision(founder.locator, { ingressRef: "synthetic:verified-ingress" });
      expect(approved.decisionReceipt?.personRef).toBe("synthetic:founder");
      expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(approved.manifest, "synthetic:item-1"))).state).toBe("verified");
      expect(approved.sourceEffect).toBe("none");
    },
  );

  it.each(["invitation", "activation"] as const)("does not let a founder self-approve %s", async phase => {
    const f = commercial(phase); f.humans.get("synthetic:requester")!.roles = ["founder"];
    // Activation is a commitment even without a message, cash charge or policy mutation.
    if (phase === "activation") f.draft.effects = { spendsMoney: false, sendsCreator: false, changesPolicy: false };
    const requested = await f.requested(), self = f.event(requested, "approved", "synthetic:requester");
    await expect(f.repo.observeDecision(self.locator, { ingressRef: "synthetic:verified-ingress" })).rejects.toThrow("SECOND_PERSON_REQUIRED");
    expect(f.state.writes).toBe(1);
  });

  it.each(["invitation", "activation"] as const)("holds %s after founder authority is withdrawn without erasing its receipt", async phase => {
    const f = commercial(phase), approved = await f.approved();
    const binding = approvalDispatchBinding(approved.manifest, "synthetic:item-1");
    const proof = await f.repo.resolveCurrentProof(binding); expect(proof.state).toBe("verified");
    f.humans.get("synthetic:founder")!.roles = ["reviewer"];
    const held = await f.repo.resolveCurrentProof(binding);
    expect(held).toMatchObject({ state: "held", reasonCodes: ["FOUNDER_REQUIRED"] });
    if (proof.state === "verified") expect(() => f.repo.assertCurrentProof(proof.proof, f.state.now)).toThrow();
    expect(f.repo.readApproval(approved.manifest.approvalRef)?.decisionReceipt).toEqual(approved.decisionReceipt);
    expect(f.state.writes).toBe(2);
  });

  it("does not downgrade an explicit programme or rate policy change through the generic phase", async () => {
    const f = make(); f.draft.phase = "other"; f.draft.acquisitionTerms = null;
    f.draft.effects = { spendsMoney: false, sendsCreator: false, changesPolicy: true };
    const requested = await f.requested(), reviewer = f.event(requested);
    await expect(f.repo.observeDecision(reviewer.locator, { ingressRef: "synthetic:verified-ingress" })).rejects.toThrow("FOUNDER_REQUIRED");
    const founder = f.event(requested, "approved", "synthetic:founder", "synthetic:policy-founder");
    expect((await f.repo.observeDecision(founder.locator, { ingressRef: "synthetic:verified-ingress" })).current.state).toBe("approved");
  });

  it("revises a rejected invitation into a fresh version that still needs founder approval", async () => {
    const f = commercial("invitation"), requested = await f.requested();
    const rejected = f.event(requested, "rejected", "synthetic:founder");
    const old = await f.repo.observeDecision(rejected.locator, { ingressRef: "synthetic:verified-ingress" });
    f.draft.payloadHash = digest("synthetic revised invitation"); f.draft.items[0]!.payloadHash = f.draft.payloadHash;
    const next = await f.repo.preparePreview({ ...f.command, approvalRef: old.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, "synthetic:revised");
    expect(next.manifest.manifestVersion).toBe(2); expect(next.decisionReceipt).toBeNull();
    expect((await f.repo.resolveCurrentProof(approvalDispatchBinding(next.manifest, "synthetic:item-1"))).state).toBe("held");
    expect(f.repo.readApproval(old.manifest.approvalRef, 1)?.decisionReceipt).toEqual(old.decisionReceipt);
  });
});
