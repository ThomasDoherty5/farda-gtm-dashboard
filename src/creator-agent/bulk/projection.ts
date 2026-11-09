import { digest } from "../config.ts";
import type { ApprovalManifest, ApprovalRead } from "../approvals/contract.ts";
import type { DispatchRead } from "../jobs/dispatchSchema.ts";
import { BulkError, type BulkSnapshot, type BulkGroup } from "./contract.ts";
import { bulkDraftMaterial, bulkEntityRef, bulkMaterialHash, bulkRowBlockers, orderBulkBlockers, type BulkAlias } from "./material.ts";
import { nativeBulkViewSchema, type BulkReadData, type BulkSampleCommitments } from "./views.ts";

export type BulkCanonicalRecords = {
  readApproval(ref: string, version: number): ApprovalRead | null;
  readRun(ref: string): DispatchRead;
  readRuns(approvalRef: string, manifestVersion: number): { runs: DispatchRead[]; total: number };
  findGroupManifest(sourceRef: string, basisHash: string, actionKind: string, payloadRef: string): ApprovalManifest | null;
  /** Verifies a real current existing JobRuntime registration, including its exact J13 schema/version. */
  assertRegistration(registration: BulkSnapshot["registration"]): void;
};
export type BulkEvidence = { groups: Map<string, { approval: ApprovalRead | null; runs: DispatchRead[] }>; assertCurrent(): void };
export function readBulkEvidence(s: BulkSnapshot, records: BulkCanonicalRecords): BulkEvidence {
  const retained: { group: BulkGroup; approval: ApprovalRead | null; runs: DispatchRead[] }[] = [];
  for (const group of s.groups) {
    const existing = group.draft ? records.findGroupManifest(s.sourceRef, bulkMaterialHash(s), group.actionKind, group.draft.payloadRef) : null;
    const locator = group.approval ?? (existing ? { approvalRef: existing.approvalRef, manifestVersion: existing.manifestVersion, manifestHash: existing.manifestHash } : null);
    const approval = locator ? records.readApproval(locator.approvalRef, locator.manifestVersion) : null;
    if (locator && (!approval || !group.draft || approval.manifest.manifestHash !== locator.manifestHash ||
      digest(approval.manifest.scope) !== digest(s.scope) ||
      digest(bulkDraftMaterial(approval.manifest.draft)) !== digest(bulkDraftMaterial(group.draft))))
      throw new BulkError("BULK_APPROVAL_BINDING_CHANGED");
    if (!approval && group.runRefs.length) throw new BulkError("BULK_RUN_WITHOUT_APPROVAL");
    const execution = approval ? records.readRuns(approval.manifest.approvalRef, approval.manifest.manifestVersion) : { runs: [], total: 0 };
    if (execution.total !== execution.runs.length || execution.total > 100 || group.runRefs.some(ref => !execution.runs.some(r => r.runRef === ref))) throw new BulkError("BULK_RUN_COVERAGE_INCOMPLETE");
    const runs = execution.runs, items = new Set<string>();
    for (const run of runs) {
      if (!approval || run.items.some(item => {
        const proof = item.intent.approval, original = approval.manifest.items.find(i => i.itemRef === proof.itemRef);
        return !original || proof.approvalRef !== approval.manifest.approvalRef || proof.manifestVersion !== approval.manifest.manifestVersion ||
          proof.manifestHash !== approval.manifest.manifestHash || proof.itemHash !== original.itemHash || proof.actionKind !== group.actionKind ||
          proof.providerAccountRef !== group.providerAccountRef || proof.payloadHash !== original.payloadHash || item.intent.payloadRef !== group.draft?.payloadRef ||
          (item.receipt !== null && (item.receipt.dispatchKey !== item.dispatchKey || item.receipt.payloadHash !== original.payloadHash));
      })) throw new BulkError("BULK_RUN_BINDING_CHANGED");
      for (const item of run.items) {
        if (items.has(item.intent.approval.itemRef)) throw new BulkError("BULK_DUPLICATE_CANONICAL_ITEM");
        items.add(item.intent.approval.itemRef);
      }
    }
    retained.push({ group, approval, runs });
  }
  const assertCurrent = () => {
    for (const { group, approval, runs } of retained) {
      const existing = group.draft ? records.findGroupManifest(s.sourceRef, bulkMaterialHash(s), group.actionKind, group.draft.payloadRef) : null;
      if (digest(existing) !== digest(approval?.manifest ?? null) || approval && (digest(records.readApproval(approval.manifest.approvalRef, approval.manifest.manifestVersion)) !== digest(approval) ||
        digest(records.readRuns(approval.manifest.approvalRef, approval.manifest.manifestVersion)) !== digest({ runs, total: runs.length })) ||
        runs.some(run => digest(records.readRun(run.runRef)) !== digest(run))) throw new BulkError("BULK_CANONICAL_RECORD_CHANGED");
    }
  };
  assertCurrent();
  return { groups: new Map(retained.map(r => [r.group.groupRef, { approval: r.approval, runs: r.runs }])), assertCurrent };
}
export function projectBulkSampleCommitments(s: BulkSnapshot, evidence: BulkEvidence, alias: BulkAlias): BulkSampleCommitments | null {
  if (!s.sampleAllocation) return null;
  const groups = s.groups.filter(g => g.kind === "sampleDecision" && g.draft), refs: string[] = [alias("bulk-allocation", s.sampleAllocation.sourceRef)];
  let units = 0n, minor = 0n, consumedUnits = 0n, consumedMinor = 0n, uncertain = false;
  for (const group of groups) {
    const facts = evidence.groups.get(group.groupRef), decision = facts?.approval?.decisionReceipt;
    if (!facts?.approval || decision?.decision !== "approved" || decision.manifestHash !== facts.approval.manifest.manifestHash) return null;
    refs.push(alias("decision", decision.receiptRef));
    for (const item of group.draft!.items) { units += BigInt(item.units); minor += BigInt(item.spendMinor); }
    for (const run of facts.runs) for (const item of run.items) {
      const original = group.draft!.items.find(i => i.itemRef === item.intent.approval.itemRef)!;
      const job = run.run.items.find(i => i.itemKey === item.dispatchKey);
      if (item.receipt) {
        if (!s.provenance.synthetic && item.receipt.sourceEffect !== "providerApplied") return null;
        refs.push(alias("receipt", item.receipt.receiptRef));
        if (item.receipt.providerOutcome?.state !== "rejected") { consumedUnits += BigInt(original.units); consumedMinor += BigInt(original.spendMinor); }
      } else if (!job || ["leased", "reconcile"].includes(job.state)) uncertain = true;
    }
  }
  if (units !== BigInt(s.sampleAllocation.approvedUnits) || minor !== BigInt(s.sampleAllocation.approvedMinor) || consumedUnits > units || consumedMinor > minor)
    throw new BulkError("BULK_SAMPLE_PROOF_MISMATCH");
  return { approvedUnits: Number(units), approvedMinor: Number(minor), remainingUnits: uncertain ? null : Number(units - consumedUnits),
    remainingMinor: uncertain ? null : Number(minor - consumedMinor), currency: "USD", evidenceRefs: refs,
    reasonCodes: uncertain ? ["ORIGINAL_SAMPLE_OUTCOME_UNCERTAIN"] : [], confersAuthority: false };
}
/** Projection consumes verified canonical records. Counts partition recipients once; action receipts remain separate. */
export function projectBulkSnapshot(s: BulkSnapshot, evidence: BulkEvidence, alias: BulkAlias, validUntil: string, now: number): BulkReadData {
  const expired = (group: BulkGroup) => Date.parse(s.expiresAt) <= now || Boolean(group.draft && Date.parse(group.draft.expiresAt) <= now);
  const rows: BulkReadData["rows"] = s.rows.map(row => { const allBlockers = bulkRowBlockers(s, row.rowId); return { rowId: alias("bulk-row", row.rowId),
    recipientRef: alias("creator", row.recipientRef), recipient: row.recipient, product: row.product, sampleDisposition: row.sampleDisposition, state: "ready",
    productRefs: row.productRefs.map(ref => alias("product", ref)), evidenceModelVersions: row.evidenceModelVersions.map(ref => alias("evidence-model", ref)),
    productVersions: row.productVersions.map(ref => alias("product-version", ref)),
    termsVersions: row.termsVersions.map(ref => alias("terms", ref)), allBlockers, primarySummaryReason: allBlockers[0] ?? null }; });
  const counts = { snapshot: rows.length, confirmed: 0, failed: 0, blocked: 0, deferred: 0, uncertain: 0, canceled: 0, ready: 0 };
  const receipts: BulkReadData["rowReceipts"] = [], recovery: BulkReadData["recoveryQueue"] = [];
  for (const row of s.rows) {
    const states: string[] = [], blockers = bulkRowBlockers(s, row.rowId);
    const safeReason = (code: string | null) => code && /^[A-Z][A-Z0-9_]{0,99}$/.test(code) ? code : "EXECUTION_HELD";
    for (const group of s.groups.filter(g => g.members.some(m => m.rowId === row.rowId))) {
      const member = group.members.find(m => m.rowId === row.rowId)!;
      const sourceHeld = bulkRowBlockers(s, row.rowId, group.groupRef).length > 0 || expired(group);
      if (expired(group)) blockers.push("BULK_APPROVAL_EXPIRED");
      const facts = evidence.groups.get(group.groupRef)!, outcomes = facts.runs.flatMap(run => run.items.filter(i => i.intent.approval.itemRef === member.itemRef).map(item => ({ run, item })));
      const approvalHeld = facts.approval?.current.state === "held";
      if (approvalHeld) blockers.push(...facts.approval!.current.reasonCodes.map(safeReason));
      if (!outcomes.length) { states.push(sourceHeld || approvalHeld ? "blocked" : "ready"); continue; }
      for (const { run, item } of outcomes) {
        const job = run.run.items.find(i => i.itemKey === item.dispatchKey);
        const state = item.receipt ? item.receipt.providerOutcome?.state === "rejected" ? "failed" : "confirmed" :
          !job || job.state === "reconcile" || job.state === "leased" ? "uncertain" : job.state === "cancelled" ? "canceled" :
          job.state === "failed" ? "failed" : job.state === "held" || sourceHeld || approvalHeld ? "blocked" : job.state === "retryWait" ? "deferred" : "ready";
        if (state === "blocked" && job?.state === "held") blockers.push(safeReason(job.reasonCode));
        states.push(state);
        if (item.receipt) receipts.push({ rowId: alias("bulk-row", row.rowId), groupRef: alias("bulk-group", group.groupRef), receiptRef: alias("receipt", item.receipt.receiptRef), sourceEffect: item.receipt.sourceEffect });
        if (["uncertain", "deferred", "failed", "blocked"].includes(state)) recovery.push({ rowId: alias("bulk-row", row.rowId), groupRef: alias("bulk-group", group.groupRef), runRef: run.runRef,
          nextAction: state === "uncertain" ? "reconcileOriginal" : state === "deferred" ? "waitForSourceReset" : state === "failed" ? "inspectFailure" : "refreshSource", owner: "sourceOwner" });
      }
    }
    const state = ["uncertain", "failed", "blocked", "deferred", "canceled", "ready"].find(value => states.includes(value)) ?? (states.length ? "confirmed" : "blocked");
    counts[state as Exclude<keyof typeof counts, "snapshot">]++;
    const output = rows.find(r => r.rowId === alias("bulk-row", row.rowId))!;
    if (!states.length) blockers.push("NO_INCLUDED_ACTION");
    if (state === "blocked" && !blockers.length) blockers.push("EXECUTION_HELD");
    output.state = state as BulkReadData["rows"][number]["state"];
    output.allBlockers = orderBulkBlockers(blockers); output.primarySummaryReason = state === "blocked" ? output.allBlockers[0]! : null;
  }
  const primary = new Map<string, number>(); for (const row of rows) if (row.primarySummaryReason) primary.set(row.primarySummaryReason, (primary.get(row.primarySummaryReason) ?? 0) + 1);
  return nativeBulkViewSchema.parse({ kind: "native-bulk", schemaVersion: "farda.bulk-output.v1", registration: { ...s.registration,
    registrationRef: alias("bulk-registration", s.registration.registrationRef), registrationVersion: alias("bulk-registration-version", s.registration.registrationVersion) },
    filters: { batchRef: s.batchRef, batchVersion: s.batchVersion }, provenance: s.provenance, actorRef: alias("principal", s.principalRef),
    sourceVersion: alias("bulk-source", s.sourceVersion), observedAt: s.observedAt, validUntil, rows,
    primaryCounts: [...primary].map(([reason, count]) => ({ reason, count })),
    groups: s.groups.map(group => { const facts = evidence.groups.get(group.groupRef)!, manifest = facts.approval?.manifest; return ({ groupRef: alias("bulk-group", group.groupRef), kind: group.kind, actionKind: group.actionKind,
      preview: group.draft && !expired(group) ? { entityRef: bulkEntityRef(s, group, alias), entityVersion: bulkMaterialHash(s), selectionRefs: group.draft.items.map(i => i.itemRef) } : null,
      approval: manifest ? { approvalRef: manifest.approvalRef, manifestVersion: manifest.manifestVersion, manifestHash: manifest.manifestHash } : null,
      runRefs: facts.runs.map(r => r.runRef), reasonCodes: expired(group) ? ["BULK_APPROVAL_EXPIRED"] : group.draft ? [] : ["BULK_NO_ELIGIBLE_ROWS"] }); }),
    aggregateCounts: counts, rowReceipts: receipts, recoveryQueue: recovery, sampleCommitments: projectBulkSampleCommitments(s, evidence, alias),
    capacity: s.capacity.map(c => ({ ...c, providerAccountRef: alias("account", c.providerAccountRef), sourceRef: alias("bulk-capacity", c.sourceRef), sourceVersion: alias("bulk-capacity-version", c.sourceVersion) })),
    commissionForecastMinor: s.commissionForecastMinor, forecastIsEarnedCap: false, sourceEffect: "none", confersAuthority: false });
}
