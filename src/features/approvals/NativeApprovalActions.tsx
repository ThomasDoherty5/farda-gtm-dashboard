import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { actionResponseSchema, type ActionResponse, type ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { scopeKey, useScope } from "@/adapter/scope";
import { useAction } from "@/adapter/useAction";
import { protectedRead } from "@/adapter/useView";
import { Button, LinkButton } from "@/components/Button";
import { ActionError, blockedReason } from "./shared";
import styles from "./Approvals.module.css";

const ref = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(v => !/^https?:/i.test(v));
const base = z.object({ entityRefs: z.array(z.never()).max(0), expectedVersion: ref, approvalRef: ref, manifestRef: ref }).strict();
export const nativeCommandSchema = z.discriminatedUnion("operation", [
  base.extend({ operation: z.literal("requestApproval"), actionKind: z.enum(["requestApproval", "reconcileApproval"]), runRef: z.null(), payload: z.object({}).strict() }),
  base.extend({ operation: z.literal("dispatchApprovedAction"), actionKind: z.literal("dispatchApprovedAction"), runRef: z.null(), payload: z.object({ itemRefs: z.array(ref).min(1).max(100).refine(v => new Set(v).size === v.length) }).strict() }),
  base.extend({ operation: z.literal("controlRun"), actionKind: z.enum(["pauseRun", "cancelUnsent", "resumeRun"]), runRef: ref, payload: z.object({ control: z.enum(["pause", "cancel", "resume"]), itemRefs: z.array(ref).min(1).max(100).refine(v => new Set(v).size === v.length).optional() }).strict().refine(v => v.itemRefs === undefined || v.control === "cancel", "Only cancellation accepts a finite item selection.") }),
  base.extend({ operation: z.literal("reconcileRun"), actionKind: z.literal("lookup"), runRef: ref, payload: z.object({ request: z.literal("lookup") }).strict() }),
]);
export type NativeCommand = z.infer<typeof nativeCommandSchema>;
const markerSchema = z.object({ key: z.string().uuid(), command: nativeCommandSchema, state: z.enum(["pending", "recorded"]), runRef: ref.nullable() }).strict();
type Marker = z.infer<typeof markerSchema>;
const fallback = new Map<string, Marker>();
function readMarker(key: string, kind: "approval" | "run", resourceRef: string): {marker: Marker | null; invalid: boolean} {
  let raw: unknown = fallback.get(key);
  if (!raw) {
    let stored: string | null = null;
    try { stored = sessionStorage.getItem(key); } catch { /* Storage unavailable; process-local metadata is checked above. */ }
    if (stored === null) return {marker:null,invalid:false};
    try { raw = JSON.parse(stored); } catch { return {marker:null,invalid:true}; }
  }
  const parsed = markerSchema.safeParse(raw);
  if (!parsed.success || (kind === "approval" ? parsed.data.command.approvalRef !== resourceRef || parsed.data.command.runRef !== null : parsed.data.command.runRef !== resourceRef)) return {marker:null,invalid:true};
  return {marker:parsed.data,invalid:false};
}
function writeMarker(key: string, marker: Marker) {
  try { sessionStorage.setItem(key, JSON.stringify(marker)); fallback.delete(key); } catch { fallback.set(key, marker); /* The original key remains in memory for this page session. */ }
}
/** Only opaque references, the original key/version and closed command choices are persisted. Never message text, source IDs or rationale. */
export function nativeCommandStorageKey(scope: readonly unknown[], kind: string, ref: string) { return "native-action:" + JSON.stringify([scope, kind, ref]); }
export function validNativeAcknowledgment(raw: unknown, command: NativeCommand, scope: {workspaceId: string; accountIds: string[]; environment: string}): raw is ActionResponse {
  const parsed = actionResponseSchema.safeParse(raw); if (!parsed.success) return false;
  const r = parsed.data;
  return r.scope.workspaceId === scope.workspaceId && r.scope.environment === scope.environment && [...r.scope.accountIds].sort().join(",") === [...scope.accountIds].sort().join(",")
    && r.actionRef === command.approvalRef && r.approvalRef === command.approvalRef && r.manifestRef === command.manifestRef
    && r.executionCertainty === "applied" && (command.operation === "requestApproval" ? r.runRef === null && r.payloadVersion === command.expectedVersion && ["approvalPending", "approved", "blocked", "canceled"].includes(r.state)
      : command.operation === "dispatchApprovedAction" ? Boolean(r.runRef) : r.runRef === command.runRef);
}
export function useNativeCommand(kind: "approval" | "run", resourceRef: string) {
  const ctx = useScope(), client = useQueryClient(), action = useAction<NativeCommand["payload"]>();
  const storageKey = nativeCommandStorageKey(scopeKey(ctx), kind, resourceRef);
  const [marker, setMarker] = useState<Marker | null>(() => readMarker(storageKey,kind,resourceRef).marker);
  const [handoff, setHandoff] = useState<Marker | null>(() => readMarker(storageKey + ":handoff",kind,resourceRef).marker);
  const [invalidMetadata,setInvalidMetadata] = useState(() => readMarker(storageKey,kind,resourceRef).invalid || readMarker(storageKey+":handoff",kind,resourceRef).invalid);
  const [error, setError] = useState<Error | null>(null);
  const busy = useRef(false);
  const persist = (m: Marker) => { writeMarker(storageKey, m); setMarker(m);
    if (m.state === "recorded" && m.command.operation === "dispatchApprovedAction") { writeMarker(storageKey + ":handoff", m); setHandoff(m); }
  };
  async function submit(command: NativeCommand, retry = false) {
    if (busy.current) return;
    const stored = readMarker(storageKey,kind,resourceRef);
    if (stored.invalid || readMarker(storageKey+":handoff",kind,resourceRef).invalid) { setInvalidMetadata(true); return; }
    const previous = stored.marker;
    if (previous?.state === "pending" && !retry) return;
    const original = previous && (retry || JSON.stringify(previous.command) === JSON.stringify(command)) ? previous : { key: crypto.randomUUID(), command: nativeCommandSchema.parse(command), state: "pending" as const, runRef: null };
    busy.current = true; setError(null); persist({ ...original, state: "pending" });
    try {
      const result = await protectedRead(client, scopeKey(ctx), original.key, () => action.mutateAsync({ ...original.command, idempotencyKey: original.key }));
      if (!validNativeAcknowledgment(result, original.command, ctx.scope)) throw new Error("The acknowledgment did not match this exact action. Keep the original request for recovery.");
      persist({ ...original, state: "recorded", runRef: result.runRef });
    } catch (e) {
      const err = e instanceof Error ? e : new Error("The action outcome is unknown.");
      // A refusal of this transport attempt (including 401/403/429) cannot prove the original logical command never applied.
      // Keep its immutable key/version even when the generic error labels this latest request notApplied.
      setError(err);
    } finally { busy.current = false; }
  }
  return { marker, handoff, invalidMetadata, error, busy: action.isPending, submit, retry: () => marker && !invalidMetadata && submit(marker.command, true), pending: invalidMetadata || marker?.state === "pending" };
}
export function NativeCommandFeedback({ command }: {command: ReturnType<typeof useNativeCommand>}) {
  return <>
    {command.error && (command.pending && command.error instanceof AdapterError && command.error.body.executionCertainty === "notApplied" ? <p role="alert">The latest request was refused. The original command outcome is still unverified; retain its original key and version.</p> : <ActionError error={command.error} />)}
    {command.pending && <div className={styles.alertBox} role="alert"><h3 className={styles.h3}>Keep the original request</h3><p>The command may have been recorded. New actions are held until its original key and version are reconciled. A refreshed version or an absent source result does not permit a new attempt.</p>{command.invalidMetadata ? <p>Recovery metadata is invalid or belongs to a different record. An owner must reconcile the original source request; this page cannot safely reconstruct or replace its key.</p> : <Button variant="secondary" loading={command.busy} onClick={() => void command.retry()}>Recover original request</Button>}</div>}
    {command.marker?.state === "recorded" && <div className={styles.panel} role="status"><p>Command acknowledged. Current authority and source completion remain separate checks.</p>{command.marker.runRef && <LinkButton variant="secondary" to={`/runs/${encodeURIComponent(command.marker.runRef)}?tab=approval`}>Open recorded run</LinkButton>}</div>}
    {command.handoff?.runRef && command.marker?.runRef !== command.handoff.runRef && <LinkButton variant="secondary" to={`/runs/${encodeURIComponent(command.handoff.runRef)}?tab=approval`}>Open recorded run</LinkButton>}
  </>;
}
export function nativeBlocked(res: ReadResponse<unknown>, action: string, pending: boolean): string | null {
  if (pending) return "Recover the original request before creating another action.";
  if (res.dataState !== "ready") return "Refresh a complete current record before requesting this action.";
  return blockedReason(res, action);
}
