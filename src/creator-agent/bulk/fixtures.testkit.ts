import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { ApprovalRepository, approvalDispatchBinding } from "../approvals/repository.ts";
import type { ApprovalDraft, ApprovalManifest, ProposeCommand, VerifiedApprovalProof } from "../approvals/contract.ts";
import { JobRepository } from "../jobs/repository.ts";
import { DispatchGuard } from "../jobs/dispatchGuard.ts";
import { DispatchError, type DispatchContext, type DispatchHandler, type DispatchReadback, type DispatchReceipt, type ResourceAuthority, type ResourceGrant } from "../jobs/dispatchSchema.ts";
import { createActionService } from "../actions/service.ts";
import { actionTestSecret as referenceKey } from "../actions/fixtures.testkit.ts";
import type { ActionDomain } from "../actionDomains.ts";
import { digest } from "../config.ts";
import { BulkError, type BulkSnapshot, type BulkSource, type BulkGroup } from "./contract.ts";
import { bulkDraftMaterial, bulkMaterialHash, createBulkAliases } from "./material.ts";
import { createBulkService } from "./service.ts";
import type { BulkCanonicalRecords } from "./projection.ts";

/** Fictional source owners and source-enforced local artifacts, real J04/ActionService/SQLite jobs.
 * This is not provider qualification. The optional registration assertion lets the HTTP fixture
 * bind the same packet to the real compiled JobRuntime registration owned by server composition. */
