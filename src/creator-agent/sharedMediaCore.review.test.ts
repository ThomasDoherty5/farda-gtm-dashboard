// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { createActionService } from "./actions/service.ts";
import { CapabilityLedger, capabilityIdForBinding } from "./connections/ledger.ts";
import { unknownBusinessEligibility, unknownSourceFreshness, type ExpectedBinding, type VerificationReceipt } from "./connections/schema.ts";
import { digest } from "./config.ts";
import { DispatchGuard } from "./jobs/dispatchGuard.ts";
import { JobRepository } from "./jobs/repository.ts";
import type { DispatchHandler, ResourceAuthority, ResourceGrant } from "./jobs/dispatchSchema.ts";

const databases: ReturnType<typeof approvalFixture>["db"][] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const requester = { principalRef: "synthetic:requester" };

/** Actual J04, capability and job repositories; all source records and native effects are fictional. */
async function world(kind: "stage" | "pause", approvedAccount = "synthetic:advertiser-a", mappedAccount = approvedAccount) {
  const f = approvalFixture(); databases.push(f.db);
  const d = f.draft;
  d.actionKind = kind === "stage" ? "media.stageRelease" : "media.pause";
  d.phase = kind === "stage" ? "mediaStageRelease" : "mediaSafetyPause";
  d.providerAccountRef = kind === "stage" ? "synthetic:internal-stage-governance" : approvedAccount;
  d.acquisitionTerms = null; d.effects = { spendsMoney: false, sendsCreator: false, changesPolicy: false };
  d.items[0]!.units = 0; d.items[0]!.spendMinor = 0; d.bounds.maxItems = 1; d.bounds.maxUnits = 0;
  const na = { state: "notApplicable" as const, policyVersion: f.policy.version, reason: "This exact synthetic status or local governance operation has no acquisition effect." };
  for (const name of ["acceptedTerms", "sampleAuthority", "providerTerms", "launchReadiness"] as const) d.gates[name] = na;
  if (kind === "stage") {
    d.mediaAuthorization = { kind: "stageCap", accountKind: "internalGovernance", poolRef: "synthetic:one-stage-pool", poolVersion: "synthetic:pool-v1", allocationHash: digest({ meta: 75000, tiktok: 75000 }), capMinor: 150000, currency: "USD" };
    d.exposure = { state: "known", minor: 150000, currency: "USD" }; d.bounds.maxSpendMinor = 150000;
    d.gates.launchReadiness = { state: "satisfied", sourceRef: "synthetic:five-growth-gates", sourceVersion: "v1", validUntil: f.until() };
  } else { d.exposure = { state: "known", minor: 0, currency: "USD" }; d.bounds.maxSpendMinor = 0; }
  f.command.actionKind = d.actionKind;
  const receipts = new Map<string, VerificationReceipt>(), grants = new Map<string, ResourceGrant>();
  const ledger = new CapabilityLedger(f.db, scope, { now: () => f.state.now, resolveReceipt: ref => receipts.get(ref) ?? null });
  const binding: ExpectedBinding = { ...scope, provider: "synthetic-media", providerAccountId: mappedAccount, action: d.actionKind,
    mode: "executeApproved", route: "api", routeRef: "route:synthetic-exact-media", authorizationScopeVersion: "v1", toolVersion: "v1", requiredScopes: ["synthetic:media-status"], connectionRef: null, secretRef: null };
  if (kind === "pause") {
    ledger.register({ binding, ownerRef: "owner:synthetic-provider", costBasis: { state: "unknown", reasonCode: "SYNTHETIC_COST_UNKNOWN" } }, 0);
    const verification: VerificationReceipt = { receiptRef: "receipt:synthetic-verified-media-route", binding, outcome: "Ready", checkedAt: f.at(), expiresAt: f.until(), verifiedScopes: binding.requiredScopes,
      connectionHealth: "Authenticated", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(), reasonCodes: [] };
    receipts.set(verification.receiptRef, verification); await ledger.verify(capabilityIdForBinding(binding), verification.receiptRef, 1);
  }
  let effects = 0, status: "ACTIVE" | "PAUSED" = "ACTIVE", afterGrant: (() => void) | null = null;
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: kind === "stage" ? "localArtifact" : "providerApplied", policyVersion: f.policy.version,
    provider: kind === "stage" ? na : { state: "required", binding },
    resources: () => ({ budget: na, stock: na, quota: kind === "stage" ? na : { state: "required", resourceRef: "synthetic:shared-media-quota", quantity: 1, unit: "request", currency: null } }),
    budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async c => { c.assertCurrent(); effects++; if (kind === "pause") status = "PAUSED";
      return { state: "applied", receipt: { receiptRef: "synthetic:media-effect", dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash,
        handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, sourceEffect: kind === "stage" ? "localArtifact" : "providerApplied", observedAt: f.at() } }; },
    reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_NOT_REQUESTED" }) };
  const resources: ResourceAuthority = { resolveGrants: async request => {
    const grant: ResourceGrant = { grantRef: `synthetic:quota:${digest(request.dispatchKey)}`, issuerRef: "synthetic:quota-owner", allocationVersion: "v1", scope,
      dispatchKey: request.dispatchKey, dimension: "quota", resourceRef: "synthetic:shared-media-quota", quantity: 1, unit: "request", currency: null, exclusive: true,
      observedAt: f.at(), validUntil: f.until(), quotaBasis: { publishedLimit: 100, operatingLimit: 80, allocatedTotal: 1, windowRef: "synthetic:shared-window", windowStart: f.at(), windowEnd: f.until(), sharedAcrossRoutes: true } };
    grants.set(grant.grantRef, structuredClone(grant)); afterGrant?.(); return [grant];
  }, assertCurrent: values => { for (const grant of values) if (digest(grants.get(grant.grantRef)) !== digest(grant)) throw new Error("Synthetic grant changed"); } };
  const jobs = new JobRepository(f.db, { scope, now: () => f.state.now });
  const handlerRef = kind === "stage" ? "synthetic-stage.v1" : "synthetic-pause.v1";
  const guard = new DispatchGuard({ db: f.db, jobs, scope, approvals: f.repo, ledger, resourceAuthority: resources, handlers: new Map([[handlerRef, handler]]), now: () => f.state.now });
  const routes = new Map([[d.providerAccountRef, handlerRef]]);
  const service = createActionService({ scope, secret: "synthetic-review-service-secret-not-a-credential", approvals: f.repo, dispatch: guard,
    registry: new Map([[d.actionKind, { handlerRefsByAccount: routes }]]), authorize: f.sources.resolveActor, assertAuthority: f.sources.assertCurrent, now: () => f.state.now });
  async function approve() {
    const requested = await f.requested(), event = f.event(requested, "approved", "synthetic:founder");
    return f.repo.observeDecision(event.locator, { ingressRef: "synthetic:verified-founder-relay" });
  }
  async function enqueue() {
    const a = await approve();
    return service.execute({ schemaVersion: SCHEMA_VERSION, requestId: "synthetic-review-request", requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: "sandbox" },
      entityRefs: [], operation: "dispatchApprovedAction", actionKind: "dispatchApprovedAction", approvalRef: a.manifest.approvalRef, manifestRef: service.manifestRef(a),
      runRef: null, expectedVersion: service.approvalVersion(a), idempotencyKey: "synthetic-exact-handoff", payload: {} }, requester);
  }
  return { ...f, handler, guard, approve, enqueue, routes, ledger, binding, effects: () => effects, status: () => status, setAfterGrant: (hook: () => void) => { afterGrant = hook; } };
}

