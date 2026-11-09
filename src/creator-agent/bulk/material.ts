import { createHmac } from "node:crypto";
import { digest } from "../config.ts";
import { stableApprovalDraft } from "../approvals/repository.ts";
import type { ApprovalDraft, ApprovalScope } from "../approvals/contract.ts";
import { BulkError, type BulkGroup, type BulkSnapshot } from "./contract.ts";

export function createBulkAliases(scope: ApprovalScope, referenceKey: string) {
  if (referenceKey.length < 32) throw new Error("Bulk references require a private key.");
  return (kind: string, value: string) => kind + "-" + createHmac("sha256", referenceKey).update(JSON.stringify([scope, kind, value])).digest("hex");
}
export type BulkAlias = ReturnType<typeof createBulkAliases>;
export const bulkEntityRef = (s: BulkSnapshot, g: BulkGroup, alias: BulkAlias) => alias("bulk-group", JSON.stringify([s.batchRef, g.groupRef]));
/** Commercial middleware owns these two proof fields. All source terms, canonical item
 * identities and the aggregate terms-version hash remain untouched. */
export function bulkDraftMaterial(d: ApprovalDraft) {
  return stableApprovalDraft(d.commercialOffers ? { ...d, commercialOffers: d.commercialOffers.map(({ itemRef, offerRef }) => ({ itemRef, offerRef })) } : d);
}
/** The owner writes this hash into each canonical draft's sourceBasisVersion. It binds held rows too.
 * Only renewable leases, authorization/read context and existing canonical outcome links are excluded. */
