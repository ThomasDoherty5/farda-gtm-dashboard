import { createHash } from "node:crypto";
import type { ActionDomain } from "../actionDomains.ts";
import { approvalDraftSchema, type ApprovalDraft } from "../approvals/contract.ts";
import { ledgerPageSchema, ledgerSnapshotSchema, type LedgerSource, type LedgerSnapshot } from "../actions/contract.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { SettlementError, type SettlementRecord } from "./contract.ts";
import type { SettlementBindings, SettlementSnapshot, SettlementPrincipal } from "./source.ts";
import type { SettlementReader } from "./reader.ts";

export const SETTLEMENT_MATCH_ACTION = "settlement.matchStatement";
export const SETTLEMENT_MATCH_HANDLER = "settlement-match-statement.v1";
/** The owning J11 registry freezes this same material. It is reconciliation, never a new payment. */
export function settlementMatchDigest(record: SettlementRecord, candidateRefs: readonly string[]) {
  const selected = record.candidates.filter(c => candidateRefs.includes(c.ref)).sort((a,b) => a.ref.localeCompare(b.ref));
  return createHash("sha256").update(JSON.stringify([record.ref, record.version, record.provider, record.accountRef, record.currency, selected])).digest("hex");
}
function validateDraft(raw: unknown): ApprovalDraft {
  const d = approvalDraftSchema.parse(raw);
  if (d.actionKind !== SETTLEMENT_MATCH_ACTION || d.phase !== "other" || Object.values(d.effects).some(Boolean) || d.historicalLiability || d.acquisitionTerms ||
    d.bounds.maxSpendMinor !== 0 || d.bounds.maxUnits !== 0 || d.exposure.state !== "known" || d.exposure.minor !== 0 || d.items.some(i => i.spendMinor !== 0 || i.units !== 0))
    throw new SettlementError("SETTLEMENT_MATCH_AUTHORITY_INVALID");
  return d;
}
/** Reuses J04 and the injected J11 owner; an absent qualified owner leaves matching held.
 * Owner drafts use the raw candidate as itemRef and targetRef. currentDraft/assertCurrentDraft
 * must accept the canonical stored manifest (whose itemRef is public) and use its raw target/source
 * facts. The observed draft passed to the owner fence has raw itemRefs again. The handler receives
 * the ORIGINAL canonical dispatch context/proof: execution uses proof.item.targetRef/sourceRef;
 * reconciliation uses payloadRef + dispatchKey. Never rewrite a signed binding or invent a ledger.
 */