describe("independent shared media approval and routing review", () => {
  it("records one actual local stage effect while retaining the full $1500 exposure and no spend allocation", async () => {
    const w = await world("stage"), queued = await w.enqueue(), run = await w.guard.execute(queued.runRef!);
    expect(run.executionCertainty).toBe("applied"); expect(run.receipt?.sourceEffect).toBe("localArtifact"); expect(w.effects()).toBe(1);
    const approved = w.repo.readApproval(queued.approvalRef!)!;
    expect(approved.decisionReceipt?.bounds.maxSpendMinor).toBe(150000); expect(approved.manifest.items[0]?.spendMinor).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) n FROM job_dispatch_grants").get()?.n).toBe(0);
  });
  it("blocks changed stage allocation material after the genuine founder approval", async () => {
    const w = await world("stage"), queued = await w.enqueue(); w.draft.mediaAuthorization!.allocationHash = digest("synthetic-changed-allocation");
    await expect(w.guard.execute(queued.runRef!)).rejects.toThrow(); expect(w.effects()).toBe(0);
  });
  it.each(["synthetic:advertiser-a", "synthetic:advertiser-b"])("executes only a zero-exposure paused status through the approved account %s", async account => {
    const w = await world("pause", account), queued = await w.enqueue(); w.routes.set(account, "synthetic:unregistered-mutation");
    const run = await w.guard.execute(queued.runRef!);
    expect(run.intent.approval.providerAccountRef).toBe(account); expect(run.receipt?.sourceEffect).toBe("providerApplied"); expect(w.status()).toBe("PAUSED");
    expect(w.effects()).toBe(1); expect(w.db.prepare("SELECT COUNT(*) n FROM job_dispatch_grants WHERE json_extract(body,'$.dimension')='budget'").get()?.n).toBe(0);
  });
  it("rejects a mapped handler whose native account differs from the actual approved account", async () => {
    const w = await world("pause", "synthetic:advertiser-a", "synthetic:advertiser-b");
    await expect(w.enqueue()).rejects.toMatchObject({ code: "DISPATCH_PROVIDER_BINDING_MISMATCH" });
    expect(w.effects()).toBe(0); expect(w.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
  });
  it("rechecks genuine founder authority after quota await before a pause effect", async () => {
    const w = await world("pause"), queued = await w.enqueue();
    w.setAfterGrant(() => { w.humans.get("synthetic:founder")!.active = false; });
    await expect(w.guard.execute(queued.runRef!)).rejects.toThrow(); expect(w.effects()).toBe(0); expect(w.status()).toBe("ACTIVE");
  });
  it("does not let a local stage or a pause switch its effect class after handoff", async () => {
    const stage = await world("stage"), queuedStage = await stage.enqueue(); stage.handler.sourceEffect = "providerApplied";
    await expect(stage.guard.execute(queuedStage.runRef!)).rejects.toThrow("MEDIA_STAGE_LOCAL_HANDLER_REQUIRED"); expect(stage.effects()).toBe(0);
    const pause = await world("pause"), queuedPause = await pause.enqueue(); pause.handler.sourceEffect = "localArtifact";
    await expect(pause.guard.execute(queuedPause.runRef!)).rejects.toThrow("MEDIA_SAFETY_NATIVE_HANDLER_REQUIRED"); expect(pause.effects()).toBe(0);
  });
});