export function bulkFixture(options: { path?: string; timestamp?: number; assertRegistration?: BulkCanonicalRecords["assertRegistration"] } = {}) {
  const a = approvalFixture(options.path), principal = { principalRef: "synthetic:requester" }, alias = createBulkAliases(scope, referenceKey);
  if (options.timestamp !== undefined) {
    a.state.now = options.timestamp; a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
    a.draft.sourceValidUntil = a.until(); a.draft.expiresAt = new Date(a.state.now + 120_000).toISOString();
    for (const human of a.humans.values()) { human.observedAt = a.at(); human.validUntil = a.until(); }
    for (const gate of Object.values(a.draft.gates)) if (gate?.state === "satisfied") gate.validUntil = a.until();
  }
  const visible = (value: string) => ({ state: "visible" as const, value, reasonCode: null });
  const rows: BulkSnapshot["rows"] = Array.from({ length: 24 }, (_, i) => ({ rowId: `fictional-row-${String(i + 1).padStart(2, "0")}`,
    recipientRef: `fictional-private-recipient-${i + 1}`, recipient: visible(`Fictional recipient ${i + 1}`), product: visible("Fictional product"),
    sampleDisposition: i < 12 ? "newSample" : "noNewSample", productRefs: ["fictional-private-product"], productVersions: ["product-v1"], evidenceModelVersions: [a.draft.configVersion],
    termsVersions: ["terms-v1"], payloadHashes: [digest(`fictional-invitation-${i + 1}`), digest(`fictional-sample-${i + 1}`)], blockers: [] }));
  function group(kind: "invitation" | "sampleDecision", count: number): BulkGroup {
    const selected = rows.slice(0, count), sample = kind === "sampleDecision";
    const draft: ApprovalDraft = { ...structuredClone(a.draft), actionKind: sample ? "bulk.sample" : "bulk.invitation", phase: sample ? "other" : "invitation",
      payloadRef: `fictional-private-bulk-${kind}`, payloadHash: digest(selected.map(r => r.payloadHashes[sample ? 1 : 0])),
      effects: { spendsMoney: sample, sendsCreator: !sample, changesPolicy: false },
      items: selected.map((row, index) => ({ ...structuredClone(a.draft.items[0]!), itemRef: alias("item", `fictional-${kind}-item-${index + 1}`), targetRef: row.recipientRef,
        payloadHash: row.payloadHashes[sample ? 1 : 0]!, units: sample ? 1 : 0, spendMinor: sample ? 2500 : 0 })),
      bounds: { maxItems: count, maxUnits: sample ? count : 0, maxSpendMinor: sample ? count * 2500 : 0, currency: "USD" },
      exposure: { state: "known", minor: sample ? count * 2500 : 0, currency: "USD" }, sourceBasisRef: "fictional-private-bulk-source", sourceBasisVersion: "0".repeat(64) };
    if (sample) { draft.gates.sampleAuthority = structuredClone(draft.gates.sourcePermission); draft.acquisitionTerms = null; }
    return { groupRef: `fictional-${kind}-group`, kind, actionKind: draft.actionKind, providerAccountRef: draft.providerAccountRef,
      ownerEntityRef: `fictional-owner-${kind}`, ownerEntityVersion: "owner-v1", members: selected.map((r, i) => ({ rowId: r.rowId, itemRef: draft.items[i]!.itemRef })), draft, approval: null, runRefs: [] };
  }
  const packet: BulkSnapshot = { schemaVersion: "farda.bulk-input.v1", registration: { jobId: "J13", version: 1, registrationRef: "fictional-j13-registration", registrationVersion: "v1", inputSchema: "farda.bulk-input.v1", outputSchema: "farda.bulk-output.v1" },
    scope, principalRef: principal.principalRef, permissionVersion: "fictional-permission-v1", permission: "permitted", request: { kind: "batch", batchRef: "fictional-batch", batchVersion: "v1" },
    provenance: { evidenceStage: "synthetic", synthetic: true }, batchRef: "fictional-batch", batchVersion: "v1", sourceRef: "fictional-private-bulk-source", sourceVersion: "fictional-source-v1",
    observedAt: a.at(), validUntil: a.until(), expiresAt: a.draft.expiresAt, rows, groups: [group("invitation", 24), group("sampleDecision", 12)],
    capacity: ["bulk.invitation", "bulk.sample"].map(action => ({ provider: "fictional-provider", providerAccountRef: a.draft.providerAccountRef, action, unit: "request", kind: action === "bulk.invitation" ? "invitationQuota" as const : "actionQuota" as const,
      remaining: 80, resetAt: a.until(), observedAt: a.at(), validUntil: a.until(), sourceRef: "fictional-private-quota", sourceVersion: "quota-v1", reasonCode: null })),
    sampleAllocation: { sourceRef: "fictional-private-sample-allocation", sourceVersion: "allocation-v1", observedAt: a.at(), validUntil: a.until(), approvedUnits: 12, approvedMinor: 30000, currency: "USD" }, commissionForecastMinor: 75000 };
  const state = { denied: false, registrationAllowed: true, ownerDenied: false, beforeOwner: null as null | (() => Promise<void>), beforeFinal: null as null | (() => void),
    beforeEffect: null as null | (() => void), beforeRead: null as null | (() => Promise<void>), uncertain: new Set<string>(), calls: [] as DispatchContext[], proofs: [] as VerifiedApprovalProof[],
    receipts: new Map<string, DispatchReceipt>(), permissions: "fictional-permission-v1" };
  function seal() { const hash = bulkMaterialHash(packet); for (const g of packet.groups) if (g.draft) g.draft.sourceBasisVersion = hash; return hash; }
  seal();
  const source: BulkSource = { async read(input) { await state.beforeRead?.(); return { ...structuredClone(packet), principalRef: input.principalRef, request: input.request,
    permissionVersion: state.permissions, permission: state.denied ? "denied" : "permitted" }; },
    assertCurrent(snapshot, input, time) {
      if (state.denied || !a.humans.get(input.principalRef)?.active) throw new BulkError("SOURCE_SCOPE_DENIED", 403);
      if (snapshot.permissionVersion !== state.permissions || bulkMaterialHash(snapshot) !== bulkMaterialHash(packet) || Date.parse(packet.validUntil) <= time) throw new BulkError("BULK_SOURCE_CHANGED");
    } };
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Fictional local artifact has no resource effect in this dimension." };
  const owners = new Map<string, ActionDomain>();
  const handlers = new Map<string, DispatchHandler>();
  function actualGroup(action: string) { const value = packet.groups.find(g => g.actionKind === action); if (!value?.draft) throw new BulkError("BULK_OWNER_NOT_FOUND"); return value; }
  for (const g of packet.groups) {
    const handlerRef = `${g.actionKind}.v1`;
    const handler: DispatchHandler = { policyVersion: a.policy.version, idempotency: "source-enforced", sourceEffect: "localArtifact", provider: na,
      resources(intent) {
        const sample = intent.approval.actionKind === "bulk.sample";
        return { budget: sample ? { state: "required", resourceRef: "fictional-sample-budget", quantity: 2500, unit: "minor", currency: "USD" } : na,
          stock: sample ? { state: "required", resourceRef: "fictional-sample-stock", quantity: 1, unit: "unit", currency: null } : na,
          quota: { state: "required", resourceRef: "fictional-shared-quota", quantity: 1, unit: "request", currency: null } };
      }, budgets: { maxItems: 100, maxSteps: 1000, maxAttempts: 2, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 2, retryBaseMs: 0 },
      async execute(c) {
        state.beforeEffect?.(); c.assertCurrent(); state.calls.push(c); state.proofs.push(structuredClone(c.approvalProof()));
        if (state.uncertain.has(c.approvalProof().item.targetRef)) return { state: "unknown", reasonCode: "FICTIONAL_ACK_LOST" };
        const old = state.receipts.get(c.dispatchKey); if (old) return { state: "applied", receipt: old };
        const receipt: DispatchReceipt = { receiptRef: `fictional-receipt-${digest(c.dispatchKey)}`, dispatchKey: c.dispatchKey, payloadHash: c.intent.approval.payloadHash,
          handlerRef: c.intent.handlerRef, providerBindingHash: c.providerBindingHash, sourceEffect: "localArtifact", observedAt: a.at() };
        state.receipts.set(c.dispatchKey, receipt); return { state: "applied", receipt };
      },
      async reconcile(c): Promise<DispatchReadback> { const receipt = state.receipts.get(c.dispatchKey); return receipt ? { state: "applied", receipt } : { state: "unknown", reasonCode: "FICTIONAL_ORIGINAL_UNRESOLVED" }; },
    };
    handlers.set(handlerRef, handler);
    const owner: ActionDomain = { actions: new Map([[g.actionKind, { handlerRef }]]), handlers: new Map([[handlerRef, handler]]), registry: {
      async resolvePreview(command) { await state.beforeOwner?.(); const current = actualGroup(command.actionKind);
        if (command.entityRef !== current.ownerEntityRef || command.entityVersion !== current.ownerEntityVersion || digest([...command.selectionRefs].sort()) !== digest(current.draft!.items.map(i => i.itemRef).sort())) throw new BulkError("FICTIONAL_OWNER_SELECTION_CHANGED");
        return structuredClone(current.draft); },
      async currentDraft(manifest) { await state.beforeOwner?.(); return structuredClone(actualGroup(manifest.draft.actionKind).draft); },
      assertCurrentDraft(manifest, observed) { state.beforeFinal?.(); const expected = actualGroup(observed.actionKind).draft!;
        const original = { ...manifest.draft, items: manifest.draft.items.map(item => ({ ...item,
          itemRef: expected.items.find(candidate => candidate.targetRef === item.targetRef)?.itemRef ?? "unknown" })) };
        if (state.ownerDenied || digest(bulkDraftMaterial(observed)) !== digest(bulkDraftMaterial(expected)) ||
          digest(bulkDraftMaterial(original)) !== digest(bulkDraftMaterial(expected))) throw new BulkError("FICTIONAL_OWNER_CHANGED"); },
    } };
    owners.set(g.actionKind, owner);
  }
  a.db.exec("CREATE TABLE IF NOT EXISTS fictional_bulk_grants(dispatch_key TEXT,dimension TEXT,quantity INTEGER,PRIMARY KEY(dispatch_key,dimension))");
  const resources: ResourceAuthority = { async resolveGrants(request) {
    const grants: ResourceGrant[] = [];
    for (const dimension of ["budget", "stock", "quota"] as const) {
      const need = request.requirements[dimension]; if (need.state !== "required") continue;
      const old = a.db.prepare("SELECT quantity FROM fictional_bulk_grants WHERE dispatch_key=? AND dimension=?").get(request.dispatchKey, dimension);
      const total = Number(a.db.prepare("SELECT COALESCE(SUM(quantity),0) AS n FROM fictional_bulk_grants WHERE dimension=?").get(dimension)?.n);
      const limit = dimension === "budget" ? 30000 : dimension === "stock" ? 12 : 80;
      if (!old && total + need.quantity > limit) throw new DispatchError("FICTIONAL_RESOURCE_EXHAUSTED");
      a.db.prepare("INSERT OR IGNORE INTO fictional_bulk_grants VALUES(?,?,?)").run(request.dispatchKey, dimension, need.quantity);
      grants.push({ grantRef: `fictional-grant-${digest([request.dispatchKey, dimension])}`, issuerRef: "fictional-source-owner", allocationVersion: "v1", scope,
        dispatchKey: request.dispatchKey, dimension, resourceRef: need.resourceRef, quantity: need.quantity, unit: need.unit, currency: need.currency,
        observedAt: a.at(), validUntil: a.until(), exclusive: true,
        ...(dimension === "quota" ? { quotaBasis: { publishedLimit: 100, operatingLimit: 80, allocatedTotal: total + (old ? 0 : need.quantity), windowRef: "fictional-quota-window", windowStart: packet.observedAt, windowEnd: packet.validUntil, sharedAcrossRoutes: true as const } } : {}) });
    }
    return grants;
  }, assertCurrent(grants) { if (state.denied) throw new DispatchError("SOURCE_SCOPE_DENIED", 403); for (const grant of grants) if (a.db.prepare("SELECT quantity FROM fictional_bulk_grants WHERE dispatch_key=? AND dimension=?").get(grant.dispatchKey, grant.dimension)?.quantity !== grant.quantity) throw new DispatchError("FICTIONAL_GRANT_CHANGED"); } };
  const jobs = new JobRepository(a.db, { scope, now: () => a.state.now });
  let repo: ApprovalRepository; let dispatch: DispatchGuard;
  const records: BulkCanonicalRecords = {
    readApproval: (ref, version) => repo.readApproval(ref, version), readRun: ref => dispatch.read(ref, false), readRuns: (ref, version) => dispatch.readApprovalRuns(ref, version),
    findGroupManifest(sourceRef, basisHash, actionKind, payloadRef) {
      const all = a.db.prepare("SELECT body FROM approval_manifests").all().map(row => JSON.parse(String(row.body)) as ApprovalManifest)
        .filter(m => digest(m.scope) === digest(scope) && m.draft.sourceBasisRef === sourceRef && m.draft.sourceBasisVersion === basisHash && m.draft.actionKind === actionKind && m.draft.payloadRef === payloadRef);
      if (all.length > 1) throw new BulkError("BULK_DUPLICATE_GROUP_MANIFEST"); return all[0] ?? null;
    },
    assertRegistration(registration) { if (!state.registrationAllowed || digest(registration) !== digest(packet.registration)) throw new BulkError("BULK_REGISTRATION_CHANGED"); options.assertRegistration?.(registration); },
  };
  const build = () => createBulkService({ scope, source, owners, records, referenceKey, now: () => a.state.now });
  let bulk = build();
  repo = new ApprovalRepository(a.db, { ...a.options, registry: bulk.domain.registry, verifyOutcome: input => dispatch.verifyOutcome(input) });
  dispatch = new DispatchGuard({ db: a.db, scope, jobs, approvals: repo, handlers: bulk.domain.handlers, resourceAuthority: resources, now: () => a.state.now });
  function actionService() { return createActionService({ scope, secret: referenceKey, approvals: repo, dispatch, registry: bulk.domain.actions,
    authorize: a.sources.resolveActor, assertAuthority: a.sources.assertCurrent, now: () => a.state.now }); }
  const filters = { batchRef: packet.batchRef, batchVersion: packet.batchVersion };
  async function command(index = 0): Promise<ProposeCommand> { const view = (await bulk.read(filters, principal)).data, group = view.groups[index]!;
    return { actionKind: group.actionKind, ...group.preview!, expectedVersion: 0 }; }
  async function approve(index = 0, idempotencyKey = `fictional-preview-${index}`) {
    const preview = await repo.preparePreview(await command(index), principal, idempotencyKey);
    const requested = await repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: preview.manifest.manifestVersion }, principal, `request-${idempotencyKey}`);
    const event = a.event(requested, "approved", "synthetic:founder", `event-${idempotencyKey}`);
    return repo.observeDecision(event.locator, { ingressRef: "synthetic:verified-ingress" });
  }
  const intentsFor = (manifest: ApprovalManifest) => manifest.items.map(item => ({ approval: approvalDispatchBinding(manifest, item.itemRef),
    handlerRef: `${manifest.draft.actionKind}.v1`, payloadRef: manifest.draft.payloadRef }));
  async function queue(index = 0) { const approved = await approve(index); return dispatch.handoffBatch(intentsFor(approved.manifest), { principalRef: principal.principalRef, idempotencyKey: `fictional-handoff-${index}` }); }
  function restart() { bulk = build(); repo = new ApprovalRepository(a.db, { ...a.options, registry: bulk.domain.registry, verifyOutcome: input => dispatch.verifyOutcome(input) });
    dispatch = new DispatchGuard({ db: a.db, scope, jobs, approvals: repo, handlers: bulk.domain.handlers, resourceAuthority: resources, now: () => a.state.now }); return { bulk, repo, dispatch, service: actionService() }; }
  return { a, packet, state, scope, principal, filters, source, owners, handlers, records, resources, referenceKey, alias, seal, jobs,
    get bulk() { return bulk; }, get repo() { return repo; }, get dispatch() { return dispatch; }, get service() { return actionService(); }, command, approve, queue, intentsFor, restart };
}
