// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { bulkFixture } from "./fixtures.testkit.ts";
import { bulkSnapshotSchema } from "./contract.ts";
import { bulkMaterialHash, validateBulkMaterial } from "./material.ts";
import { createBulkService } from "./service.ts";
import { digest } from "../config.ts";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";

const worlds: ReturnType<typeof bulkFixture>[] = [];
function world() { const w = bulkFixture(); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.a.db.close(); });
function pruneInvitation(w: ReturnType<typeof bulkFixture>, excluded: string[]) {
  const group = w.packet.groups[0]!, draft = group.draft!;
  draft.items = draft.items.filter(i => !excluded.includes(i.targetRef)); draft.bounds.maxItems = draft.items.length;
  draft.payloadHash = digest(draft.items.map(i => i.payloadHash)); w.seal();
}

describe("J13 finite source composition with actual canonical approvals and jobs", () => {
  it("keeps24 recipients,12 separate approved25USD samples and12 no-new-sample rows through actual J04/run receipts", async () => {
    const w = world();
    const first = (await w.bulk.read(w.filters, w.principal)).data;
    expect(first.sampleCommitments).toBeNull(); expect(first.groups[0]?.preview?.selectionRefs).toHaveLength(24);
    expect(first.rows.filter(r => r.sampleDisposition === "noNewSample")).toHaveLength(12);
    const invitations = await w.queue(0), samples = await w.queue(1);
    const approved = (await w.bulk.read(w.filters, w.principal)).data;
    expect(approved.sampleCommitments).toMatchObject({ approvedUnits: 12, approvedMinor: 30000, remainingUnits: 12, remainingMinor: 30000, currency: "USD" });
    expect(approved.commissionForecastMinor).toBe(75000); expect(approved.forecastIsEarnedCap).toBe(false);
    await w.dispatch.execute(invitations.runRef);
    const partial = (await w.bulk.read(w.filters, w.principal)).data;
    expect(partial.aggregateCounts).toMatchObject({ snapshot: 24, confirmed: 12, ready: 12 });
    expect(partial.rows.filter(r => r.sampleDisposition === "newSample").every(r => r.state === "ready")).toBe(true);
    await w.dispatch.execute(samples.runRef);
    const final = (await w.bulk.read(w.filters, w.principal)).data;
    expect(final.aggregateCounts).toEqual({ snapshot: 24, confirmed: 24, ready: 0, blocked: 0, failed: 0, deferred: 0, uncertain: 0, canceled: 0 });
    expect(final.sampleCommitments).toMatchObject({ approvedUnits: 12, approvedMinor: 30000, remainingUnits: 0, remainingMinor: 0 });
    expect(final.rowReceipts).toHaveLength(36); expect(w.state.calls).toHaveLength(36);
    const receipts = w.dispatch.read(samples.runRef).items.map(i => i.receipt);
    w.restart(); await w.dispatch.execute(samples.runRef);
    expect(w.dispatch.read(samples.runRef).items.map(i => i.receipt)).toEqual(receipts); expect(w.state.calls).toHaveLength(36);
    expect(JSON.stringify(final)).not.toMatch(/fictional-private|synthetic:provider|fictional-owner-/);
    expect(final.provenance).toEqual({ evidenceStage: "synthetic", synthetic: true });
  });

  it("the actual ActionService preview uses exact public selectors and delegates an unchanged canonical proof", async () => {
    const w = world(), command = await w.command();
    const input = { schemaVersion: SCHEMA_VERSION, requestId: "fictional-preview-http", requestedScope: { workspaceId: w.scope.workspaceId, accountIds: [w.scope.accountId], environment: "sandbox" as const },
      entityRefs: [], approvalRef: null, manifestRef: null, runRef: null, idempotencyKey: "fictional-action-preview", expectedVersion: command.entityVersion,
      operation: "previewAction", actionKind: command.actionKind, payload: { entityRef: command.entityRef, entityVersion: command.entityVersion, selectionRefs: command.selectionRefs } };
    const response = await w.service.execute(input, w.principal), manifest = w.repo.readApproval(response.approvalRef!)!.manifest;
    expect(manifest.draft.items).toEqual(w.packet.groups[0]!.draft!.items);
    expect(manifest.draft.sourceBasisVersion).toBe(bulkMaterialHash(w.packet));
    expect(w.a.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(0);
    const requested = await w.repo.requestDecision({ approvalRef: manifest.approvalRef, expectedVersion: 1 }, w.principal, "fictional-request");
    const event = w.a.event(requested, "approved", "synthetic:founder"); await w.repo.observeDecision(event.locator, { ingressRef: "synthetic:ingress" });
    const run = await w.dispatch.handoffBatch(w.intentsFor(manifest), { principalRef: w.principal.principalRef, idempotencyKey: "fictional-native-handoff" });
    await w.dispatch.execute(run.runRef);
    const context = w.state.calls[0]!, original = manifest.items.find(i => i.itemRef === context.intent.approval.itemRef)!;
    expect(context.intent.approval.manifestHash).toBe(manifest.manifestHash); expect(context.intent.approval.itemHash).toBe(original.itemHash);
    expect(context.intent.payloadRef).toBe(manifest.draft.payloadRef);
    expect(w.state.proofs[0]!.item).toEqual(original);
  });

  it("retains every blocker, chooses one stable primary and does not hide secondary duplicate/suppression reasons", async () => {
    const w = world(), row = w.packet.rows[23]!;
    row.recipientRef = w.packet.rows[22]!.recipientRef;
    row.blockers = [{ code: "OFFER_EXPIRED", groupRef: null }, { code: "SUPPRESSED", groupRef: null }];
    const d = w.packet.groups[0]!.draft!; d.items = d.items.filter(i => i.itemRef !== w.packet.groups[0]!.members[23]!.itemRef); d.bounds.maxItems = 23; w.seal();
    const data = (await w.bulk.read(w.filters, w.principal)).data, blocked = data.rows.find(r => r.rowId === w.alias("bulk-row", row.rowId))!;
    expect(blocked.allBlockers).toEqual(["SUPPRESSED", "DUPLICATE_RECIPIENT", "OFFER_EXPIRED"]); expect(blocked.primarySummaryReason).toBe("SUPPRESSED");
    expect(data.primaryCounts).toEqual([{ reason: "SUPPRESSED", count: 1 }]); expect(data.aggregateCounts.blocked).toBe(1);
    expect(data.groups[0]!.preview!.selectionRefs).toHaveLength(23);
  });

  it("runtime holds contribute a primary reason and reconcile blocked summary counts", async () => {
    const w = world(), run = await w.queue(0), item = run.run.items[0]!;
    w.a.db.prepare("UPDATE job_items SET state='held',reason_code='SOURCE_THROTTLED' WHERE item_id=?").run(item.itemId);
    const data = (await w.bulk.read(w.filters, w.principal)).data;
    expect(data.primaryCounts).toContainEqual({ reason: "SOURCE_THROTTLED", count: 1 });
    expect(data.primaryCounts.reduce((n, r) => n + r.count, 0)).toBe(data.aggregateCounts.blocked);
  });

  it("retains the other action's receipt while an invitation row is source-held", async () => {
    const w = world(), row = w.packet.rows[0]!;
    row.blockers.push({ code: "INVITATION_SUPPRESSED", groupRef: w.packet.groups[0]!.groupRef }); pruneInvitation(w, [row.recipientRef]);
    const samples = await w.queue(1); await w.dispatch.execute(samples.runRef);
    const data = (await w.bulk.read(w.filters, w.principal)).data, id = w.alias("bulk-row", row.rowId);
    expect(data.rows.find(r => r.rowId === id)).toMatchObject({ state: "blocked", allBlockers: ["INVITATION_SUPPRESSED"] });
    expect(data.rowReceipts.filter(r => r.rowId === id)).toHaveLength(1);
    expect(data.primaryCounts.reduce((n, r) => n + r.count, 0)).toBe(data.aggregateCounts.blocked);
  });

  it("freezes held membership too and refuses a new-key duplicate proposal inside the existing J04 transaction", async () => {
    const w = world(), command = await w.command(), first = await w.repo.preparePreview(command, w.principal, "first");
    await expect(w.repo.preparePreview(command, w.principal, "second")).rejects.toThrow("BULK_GROUP_ALREADY_PROPOSED");
    expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);
    w.restart(); expect((await w.repo.preparePreview(command, w.principal, "first")).manifest).toEqual(first.manifest);
    w.packet.rows[23]!.blockers.push({ code: "SUPPRESSED", groupRef: null });
    await expect(w.bulk.domain.registry.currentDraft(first.manifest)).rejects.toThrow("BULK_MANIFEST_BINDING_INVALID");
    expect(w.repo.readCommand("propose", command, w.principal, "first")?.manifest).toEqual(first.manifest);
  });

  it("rejects all membership, version, economics and product-version mutations without rebasing the old proposal", async () => {
    const w = world(), original = structuredClone(w.packet), command = await w.command();
    for (const change of [() => { w.packet.rows[0]!.evidenceModelVersions.push("different-model"); }, () => { w.packet.rows[0]!.termsVersions.push("terms-v2"); },
      () => { w.packet.commissionForecastMinor = 1; }, () => { w.packet.rows[0]!.productRefs.push("other-product"); }]) {
      Object.assign(w.packet, structuredClone(original)); change();
      await expect(w.bulk.domain.registry.resolvePreview(command, w.principal, w.scope)).rejects.toThrow("BULK_MANIFEST_BINDING_INVALID");
    }
    Object.assign(w.packet, original); w.packet.rows[0]!.productVersions = ["wrong-version"]; w.seal();
    expect(() => validateBulkMaterial(w.packet)).toThrow("BULK_ROW_BINDING_INVALID");
  });

  it("denial during owner await and a final transactional revocation produce no manifest or effects", async () => {
    for (const final of [false, true]) {
      const w = world(), command = await w.command();
      if (final) w.state.beforeFinal = () => { w.state.denied = true; }; else w.state.beforeOwner = async () => { w.state.denied = true; };
      await expect(w.repo.preparePreview(command, w.principal, "revoked")).rejects.toThrow();
      expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0); expect(w.state.calls).toHaveLength(0);
    }
  });

  it("requires synchronous current source fences and a qualified registration", async () => {
    const w = world(); w.state.registrationAllowed = false;
    await expect(w.bulk.read(w.filters, w.principal)).rejects.toThrow("BULK_REGISTRATION_CHANGED");
    w.state.registrationAllowed = true;
    const unsafe = createBulkService({ scope: w.scope, source: { ...w.source, assertCurrent: async () => undefined }, owners: w.owners, records: w.records, referenceKey: w.referenceKey, now: () => w.a.state.now });
    await expect(unsafe.read(w.filters, w.principal)).rejects.toThrow();
  });

  it("rejects synthetic evidence at provider executors and unconfigured source ownership", async () => {
    const w = world(), command = await w.command(); w.handlers.get("bulk.invitation.v1")!.sourceEffect = "providerApplied";
    await expect(w.bulk.domain.registry.resolvePreview(command, w.principal, w.scope)).rejects.toThrow("BULK_SOURCE_EFFECT_UNQUALIFIED");
    const unavailable = createBulkService({ scope: w.scope, owners: w.owners, records: w.records, referenceKey: w.referenceKey });
    await expect(unavailable.read(w.filters, w.principal)).rejects.toMatchObject({ code: "BULK_SOURCE_UNCONFIGURED", status: 503 });
  });

  it("a current source-authorized viewer can read the same immutable approval without becoming its proposer", async () => {
    const w = world(), approved = await w.approve();
    w.a.humans.set("fictional-viewer", { ...w.a.humans.get(w.principal.principalRef)!, principalRef: "fictional-viewer", roles: ["viewer"] });
    const data = (await w.bulk.read(w.filters, { principalRef: "fictional-viewer" })).data;
    expect(data.groups[0]?.approval?.approvalRef).toBe(approved.manifest.approvalRef);
    await expect(w.repo.preparePreview(await w.command(), { principalRef: "fictional-viewer" }, "viewer-write")).rejects.toThrow("AUTHORITY_REQUIRED");
  });

  it("final publication rejects permission/version changes and a late canonical approval", async () => {
    const w = world(), read = await w.bulk.read(w.filters, w.principal);
    w.state.permissions = "v2"; expect(read.assertCurrent).toThrow("BULK_SOURCE_CHANGED"); w.state.permissions = "fictional-permission-v1";
    const before = await w.bulk.read(w.filters, w.principal); await w.repo.preparePreview(await w.command(), w.principal, "late-preview");
    expect(before.assertCurrent).toThrow("BULK_CANONICAL_RECORD_CHANGED");
    const after = await w.bulk.read(w.filters, w.principal); w.state.denied = true; expect(after.assertCurrent).toThrow("SOURCE_SCOPE_DENIED");
  });

  it("expires exactly at the earliest source/sample/capacity lease without publishing old data", async () => {
    const w = world(); w.packet.sampleAllocation!.validUntil = new Date(w.a.state.now + 10).toISOString();
    const read = await w.bulk.read(w.filters, w.principal); w.a.state.now += 10;
    expect(read.assertCurrent).toThrow("BULK_SOURCE_STALE");
    expect(read.data.validUntil).toBe(w.packet.sampleAllocation!.validUntil);
  });

  it("keeps original uncertain sample allocation unavailable and never replays it or counts a new key as recovery", async () => {
    const w = world(), run = await w.queue(1); w.state.uncertain.add(w.packet.rows[0]!.recipientRef);
    await w.dispatch.execute(run.runRef); const data = (await w.bulk.read(w.filters, w.principal)).data;
    expect(data.aggregateCounts.uncertain).toBe(1); expect(data.sampleCommitments).toMatchObject({ remainingUnits: null, remainingMinor: null, reasonCodes: ["ORIGINAL_SAMPLE_OUTCOME_UNCERTAIN"] });
    const calls = w.state.calls.length; w.restart(); await w.dispatch.execute(run.runRef); await w.dispatch.reconcile(run.runRef);
    expect(w.state.calls).toHaveLength(calls); expect(w.dispatch.read(run.runRef).executionCertainty).toBe("uncertain");
  });

  it("preserves pause/cancel decisions and drains only still-authorized unsent canonical rows", async () => {
    const w = world(), run = await w.queue();
    w.dispatch.control(run.runRef, run.revision, "pause"); await w.dispatch.execute(run.runRef); expect(w.state.calls).toHaveLength(0);
    w.dispatch.control(run.runRef, w.dispatch.read(run.runRef).revision, "cancel"); await w.dispatch.execute(run.runRef);
    expect(w.dispatch.read(run.runRef).run.counts.cancelled).toBe(24); expect(w.state.calls).toHaveLength(0);
  });

  it("requires exact explicit sample membership, positive units, USD and complete finite row membership", () => {
    const w = world();
    for (const mutate of [(s: typeof w.packet) => { s.rows[0]!.sampleDisposition = "noNewSample"; },
      (s: typeof w.packet) => { s.rows[23]!.sampleDisposition = "newSample"; },
      (s: typeof w.packet) => { s.groups[0]!.members.pop(); }]) {
      const s = structuredClone(w.packet); mutate(s); expect(bulkSnapshotSchema.safeParse(s).success).toBe(false);
    }
    const invalid = structuredClone(w.packet) as unknown as { sampleAllocation: { currency: string } }; invalid.sampleAllocation.currency = "EUR";
    expect(bulkSnapshotSchema.safeParse(invalid).success).toBe(false);
    w.packet.groups[1]!.draft!.items[0]!.units = 0; w.seal(); expect(() => validateBulkMaterial(w.packet)).toThrow("BULK_SAMPLE_UNITS_REQUIRED");
  });
});
