import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { copyRegisteredAction, registeredHandler, type RegisteredAction } from "../actions/registration.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import type { ActionDomain } from "../actionDomains.ts";
import { approvalDraftSchema, approvalScopeSchema, principalSchema, type ApprovalDraft, type ApprovalManifest, type ApprovalPrincipal, type ApprovalScope } from "../approvals/contract.ts";
import { BulkError, bulkReadFiltersSchema, bulkRequestSchema, bulkSnapshotSchema, type BulkGroup, type BulkReadFilters, type BulkRequest, type BulkSnapshot, type BulkSource, type BulkSourceInput } from "./contract.ts";
import { bulkDraftMaterial, bulkEntityRef, createBulkAliases, validateBulkMaterial } from "./material.ts";
import { projectBulkSnapshot, readBulkEvidence, type BulkCanonicalRecords } from "./projection.ts";

export type BulkServiceOptions = { scope: ApprovalScope; source?: BulkSource; owners: ReadonlyMap<string, ActionDomain>;
  records: BulkCanonicalRecords; referenceKey: string; now?: () => number; timeoutMs?: number };
type Retained = { snapshot: BulkSnapshot; group: BulkGroup; owner: ActionDomain; assertCurrent(): void };
const MAX_AGE = 300_000;
function fail(code: string, status = 409): never { throw new BulkError(code, status); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }

/** J13 composes exact existing J04/domain/runner contracts. It never dispatches or allocates resources itself. */
export function createBulkService(options: BulkServiceOptions) {
  const scope = approvalScopeSchema.parse(options.scope), alias = createBulkAliases(scope, options.referenceKey), now = options.now ?? Date.now;
  const timeoutMs = Math.min(30_000, Math.max(1, options.timeoutMs ?? 10_000)), owners = new Map(options.owners);
  const actions = new Map<string, RegisteredAction>();
  const handlers = new Map<string, DispatchHandler>();
  for (const [kind, owner] of owners) {
    if (!kind.startsWith("bulk.") || !owner.registry.assertCurrentDraft || !owner.actions.has(kind)) fail("BULK_OWNER_INVALID", 500);
    const registration = copyRegisteredAction(owner.actions.get(kind)!); actions.set(kind, registration);
    for (const [ref, handler] of owner.handlers) {
      if (handlers.has(ref) && handlers.get(ref) !== handler) fail("BULK_HANDLER_COLLISION", 500);
      if (handler.idempotency !== "source-enforced") fail("BULK_OWNER_INVALID", 500);
      handlers.set(ref, handler);
    }
  }
  const retained = new Map<string, Retained>();
  const key = (d: ApprovalDraft, principal: string) => digest([principal, bulkDraftMaterial(d)]);
  async function load(request: BulkRequest, principal: ApprovalPrincipal) {
    if (!options.source || typeof options.source.assertCurrent !== "function") return fail("BULK_SOURCE_UNCONFIGURED", 503);
    const input: BulkSourceInput = { scope, principalRef: principalSchema.parse(principal).principalRef, request: bulkRequestSchema.parse(request) };
    const raw = await boundedSourceRead(() => options.source!.read(structuredClone(input)), undefined, timeoutMs);
    const parsed = bulkSnapshotSchema.safeParse(raw); if (!parsed.success) return fail("BULK_SOURCE_INVALID", 502);
    const snapshot = freeze(structuredClone(parsed.data)), hash = validateBulkMaterial(snapshot);
    // Expiry holds new actions, not a currently authorized read of historical receipts.
    const deadlines = [Date.parse(snapshot.validUntil), ...(request.kind === "batch" ? [] : [Date.parse(snapshot.expiresAt)]), Date.parse(snapshot.observedAt) + MAX_AGE,
      ...snapshot.capacity.map(c => Date.parse(c.validUntil)), ...(snapshot.sampleAllocation ? [Date.parse(snapshot.sampleAllocation.validUntil)] : [])];
    const validUntil = new Date(Math.min(...deadlines)).toISOString();
    const assertCurrent = () => {
      const time = now();
      if (digest(snapshot.scope) !== digest(scope) || snapshot.principalRef !== input.principalRef || digest(snapshot.request) !== digest(input.request)) fail("BULK_SCOPE_DENIED", 403);
      if (snapshot.permission === "denied") fail("SOURCE_SCOPE_DENIED", 403);
      if (snapshot.permission !== "permitted") fail("BULK_PERMISSION_UNVERIFIED", 503);
      if (!Number.isFinite(time) || Date.parse(snapshot.observedAt) > time || Date.parse(validUntil) <= time || Date.parse(snapshot.validUntil) <= Date.parse(snapshot.observedAt) ||
        snapshot.capacity.some(c => Date.parse(c.observedAt) > Date.parse(snapshot.observedAt)) || snapshot.sampleAllocation && Date.parse(snapshot.sampleAllocation.observedAt) > Date.parse(snapshot.observedAt)) fail("BULK_SOURCE_STALE");
      if (request.kind === "batch" && (snapshot.batchRef !== request.batchRef || snapshot.batchVersion !== request.batchVersion) ||
        request.kind === "manifest" && (snapshot.sourceRef !== request.sourceRef || hash !== request.basisHash) ||
        request.kind === "preview" && (hash !== request.entityVersion || !snapshot.groups.some(g => bulkEntityRef(snapshot, g, alias) === request.entityRef))) fail("BULK_REQUEST_CHANGED");
      assertSynchronousVoid(() => options.records.assertRegistration(structuredClone(snapshot.registration)));
      assertSynchronousVoid(() => options.source!.assertCurrent(structuredClone(snapshot), structuredClone(input), time));
    };
    assertCurrent(); return { snapshot, hash, validUntil, assertCurrent };
  }
  function ownerFor(group: BulkGroup) {
    const owner = owners.get(group.actionKind), action = actions.get(group.actionKind); if (!owner || !action) return fail("BULK_OWNER_UNCONFIGURED", 503);
    const handler = handlers.get(registeredHandler(action, group.providerAccountRef)); if (!handler) return fail("BULK_OWNER_UNCONFIGURED", 503);
    return { owner, handler };
  }
  function validate(raw: unknown, value: Retained): ApprovalDraft {
    const d = approvalDraftSchema.parse(raw), expected = value.group.draft;
    if (!expected || digest(bulkDraftMaterial(d)) !== digest(bulkDraftMaterial(expected)) || Date.parse(d.sourceValidUntil) > Date.parse(value.snapshot.validUntil) ||
      Date.parse(d.sourceValidUntil) <= now() || Date.parse(d.expiresAt) <= now()) return fail("BULK_OWNER_DRAFT_CHANGED");
    const { handler } = ownerFor(value.group);
    if (value.snapshot.provenance.synthetic ? handler.sourceEffect !== "localArtifact" : handler.sourceEffect !== "providerApplied") return fail("BULK_SOURCE_EFFECT_UNQUALIFIED");
    value.assertCurrent(); return d;
  }
  function keep(value: Retained, d: ApprovalDraft, principal: string) {
    for (const [k, entry] of retained) if (Date.parse(entry.snapshot.validUntil) <= now()) retained.delete(k);
    if (retained.size >= 500) retained.delete(retained.keys().next().value!);
    const published = structuredClone(d); retained.set(key(published, principal), value); return published;
  }
  const domain: ActionDomain = { actions, handlers, registry: {
    async resolvePreview(command, principal, requestedScope) {
      if (digest(requestedScope) !== digest(scope)) return fail("BULK_SCOPE_DENIED", 403);
      const loaded = await load({ kind: "preview", entityRef: command.entityRef, entityVersion: command.entityVersion }, principal);
      const group = loaded.snapshot.groups.find(g => bulkEntityRef(loaded.snapshot, g, alias) === command.entityRef);
      if (!group?.draft || group.actionKind !== command.actionKind || digest([...command.selectionRefs].sort()) !== digest(group.draft.items.map(i => i.itemRef).sort())) return fail("BULK_SELECTION_CHANGED");
      const { owner } = ownerFor(group), value: Retained = { ...loaded, group, owner };
      const raw = await boundedSourceRead(() => owner.registry.resolvePreview({ ...command, entityRef: group.ownerEntityRef, entityVersion: group.ownerEntityVersion,
        selectionRefs: group.draft!.items.map(i => i.itemRef) }, principal, scope), undefined, timeoutMs);
      return keep(value, validate(raw, value), principal.principalRef);
    },
    async currentDraft(manifest: ApprovalManifest) {
      const loaded = await load({ kind: "manifest", sourceRef: manifest.draft.sourceBasisRef, basisHash: manifest.draft.sourceBasisVersion }, { principalRef: manifest.proposer.principalRef });
      const group = loaded.snapshot.groups.find(g => g.draft && digest(bulkDraftMaterial(g.draft)) === digest(bulkDraftMaterial(manifest.draft)));
      if (!group) return fail("BULK_MANIFEST_CHANGED");
      const { owner } = ownerFor(group), value: Retained = { ...loaded, group, owner };
      const raw = await boundedSourceRead(() => owner.registry.currentDraft(manifest), undefined, timeoutMs);
      return keep(value, validate(raw, value), manifest.proposer.principalRef);
    },
    assertCurrentDraft(manifest, observed, timestamp) {
      const value = retained.get(key(observed, manifest.proposer.principalRef)); if (!value?.group.draft) return fail("BULK_CURRENT_SOURCE_UNVERIFIED");
      const expected = value.group.draft;
      if (digest(bulkDraftMaterial(expected)) !== digest(bulkDraftMaterial(observed))) return fail("BULK_MANIFEST_CHANGED");
      const prior = options.records.findGroupManifest(observed.sourceBasisRef, observed.sourceBasisVersion, observed.actionKind, observed.payloadRef);
      if (prior && (prior.approvalRef !== manifest.approvalRef || prior.manifestVersion !== manifest.manifestVersion || prior.manifestHash !== manifest.manifestHash)) return fail("BULK_GROUP_ALREADY_PROPOSED");
      validate(value.group.draft, value);
      assertSynchronousVoid(() => value.owner.registry.assertCurrentDraft!(manifest, structuredClone(value.group.draft!), timestamp));
      value.assertCurrent();
    },
  } };
  async function read(filters: BulkReadFilters, principal: ApprovalPrincipal) {
    const loaded = await load({ kind: "batch", ...bulkReadFiltersSchema.parse(filters) }, principal);
    const evidence = readBulkEvidence(loaded.snapshot, options.records);
    const time = now(), actionDeadlines = [Date.parse(loaded.snapshot.expiresAt), ...loaded.snapshot.groups.flatMap(g => g.draft ? [Date.parse(g.draft.expiresAt)] : [])];
    // A displayed preview must disappear at its exact expiry; a later fresh read
    // can still publish the same immutable outcomes under its current read lease.
    const validUntil = new Date(Math.min(Date.parse(loaded.validUntil), ...actionDeadlines.filter(deadline => deadline > time))).toISOString();
    const data = projectBulkSnapshot(loaded.snapshot, evidence, alias, validUntil, time);
    const assertCurrent = () => {
      if (now() >= Date.parse(validUntil)) fail("BULK_SOURCE_STALE");
      evidence.assertCurrent(); loaded.assertCurrent();
      if (now() >= Date.parse(validUntil)) fail("BULK_SOURCE_STALE");
    };
    assertCurrent(); return { data, assertCurrent };
  }
  return { domain, read, alias };
}
