import { z } from "zod";
import { digest } from "./config.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import { approvalScopeSchema, approvalRefSchema as ref, approvalInstantSchema as instant, principalSchema,
  trustedHumanSchema, type ApprovalPrincipal, type ApprovalScope, type ApprovalSources, type TrustedHuman } from "./approvals/contract.ts";
import { approvalItemSchema } from "./approvals/contract.ts";
import { operationsControlSourceSchema, type OperationsControlSnapshot } from "./operationsControlsSchema.ts";

export const OPERATIONS_AUTHORITY_MAX_AGE_MS = 300_000;
const targetKind = z.enum(["task", "takeover", "repair", "permissionEvidence", "schedule"]);
export type OperationsTargetKind = z.infer<typeof targetKind>;
export const operationsAuthorityTargetSchema = z.object({
  kind: targetKind, id: ref, sourceVersion: ref, providerAccountRef: ref, providerAccountVersion: ref,
  ownerPersonRef: ref, permission: z.enum(["allowed", "denied", "unknown"]),
  items: z.array(approvalItemSchema.omit({payloadHash:true})).min(1).max(100),
}).strict().refine(value => new Set(value.items.map(item=>item.itemRef)).size === value.items.length && new Set(value.items.map(item=>item.targetRef)).size === value.items.length, "Finite item references and subjects must be unique.");
export type OperationsAuthorityTarget = z.infer<typeof operationsAuthorityTargetSchema>;
export const operationsServiceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("runtimeRegistration"), targetId: ref, jobId: ref, jobVersion: z.number().int().positive().safe(), registrationRef: ref, registrationVersion: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal("runtimeRun"), targetId: ref, runId: ref, registrationRef: ref, registrationVersion: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal("report"), targetId: ref, reportRef: ref }).strict(),
  z.object({ kind: z.enum(["repairReceipt", "permissionReceipt", "takeoverReceipt"]), targetId: ref, receiptRef: ref, sourceVersion: ref,
    state: z.enum(["requested", "assigned", "applied", "resolved", "uncertain", "rejected"]), observedAt: instant,
    sourceReadbackVersion: ref.nullable(), mirrorReadbackVersion: ref.nullable(), ownerPersonRef: ref }).strict(),
]);
export type OperationsServiceReference = z.infer<typeof operationsServiceReferenceSchema>;
export const operationsAuthoritySnapshotSchema = z.object({
  scope: approvalScopeSchema, principalRef: ref, personRef: ref, directoryVersion: ref,
  observedAt: instant, validUntil: instant, permission: z.enum(["allowed", "denied", "unknown"]),
  snapshot: operationsControlSourceSchema, targets: z.array(operationsAuthorityTargetSchema).max(200),
  serviceRefs: z.array(operationsServiceReferenceSchema).max(25),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.targets.map(row => row.kind + ":" + row.id)).size !== value.targets.length ||
      new Set(value.serviceRefs.map(row => row.kind + ":" + row.targetId)).size !== value.serviceRefs.length)
    ctx.addIssue({ code: "custom", message: "Current authority references must be unique." });
  for(const record of value.serviceRefs){
    if("observedAt"in record&&Date.parse(record.observedAt)>Date.parse(value.observedAt))ctx.addIssue({code:"custom",message:"Source receipts cannot be observed after the current envelope."});
    if(record.kind==="repairReceipt"){
      const conflict=value.snapshot.conflicts.find(row=>row.id===record.targetId),comparison=value.snapshot.comparisons.find(row=>row.id===conflict?.comparisonId);
      if(!conflict||conflict.ownership!=="source"||record.receiptRef!==conflict.receiptRef)ctx.addIssue({code:"custom",message:"Repair receipt requires its exact source-owned conflict."});
      if(record.state==="resolved"&&(!comparison||comparison.coverage!=="complete"||conflict?.state!=="resolved"||Date.parse(value.observedAt)-Date.parse(comparison.observedAt)>=900_000||Date.parse(value.observedAt)-Date.parse(conflict.observedAt)>=900_000||!record.sourceReadbackVersion||!record.mirrorReadbackVersion||
          record.sourceReadbackVersion!==conflict.authoritativeVersion||record.mirrorReadbackVersion!==conflict.mirrorVersion||comparison.sourceCount===null||comparison.mirrorCount===null||comparison.sourceCount!==comparison.mirrorCount||
          !comparison.sourceAmount||!comparison.mirrorAmount||digest(comparison.sourceAmount)!==digest(comparison.mirrorAmount)))
        ctx.addIssue({code:"custom",message:"Resolved requires matching complete key/count/money source and mirror readbacks, not a write acknowledgment."});
    }
    if(record.kind==="permissionReceipt"){
      const permission=value.snapshot.permissions.find(row=>row.id===record.targetId);
      if(!permission||permission.receiptRef!==record.receiptRef||!permission.verified)ctx.addIssue({code:"custom",message:"Permission evidence requires the exact verified source receipt."});
    }
    if(record.kind==="takeoverReceipt"){
      const takeover=value.snapshot.takeovers.find(row=>row.id===record.targetId);
      if(!takeover||!takeover.assignment||takeover.assignment.receiptRef!==record.receiptRef||takeover.assignment.actorRef!==record.ownerPersonRef)
        ctx.addIssue({code:"custom",message:"Takeover evidence requires the exact source assignment receipt."});
    }
  }
});
export type OperationsAuthoritySnapshot = z.infer<typeof operationsAuthoritySnapshotSchema>;
export type OperationsAuthorityRequest = { scope: ApprovalScope; principal: ApprovalPrincipal; actor: TrustedHuman };
export interface OperationsControlAuthoritySource {
  read(request: OperationsAuthorityRequest): Promise<unknown>;
  /** Inspect current backing permission and material; return undefined synchronously. */
  assertCurrent(request: OperationsAuthorityRequest, observed: OperationsAuthoritySnapshot, now: number): void;
}
export class OperationsAuthorityError extends Error {
  readonly code: string; readonly status: number;
  readonly executionCertainty: "notApplied" | "applied" | "uncertain";
  constructor(code: string, status = 409, certainty: OperationsAuthorityError["executionCertainty"] = "notApplied") {
    super(code); this.name = "OperationsAuthorityError"; this.code = code; this.status = status; this.executionCertainty = certainty;
  }
}
export type OperationsControlProof = {
  actor: TrustedHuman; snapshot: OperationsControlSnapshot; authority: OperationsAuthoritySnapshot;
  observedAt: string; validUntil: string; materialHash: string; assertCurrent(): void;
};
export function operationsAuthorityMaterial(value: unknown): unknown {
  // Renewal changes freshness, never source material or ownership.
  const omit = (value: unknown): unknown => Array.isArray(value) ? value.map(omit) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "observedAt" && key !== "validUntil").map(([key, item]) => [key, omit(item)])) : value;
  return omit(value);
}
export function operationsTargetMaterialHash(proof:OperationsControlProof,kind:OperationsTargetKind,id:string):string{
  const snapshot=proof.snapshot,member=(kind==="task"?snapshot.tasks:kind==="takeover"?snapshot.takeovers:kind==="repair"?snapshot.conflicts:kind==="permissionEvidence"?snapshot.permissions:snapshot.reports).find(row=>row.id===id)??null;
  const comparison=kind==="repair"?snapshot.comparisons.find(row=>row.id===snapshot.conflicts.find(row=>row.id===id)?.comparisonId)??null:null;
  const material=operationsAuthorityMaterial({scope:proof.authority.scope,principalRef:proof.authority.principalRef,personRef:proof.authority.personRef,
    directoryVersion:proof.authority.directoryVersion,permission:proof.authority.permission,coverage:snapshot.coverage,
    target:proof.authority.targets.find(row=>row.kind===kind&&row.id===id)??null,member,comparison});
  return digest(material);
}
export function createOperationsControlAuthority(options: { scope: ApprovalScope; sources: ApprovalSources; source?: OperationsControlAuthoritySource; now?: () => number }) {
  const scope = approvalScopeSchema.parse(structuredClone(options.scope)), now = options.now ?? Date.now;
  const fail = (code: string, status = 409): never => { throw new OperationsAuthorityError(code, status); };
  function currentTime() { const at = now(); if (!Number.isSafeInteger(at)) return fail("INVALID_CLOCK", 500); return at; }
  function fresh(observedAt: string, validUntil: string, timestamp: number) {
    const observed = Date.parse(observedAt), until = Date.parse(validUntil);
    return observed <= timestamp && until > timestamp && until > observed && until - observed <= OPERATIONS_AUTHORITY_MAX_AGE_MS;
  }
  function assertActor(actor: TrustedHuman, principal: ApprovalPrincipal) {
    if (!actor.active || digest(actor.scope) !== digest(scope) || actor.principalRef !== principal.principalRef ||
        !fresh(actor.observedAt, actor.validUntil, currentTime()) || !options.sources.assertCurrent)
      return fail("OPERATIONS_NAMED_ACTOR_DENIED", 403);
    try { assertSynchronousVoid(() => options.sources.assertCurrent!({ scope, actor: structuredClone(actor), slack: null, linearRecords: [] }, currentTime())); }
    catch { return fail("OPERATIONS_NAMED_ACTOR_DENIED", 403); }
  }
  async function resolve(rawPrincipal: ApprovalPrincipal): Promise<OperationsControlProof> {
    const principal = principalSchema.parse(structuredClone(rawPrincipal));
    if (!options.sources.resolveActor || !options.source) return fail("OPERATIONS_AUTHORITY_UNCONFIGURED", 503);
    let rawActor: unknown;
    try { rawActor = await options.sources.resolveActor(principal.principalRef, scope); }
    catch { return fail("OPERATIONS_NAMED_ACTOR_DENIED", 403); }
    const parsedActor = trustedHumanSchema.safeParse(rawActor);
    if (!parsedActor.success) return fail("OPERATIONS_NAMED_ACTOR_DENIED", 403);
    const actor = structuredClone(parsedActor.data); assertActor(actor, principal);
    const request: OperationsAuthorityRequest = { scope, principal, actor };
    let raw: unknown;
    try { raw = await options.source.read(structuredClone(request)); }
    catch (error) { if (error instanceof OperationsAuthorityError) throw error; return fail("OPERATIONS_SOURCE_UNAVAILABLE", 503); }
    const parsed = operationsAuthoritySnapshotSchema.safeParse(raw);
    if (!parsed.success) return fail("OPERATIONS_SOURCE_INVALID", 502);
    const source = structuredClone(parsed.data);
    const value: Omit<OperationsControlProof, "assertCurrent"> = { actor: structuredClone(actor), snapshot: structuredClone(source.snapshot), authority: structuredClone(source),
      observedAt: source.observedAt, validUntil: new Date(Math.min(Date.parse(source.validUntil), Date.parse(actor.validUntil))).toISOString(),
      materialHash: digest(operationsAuthorityMaterial(source)) };
    const immutableHash = digest(value);
    const assertCurrent = () => {
      assertActor(actor, principal);
      if (digest(source.scope) !== digest(scope) || digest(source.snapshot.scope) !== digest(scope) || source.principalRef !== principal.principalRef ||
          source.personRef !== actor.personRef || source.directoryVersion !== actor.directoryVersion || source.permission === "denied")
        return fail("OPERATIONS_SOURCE_SCOPE_DENIED", 403);
      if (source.permission !== "allowed") return fail("OPERATIONS_SOURCE_PERMISSION_UNKNOWN", 503);
      const timestamp = currentTime();
      if (!fresh(source.observedAt, source.validUntil, timestamp) || Date.parse(source.snapshot.observedAt) > timestamp || timestamp - Date.parse(source.snapshot.observedAt) >= 900_000)
        return fail("OPERATIONS_SOURCE_STALE");
      for (const rows of [source.snapshot.roles, source.snapshot.tasks, source.snapshot.takeovers, source.snapshot.permissions, source.snapshot.comparisons,
        source.snapshot.conflicts, source.snapshot.reports, source.snapshot.attribution, source.snapshot.handoffs, source.snapshot.runMembership])
        if (rows.some(row => Date.parse(row.observedAt) > timestamp)) return fail("OPERATIONS_SOURCE_INVALID", 502);
      if (digest(value) !== immutableHash) return fail("OPERATIONS_PROOF_CHANGED");
      try { assertSynchronousVoid(() => options.source!.assertCurrent(structuredClone(request), structuredClone(source), timestamp)); }
      catch (error) { if (error instanceof OperationsAuthorityError) throw error; return fail("OPERATIONS_SOURCE_CHANGED"); }
      assertActor(actor, principal);
    };
    assertCurrent(); return Object.freeze({ ...value, assertCurrent });
  }
  return { resolve };
}
export type OperationsControlAuthority = ReturnType<typeof createOperationsControlAuthority>;