export function createSettlementActionDomain(reader: SettlementReader, bindings: SettlementBindings): ActionDomain | undefined {
  const matching = bindings.matching;
  if (!matching) return undefined;
  if (matching.actionKind !== SETTLEMENT_MATCH_ACTION || !matching.registry.assertCurrentDraft || matching.handler.sourceEffect !== "providerApplied" || matching.handler.provider.state !== "required")
    throw new SettlementError("SETTLEMENT_MATCH_AUTHORITY_INVALID");
  const currentSources=new Map<string,{snapshot:SettlementSnapshot;principal:SettlementPrincipal}>();
  const key=(draft:ApprovalDraft,principalRef:string)=>JSON.stringify([draft.payloadHash,draft.sourceBasisRef,draft.sourceBasisVersion,principalRef]);
  function publicDraft(draft:ApprovalDraft):ApprovalDraft {
    if(draft.items.some(item=>item.itemRef!==item.targetRef))throw new SettlementError("SETTLEMENT_MATCH_ITEM_IDENTITY_INVALID");
    return {...draft,items:draft.items.map(item=>({...item,itemRef:reader.alias("candidate",item.targetRef)}))};
  }
  function ownerDraft(raw:ApprovalDraft):ApprovalDraft {
    const draft=validateDraft(raw);
    if(draft.items.some(item=>item.itemRef!==reader.alias("candidate",item.targetRef)))throw new SettlementError("SETTLEMENT_MATCH_ITEM_IDENTITY_INVALID");
    return {...draft,items:draft.items.map(item=>({...item,itemRef:item.targetRef}))};
  }
  function verifySource(draft:ApprovalDraft,snapshot:SettlementSnapshot,record:SettlementRecord,selected:readonly string[],actor:SettlementPrincipal){
    if(!reader.isCurrent(snapshot) || draft.sourceBasisRef!==record.ref || draft.sourceBasisVersion!==record.version || draft.payloadHash!==settlementMatchDigest(record,selected) ||
      draft.providerAccountRef!==record.accountRef || Date.parse(draft.sourceValidUntil)>Date.parse(snapshot.validUntil) || draft.items.length!==selected.length ||
      new Set(draft.items.map(i=>i.targetRef)).size!==selected.length || draft.items.some(i=>!selected.includes(i.targetRef)) || selected.some(id=>!record.candidates.some(c=>c.ref===id&&!c.problem)))throw new SettlementError("SETTLEMENT_MATCH_SOURCE_CHANGED");
    reader.assert(snapshot,actor);currentSources.set(key(draft,actor.principalRef),{snapshot,principal:actor});return draft;
  }
  return {
    actions: new Map([[SETTLEMENT_MATCH_ACTION, { handlerRef: SETTLEMENT_MATCH_HANDLER }]]),
    handlers: new Map([[SETTLEMENT_MATCH_HANDLER, matching.handler]]),
    registry: {
      async resolvePreview(command, principal, scope) {
        if (command.actionKind !== SETTLEMENT_MATCH_ACTION) throw new SettlementError("SETTLEMENT_MATCH_AUTHORITY_INVALID");
        const actor = { ...principal, role: "reviewer" as const };
        const { snapshot } = await reader.load("settlementDetail", { settlementId: command.entityRef }, actor, {cursor:null,limit:1});
        const record = snapshot?.records[0];
        if (!snapshot || !record || !reader.isCurrent(snapshot) || command.entityVersion !== reader.alias("version",record.version))
          throw new SettlementError("SETTLEMENT_MATCH_SOURCE_CHANGED");
        const selected = record.candidates.filter(c=>command.selectionRefs.includes(reader.alias("candidate",c.ref)));
        if (!selected.length || selected.length!==command.selectionRefs.length || new Set(command.selectionRefs).size!==command.selectionRefs.length || selected.some(c=>c.problem))
          throw new SettlementError("SETTLEMENT_MATCH_SELECTION_INVALID",422);
        const raw = {...command,entityRef:record.ref,entityVersion:record.version,selectionRefs:selected.map(c=>c.ref)};
        const draft=validateDraft(await matching.registry.resolvePreview(raw,principal,scope));
        return publicDraft(verifySource(draft,snapshot,record,raw.selectionRefs,actor));
      },
      async currentDraft(manifest) {
        const actor={principalRef:manifest.proposer.principalRef,role:"reviewer" as const};
        const {snapshot}=await reader.load("settlementDetail",{settlementId:reader.reference("settlement",manifest.draft.sourceBasisRef)},actor,{cursor:null,limit:1});
        if(!snapshot?.records[0])throw new SettlementError("SETTLEMENT_MATCH_SOURCE_CHANGED");
        const draft=validateDraft(await matching.registry.currentDraft(manifest));
        return publicDraft(verifySource(draft,snapshot,snapshot.records[0],manifest.items.map(i=>i.targetRef),actor));
      },
      assertCurrentDraft(manifest,observed,now) { const raw=ownerDraft(observed);assertSynchronousVoid(()=>matching.registry.assertCurrentDraft!(manifest,raw,now));
        const retained=currentSources.get(key(observed,manifest.proposer.principalRef));if(!retained)throw new SettlementError("SETTLEMENT_MATCH_SOURCE_CHANGED");if(!reader.isCurrent(retained.snapshot))throw new SettlementError("SETTLEMENT_MATCH_SOURCE_CHANGED");reader.assert(retained.snapshot,retained.principal); },
    },
  };
}

/** The existing export service consumes opaque version bindings consistently; actual source snapshots stay server-only. */
export function settlementLedgerSource(reader: SettlementReader, bindings: SettlementBindings): LedgerSource | undefined {
  const source=bindings.ledger;if(!source)return undefined;
  const originals=new Map<string,LedgerSnapshot>();
  const key=(s:LedgerSnapshot)=>JSON.stringify([s.scope,s.snapshotRef,s.version,s.filters]);
  const project=(s:LedgerSnapshot)=>({...s,version:reader.alias("export-version",s.version)});
  function retain(raw:unknown){const s=ledgerSnapshotSchema.parse(raw),p=project(s);originals.set(key(p),s);return p;}
  function original(s:LedgerSnapshot){const raw=originals.get(key(s));if(!raw)throw new SettlementError("SETTLEMENT_EXPORT_BASIS_UNVERIFIED");return raw;}
  return {
    async open(scope,principal,filters){return retain(await source.open(scope,principal,filters));},
    async page(snapshot,cursor){const raw=original(snapshot);const page=ledgerPageSchema.parse(await source.page(raw,cursor));
      if(page.version!==raw.version || page.snapshotRef!==raw.snapshotRef)throw new SettlementError("SETTLEMENT_EXPORT_BASIS_UNVERIFIED");
      return {...page,version:snapshot.version,rows:page.rows.map(r=>({...r,ledgerRevision:reader.alias("export-version",r.ledgerRevision)}))};},
    async current(snapshot,principal){
      let raw=originals.get(key(snapshot));
      if(!raw){const current=ledgerSnapshotSchema.parse(await source.open(snapshot.scope,principal,snapshot.filters));
        if(project(current).version!==snapshot.version || current.snapshotRef!==snapshot.snapshotRef)throw new SettlementError("SETTLEMENT_EXPORT_BASIS_UNVERIFIED");raw=current;}
      const current=retain(await source.current(raw,principal));if(current.version!==snapshot.version || current.snapshotRef!==snapshot.snapshotRef)throw new SettlementError("SETTLEMENT_EXPORT_BASIS_UNVERIFIED");return current;
    },
    assertCurrent(snapshot,principal,now){assertSynchronousVoid(()=>source.assertCurrent(original(snapshot),principal,now));},
  };
}
