// @vitest-environment node
import { describe, expect, it } from "vitest";
import { composeActionDomains, type ActionDomain } from "./actionDomains.ts";
import { approvalFixture } from "./approvals/fixtures.testkit.ts";
import type { ApprovalRegistry } from "./approvals/contract.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";

describe.each(["domain", "base-registry"] as const)("independent %s composition source fence", owner => {
  it.each(["async-resolve", "async-reject", "false", "undefined"] as const)("preserves the actual %s assertion result at the final boundary", async mode => {
    const fixture = approvalFixture();
    try {
      const preview = await fixture.repo.preparePreview(fixture.command, { principalRef: "synthetic:requester" }, "synthetic-fence-preview");
      let calls = 0, backingDenials = 0, effects = 0;
      const observedArguments: unknown[][] = [];
      const settledAssertions: Promise<unknown>[] = [];
      const selected: ApprovalRegistry = { ...fixture.options.registry, assertCurrentDraft: (manifest, draft, now) => {
        calls++; observedArguments.push([manifest, draft, now]);
        if (mode === "async-resolve") return Promise.resolve();
        if (mode === "async-reject") {
          const pending = Promise.resolve().then(() => { throw new Error("Synthetic backing source withdrew permission"); });
          settledAssertions.push(pending.catch(() => { backingDenials++; }));
          return pending;
        }
        if (mode === "false") return false;
        fixture.options.registry.assertCurrentDraft(manifest, draft, now);
      } };
      const wrongOwner: ApprovalRegistry = { ...fixture.options.registry,
        assertCurrentDraft: () => { throw new Error("The unrelated registry must not assert this action"); } };
      const na = { state: "notApplicable" as const, policyVersion: fixture.policy.version, reason: "Synthetic local test only" };
      const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: fixture.policy.version,
        provider: na, resources: () => ({ budget: na, stock: na, quota: na }),
        budgets: { maxItems: 1, maxSteps: 1, maxAttempts: 1, maxRunMs: 1000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
        execute: async () => { throw new Error("No provider or job execution belongs in this composition test"); },
        reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_UNKNOWN" }) };
      const domain: ActionDomain = { registry: owner === "domain" ? selected : wrongOwner,
        actions: new Map([[owner === "domain" ? fixture.draft.actionKind : "synthetic-unrelated-action", { handlerRef: "synthetic-fence-handler" }]]),
        handlers: new Map([["synthetic-fence-handler", handler]]) };
      const composed = composeActionDomains({ approvals: { ...fixture.options, registry: owner === "base-registry" ? selected : wrongOwner } }, [domain]);
      const finalBoundary = () => {
        assertSynchronousVoid(() => composed!.approvals!.registry!.assertCurrentDraft!(preview.manifest, fixture.draft, fixture.state.now));
        effects++; // A stand-in after the exact production composition boundary, never a native effect.
      };
      if (mode === "undefined") expect(finalBoundary).not.toThrow();
      else expect(finalBoundary).toThrow("Source authority requires a synchronous void assertion");
      await Promise.all(settledAssertions);
      expect(calls).toBe(1);
      expect(observedArguments).toEqual([[preview.manifest, fixture.draft, fixture.state.now]]);
      expect(effects).toBe(mode === "undefined" ? 1 : 0);
      expect(backingDenials).toBe(mode === "async-reject" ? 1 : 0);
      expect(fixture.state.writes).toBe(0);
    } finally { fixture.db.close(); }
  });
});
