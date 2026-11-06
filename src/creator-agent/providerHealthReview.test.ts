// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOperations } from "./operations.ts";
import { AgentStore } from "./store.ts";
import { createProviderHealth } from "./providerHealth.ts";
import { capabilityIdForBinding } from "./connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import { healthObservationSchema, noObservation, summarize, type HealthObservation, type HealthTarget } from "./providerHealthSchema.ts";

const scope = { workspaceId: "synthetic-review-workspace", accountId: "synthetic-review-account", environment: "sandbox" as const };
const now = Date.parse("2026-11-05T16:00:00Z");
const at = new Date(now).toISOString();
const binding: ExpectedBinding = { ...scope, provider: "synthetic-provider", providerAccountId: "synthetic-native-a", action: "readHealth", mode: "observe",
  route: "api", routeRef: "route:synthetic", authorizationScopeVersion: "v1", toolVersion: "v1", requiredScopes: [],
  connectionRef: null, secretRef: null };
const target = (b: ExpectedBinding, owner: string, probe: NonNullable<HealthTarget["probe"]>): HealthTarget => ({
  binding: b, ownerRef: owner, maxAgeSeconds: 300, documentationRef: "docs:synthetic", documentationCheckedAt: at, freshnessBasis: "successful_read", probe,
});
const observation = (b: ExpectedBinding, patch: Partial<HealthObservation> = {}): HealthObservation =>
  ({ ...noObservation(b, now, "observed"), permission: "allowed", session: "authenticated", roleScopePlan: "verified", coverage: "complete", sourceLastSuccess: at, sourceUpdatedAt: at,
    quotaState: "known", quotaRemaining: 5, deadlineState: "known", deadline: new Date(now + 600_000).toISOString(), ...patch });
