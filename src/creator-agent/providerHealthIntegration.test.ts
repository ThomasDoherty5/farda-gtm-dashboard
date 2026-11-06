// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createAgentServer } from "./server.ts";
import { assetTestScope } from "./assetTestFixtures.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import { noObservation, type HealthObservation, type HealthTarget } from "./providerHealthSchema.ts";

const scope = { ...assetTestScope, environment: "sandbox" as const };
const binding: ExpectedBinding = { ...scope, provider: "notion", providerAccountId: "synthetic-provider-account", action: "read-content-registry", mode: "observe",
  route: "api", routeRef: "route:synthetic-registry", authorizationScopeVersion: "synthetic-auth-v1", toolVersion: "synthetic-tool-v1", requiredScopes: ["content:read"],
  connectionRef: "connection:synthetic-health-private", secretRef: "secretref:synthetic-health-private" };

describe("provider-health native HTTP integration", () => {
  let app: ReturnType<typeof createAgentServer> | undefined;
  let origin: string;
  let clock = Date.parse("2026-11-06T05:00:00.000Z");
  let calls = 0;
  let outcome: "observed" | "failed" = "observed";
  const receipt = (): VerificationReceipt => ({ receiptRef: "receipt:synthetic-health-permission", binding, outcome: "Ready", checkedAt: new Date(clock).toISOString(),
    expiresAt: new Date(clock + 60_000).toISOString(), verifiedScopes: binding.requiredScopes, connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(),
    businessEligibility: unknownBusinessEligibility(), reasonCodes: [] });
  const target = (): HealthTarget => ({ binding, ownerRef: "owner:synthetic-operator", maxAgeSeconds: 300, documentationCheckedAt: "2026-11-05T00:00:00.000Z",
    documentationRef: "docs:synthetic-registry", freshnessBasis: "successful_read", probe: async (): Promise<HealthObservation> => {
      calls++;
      return { ...noObservation(binding, clock, outcome), ...(outcome === "observed" ? { permission: "allowed", session: "authenticated", roleScopePlan: "verified",
        sourceLastSuccess: new Date(clock).toISOString(), coverage: "complete", quotaState: "not_applicable", deadlineState: "not_applicable" } as const : {}) };
    } });
  async function start(configured = false, activated = false) {
    clock = Date.parse("2026-11-06T05:00:00.000Z"); calls = 0; outcome = "observed";
    app = createAgentServer({ databasePath: ":memory:", ...assetTestScope, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
      operations: { now: () => clock, resolveReceipt: ref => ref === "receipt:synthetic-health-permission" ? receipt() : null,
        resolveJobActivation: activated ? request => ({ approved: true, decisionRef: request.decisionRef, definitionHash: request.definitionHash }) : undefined },
      providerHealth: { now: () => clock, catalog: configured ? [target()] : [], ...(activated ? { activationRef: "decision:synthetic-read-health" } : {}) } });
    await new Promise<void>(resolve => app!.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected test address");
    origin = `http://127.0.0.1:${address.port}`;
  }
  async function request(path: string, body?: unknown, token: string | null = SYNTHETIC_READ_TOKEN, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method: body === undefined ? "GET" : "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    expect(JSON.stringify(value)).not.toContain(binding.secretRef); expect(JSON.stringify(value)).not.toContain(binding.connectionRef);
    return { status: response.status, body: value, headers: response.headers };
  }
  async function registerAndVerify() {
    const record = app!.operations.ledger.register({ binding, ownerRef: "owner:synthetic-operator", costBasis: { state: "unknown", reasonCode: "COST_UNKNOWN" } }, 0);
    await app!.operations.ledger.verify(record.capabilityId, "receipt:synthetic-health-permission", 1);
    return record.capabilityId;
  }
  const check = (id: string, event: string) => request("/v1/provider-health/check", { capabilityId: id, eventId: event }, SYNTHETIC_REVIEW_TOKEN, { "idempotency-key": event });
  afterEach(async () => { if (app) await app.close(); app = undefined; });

  it("requires auth and distinguishes no saved bindings from configured provider readiness", async () => {
    await start();
    expect((await request("/v1/provider-health", undefined, null)).status).toBe(401);
    const result = await request("/v1/provider-health");
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toMatchObject({ sourceEffect: "none", data: { configured: false, records: [], total: 0, partial: false } });
    const id = await registerAndVerify();
    const noProbe = await check(id, "synthetic-unconfigured");
    expect(noProbe.body.data).toMatchObject({ state: "unconfigured", runId: null, observationId: null, health: { state: "unverified", configured: false } });
    expect(calls).toBe(0);
  });

  it("rejects reader writes, client assertions, missing idempotency, duplicate queries and cookie CSRF", async () => {
    await start(true);
    const id = await registerAndVerify(); const input = { capabilityId: id, eventId: "synthetic-health" };
    expect((await request("/v1/provider-health/check", input)).status).toBe(403);
    expect((await request("/v1/provider-health/check", input, SYNTHETIC_REVIEW_TOKEN)).status).toBe(400);
    expect((await request("/v1/provider-health/check", { ...input, state: "ready", role: "reviewer" }, SYNTHETIC_REVIEW_TOKEN, { "idempotency-key": "synthetic-invalid" })).status).toBe(400);
    expect((await request("/v1/provider-health?limit=1&limit=2")).status).toBe(400);
    expect((await request("/v1/provider-health?accountId=synthetic-other")).status).toBe(400);
    const session = await request("/v1/session", undefined, SYNTHETIC_REVIEW_TOKEN);
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    expect((await request("/v1/provider-health/check", input, null, { cookie, "idempotency-key": "synthetic-cookie" })).status).toBe(403);
    expect(calls).toBe(0);
  });

  it("persists a held disabled job when no trusted activation exists and never probes", async () => {
    await start(true);
    const id = await registerAndVerify();
    const first = await check(id, "synthetic-disabled");
    const replay = await check(id, "synthetic-disabled");
    expect(first.status).toBe(200); expect(first.body.data).toMatchObject({ state: "held", observationId: null });
    expect(replay.body.data.runId).toBe(first.body.data.runId); expect(calls).toBe(0);
    const runs = await request("/v1/job-runs");
    expect(runs.body.data).toMatchObject({ total: 1, records: [expect.objectContaining({ enabled: false, state: "held" })] });
  });

  it("observes, owns a deduplicated failure, recovers from fresh evidence and replays without bypassing expiry", async () => {
    await start(true, true);
    const id = await registerAndVerify();
    const first = await check(id, "synthetic-success");
    expect(first.status).toBe(200); expect(first.body.data).toMatchObject({ state: "observed", health: { state: "ready", freshness: "current" } });
    outcome = "failed"; clock += 1000;
    const failed = await check(id, "synthetic-failed");
    expect(failed.body.data.health).toMatchObject({ state: "unverified", sourceLastSuccess: new Date(clock - 1000).toISOString() });
    await check(id, "synthetic-failed-again");
    const errors = await request(`/v1/provider-health/${id}/exceptions`);
    expect(errors.body.data.records.filter((row: { reasonCode: string }) => row.reasonCode === "PROBE_FAILED")).toHaveLength(1);
    expect(errors.body.data.records).toEqual(expect.arrayContaining([expect.objectContaining({ state: "open", ownerRef: "owner:synthetic-operator" })]));
    outcome = "observed"; clock += 1000;
    expect((await check(id, "synthetic-recovered")).body.data.health.state).toBe("ready");
    const resolved = await request(`/v1/provider-health/${id}/exceptions`);
    expect(resolved.body.data.records.every((row: { state: string }) => row.state === "resolved")).toBe(true);
    const callsBefore = calls; clock += 60_001;
    const replay = await check(id, "synthetic-success");
    expect(replay.body.data.health.state).not.toBe("ready"); expect(calls).toBe(callsBefore);
    const history = await request(`/v1/provider-health/${id}/history?limit=1`);
    expect(history.body.data).toMatchObject({ total: 4, partial: true, records: [expect.anything()] });
  });
});
