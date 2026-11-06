// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProviderHealth } from "./providerHealth.ts";
import { AgentStore } from "./store.ts";
import { createOperations } from "./operations.ts";
import { readOperationsView, type OperationsViewKey } from "./operationsViewReader.ts";
import { savedBindingsSchema, savedRunsSchema } from "./operationsView.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type CapabilityRegistration, type VerificationReceipt } from "./connections/schema.ts";

const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
let now: number;
let store: AgentStore;
let operations: ReturnType<typeof createOperations>;
let proof: VerificationReceipt | null;
const registration = (action: string): CapabilityRegistration => ({
  binding: { ...scope, provider: "zapier", providerAccountId: "private-source-account", action, mode: "observe", route: "api", routeRef: "route:private-route",
    requiredScopes: ["readHealth"], authorizationScopeVersion: "synthetic-v1", toolVersion: "v1", connectionRef: "connection:private-connection", secretRef: "secretref:private-secret" },
  ownerRef: "owner:private-owner", costBasis: { state: "unknown", reasonCode: "COST_UNKNOWN" },
});
const readInput = (viewKey: OperationsViewKey, limit = 50) => ({ viewKey, db: store.database, scope, ledger: operations.ledger, jobs: operations.jobs,
  authorizationContext: "test:reader", secret: "synthetic-test-key", limit, cursor: null, now: () => now });

beforeEach(() => {
  now = Date.parse("2026-11-04T16:00:00Z"); proof = null;
  store = new AgentStore(":memory:", scope);
  operations = createOperations(store.database, scope, { now: () => now, resolveReceipt: () => proof });
});
afterEach(() => { operations.close(); store.close(); });

