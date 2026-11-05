// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { CapabilityLedger, capabilityIdForBinding } from "./ledger.ts";
import { MAX_VERIFICATION_AGE_MS, expectedBindingSchema, registrationSchema, unknownBusinessEligibility, unknownSourceFreshness, type CapabilityRegistration, type ExpectedBinding, type VerificationReceipt } from "./schema.ts";

const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-internal-account", environment: "sandbox" as const };
const binding = (patch: Partial<ExpectedBinding> = {}): ExpectedBinding => ({
  ...scope, provider: "synthetic-provider", providerAccountId: "synthetic-source-account", action: "readPolicy", mode: "observe",
  route: "api", routeRef: "route:synthetic-reader", authorizationScopeVersion: "synthetic-scope-v1", toolVersion: "synthetic-tool-v1",
  requiredScopes: ["policy:read"], connectionRef: "connection:synthetic-reader", secretRef: "secretref:synthetic-reader", ...patch,
});
const registration = (b = binding()): CapabilityRegistration => ({ binding: b, ownerRef: "owner:synthetic-operator", costBasis: { state: "unknown", reasonCode: "COST_NOT_MEASURED" } });

describe("scoped persistent capability ledger", () => {
  let directory: string;
  let path: string;
  let clock: number;
  let ledger: CapabilityLedger;
  let receipts: Map<string, VerificationReceipt>;
  const proof = (patch: Partial<VerificationReceipt> = {}): VerificationReceipt => ({
    receiptRef: "receipt:synthetic-verified-read", binding: binding(), outcome: "Ready", checkedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(), verifiedScopes: ["policy:read"], connectionHealth: "Authenticated",
    sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [], ...patch,
  });
  const register = () => ledger.register(registration(), 0);
  const verify = async (value = proof(), revision = 1) => {
    receipts.set(value.receiptRef, value);
    return ledger.verify(capabilityIdForBinding(binding()), value.receiptRef, revision);
  };

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "farda-capability-ledger-"));
    path = join(directory, "agent.sqlite");
    clock = Date.parse("2026-11-05T06:00:00.000Z");
    receipts = new Map();
    ledger = new CapabilityLedger(path, scope, { now: () => clock, resolveReceipt: (ref) => receipts.get(ref) ?? null });
  });
  afterEach(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });

  it("starts unverified, preserves unknown cost/data/business facts and exposes no private credential references", () => {
    const record = register();
    expect(record).toMatchObject({ state: "Unverified", observedState: "Unverified", checkedAt: null, receiptRef: null, fresh: false, recovery: "configureRoute" });
    expect(record.registration.costBasis).toEqual({ state: "unknown", reasonCode: "COST_NOT_MEASURED" });
    expect(record.sourceFreshness.state).toBe("unknown");
    expect(record.businessEligibility.state).toBe("notEvaluated");
    expect(record.registration).toMatchObject({ ownerRef: "owner:synthetic-operator", hasCredentialReference: true, hasConnectionReference: true });
    expect(record).not.toHaveProperty("registration.binding.secretRef");
    expect(record).not.toHaveProperty("registration.binding.connectionRef");
    expect(JSON.stringify(record)).not.toContain("secretref:");
    expect(JSON.stringify(record)).not.toContain("connection:synthetic-reader");
    expect(ledger.requireReady(binding()).allowed).toBe(false);
  });

  it("permits only the exact action/mode/account/route after trusted action-specific proof", async () => {
    register();
    const record = await verify();
    expect(record.state).toBe("Ready");
    expect(ledger.requireReady(binding())).toMatchObject({ allowed: true, state: "Ready", revision: 2, ownerRef: "owner:synthetic-operator", recovery: "none" });
    for (const patch of [{ action: "sendInvite" }, { mode: "executeApproved" as const }, { route: "browser" as const }, { routeRef: "route:another-reader" }]) {
      expect(ledger.requireReady(binding(patch))).toMatchObject({ allowed: false, state: "Unverified" });
    }
    expect(ledger.requireReady(binding({ providerAccountId: "synthetic-other-account" }))).toMatchObject({ allowed: false, state: "Denied", reasonCodes: ["CAPABILITY_ACCOUNT_MISMATCH"], receiptRef: null });
    expect(ledger.requireReady(binding({ authorizationScopeVersion: "synthetic-scope-v2" }))).toMatchObject({ allowed: false, reasonCodes: ["CAPABILITY_BINDING_STALE"] });
    expect(ledger.requireReady(binding({ environment: "production" }))).toMatchObject({ allowed: false, state: "Denied", reasonCodes: ["CAPABILITY_SCOPE_MISMATCH"], receiptRef: null });
    expect(record.businessEligibility.state).toBe("notEvaluated"); // Permission is not business approval.
  });

  it("cannot establish Ready without a configured trusted verifier or from an incoming connected/Ready flag", async () => {
    ledger.close();
    ledger = new CapabilityLedger(path, scope, { now: () => clock });
    register();
    const record = await ledger.verify(capabilityIdForBinding(binding()), "receipt:client-asserted-ready", 1);
    expect(record).toMatchObject({ state: "Unverified", checkedAt: null, receiptRef: null, reasonCodes: ["VERIFIER_NOT_CONFIGURED"] });
    expect(registrationSchema.safeParse({ ...registration(), connected: true, state: "Ready" }).success).toBe(false);
    expect(expectedBindingSchema.safeParse({ ...binding(), accessToken: "synthetic-inline-token" }).success).toBe(false);
  });

  it.each([
    { providerAccountId: "synthetic-wrong-account" }, { workspaceId: "synthetic-other-workspace" },
    { environment: "production" as const }, { action: "publishCampaign" }, { route: "browser" as const },
  ])("refuses a receipt verified for a different identity: %j", async (patch) => {
    register();
    const record = await verify(proof({ binding: binding(patch) }));
    expect(record.state).toBe("Denied");
    expect(record.reasonCodes).toContain("VERIFICATION_IDENTITY_MISMATCH");
    expect(ledger.requireReady(binding()).allowed).toBe(false);
  });

  it("refuses stale binding/tool context and authentication without the required operation scope", async () => {
    register();
    expect((await verify(proof({ binding: binding({ toolVersion: "synthetic-tool-v2" }) })))).toMatchObject({ state: "Unverified", reasonCodes: ["VERIFICATION_BINDING_STALE"] });
    expect((await verify(proof({ verifiedScopes: [] }), 2))).toMatchObject({ state: "Denied", reasonCodes: ["REQUIRED_SCOPE_MISSING"] });
    expect((await verify(proof({ connectionHealth: "Expired" }), 3))).toMatchObject({ state: "Unverified", reasonCodes: ["AUTHENTICATION_UNVERIFIED"] });
  });

  it.each([
    ["VERIFICATION_TIME_IN_FUTURE", 1, 60_000],
    ["VERIFICATION_STALE", -MAX_VERIFICATION_AGE_MS, 60_000],
    ["INVALID_VERIFICATION_EXPIRY", 0, MAX_VERIFICATION_AGE_MS + 1],
    ["INVALID_VERIFICATION_EXPIRY", 0, 0],
    ["VERIFICATION_EXPIRED", -2_000, -1_000],
  ])("rejects invalid verification time/freshness: %s", async (reason, checkedDelta, expiryDelta) => {
    register();
    const record = await verify(proof({ checkedAt: new Date(clock + Number(checkedDelta)).toISOString(), expiresAt: new Date(clock + Number(expiryDelta)).toISOString() }));
    expect(record.state).toBe("Unverified");
    expect(record.reasonCodes).toContain(reason);
    expect(ledger.requireReady(binding()).allowed).toBe(false);
  });

  it("requires bounded expiry and degrades an expired Ready result without rewriting the saved observation", async () => {
    register();
    expect((await verify(proof({ expiresAt: null })))).toMatchObject({ state: "Unverified", reasonCodes: ["VERIFICATION_EXPIRY_REQUIRED"] });
    await verify(proof(), 2);
    clock += 60_000;
    expect(ledger.get(capabilityIdForBinding(binding()))).toMatchObject({ state: "Unverified", observedState: "Ready", fresh: false, reasonCodes: ["VERIFICATION_EXPIRED", "ACTION_VERIFIED"] });
    expect(ledger.requireReady(binding()).allowed).toBe(false);
    expect(ledger.history(capabilityIdForBinding(binding())).at(-1)?.observedState).toBe("Ready");
  });

  it.each(["Denied", "Unsupported", "Unverified"] as const)("preserves an actual %s result without converting auth health into action readiness", async (outcome) => {
    register();
    const record = await verify(proof({ outcome, reasonCodes: ["SYNTHETIC_SOURCE_RESULT"] }));
    expect(record.state).toBe(outcome);
    expect(ledger.requireReady(binding())).toMatchObject({ allowed: false, state: outcome });
  });

  it("invalidates an old Ready result on verifier failure without exposing the verifier's private error", async () => {
    register();
    await verify();
    ledger.close();
    ledger = new CapabilityLedger(path, scope, { now: () => clock, resolveReceipt: () => { throw new Error("synthetic-private-error-content"); } });
    const record = await ledger.verify(capabilityIdForBinding(binding()), "receipt:unavailable", 2);
    expect(record).toMatchObject({ state: "Unverified", receiptRef: null, reasonCodes: ["VERIFIER_UNAVAILABLE"] });
    expect(JSON.stringify(ledger.history(record.capabilityId))).not.toContain("synthetic-private-error-content");
  });

  it("makes revocation authoritative and requires proof observed after revocation to regain Ready", async () => {
    const first = register();
    const oldProof = proof();
    await verify(oldProof);
    ledger.revoke(first.capabilityId, "SOURCE_PERMISSION_REVOKED", 2);
    expect(ledger.requireReady(binding())).toMatchObject({ allowed: false, state: "Denied" });
    expect((await ledger.verify(first.capabilityId, oldProof.receiptRef, 3))).toMatchObject({ state: "Denied", reasonCodes: ["REVOKED", "REVERIFICATION_REQUIRED"] });
    clock += 1;
    const freshProof = proof({ receiptRef: "receipt:synthetic-reverified-read" });
    expect(await verify(freshProof, 4)).toMatchObject({ state: "Ready", revokedAt: null });
    expect(ledger.history(first.capabilityId)).toHaveLength(5);
  });

  it("cannot overwrite concurrent revocation with a late successful verifier response", async () => {
    register();
    ledger.close();
    let finish: ((value: VerificationReceipt) => void) | undefined;
    ledger = new CapabilityLedger(path, scope, { now: () => clock, resolveReceipt: () => new Promise((resolve) => { finish = resolve; }) });
    const id = capabilityIdForBinding(binding());
    const pending = ledger.verify(id, "receipt:synthetic-verified-read", 1);
    ledger.revoke(id, "SOURCE_PERMISSION_REVOKED", 1);
    finish?.(proof());
    await expect(pending).rejects.toThrow("CAPABILITY_VERSION_CONFLICT");
    expect(ledger.get(id)?.state).toBe("Denied");
    expect(ledger.history(id)).toHaveLength(2);
  });

  it("invalidates verification when the configured source account changes and rejects stale revisions", async () => {
    const first = register();
    await verify();
    const changed = binding({ providerAccountId: "synthetic-next-account", authorizationScopeVersion: "synthetic-scope-v2" });
    expect(capabilityIdForBinding(changed)).toBe(first.capabilityId);
    expect(ledger.register(registration(changed), 2)).toMatchObject({ state: "Unverified", revision: 3, checkedAt: null });
    expect(ledger.requireReady(binding()).allowed).toBe(false);
    expect(ledger.requireReady(changed).allowed).toBe(false);
    expect(() => ledger.register(registration(), 2)).toThrow("CAPABILITY_VERSION_CONFLICT");
    expect(await ledger.verify(first.capabilityId, "receipt:synthetic-verified-read", 3)).toMatchObject({ state: "Denied", reasonCodes: ["VERIFICATION_IDENTITY_MISMATCH"] });
  });

  it("persists Ready/expiry/revocation across restart with the same scope and refuses a different database scope", async () => {
    register();
    await verify();
    ledger.close();
    ledger = new CapabilityLedger(path, scope, { now: () => clock });
    expect(ledger.requireReady(binding()).allowed).toBe(true);
    expect(() => new CapabilityLedger(path, { ...scope, accountId: "synthetic-other-account" })).toThrow("CAPABILITY_SCOPE_MISMATCH");
    expect(() => new CapabilityLedger(path, { ...scope, environment: "production" })).toThrow("CAPABILITY_SCOPE_MISMATCH");
    clock += MAX_VERIFICATION_AGE_MS;
    expect(ledger.requireReady(binding())).toMatchObject({ allowed: false, state: "Unverified" });
  });

  it("shares the existing agent database only within its configured workspace/account", () => {
    const agent = new AgentStore(path, scope);
    agent.close();
    expect(() => new CapabilityLedger(path, { ...scope, workspaceId: "synthetic-other-workspace" })).toThrow("CAPABILITY_SCOPE_MISMATCH");
    expect(ledger.list()).toEqual({ records: [], total: 0, partial: false });
  });

  it("borrows an in-memory owner database without closing it on release or scope failure", () => {
    const agent = new AgentStore(":memory:", scope);
    try {
      const borrowed = new CapabilityLedger(agent.database, scope, { now: () => clock });
      expect(borrowed.register(registration(), 0).state).toBe("Unverified");
      expect(agent.database.prepare("SELECT COUNT(*) AS total FROM capability_events").get()?.total).toBe(1);
      borrowed.close();
      borrowed.close();
      expect(() => new CapabilityLedger(agent.database, { ...scope, accountId: "synthetic-other-account" })).toThrow("CAPABILITY_SCOPE_MISMATCH");
      expect(agent.database.prepare("SELECT COUNT(*) AS total FROM capability_events").get()?.total).toBe(1);
    } finally { agent.close(); }
  });

  it("returns bounded honest coverage, redacted history, known zero cost, and owner/recovery metadata", () => {
    const first = register();
    ledger.register({ ...registration(binding({ action: "readHealth" })), costBasis: { state: "known", unit: "request", amountMinor: 0, currency: "USD", sourceRef: "source:synthetic-measurement" } }, 0);
    const page = ledger.list(1);
    expect(page).toMatchObject({ total: 2, partial: true });
    expect(page.records).toHaveLength(1);
    expect(ledger.list().records.some((record) => record.registration.costBasis.state === "known" && record.registration.costBasis.amountMinor === 0)).toBe(true);
    expect(JSON.stringify(ledger.history(first.capabilityId))).not.toMatch(/secretref:|connection:synthetic-reader/);
    expect(() => ledger.list(101)).toThrow("INVALID_CAPABILITY_LIMIT");
  });

  it.each(["raw-inline-token", "https://user:password@example.invalid", "secretref:abc?token=synthetic", "secretref:Bearer synthetic"])("rejects raw or URL credential material in a reference field: %s", (secretRef) => {
    expect(() => ledger.register(registration(binding({ secretRef })), 0)).toThrow();
    expect(ledger.list().total).toBe(0);
  });

  it("treats required scopes as a set and keeps data/business dimensions independent", async () => {
    const b = binding({ requiredScopes: ["z:read", "a:read"] });
    const first = ledger.register(registration(b), 0);
    const value = proof({ binding: { ...b, requiredScopes: ["a:read", "z:read"] }, verifiedScopes: ["z:read", "a:read"], businessEligibility: { state: "held", reasonCodes: ["BUSINESS_APPROVAL_REQUIRED"], sourceRef: null } });
    receipts.set(value.receiptRef, value);
    const view = await ledger.verify(first.capabilityId, value.receiptRef, 1);
    expect(ledger.requireReady(b).allowed).toBe(true);
    expect(view.businessEligibility.state).toBe("held");
    expect(view.sourceFreshness.state).toBe("unknown");
  });
});
