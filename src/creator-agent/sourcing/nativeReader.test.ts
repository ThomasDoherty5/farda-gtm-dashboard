// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { AgentStore } from "../store.ts";
import { nativeSourcingFixture } from "./nativeFixtures.testkit.ts";
import { sourcingTestScope } from "./fixtures.testkit.ts";
import { createNativeSourcingReader } from "./nativeReader.ts";
import { NativeSourcingError, type NativeSourcingSource } from "./nativeSource.ts";
import { nativeSourcingPlanSchema } from "./views.ts";
const stores: AgentStore[] = [];
function fixture() { const store = new AgentStore(":memory:", sourcingTestScope); stores.push(store); return { ...nativeSourcingFixture(store.database), store }; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const read = (f: ReturnType<typeof fixture>) => f.reader.read(f.request, f.principal);

describe("native sourcing authority and immutable projection", () => {
  it("retains original plan/capacity/receipt arithmetic and labels the fictional owner", async () => {
    const f = fixture(), result = await read(f);
    expect(nativeSourcingPlanSchema.safeParse(result.data).success).toBe(true);
    expect(result.data).toMatchObject({ datasetKey: "sourcing-plan-native", provenance: { evidenceStage: "synthetic", synthetic: true } });
    expect(result.data.plan!.steps.map(step => step.step)).toEqual(["discovery", "identityResolution", "videoReview", "qualification", "invitationPlanning"]);
    expect(result.data.plan!.latestRun!.receiptRefs).toHaveLength(result.data.plan!.latestRun!.confirmedInvitations.value!);
    expect(result.data.plan!.dispatchHoldReasons).toContain("READ_ONLY_PLAN");
    expect(JSON.stringify(result.data)).not.toMatch(/synthetic-|fictional-|permissionVersion|principalRef/);
    expect(() => result.assertCurrent()).not.toThrow();
    expect(nativeSourcingPlanSchema.safeParse({ ...result.data, provenance: { ...result.data.provenance, synthetic: false } }).success).toBe(false);
  });
  it("does not expose an unconfigured success or downgrade denied source authority to stale protected data", async () => {
    const f = fixture(), service = createNativeSourcingReader({ db: f.store.database, scope: f.scope, referenceKey: f.referenceKey });
    await expect(service.read(f.request, f.principal)).rejects.toMatchObject({ code: "SOURCING_SOURCE_UNCONFIGURED", status: 503 });
    f.state.allowed = false;
    await expect(read(f)).rejects.toMatchObject({ code: "SOURCING_SOURCE_DENIED", status: 403 });
  });
  it.each(["denial", "permission", "version"])("refuses a captured snapshot after %s changes during await, without persisting its head", async kind => {
    const f = fixture();
    f.state.afterRead = () => { if (kind === "denial") f.state.allowed = false; else if (kind === "permission") f.state.permissionVersion = "changed"; else f.state.version = "changed"; };
    await expect(read(f)).rejects.toMatchObject({ code: kind === "denial" ? "SOURCING_SOURCE_DENIED" : "SOURCING_SOURCE_CHANGED" });
    expect(f.store.database.prepare("SELECT name FROM sqlite_master WHERE name='sourcing_plan_source_head'").get()).toBeUndefined();
  });
  it("checks current permission inside the integrity transaction and rolls back its head on revocation", async () => {
    const f = fixture(), original = f.source.assertCurrent;
    f.source.assertCurrent = (snapshot, binding, now) => {
      original(snapshot, binding, now);
      const exists = f.store.database.prepare("SELECT name FROM sqlite_master WHERE name='sourcing_plan_source_head'").get();
      if (exists && f.store.database.prepare("SELECT version FROM sourcing_plan_source_head WHERE id=1").get()) throw new NativeSourcingError("SOURCING_SOURCE_DENIED", 403);
    };
    await expect(read(f)).rejects.toMatchObject({ code: "SOURCING_SOURCE_DENIED", status: 403 });
    expect(f.store.database.prepare("SELECT version FROM sourcing_plan_source_head WHERE id=1").get()).toBeUndefined();
  });
  it("final publication rejects exact lease crossover and late permission changes", async () => {
    const f = fixture(), result = await read(f); f.state.allowed = false;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "SOURCING_SOURCE_DENIED" }));
    f.state.allowed = true; f.state.now += 60_000;
    expect(() => result.assertCurrent()).toThrowError(expect.objectContaining({ code: "SOURCING_PUBLICATION_EXPIRED" }));
  });
  it.each(["async", "nonvoid", "missing"])("rejects a %s source fence", async kind => {
    const f = fixture(), assertCurrent = kind === "async" ? async () => {} : kind === "nonvoid" ? () => 1 : undefined;
    const source = { read: f.source.read, assertCurrent: assertCurrent as NativeSourcingSource["assertCurrent"] };
    const service = createNativeSourcingReader({ db: f.store.database, scope: f.scope, referenceKey: f.referenceKey, source, now: f.now });
    await expect(service.read(f.request, f.principal)).rejects.toBeInstanceOf(NativeSourcingError);
  });
  it("checks scope/principal/request equality and never reflects private source strings", async () => {
    const f = fixture(); f.state.mutate = snapshot => { snapshot.binding.principal.principalRef = "private-source-principal"; };
    await expect(read(f)).rejects.toMatchObject({ code: "SOURCING_BINDING_MISMATCH", status: 403 });
    expect(new NativeSourcingError("someone@example.test", 403)).toMatchObject({ code: "SOURCING_SOURCE_UNAVAILABLE", message: "SOURCING_SOURCE_UNAVAILABLE", status: 503 });
  });
  it("rejects same-version changed source material after a successful read and preserves the immutable original", async () => {
    const f = fixture(); await read(f);
    const original = f.store.database.prepare("SELECT facts_hash FROM sourcing_plan_source_versions WHERE version=?").get(f.state.version);
    f.state.mutate = packet => { packet.snapshot.schedule.state = "paused"; };
    await expect(read(f)).rejects.toMatchObject({ code: "SOURCING_SOURCE_CHANGED", status: 409 });
    expect(f.store.database.prepare("SELECT facts_hash FROM sourcing_plan_source_versions WHERE version=?").get(f.state.version)).toEqual(original);
  });
  it("keeps partial unknown capacity held and does not turn a reported receipt into an invitation action", async () => {
    const f = fixture(); f.state.mutate = packet => { packet.snapshot.coverage = "partial"; packet.snapshot.capacity[0]!.remaining = { value: null, missingReason: "CAPACITY_NOT_REPORTED" }; };
    const result = await read(f);
    expect(result.dataState).toBe("partial"); expect(result.data.plan!.capacity[0]).toMatchObject({ state: "unknown", dispatchBlocked: true, remaining: { value: null } });
    expect(result.capabilities.every(capability => capability.state !== "available")).toBe(true);
  });
});
