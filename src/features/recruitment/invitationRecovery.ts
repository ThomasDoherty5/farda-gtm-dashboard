import type { SaveResourceResponse } from "@/adapter/contract";
import { invitationSaveReceiptSchema, invitationSaveSchema, type InvitationSave, type InvitationSaveReceipt, type NativeInvitationView } from "@/creator-agent/recruitment/contract";

export type PendingInvitation = { scope: InvitationSaveReceipt["scope"]; actorRef: string; requestKey: string; payload: InvitationSave; payloadDigest: string };
export function canonicalInvitation(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInvitation).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>`${JSON.stringify(key)}:${canonicalInvitation(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
export async function invitationDigest(value: unknown) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonicalInvitation(value)));
  return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("");
}
export async function prepareInvitation(scope: PendingInvitation["scope"], actorRef: string, raw: InvitationSave): Promise<PendingInvitation> {
  const payload=invitationSaveSchema.parse(raw);
  return {scope,actorRef,payload,requestKey:crypto.randomUUID(),payloadDigest:await invitationDigest(payload)};
}
export function matchesInvitationReceipt(raw: unknown, pending: PendingInvitation): raw is InvitationSaveReceipt {
  const parsed=invitationSaveReceiptSchema.safeParse(raw);if(!parsed.success)return false;
  const r=parsed.data;
  return canonicalInvitation(r.scope)===canonicalInvitation(pending.scope)&&r.actorRef===pending.actorRef&&r.resource.actorRef===pending.actorRef&&
    r.requestKey===pending.requestKey&&r.expectedVersion===pending.payload.expectedVersion&&r.payloadDigest===pending.payloadDigest&&
    r.resourceRef===pending.payload.draftId&&r.resource.draftId===r.resourceRef&&r.resource.version===r.version&&r.resource.recordedAt===r.updatedAt&&
    canonicalInvitation(r.resource.terms)===canonicalInvitation(pending.payload.terms);
}
export function matchesInvitationAck(ack: SaveResourceResponse<InvitationSaveReceipt>, pending: PendingInvitation) {
  return ack.executionCertainty==="applied"&&ack.scope.workspaceId===pending.scope.workspaceId&&ack.scope.environment===pending.scope.environment&&
    ack.scope.accountIds.length===1&&ack.scope.accountIds[0]===pending.scope.accountId&&matchesInvitationReceipt(ack.record,pending)&&
    ack.resourceRef===ack.record.resourceRef&&ack.resourceVersion===ack.record.version&&ack.persistedAt===ack.record.updatedAt&&ack.persistedByRef===ack.record.actorRef;
}
export async function recoverInvitation(scope: PendingInvitation["scope"], data: Pick<NativeInvitationView,"requestRecovery"|"actorRef"|"filters">, requestKey: string, pending: PendingInvitation|null) {
  const recovery=data.requestRecovery,receipt=recovery?.receipt;
  if(recovery?.state!=="recorded"||recovery.requestKey!==requestKey||!receipt||receipt.actorRef!==data.actorRef||receipt.resourceRef!==data.filters.draftId)return null;
  const payload=invitationSaveSchema.parse({kind:"recruitmentInvitation",draftId:receipt.resourceRef,expectedVersion:receipt.expectedVersion,terms:receipt.resource.terms});
  const candidate:PendingInvitation={scope,actorRef:data.actorRef,requestKey,payload,payloadDigest:await invitationDigest(payload)};
  if(pending&&(canonicalInvitation(candidate)!==canonicalInvitation(pending)))return null;
  return matchesInvitationReceipt(receipt,candidate)?{pending:candidate,receipt}:null;
}