let store: AgentStore;
let ops: ReturnType<typeof createOperations>;
let receipt: VerificationReceipt | null;
let authorize: (hash: string) => boolean;
const activationDigests: string[] = [];
beforeEach(() => {
  receipt = null; activationDigests.length = 0; authorize = () => true;
  store = new AgentStore(":memory:", scope);
  ops = createOperations(store.database, scope, { now: () => now,
    resolveReceipt: () => receipt,
    resolveJobActivation: request => {
      activationDigests.push(request.definitionHash);
      return authorize(request.definitionHash) ? { approved: true, decisionRef: request.decisionRef, definitionHash: request.definitionHash } : null;
    } });
});
afterEach(() => { ops.close(); store.close(); });
function health(catalog: HealthTarget[]) {
  return createProviderHealth(store.database, scope, ops.ledger, ops.jobs, { catalog, activationRef: "decision:synthetic", now: () => now });
}
async function register(b: ExpectedBinding, expectedRevision: number, owner = "owner:synthetic") {
  const item = ops.ledger.register({ binding: b, ownerRef: owner, costBasis: { state: "unknown", reasonCode: "COST_UNKNOWN" } }, expectedRevision);
  receipt = { receiptRef: "receipt:synthetic", binding: b, outcome: "Ready", checkedAt: at, expiresAt: new Date(now + 120_000).toISOString(), verifiedScopes: [],
    connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
  return ops.ledger.verify(item.capabilityId, receipt.receiptRef, item.revision);
}

describe("provider health authorization regression cases", () => {
  it.each(["checkedAt", "deadline"] as const)("rejects an unparsable %s and fails closed if it was already persisted", field => {
    const executable = { ...binding, mode: "executeApproved" as const };
    const bad = observation(executable, { [field]: "2026-11-05T16:00:00+99:99" });
    const config = target(executable, "owner:synthetic", async () => bad);
    expect(Number.isFinite(Date.parse(bad[field]!))).toBe(false);
    expect(healthObservationSchema.safeParse(bad).success).toBe(false);
    expect(summarize({ id: capabilityIdForBinding(executable), target: config, ownerRef: config.ownerRef, capabilityState: "Ready", capabilityRevision: 1, observation: bad,
      revisionCurrent: true, now, activeDenial: false }).state).not.toBe("ready");
  });
  it("rejects a future persisted preflight even when source time itself is current", () => {
    const future = observation(binding, { checkedAt: new Date(now + 60_000).toISOString() });
    const config = target(binding, "owner:synthetic", async () => future);
    expect(summarize({ id: capabilityIdForBinding(binding), target: config, ownerRef: config.ownerRef, capabilityState: "Ready", capabilityRevision: 1,
      observation: future, revisionCurrent: true, now, activeDenial: false }).state).not.toBe("ready");
  });
  it("keeps native account A's observations out of account B's current details and failed checks after a slot rebind", async () => {
    const a = await register(binding, 0);
    const first = health([target(binding, "owner:synthetic", async () => observation(binding))]);
    await first.check({ capabilityId: a.capabilityId, eventId: "a" }, "a");
    const b = { ...binding, providerAccountId: "synthetic-native-b" };
    const rebound = await register(b, a.revision);
    expect(rebound.capabilityId).toBe(a.capabilityId);
    const current = health([target(b, "owner:synthetic", async () => noObservation(b, now, "failed"))]);
    expect(current.get(a.capabilityId)).toMatchObject({ permission: "unknown", session: "unknown", coverage: "unknown", sourceLastSuccess: null, sourceUpdatedAt: null });
    const check = await current.check({ capabilityId: rebound.capabilityId, eventId: "b" }, "b");
    expect(check.health).toMatchObject({ sourceLastSuccess: null, sourceUpdatedAt: null, permission: "unknown" });
  });
  it("a healthy replacement account cannot resolve the original native denial or unblock its independent fallback", async () => {
    const a = await register(binding, 0);
    const browser = { ...binding, route: "browser" as const, routeRef: "route:synthetic-browser" };
    const alternative = await register(browser, 0);
    const browserTarget = target(browser, "owner:synthetic", async () => observation(browser));
    const first = health([browserTarget, target(binding, "owner:synthetic", async () => observation(binding, { status: "restricted", permission: "denied" }))]);
    await first.check({ capabilityId: alternative.capabilityId, eventId: "browser" }, "browser");
    await first.check({ capabilityId: a.capabilityId, eventId: "deny-a" }, "deny-a");
    expect(ops.ledger.requireReady(browser).allowed).toBe(false);
    const b = { ...binding, providerAccountId: "synthetic-native-b" };
    const rebound = await register(b, a.revision);
    const current = health([browserTarget, target(b, "owner:synthetic", async () => observation(b))]);
    await current.check({ capabilityId: rebound.capabilityId, eventId: "healthy-b" }, "healthy-b");
    expect(current.exceptions(alternative.capabilityId).records).toContainEqual(expect.objectContaining({ reasonCode: "PERMISSION_DENIED", state: "open" }));
    expect(ops.ledger.requireReady(browser).allowed).toBe(false);
  });
  it("requires a newly authorized job definition when the catalog owner changes and can recover once granted", async () => {
    const a = await register(binding, 0, "owner:first");
    const first = health([target(binding, "owner:first", async () => observation(binding))]);
    await first.check({ capabilityId: a.capabilityId, eventId: "owner-first" }, "owner-first");
    const original = activationDigests[0]!;
    authorize = hash => hash === original;
    let calls = 0;
    const updated = health([target(binding, "owner:second", async () => { calls++; return observation(binding); })]);
    const hold = await updated.check({ capabilityId: a.capabilityId, eventId: "owner-second" }, "owner-second");
    expect(hold.state).toBe("held");
    expect(calls).toBe(0);
    expect(activationDigests.at(-1)).not.toBe(original);
    authorize = () => true;
    const result = await updated.check({ capabilityId: a.capabilityId, eventId: "owner-second" }, "owner-second");
    expect(result.state).toBe("observed");
    expect(calls).toBe(1);
  });
});
