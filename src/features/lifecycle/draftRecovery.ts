import type { SaveResourceResponse } from "@/adapter/contract";
import { draftPayloadSchema, saveReceiptSchema, type FlowDraft, type NativeEmailFlow, type SaveReceipt } from "@/creator-agent/lifecycle/contract";

export type PendingDraft = { scope: SaveReceipt["scope"]; requestKey: string; actorRef: string; resourceRef: SaveReceipt["resourceRef"]; expectedVersion: string; payload: FlowDraft; payloadDigest: string };
const canonical = (payload: FlowDraft) => JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
export const sameDraft = (a: FlowDraft, b: FlowDraft) => canonical(a) === canonical(b);
export async function draftDigest(payload: FlowDraft) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function prepareDraft(scope: SaveReceipt["scope"], actorRef: string, resourceRef: SaveReceipt["resourceRef"], expectedVersion: string, input: FlowDraft): Promise<PendingDraft> {
  const payload = draftPayloadSchema.parse(input);
  return { scope, actorRef, resourceRef, expectedVersion, payload, payloadDigest: await draftDigest(payload), requestKey: crypto.randomUUID() };
}
export function matchesReceipt(raw: unknown, pending: PendingDraft): raw is SaveReceipt {
  const parsed = saveReceiptSchema.safeParse(raw);
  if (!parsed.success) return false;
  const r = parsed.data;
  return r.scope.workspaceId === pending.scope.workspaceId && r.scope.accountId === pending.scope.accountId && r.scope.environment === pending.scope.environment && r.requestKey === pending.requestKey && r.expectedVersion === pending.expectedVersion && r.payloadDigest === pending.payloadDigest &&
    r.persistedByRef === pending.actorRef && r.record.savedBy === pending.actorRef && r.persistedAt === r.record.savedAt &&
    r.resourceRef === pending.resourceRef && `flow-${r.record.flow}` === pending.resourceRef && r.record.templateVersion === pending.payload.templateVersion && sameDraft(r.record.payload, pending.payload);
}
/** Generic transport success is insufficient: every immutable request and standard ACK field must agree. */
export function matchesDraftAck(ack: SaveResourceResponse<SaveReceipt>, pending: PendingDraft) {
  return ack.scope.workspaceId === pending.scope.workspaceId && ack.scope.environment === pending.scope.environment && ack.scope.accountIds.length === 1 && ack.scope.accountIds[0] === pending.scope.accountId && ack.executionCertainty === "applied" && matchesReceipt(ack.record, pending) && ack.resourceRef === ack.record.resourceRef &&
    ack.resourceVersion === ack.record.resourceVersion && ack.persistedAt === ack.record.persistedAt && ack.persistedByRef === ack.record.persistedByRef;
}
export async function recoverDraft(scope: SaveReceipt["scope"], data: NativeEmailFlow, requestKey: string, pending: PendingDraft | null): Promise<{ state: "recorded" | "rejected"; pending: PendingDraft; receipt: SaveReceipt | null } | null> {
  const r = data.requestedSave;
  if (!r || r.requestKey !== requestKey || r.actorRef !== data.actorRef || r.resourceRef !== `flow-${data.flow}` || !r.original ||
      !r.expectedVersion || r.original.expectedVersion !== r.expectedVersion || !r.payloadDigest) return null;
  const candidate: PendingDraft = { scope, requestKey, actorRef: r.actorRef, resourceRef: r.resourceRef, expectedVersion: r.expectedVersion,
    payload: r.original.payload, payloadDigest: await draftDigest(r.original.payload) };
  if (candidate.payloadDigest !== r.payloadDigest || pending && (pending.scope.workspaceId !== scope.workspaceId || pending.scope.accountId !== scope.accountId || pending.scope.environment !== scope.environment || pending.actorRef !== candidate.actorRef || pending.resourceRef !== candidate.resourceRef ||
      pending.requestKey !== requestKey || pending.expectedVersion !== candidate.expectedVersion || pending.payloadDigest !== candidate.payloadDigest || !sameDraft(pending.payload, candidate.payload))) return null;
  if (r.disposition === "recorded" && r.state === "applied" && matchesReceipt(r.receipt, candidate)) return { state: "recorded", pending: candidate, receipt: r.receipt };
  if (r.disposition === "rejected" && r.state === "notApplied" && r.receipt === null && r.reasonCode) return { state: "rejected", pending: candidate, receipt: null };
  // An absent or unverified lookup is an observation, never a terminal fence against a delayed save.
  return null;
}
