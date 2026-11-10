// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { approvalDispatchBinding } from "./approvals/repository.ts";
import { CapabilityLedger, capabilityIdForBinding } from "./connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import { DispatchGuard } from "./jobs/dispatchGuard.ts";
import { DispatchError, type DispatchHandler, type ResourceAuthority } from "./jobs/dispatchSchema.ts";
import { JobRepository } from "./jobs/repository.ts";
import { JobRuntime } from "./jobs/runtime.ts";
import type { RuntimeAuthority } from "./jobs/runtimeSchema.ts";
import { createBulkRuntimeRegistration } from "./bulkRuntime.ts";
import { bulkServerFixture } from "./bulk/serverFixture.testkit.ts";
import { createAgentServer } from "./server.ts";
import { digest } from "./config.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";
import { nativeBulkViewSchema } from "./bulk/views.ts";

it("actual J04 API and separately verified browser dispatch share the same source quota with a scheduled runtime", async () => {
  // Fictional capability receipts and transports exercise the real shared guards.
  // They do not qualify either route against a provider or configure a live source.
  const a = approvalFixture();
  try {
    const receipts = new Map<string, VerificationReceipt>(), calls: string[] = [];
    const ledger = new CapabilityLedger(a.db, scope, { now: () => a.state.now, resolveReceipt: ref => receipts.get(ref) ?? null });
    const binding = (route: "api" | "browser"): ExpectedBinding => ({ ...scope, provider: "fictional-provider", providerAccountId: a.draft.providerAccountRef,
      action: a.draft.actionKind, mode: "executeApproved", route, routeRef: `route:fictional-${route}`, authorizationScopeVersion: "v1", toolVersion: "v1",
      requiredScopes: ["fictional:invite"], connectionRef: null, secretRef: null });
    const apiBinding = binding("api"), browserBinding = binding("browser");
    async function verify(b: ExpectedBinding) {
      const proof: VerificationReceipt = { receiptRef: `receipt:fictional-${b.route}`, binding: b, outcome: "Ready", checkedAt: a.at(), expiresAt: a.until(),
        verifiedScopes: b.requiredScopes, connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
      receipts.set(proof.receiptRef, proof); await ledger.verify(capabilityIdForBinding(b), proof.receiptRef, 1);
    }
    for (const b of [apiBinding, browserBinding]) ledger.register({ binding: b, ownerRef: "owner:fictional-source-owner", costBasis: { state: "unknown", reasonCode: "FICTIONAL_COST" } }, 0);
    await verify(apiBinding);
    a.db.exec("CREATE TABLE fictional_route_quota(window_ref TEXT, dispatch_key TEXT, PRIMARY KEY(window_ref,dispatch_key))");
    let windowRef = "fictional-window-1", windowStart = a.at(), windowEnd = a.until();
    const resources: ResourceAuthority = { async resolveGrants(request) {
      const old = a.db.prepare("SELECT 1 FROM fictional_route_quota WHERE window_ref=? AND dispatch_key=?").get(windowRef, request.dispatchKey);
      const total = Number(a.db.prepare("SELECT count(*) n FROM fictional_route_quota WHERE window_ref=?").get(windowRef)?.n);
      if (!old && total >= 1) throw new DispatchError("SOURCE_RATE_LIMITED", 429, "notApplied", 1000);
      a.db.prepare("INSERT OR IGNORE INTO fictional_route_quota VALUES(?,?)").run(windowRef, request.dispatchKey);
      return [{ grantRef: `fictional-grant-${digest([windowRef, request.dispatchKey])}`, issuerRef: "fictional-source-owner", allocationVersion: windowRef, scope,
        dispatchKey: request.dispatchKey, dimension: "quota", resourceRef: "fictional-account-invitation-pool", quantity: 1, unit: "invitation", currency: null,
        observedAt: windowStart, validUntil: windowEnd, exclusive: true, quotaBasis: { publishedLimit: 2, operatingLimit: 1, allocatedTotal: 1, windowRef, windowStart, windowEnd, sharedAcrossRoutes: true } }];
    }, assertCurrent(grants) { for (const grant of grants) if (grant.allocationVersion !== windowRef || !a.db.prepare("SELECT 1 FROM fictional_route_quota WHERE window_ref=? AND dispatch_key=?").get(windowRef, grant.dispatchKey)) throw new DispatchError("FICTIONAL_QUOTA_CHANGED"); } };
    const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Fictional invitation has no stock or money effect." };
    const budgets = { maxItems: 100, maxSteps: 100, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 2, retryBaseMs: 0 };
    function handler(b: ExpectedBinding): DispatchHandler { return { policyVersion: a.policy.version, idempotency: "source-enforced", sourceEffect: "providerApplied", provider: { state: "required", binding: b }, budgets,
      resources: () => ({ budget: na, stock: na, quota: { state: "required", resourceRef: "fictional-account-invitation-pool", quantity: 1, unit: "invitation", currency: null } }),
      async execute(c) { c.assertCurrent(); calls.push(b.route); return { state: "applied", receipt: { receiptRef: `fictional-${b.route}-${digest(c.dispatchKey)}`, dispatchKey: c.dispatchKey,
        payloadHash: c.intent.approval.payloadHash, handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, sourceEffect: "providerApplied", observedAt: a.at() } }; },
      async reconcile() { return { state: "unknown", reasonCode: "FICTIONAL_UNUSED_READBACK" }; } }; }
    const jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
    const guard = new DispatchGuard({ db: a.db, scope, jobs, approvals: a.repo, ledger, resourceAuthority: resources, now: () => a.state.now,
      handlers: new Map([["fictional-api", handler(apiBinding)], ["fictional-browser", handler(browserBinding)]]) });
    async function approve(key: string, handlerRef: string) {
      const preview = await a.repo.preparePreview(a.command, { principalRef: "synthetic:requester" }, `preview-${key}`);
      const requested = await a.repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: 1 }, { principalRef: "synthetic:requester" }, `request-${key}`);
      const event = a.event(requested, "approved", "synthetic:founder", `event-${key}`), approved = await a.repo.observeDecision(event.locator, { ingressRef: "fictional-verified-ingress" });
      return { approval: approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef), handlerRef, payloadRef: approved.manifest.draft.payloadRef };
    }
    const apiIntent = await approve("api", "fictional-api"), api = await guard.handoff(apiIntent, { principalRef: "synthetic:requester", idempotencyKey: "fictional-api-start" });
    await guard.execute(api.runRef); const originalReceipt = guard.read(api.runRef, false).receipt; expect(calls).toEqual(["api"]);
    a.draft.items[0]!.itemRef = "fictional-browser-item"; a.draft.items[0]!.targetRef = "fictional-browser-recipient";
    a.command.selectionRefs = ["fictional-browser-item"];
    const browserIntent = await approve("browser", "fictional-browser");
    const registration = createBulkRuntimeRegistration({ registrationRef: "fictional-shared-scheduled-dispatch", ownerRef: "fictional-runtime-owner", sourceRef: "fictional-runtime-source", policyVersion: a.policy.version, budgets });
    registration.cadence = { kind: "hourly", timezone: "UTC", minute: 0, startsAt: a.at() };
    const lease = () => ({ scope, observedAt: a.at(), validUntil: a.until() });
    const authority: RuntimeAuthority = {
      resolveActivation: async () => ({ ...lease(), receiptRef: "receipt:fictional-runtime", registrationRef: registration.registrationRef, registrationHash: digest(registration), sourceVersion: "v1", triggerRef: "fictional-schedule", triggerVersion: "v1", toolApprovalRef: "fictional-machine-approval", migration: { state: "notApplicable", policyVersion: a.policy.version } }), assertActivation: () => {},
      prepareWindow: async ({ window }) => ({ ...lease(), receiptRef: `receipt:fictional-window-${a.state.now}`, sourceVersion: "v1", registrationHash: digest(registration), window, kind: "approved", intents: [browserIntent] }), assertWindow: () => {},
      resolvePreflight: async () => { throw new Error("Approved dispatch owns preflight."); }, assertCurrent: () => {},
      resolveTakeover: async () => { throw new Error("No takeover is authorized."); }, assertTakeover: () => {},
    };
    const runtimeOptions = { scope, jobs, ledger, dispatch: guard, registry: { registrations: new Map([[registration.registrationRef, registration]]), executors: new Map() }, authority, now: () => a.state.now };
    let runtime = new JobRuntime(a.db, runtimeOptions); const machine = { workerRef: "fictional-runtime-worker", assertCurrent: () => {} };
    runtime.install(registration.registrationRef, 0, machine);
    const event = { registrationRef: registration.registrationRef, registrationVersion: 1, intendedAt: a.at(), triggerEventRef: "fictional-scheduled-event" };
    const scheduled = await runtime.fire(event, machine);
    expect(ledger.requireReady(browserBinding)).toMatchObject({ state: "Unverified", allowed: false });
    // Quota resolution precedes capability assertion: the full source pool is the first blocker.
    await expect(runtime.work({ runRef: scheduled.run.runId }, machine)).rejects.toMatchObject({ code: "SOURCE_RATE_LIMITED", status: 429, executionCertainty: "notApplied" });
    expect(calls).toEqual(["api"]); expect(a.db.prepare("SELECT count(*) n FROM fictional_route_quota").get()?.n).toBe(1);
    const originalKey = guard.read(scheduled.run.runId, false).dispatchKey;
    const deferred = guard.read(scheduled.run.runId, false).run.items.find(item => item.itemKey === originalKey)!;
    expect(deferred).toMatchObject({ state: "retryWait", attempts: 0, dueAt: new Date(a.state.now + 1000).toISOString(), reasonCode: "SOURCE_RATE_LIMITED" });
    await runtime.work({ runRef: scheduled.run.runId }, machine);
    expect(guard.read(scheduled.run.runId, false).run.items.find(item => item.itemKey === originalKey)).toEqual(deferred);
    expect(calls).toEqual(["api"]);
    // Only an explicit source reset supplies a new pool. The route, run and intent stay fixed.
    a.state.now += 1000; windowRef = "fictional-window-2"; windowStart = a.at(); windowEnd = a.until();
    runtime = new JobRuntime(a.db, runtimeOptions);
    await expect(runtime.work({ runRef: scheduled.run.runId }, machine)).rejects.toMatchObject({ code: "NOT_VERIFIED", executionCertainty: "notApplied" });
    expect(calls).toEqual(["api"]);
    expect(guard.read(scheduled.run.runId, false).run.items.find(item => item.itemKey === originalKey)).toMatchObject({ state: "held", attempts: 0, reasonCode: "NOT_VERIFIED" });
    expect(ledger.requireReady(browserBinding)).toMatchObject({ state: "Unverified", allowed: false });
    await verify(browserBinding);
    expect(ledger.requireReady(browserBinding)).toMatchObject({ state: "Ready", allowed: true });
    await runtime.work({ runRef: scheduled.run.runId }, machine);
    expect(guard.read(scheduled.run.runId, false).dispatchKey).toBe(originalKey);
    expect(calls).toEqual(["api", "browser"]); expect(guard.read(api.runRef, false).receipt).toEqual(originalReceipt);
    expect((await runtime.fire(event, machine)).run.runId).toBe(scheduled.run.runId);
    await runtime.work({ runRef: scheduled.run.runId }, machine); expect(calls).toEqual(["api", "browser"]);
    expect(a.db.prepare("SELECT window_ref,count(*) n FROM fictional_route_quota GROUP BY window_ref ORDER BY window_ref").all().map(r => [r.window_ref, r.n])).toEqual([["fictional-window-1", 1], ["fictional-window-2", 1]]);
  } finally { a.db.close(); }
});

