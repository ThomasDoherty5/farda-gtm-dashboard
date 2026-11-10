// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../store.ts";
import { digest } from "../config.ts";
import { createLifecycleService } from "./repository.ts";
import { LifecycleError, lifecycleSnapshotSchema } from "./source.ts";
import { lifecycleSourceFixture, lifecycleTestSource, lifecycleTestScope as scope, lifecycleTestSecret as secret, lifecycleTestTime } from "./fixtures.testkit.ts";
import { draftPayloadSchema, flowResourceSchema, type FlowKey, type NativeEmailFlow, type SaveDraftInput } from "./contract.ts";

const stores: AgentStore[] = [];
function setup(sourceOverride?: () => Promise<unknown | null>, path = ":memory:") {
  const store = new AgentStore(path, scope); stores.push(store);
  let clock = lifecycleTestTime;
  const source = lifecycleSourceFixture();
  const reader = lifecycleTestSource(sourceOverride ?? (async () => structuredClone(source)), () => clock);
  const ownedService = createLifecycleService({ db: store.database, scope, secret, source: reader, now: () => clock });
  // Existing assertions concern the exact persisted receipt; the source-fence
  // regression suite separately tests publication of the bound result.
  const service = { ...ownedService, saveDraft: async (...args: Parameters<typeof ownedService.saveDraft>) => (await ownedService.saveDraft(...args)).receipt };
  return { store, service, source, reader, time: () => clock, setTime: (value: number) => { clock = value; },
    advanceVersion: (version: string) => { clock++; source.version = version; source.observedAt = new Date(clock).toISOString(); } };
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
async function flowView(service: Pick<ReturnType<typeof createLifecycleService>, "read">, flow: FlowKey = "early-access", draftRequestKey?: string): Promise<NativeEmailFlow> {
  const { data } = await service.read("emailFlow", { flow, ...(draftRequestKey ? { draftRequestKey } : {}) }, "agent-reviewer");
  if (data.kind !== "source-email-flow") throw new Error("Wrong view");
  return data;
}
async function request(service: Pick<ReturnType<typeof createLifecycleService>, "read">, key = "synthetic-save", flow: Exclude<FlowKey, "setup"> = "early-access"): Promise<SaveDraftInput> {
  const view = await flowView(service, flow), config = view.sourceConfig!;
  const entry = config.entryEvents[0]!, timing = config.timingRules[0]!, template = config.templates[0]!;
  return { resourceKind: "configurationDraft", resourceRef: `flow-${flow}`, expectedVersion: view.draftVersion, idempotencyKey: key,
    payload: { entryEventRef: entry.ref, timingRuleRef: timing.ref, timezone: timing.timezone, templateRef: template.ref, templateVersion: template.version, templateName: "Synthetic local title" } };
}
const revisionCount = (w: ReturnType<typeof setup>) => Number(w.store.database.prepare("SELECT count(*) n FROM lifecycle_draft_revisions").get()!.n);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("lifecycle source-safe schema boundaries", () => {
  it.each(["recipients", "email", "medicationLog", "deviceId", "providerToken"])("rejects the private or undeclared source field %s", field => {
    expect(lifecycleSnapshotSchema.safeParse({ ...lifecycleSourceFixture(), [field]: "not-permitted" }).success).toBe(false);
  });
  it("rejects invalid offsets, source leases, future aggregate windows, unsafe totals and unrelated flow triggers", () => {
    const s = lifecycleSourceFixture(); s.observedAt = "2026-11-07T03:00:00+99:99";
    expect(lifecycleSnapshotSchema.safeParse(s).success).toBe(false);
    const badLease = lifecycleSourceFixture(); badLease.validUntil = badLease.observedAt;
    expect(lifecycleSnapshotSchema.safeParse(badLease).success).toBe(false);
    const future = lifecycleSourceFixture(); future.consent!.cohort.end = new Date(lifecycleTestTime + 1).toISOString();
    expect(lifecycleSnapshotSchema.safeParse(future).success).toBe(false);
    const total = lifecycleSourceFixture(); total.consent!.eligible.value = Number.MAX_SAFE_INTEGER; total.consent!.withdrawn.value = Number.MAX_SAFE_INTEGER;
    expect(lifecycleSnapshotSchema.safeParse(total).success).toBe(false);
    const trigger = lifecycleSourceFixture(); trigger.flows[1]!.entryEvents[0]!.trigger = "confirmed-delivery";
    expect(lifecycleSnapshotSchema.safeParse(trigger).success).toBe(false);
  });
  it("requires exclusive same-cohort consent counts, known-zero receipts and exact anonymous denominators", () => {
    const source = lifecycleSourceFixture(); source.consent!.unknown.value = 4;
    expect(lifecycleSnapshotSchema.safeParse(source).success).toBe(false);
    const nullValue = lifecycleSourceFixture(); nullValue.consent!.unknown = { value: null, missingReason: "No source category count" };
    expect(lifecycleSnapshotSchema.safeParse(nullValue).success).toBe(true);
    nullValue.activation!.weekOne.value = 87;
    expect(lifecycleSnapshotSchema.safeParse(nullValue).success).toBe(false);
    const outcome = lifecycleSourceFixture(); outcome.flows[0]!.outcomes!.rows[0]!.count.value = 0; outcome.flows[0]!.outcomes!.rows[0]!.receipt = null;
    expect(lifecycleSnapshotSchema.safeParse(outcome).success).toBe(false);
  });
  it("rejects unapproved variables and approvals without their source receipts", () => {
    const s = lifecycleSourceFixture(); s.flows[0]!.templates[0]!.preview!.lines = ["{{private_medication}}"];
    expect(lifecycleSnapshotSchema.safeParse(s).success).toBe(false);
    const approved = lifecycleSourceFixture(); approved.flows[0]!.templates[0]!.approval = "approved";
    expect(lifecycleSnapshotSchema.safeParse(approved).success).toBe(false);
    expect(flowResourceSchema.safeParse("flow-setup").success).toBe(false);
    expect(flowResourceSchema.safeParse("flow-anything").success).toBe(false);
  });
});

describe("scoped lifecycle reads and truthful evidence", () => {
  it("returns four native views with known zero distinct from null and raw references hidden", async () => {
    const w = setup();
    const overview = await w.service.read("lifecycleOverview", {}, "agent-reader");
    expect(overview.data).toMatchObject({ kind: "source-lifecycle", returnsAwaitingInspection: { value: 0, missingReason: null } });
    expect(JSON.stringify(overview.data)).not.toContain("synthetic-cohort-receipt");
    expect(JSON.stringify(overview.data)).not.toContain(scope.accountId);
    expect((await w.service.read("consentEligibility", {}, "agent-reader")).data).toMatchObject({ consent: { total: { value: 100 }, eligible: { value: 70 } } });
    expect((await w.service.read("activationRetention", {}, "agent-reader")).data).toMatchObject({ activation: { weekOneDefinition: "first-seven-days-after-delivery" } });
    const view = await flowView(w.service);
    expect(view.lockedPolicies).toEqual({ recheckConsentBeforeSend: true, stopOnOptOutOrSuppression: true, preventDuplicateEnrollment: true });
    expect(view.sourceConfig!.timingRules[0]!.approval).toBe("proposed");
    expect(view.sourceConfig!.evidence[0]!.state).toBe("passed");
    expect(view.currentSourceMatch).toBe(false);
  });
  it("keeps sections unavailable rather than zero and withholds unapproved activation exports", async () => {
    const w = setup(); w.source.consent = null; w.source.activation!.privacyApproval = { state: "unverified", receipt: null };
    expect((await w.service.read("consentEligibility", {}, "agent-reader"))).toMatchObject({ partial: true, data: { consent: null } });
    expect((await w.service.read("activationRetention", {}, "agent-reader")).data).toMatchObject({ activation: { paired: { value: null, missingReason: "Anonymous export approval is unverified." } } });
  });
  it("rejects foreign scope, future observations and source denial before exposing a protected draft", async () => {
    const w = setup(); w.source.scope = { ...scope, accountId: "foreign-account" };
    await expect(flowView(w.service)).rejects.toMatchObject({ status: 403 });
    const future = setup(); future.source.observedAt = new Date(lifecycleTestTime + 1).toISOString();
    await expect(flowView(future.service)).rejects.toMatchObject({ code: "LIFECYCLE_SOURCE_INVALID" });
    const denied = setup(async () => { throw new LifecycleError("SOURCE_AUTHORITY_DENIED", 403); });
    await expect(flowView(denied.service)).rejects.toMatchObject({ status: 403 });
  });
  it("caps a long source lease at the server observation deadline and holds a draft at that exact boundary", async () => {
    const w = setup(), input = await request(w.service);
    const before = await flowView(w.service);
    const effectiveDeadline = new Date(lifecycleTestTime + 15 * 60_000).toISOString();
    expect(before.validUntil).toBe(effectiveDeadline);
    expect(before.sourceConfig!.evidence[0]!.validUntil).toBe(effectiveDeadline);
    w.setTime(lifecycleTestTime + 15 * 60_000);
    const stale = await w.service.read("emailFlow", { flow: "early-access" }, "agent-reviewer");
    expect(stale).toMatchObject({ stale: true, partial: true, capabilities: [{ state: "held", reasonCodes: ["SOURCE_STALE"] }, { state: "held" }],
      data: { sourceState: "expired", freshness: "stale", currentSourceMatch: false, sourceConfig: { evidence: [{ state: "unknown" }] } } });
    await expect(w.service.saveDraft(input, "agent-reviewer")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(revisionCount(w)).toBe(0);
  });
  it("keeps a 300-day-old snapshot historical despite a source-issued year-long lease", async () => {
    const old = lifecycleSourceFixture(scope, lifecycleTestTime - 300 * 86400_000);
    old.validUntil = new Date(lifecycleTestTime + 65 * 86400_000).toISOString();
    for (const flow of old.flows) for (const evidence of flow.evidence) evidence.validUntil = old.validUntil;
    const w = setup(async () => structuredClone(old));
    const view = await flowView(w.service);
    expect(view).toMatchObject({ sourceState: "expired", freshness: "stale", saveHoldReasons: ["SOURCE_STALE"] });
    expect(view.sourceConfig!.evidence[0]!.state).toBe("unknown");
    expect(view.sourceConfig!.outcomes!.rows[0]!.count.value).toBe(2);
    await expect(w.service.saveDraft(await request(w.service), "agent-reviewer")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(revisionCount(w)).toBe(0);
  });
  it("does not renew old readiness evidence merely because its enclosing snapshot is freshly observed", async () => {
    const w = setup();
    const evidence = w.source.flows[1]!.evidence[0]!;
    evidence.observedAt = new Date(lifecycleTestTime - 15 * 60_000).toISOString();
    evidence.validUntil = new Date(lifecycleTestTime + 365 * 86400_000).toISOString();
    const view = await flowView(w.service);
    expect(view.sourceState).toBe("current");
    expect(view.sourceConfig!.evidence[0]).toMatchObject({ state: "unknown", validUntil: new Date(lifecycleTestTime).toISOString() });
  });
  it("rechecks the age at read publication and draft commit after the source promise has completed", async () => {
    const w = setup();
    // A fresh explicit permission at +14m remains valid when the business
    // observation reaches its independent +15m deadline after the source await.
    w.setTime(lifecycleTestTime + 14 * 60_000);
    const input = await request(w.service), originalAssertion = w.reader.assertCurrent;
    w.reader.assertCurrent = (result, binding, now) => {
      originalAssertion(result, binding, now);
      w.setTime(lifecycleTestTime + 15 * 60_000);
    };
    const result = await w.service.read("emailFlow", { flow: "early-access" }, "agent-reviewer");
    expect(result).toMatchObject({ stale: true, data: { sourceState: "expired", freshness: "stale", saveHoldReasons: ["SOURCE_STALE"] } });
    expect(() => result.assertCurrent()).not.toThrow();
    w.setTime(lifecycleTestTime + 14 * 60_000);
    await expect(w.service.saveDraft(input, "agent-reviewer")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(revisionCount(w)).toBe(0);
  });
  it("honors a source's shorter expiry without extending it to the server maximum", async () => {
    const w = setup(); w.source.validUntil = new Date(lifecycleTestTime + 60_000).toISOString();
    const before = await flowView(w.service);
    expect(before.validUntil).toBe(w.source.validUntil);
    expect(before.sourceConfig!.evidence[0]!.validUntil).toBe(w.source.validUntil);
    w.setTime(lifecycleTestTime + 60_000);
    expect(await flowView(w.service)).toMatchObject({ freshness: "stale", sourceState: "expired" });
  });
  it("keeps renewed evidence distinct from a conflicting reused source version or regressed observation", async () => {
    const w = setup(); await flowView(w.service);
    w.setTime(w.time() + 1); w.source.observedAt = new Date(w.time()).toISOString(); w.source.validUntil = new Date(w.time() + 3600_000).toISOString();
    await expect(flowView(w.service)).resolves.toMatchObject({ sourceState: "current" });
    w.source.consent!.eligible.value = 69; w.source.consent!.unknown.value = 6;
    await expect(flowView(w.service)).rejects.toMatchObject({ code: "LIFECYCLE_SOURCE_CONFLICT" });
    w.source.consent!.eligible.value = 70; w.source.consent!.unknown.value = 5; w.source.observedAt = new Date(lifecycleTestTime).toISOString();
    await expect(flowView(w.service)).rejects.toMatchObject({ code: "LIFECYCLE_SOURCE_REGRESSED" });
  });
  it("rejects different source facts at the same instant even when the timestamp uses another offset", async () => {
    const w = setup(); await flowView(w.service);
    const originalHead = w.store.database.prepare("SELECT * FROM lifecycle_source_head").get();
    w.source.version = "synthetic-equivalent-instant-v2";
    w.source.observedAt = "2026-11-06T19:00:00-08:00";
    expect(Date.parse(w.source.observedAt)).toBe(lifecycleTestTime);
    w.source.consent!.eligible.value = 69; w.source.consent!.unknown.value = 6;
    await expect(flowView(w.service)).rejects.toMatchObject({ code: "LIFECYCLE_SOURCE_CONFLICT", status: 409 });
    expect(w.store.database.prepare("SELECT * FROM lifecycle_source_head").get()).toEqual(originalHead);
    expect(w.store.database.prepare("SELECT * FROM lifecycle_source_versions WHERE version=?").get(w.source.version)).toBeUndefined();
  });
  it("downgrades expired, wrong-template and wrong-policy readiness receipts without erasing history", async () => {
    const w = setup(); w.source.flows[1]!.evidence[0]!.basis!.policyVersion = "unmatched-policy";
    const bad = await flowView(w.service); expect(bad.sourceConfig!.evidence[0]).toMatchObject({ state: "unknown", missingReason: expect.any(String) });
    w.advanceVersion("synthetic-v2"); w.source.flows[1]!.evidence[0]!.basis!.policyVersion = "synthetic-policy-v1";
    w.source.flows[1]!.evidence[0]!.basis!.templateVersion = "another-version";
    expect((await flowView(w.service)).sourceConfig!.evidence[0]!.state).toBe("unknown");
    w.setTime(lifecycleTestTime + 3600_001);
    expect(await flowView(w.service)).toMatchObject({ sourceState: "expired", freshness: "stale", saveHoldReasons: ["SOURCE_STALE"] });
  });
});

describe("immutable local flow draft persistence and recovery", () => {
  it.each(["early-access", "abandoned-checkout", "review-request"] as const)("saves %s only as a versioned local draft and matches its exact receipt", async flow => {
    const w = setup(), input = await request(w.service, "save-" + flow, flow);
    const before = structuredClone(w.source), receipt = await w.service.saveDraft(input, "agent-reviewer");
    expect(receipt.record).toMatchObject({ kind: "local-flow-draft", revision: 1, flow, payload: input.payload, lockedPolicies: { stopOnOptOutOrSuppression: true } });
    expect(receipt.payloadDigest).toBe(digest(input.payload)); expect(receipt.expectedVersion).toBe(input.expectedVersion);
    expect(w.source).toEqual(before);
    const read = await flowView(w.service, flow, input.idempotencyKey);
    expect(read).toMatchObject({ draft: receipt.record, draftVersion: receipt.resourceVersion, currentSourceMatch: true,
      requestedSave: { state: "applied", disposition: "recorded", original: { payload: input.payload, expectedVersion: input.expectedVersion }, receipt } });
  });
  it.each(["recheckConsentBeforeSend", "stopOnOptOutOrSuppression", "preventDuplicateEnrollment", "enabled", "send", "recipients", "actor", "medication"])("rejects forged %s before persistence", async key => {
    const w = setup(), input = await request(w.service);
    const payload = { ...input.payload, [key]: false };
    expect(draftPayloadSchema.safeParse(payload).success).toBe(false);
    await expect(w.service.saveDraft({ ...input, payload }, "agent-reviewer")).rejects.toMatchObject({ status: 422 });
    expect(revisionCount(w)).toBe(0);
  });
  it("rejects reader writes, setup edits, foreign catalog selectors and altered timezone", async () => {
    const w = setup(), input = await request(w.service);
    await expect(w.service.saveDraft(input, "agent-reader")).rejects.toMatchObject({ status: 403 });
    await expect(w.service.saveDraft({ ...input, resourceRef: "flow-setup" }, "agent-reviewer")).rejects.toMatchObject({ status: 422 });
    const other = await request(w.service, "other", "review-request");
    await expect(w.service.saveDraft({ ...input, payload: other.payload }, "agent-reviewer")).rejects.toMatchObject({ code: "FLOW_CATALOG_SELECTION_INVALID" });
    await expect(w.service.saveDraft({ ...input, idempotencyKey: "timezone", payload: { ...input.payload, timezone: "UTC" } }, "agent-reviewer")).rejects.toMatchObject({ code: "FLOW_CATALOG_SELECTION_INVALID" });
    expect(revisionCount(w)).toBe(0);
  });
  it("deduplicates concurrent same-key saves; changed bodies conflict and competing stale keys are terminal no-ops", async () => {
    const w = setup(), input = await request(w.service);
    const [a, b] = await Promise.all([w.service.saveDraft(input, "agent-reviewer"), w.service.saveDraft(input, "agent-reviewer")]);
    expect(b).toEqual(a); expect(revisionCount(w)).toBe(1);
    await expect(w.service.saveDraft({ ...input, payload: { ...input.payload, templateName: "Different title" } }, "agent-reviewer")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    const stale = { ...input, idempotencyKey: "competing-save" };
    await expect(w.service.saveDraft(stale, "agent-reviewer")).rejects.toMatchObject({ code: "STALE_VERSION", currentVersion: a.resourceVersion });
    const read = await flowView(w.service, "early-access", stale.idempotencyKey);
    expect(read.requestedSave).toMatchObject({ state: "notApplied", disposition: "rejected", original: { payload: stale.payload, expectedVersion: stale.expectedVersion }, payloadDigest: digest(stale.payload) });
    await expect(w.service.saveDraft({ ...stale, expectedVersion: a.resourceVersion }, "agent-reviewer")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(revisionCount(w)).toBe(1);
  });
  it("treats absent receipt as unknown, scopes lookup and does not infer a past save from a newer draft", async () => {
    const w = setup(), input = await request(w.service);
    expect((await flowView(w.service, "early-access", input.idempotencyKey)).requestedSave).toMatchObject({ state: "unknown", disposition: "absent", original: null, receipt: null });
    const saved = await w.service.saveDraft(input, "agent-reviewer");
    const next = await request(w.service, "second"); next.payload.templateName = "Second local draft";
    await w.service.saveDraft(next, "agent-reviewer");
    expect((await flowView(w.service, "early-access", input.idempotencyKey)).requestedSave?.receipt).toEqual(saved);
    await expect(flowView(w.service, "review-request", input.idempotencyKey)).rejects.toMatchObject({ status: 403 });
    await expect(w.service.read("emailFlow", { flow: "early-access", draftRequestKey: input.idempotencyKey }, "agent-reader")).rejects.toMatchObject({ status: 403 });
  });
  it("holds new drafts after expiry/policy change while preserving original persisted receipts", async () => {
    const w = setup(), input = await request(w.service), saved = await w.service.saveDraft(input, "agent-reviewer");
    w.advanceVersion("synthetic-source-v2"); w.source.flows[1]!.policyVersion = "new-policy";
    await expect(w.service.saveDraft({ ...input, idempotencyKey: "late" }, "agent-reviewer")).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect(await w.service.saveDraft(input, "agent-reviewer")).toEqual(saved);
    expect((await flowView(w.service)).currentSourceMatch).toBe(false);
    w.setTime(lifecycleTestTime + 3600_001);
    const expired = await request(w.service, "expired");
    await expect(w.service.saveDraft(expired, "agent-reviewer")).rejects.toMatchObject({ code: "SOURCE_STALE" });
    expect(revisionCount(w)).toBe(1);
  });
  it("allows a lease-only renewal without changing the reviewed material source version", async () => {
    const w = setup(), input = await request(w.service);
    w.setTime(w.time() + 1000); w.source.observedAt = new Date(w.time()).toISOString(); w.source.validUntil = new Date(w.time() + 3600_000).toISOString();
    for (const f of w.source.flows) for (const e of f.evidence) { e.observedAt = w.source.observedAt; e.validUntil = w.source.validUntil; }
    expect((await flowView(w.service)).draftVersion).toBe(input.expectedVersion);
    await expect(w.service.saveDraft(input, "agent-reviewer")).resolves.toMatchObject({ record: { revision: 1 } });
  });
  it("checks source withdrawal and lease expiry after an awaited source read", async () => {
    let gate = deferred(), entered = deferred(), wait = false, denied = false;
    const source = lifecycleSourceFixture();
    const w = setup(async () => { if (wait) { entered.resolve(); await gate.promise; } if (denied) throw new LifecycleError("SOURCE_AUTHORITY_DENIED", 403); return structuredClone(source); });
    const input = await request(w.service); wait = true;
    const deniedPromise = w.service.saveDraft(input, "agent-reviewer");
    const deniedAssertion = expect(deniedPromise).rejects.toMatchObject({ status: 403 });
    await entered.promise; denied = true; gate.resolve();
    await deniedAssertion; expect(revisionCount(w)).toBe(0);
    denied = false; gate = deferred(); entered = deferred();
    const expired = w.service.saveDraft({ ...input, idempotencyKey: "expired-wait" }, "agent-reviewer");
    const expiredAssertion = expect(expired).rejects.toMatchObject({ code: "SOURCE_STALE" });
    await entered.promise; w.setTime(lifecycleTestTime + 15 * 60_000); gate.resolve();
    await expiredAssertion; expect(revisionCount(w)).toBe(0);
  });
  it("rejects a delayed older source read after a newer policy observation has been accepted", async () => {
    let slow = false;
    const entered = deferred(), gate = deferred();
    let snapshot = lifecycleSourceFixture();
    const w = setup(async () => { const captured = structuredClone(snapshot); if (slow) { entered.resolve(); await gate.promise; } return captured; });
    const input = await request(w.service); slow = true;
    const pending = w.service.saveDraft(input, "agent-reviewer");
    const rejection = expect(pending).rejects.toMatchObject({ code: "LIFECYCLE_SOURCE_REGRESSED" });
    await entered.promise;
    snapshot = structuredClone(snapshot); snapshot.version = "newer-policy-source"; snapshot.flows[1]!.policyVersion = "newer-policy";
    w.setTime(w.time() + 1); snapshot.observedAt = new Date(w.time()).toISOString(); slow = false;
    await flowView(w.service); gate.resolve();
    await rejection;
    expect(revisionCount(w)).toBe(0);
  });
  it("reports finite history truncation and preserves exact old receipts beyond the visible history page", async () => {
    const w = setup(); let original: Awaited<ReturnType<typeof w.service.saveDraft>> | undefined;
    for (let i = 0; i < 21; i++) {
      const input = await request(w.service, "history-" + i); input.payload.templateName = "Synthetic revision " + i;
      const receipt = await w.service.saveDraft(input, "agent-reviewer"); original ??= receipt;
    }
    const view = await flowView(w.service, "early-access", "history-0");
    expect(view.history).toMatchObject({ total: 21, truncated: true });
    expect(view.history.rows).toHaveLength(20); expect(view.history.rows[0]!.revision).toBe(21);
    expect(view.requestedSave!.receipt).toEqual(original);
  });
  it("preserves immutable history and exact request readback after file SQLite restart without a source binding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifecycle-restart-"));
    try {
      const w = setup(undefined, join(dir, "drafts.sqlite")), input = await request(w.service), receipt = await w.service.saveDraft(input, "agent-reviewer");
      const raw = w.store.database.prepare("SELECT body FROM lifecycle_draft_revisions").get()!.body;
      w.store.close(); stores.splice(stores.indexOf(w.store), 1);
      const store = new AgentStore(join(dir, "drafts.sqlite"), scope); stores.push(store);
      const service = createLifecycleService({ db: store.database, scope, secret, now: () => lifecycleTestTime });
      const read = await flowView(service, "early-access", input.idempotencyKey);
      expect(read).toMatchObject({ sourceState: "unconfigured", sourceConfig: null, currentSourceMatch: false, draft: receipt.record });
      expect(read.requestedSave?.receipt).toEqual(receipt);
      expect(store.database.prepare("SELECT body FROM lifecycle_draft_revisions").get()!.body).toBe(raw);
      expect(read.history).toMatchObject({ total: 1, truncated: false, rows: [receipt.record] });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