export function bulkMaterialHash(s: BulkSnapshot): string {
  return digest({ registration: s.registration, scope: s.scope, provenance: s.provenance, batchRef: s.batchRef,
    batchVersion: s.batchVersion, sourceRef: s.sourceRef, sourceVersion: s.sourceVersion, expiresAt: s.expiresAt, rows: s.rows,
    groups: s.groups.map(({ approval: _a, runRefs: _r, draft, ...group }) => {
      void _a; void _r;
      if (!draft) return { ...group, draft: null };
      const material: Record<string, unknown> = { ...bulkDraftMaterial(draft) }; delete material.sourceBasisVersion;
      return { ...group, draft: material };
    }),
    capacity: s.capacity.map(({ observedAt: _o, validUntil: _v, ...c }) => { void _o; void _v; return c; }),
    sampleAllocation: s.sampleAllocation ? { sourceRef: s.sampleAllocation.sourceRef, sourceVersion: s.sampleAllocation.sourceVersion,
      approvedUnits: s.sampleAllocation.approvedUnits, approvedMinor: s.sampleAllocation.approvedMinor, currency: s.sampleAllocation.currency } : null,
    commissionForecastMinor: s.commissionForecastMinor });
}
const priority = ["SOURCE_SCOPE_DENIED", "SUPPRESSED", "DUPLICATE_RECIPIENT", "POLICY_HELD", "OFFER_EXPIRED", "CAPACITY_UNKNOWN", "CAPACITY_EXHAUSTED"];
export function orderBulkBlockers(values: readonly string[]) {
  const rank = (v: string) => { const i = priority.indexOf(v); return i < 0 ? priority.length : i; };
  return [...new Set(values)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
export function bulkRowBlockers(s: BulkSnapshot, rowId: string, groupRef?: string): string[] {
  const row = s.rows.find(r => r.rowId === rowId); if (!row) throw new BulkError("BULK_ROW_NOT_FOUND", 422);
  const first = s.rows.filter(r => r.recipientRef === row.recipientRef).map(r => r.rowId).sort()[0];
  const capacityReasons: string[] = [];
  for (const group of s.groups.filter(g => (groupRef === undefined || g.groupRef === groupRef) && g.members.some(m => m.rowId === rowId))) {
    const required = [group.kind === "invitation" ? "invitationQuota" : "actionQuota", ...(group.kind === "activation" ? ["activeCollaborations"] : [])];
    for (const kind of required) {
      const counters = s.capacity.filter(c => c.providerAccountRef === group.providerAccountRef && c.action === group.actionKind && c.kind === kind);
      if (counters.length !== 1 || counters[0]!.remaining === null) capacityReasons.push("CAPACITY_UNKNOWN");
      else {
        if (counters[0]!.reasonCode) capacityReasons.push(counters[0]!.reasonCode!);
        const eligible = group.members.filter(m => {
          const candidate = s.rows.find(r => r.rowId === m.rowId)!;
          return !candidate.blockers.some(b => b.groupRef === null || b.groupRef === group.groupRef) && candidate.sampleDisposition !== "unknown" &&
            s.rows.filter(r => r.recipientRef === candidate.recipientRef).map(r => r.rowId).sort()[0] === m.rowId;
        }).length;
        if (counters[0]!.remaining! < eligible) capacityReasons.push("CAPACITY_EXHAUSTED");
      }
    }
  }
  return orderBulkBlockers([...row.blockers.filter(b => groupRef === undefined || b.groupRef === null || b.groupRef === groupRef).map(b => b.code),
    ...capacityReasons, ...(first !== rowId ? ["DUPLICATE_RECIPIENT"] : []), ...(row.sampleDisposition === "unknown" ? ["SAMPLE_REQUIREMENT_UNKNOWN"] : [])]);
}
export function validateBulkMaterial(s: BulkSnapshot) {
  const hash = bulkMaterialHash(s);
  const allItems = new Set<string>(); let sampleUnits = 0n, sampleMinor = 0n;
  for (const g of s.groups) {
    const selected = g.members.filter(m => bulkRowBlockers(s, m.rowId, g.groupRef).length === 0);
    if (!g.draft) { if (selected.length) throw new BulkError("BULK_ELIGIBLE_DRAFT_MISSING", 502); continue; }
    const d = g.draft;
    if (d.actionKind !== g.actionKind || d.providerAccountRef !== g.providerAccountRef || d.sourceBasisRef !== s.sourceRef ||
      d.sourceBasisVersion !== hash || Date.parse(d.expiresAt) > Date.parse(s.expiresAt) || d.historicalLiability !== null ||
      digest(d.items.map(i => i.itemRef).sort()) !== digest(selected.map(m => m.itemRef).sort())) throw new BulkError("BULK_MANIFEST_BINDING_INVALID", 502);
    if ((g.kind === "invitation" && (d.phase !== "invitation" || !d.effects.sendsCreator)) ||
      (g.kind === "activation" && d.phase !== "activation") ||
      (g.kind === "sampleDecision" && (!["other", "shipment"].includes(d.phase) || d.effects.sendsCreator || d.effects.changesPolicy)) ||
      (g.kind !== "sampleDecision" && (d.items.some(i => i.units !== 0 || i.spendMinor !== 0) || d.bounds.maxUnits !== 0 || d.bounds.maxSpendMinor !== 0 || d.effects.spendsMoney)))
      throw new BulkError("BULK_EFFECT_SEPARATION_REQUIRED", 502);
    if (d.acquisitionTerms && (d.acquisitionTerms.relationship !== "commissionOnly" || d.acquisitionTerms.upfrontFeeMinor !== 0 ||
      d.acquisitionTerms.guaranteedFeeMinor !== 0 || d.acquisitionTerms.paidComponentMinor !== 0)) throw new BulkError("BULK_COMMISSION_ONLY_REQUIRED", 422);
    if (g.kind !== "sampleDecision" && !d.acquisitionTerms) throw new BulkError("BULK_COMMISSION_ONLY_REQUIRED", 422);
    for (const item of d.items) {
      const member = selected.find(m => m.itemRef === item.itemRef)!, row = s.rows.find(r => r.rowId === member.rowId)!;
      if (!/^item-[a-f0-9]{64}$/.test(item.itemRef) || allItems.has(item.itemRef) || item.targetRef !== row.recipientRef || !row.payloadHashes.includes(item.payloadHash) ||
        !row.evidenceModelVersions.includes(d.configVersion) || d.productVersion.state !== "required" || !row.productVersions.includes(d.productVersion.version) ||
        d.termsVersion.state !== "required" || !row.termsVersions.includes(d.termsVersion.version))
        throw new BulkError("BULK_ROW_BINDING_INVALID", 502);
      allItems.add(item.itemRef);
      if (g.kind === "sampleDecision") { if (item.units < 1) throw new BulkError("BULK_SAMPLE_UNITS_REQUIRED", 422); sampleUnits += BigInt(item.units); sampleMinor += BigInt(item.spendMinor); }
    }
    if (d.bounds.maxItems !== selected.length || BigInt(d.bounds.maxUnits) !== d.items.reduce((n, i) => n + BigInt(i.units), 0n) ||
      BigInt(d.bounds.maxSpendMinor) !== d.items.reduce((n, i) => n + BigInt(i.spendMinor), 0n)) throw new BulkError("BULK_EXACT_BOUNDS_REQUIRED", 502);
  }
  if (s.sampleAllocation ? sampleUnits !== BigInt(s.sampleAllocation.approvedUnits) || sampleMinor !== BigInt(s.sampleAllocation.approvedMinor) : sampleUnits !== 0n || sampleMinor !== 0n)
    throw new BulkError("BULK_SAMPLE_ALLOCATION_MISMATCH", 502);
  return hash;
}