describe("saved dashboard operation views", () => {
  it("shows empty local collections without asserting global coverage", () => {
    expect(savedBindingsSchema.parse(readOperationsView(readInput("connectionsOverview")).data).coverage).toEqual({ returned: 0, total: 0, partial: false });
    const runs = savedRunsSchema.parse(readOperationsView(readInput("automationRuns")).data);
    expect(runs.source).toBe("saved-operations");
    expect(runs.jobCoverage.total).toBe(0);
  });
  it("exposes stable safe aliases and truthful truncated coverage, with a distinct missing receipt", async () => {
    const item = operations.ledger.register(registration("private-action"), 0);
    operations.ledger.register(registration("readPolicy"), 0);
    expect(readOperationsView(readInput("connectionsOverview", 1))).toMatchObject({ returned: 1, total: 2, partial: true });
    await operations.ledger.verify(item.capabilityId, "receipt:private-location", 1);
    const result = savedBindingsSchema.parse(readOperationsView(readInput("channelCapabilities")).data);
    const missing = result.records.find(row => row.state === "Missing evidence")!;
    expect(missing.receipt).toBeNull();
    expect(result.records.some(row => row.state === "Documented")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(savedBindingsSchema.parse(readOperationsView(readInput("connectionsOverview")).data).records).toEqual(result.records);
  });
  it("re-evaluates receipt expiry without inventing a successful source read", async () => {
    const input = registration("readPolicy");
    const record = operations.ledger.register(input, 0);
    proof = { receiptRef: "receipt:private-location", binding: input.binding, outcome: "Ready", checkedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), verifiedScopes: ["readHealth"], connectionHealth: "Authenticated",
      sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
    await operations.ledger.verify(record.capabilityId, proof.receiptRef, 1);
    const snapshot = readInput("connectionsOverview");
    const first = savedBindingsSchema.parse(readOperationsView(snapshot).data).records[0]!;
    expect(first).toMatchObject({ state: "Ready", observedAt: null, lastSuccessAt: null, freshness: "unknown" });
    now += 60_000;
    const next = savedBindingsSchema.parse(readOperationsView(snapshot).data).records[0]!;
    expect(next).toMatchObject({ id: first.id, state: "Expired", revision: first.revision, receipt: first.receipt });
  });
  it("preserves the receipt's source observation when no J14 check exists, and displays an explicit unknown check separately", async () => {
    const input = registration("readPolicy");
    const record = operations.ledger.register(input, 0);
    const at = new Date(now).toISOString();
    const updated = new Date(now - 60_000).toISOString();
    proof = { receiptRef: "receipt:private-location", binding: input.binding, outcome: "Ready", checkedAt: at,
      expiresAt: new Date(now + 60_000).toISOString(), verifiedScopes: ["readHealth"], connectionHealth: "Authenticated",
      sourceFreshness: { state: "current", observedAt: at, sourceUpdatedAt: updated, sourceRef: "source:private-location" },
      businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
    await operations.ledger.verify(record.capabilityId, proof.receiptRef, 1);
    const health = createProviderHealth(store.database, scope, operations.ledger, operations.jobs, { now: () => now });
    const registered = health.get(record.capabilityId)!;
    expect(registered.checkedAt).toBeNull();
    const snapshot = readInput("connectionsOverview");
    const prior = savedBindingsSchema.parse(readOperationsView({ ...snapshot, health }).data).records[0]!;
    expect(prior).toMatchObject({ observedAt: at, sourceUpdatedAt: updated, lastSuccessAt: null, freshness: "current", sourceHealth: { checkedAt: null } });
    const checked = new Date(now + 1_000).toISOString();
    const later = savedBindingsSchema.parse(readOperationsView({ ...snapshot, health: { get: () => ({ ...registered, checkedAt: checked }) } }).data).records[0]!;
    expect(later).toMatchObject({ observedAt: at, sourceUpdatedAt: null, freshness: "unknown", sourceHealth: { checkedAt: checked, coverage: "unknown" } });
  });
  it("pins initial membership while reads reevaluate revoked permission and ignore later inserts", () => {
    const rows = ["readPolicy", "readOrders", "readMetrics"].map(action => operations.ledger.register(registration(action),0)).sort((a,b) => a.capabilityId.localeCompare(b.capabilityId));
    const input = readInput("channelCapabilities",1);
    const page1 = readOperationsView(input);
    operations.ledger.revoke(rows[1]!.capabilityId,"REVOKED",1);
    operations.ledger.register(registration("appeared-later"),0);
    const page2 = readOperationsView({...input,cursor:page1.nextCursor});
    const page3 = readOperationsView({...input,cursor:page2.nextCursor});
    const pages = [page1,page2,page3].map(p=>savedBindingsSchema.parse(p.data));
    expect(pages.map(p=>p.coverage.returned)).toEqual([1,2,3]);
    expect(new Set(pages.flatMap(p=>p.records.map(r=>r.id))).size).toBe(3);
    expect(pages[1]!.records[0]!.state).toBe("Blocked");
    expect(page3).toMatchObject({nextCursor:null,hasMore:false,total:3,partial:false});
    expect(readOperationsView(input).total).toBe(4);
  });
  it("rejects an expired token or a token reused under other display filters, scope, authorization, limit or view", () => {
    for (const action of ["readOrders","readMetrics"]) operations.ledger.register(registration(action),0);
    const input = {...readInput("connectionsOverview",1),filters:{q:"chosen"}};
    const cursor = readOperationsView(input).nextCursor!;
    for (const fields of [{filters:{q:"new"}},{authorizationContext:"test:reviewer"},{limit:2},{viewKey:"channelCapabilities" as const},
      {scope:{...scope,accountId:"other"}},{cursor:cursor+"A"}]) {
      expect(()=>readOperationsView({...input,cursor,...fields})).toThrow("INVALID_OPERATIONS_CURSOR");
    }
    now += 15 * 60_000;
    expect(()=>readOperationsView({...input,cursor})).toThrow("OPERATIONS_CURSOR_EXPIRED");
  });
  it("rejects cursor, invalid limit and other scopes instead of returning a prior scope", () => {
    const input = readInput("automationRuns");
    expect(() => readOperationsView({ ...input, cursor: "unknown" })).toThrow();
    expect(() => readOperationsView({ ...input, limit: 101 })).toThrow();
    expect(() => readOperationsView({ ...input, scope: { ...scope, accountId: "another" } })).toThrow("DATABASE_SCOPE_MISMATCH");
  });
});