it("an actually saved offer expires through the authenticated bulk and commercial composition before the batch expires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bulk-offer-expiry-")), w = bulkServerFixture(join(dir, "db.sqlite"), { offerExpiryMs: 60000 });
  const app = createAgentServer(w.options);
  try {
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve)); const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const post = async (path: string, body: unknown) => { const r = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${SYNTHETIC_REVIEW_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    const requestedScope = { workspaceId: w.scope.workspaceId, accountIds: [w.scope.accountId], environment: "sandbox" };
    const read = await post("/v1/read", { schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "fictional-expiry-read", requestedScope, viewKey: "batchDetail", filters: { context: "bulk", ...w.filters }, period: null, sort: [], page: { cursor: null, limit: 100 } });
    expect(read.status).toBe(200); const group = nativeBulkViewSchema.parse(read.body.data).groups[0]!;
    const preview = await post("/v1/action", { schemaVersion: SCHEMA_VERSION, operation: "previewAction", requestId: "fictional-expiry-preview", requestedScope, actionKind: group.actionKind, entityRefs: [], expectedVersion: group.preview!.entityVersion, approvalRef: null, manifestRef: null, runRef: null, payload: group.preview, idempotencyKey: "fictional-expiry-preview" });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    const repo = app.actionFoundation.approvals, requested = await repo.requestDecision({ approvalRef: preview.body.approvalRef, expectedVersion: 1 }, { principalRef: "agent-reviewer" }, "fictional-expiry-request");
    const event = w.a.event(requested, "approved", "synthetic:founder", "fictional-expiry-approved"), approved = await repo.observeDecision(event.locator, { ingressRef: "fictional-verified-ingress" });
    expect(approved.current.state).toBe("approved");
    const run = await app.actionFoundation.dispatch.handoffBatch(w.intentsFor(approved.manifest), { principalRef: "agent-reviewer", idempotencyKey: "fictional-expiry-handoff" });
    app.actionFoundation.dispatch.control(run.runRef, run.revision, "pause");
    w.a.state.now += 60000; w.o.advance(60000);
    expect(Date.parse(w.packet.expiresAt)).toBeGreaterThan(w.a.state.now);
    const firstOffer = approved.manifest.draft.commercialOffers![0]!.offerRef;
    expect(w.o.repo.readEligibility(firstOffer)).toMatchObject({ state: "held", reasonCodes: expect.arrayContaining(["OFFER_SOURCE_EXPIRED"]) });
    const proof = await repo.resolveCurrentProof(approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef));
    expect(proof).toMatchObject({ state: "held", reasonCodes: expect.arrayContaining(["OFFER_SOURCE_EXPIRED"]) });
    app.actionFoundation.dispatch.control(run.runRef, app.actionFoundation.dispatch.read(run.runRef, false).revision, "resume");
    await expect(app.actionFoundation.dispatch.execute(run.runRef)).rejects.toMatchObject({ executionCertainty: "notApplied" });
    expect(w.state.calls).toHaveLength(0); expect(w.a.db.prepare("SELECT count(*) n FROM job_dispatch_attempts").get()?.n).toBe(0);
    expect(repo.readApproval(approved.manifest.approvalRef)!.manifest).toEqual(approved.manifest);
  } finally { await app.close(); w.close(); rmSync(dir, { recursive: true, force: true }); }
});
