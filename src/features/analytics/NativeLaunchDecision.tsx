import { useEffect, useRef, useState } from "react";
import { onlineManager, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useSearchParams } from "react-router-dom";
import { scopeKey, useScope } from "@/adapter/scope";
import { protectedRead } from "@/adapter/useView";
import { useAction } from "@/adapter/useAction";
import { SCHEMA_VERSION, type ActionResponse, type ReadResponse } from "@/adapter/contract";
import { useOnline, OFFLINE_ACTION_REASON } from "@/adapter/connectivity";
import { AdapterError } from "@/adapter/errors";
import type { NativeReadinessView } from "@/creator-agent/actions/views";
import type { ReadinessPayload } from "@/creator-agent/actions/contract";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { TextField } from "@/components/Field";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { isCalendarDate } from "./launchRules";
import { Card, dateTime } from "./parts";
import styles from "./Analytics.module.css";
import native from "./NativeLaunch.module.css";

type Pending = { requestKey: string; actorRef: string; targetRef: string; expectedVersion: string; payload: ReadinessPayload; payloadDigest: string };
const markerSchema = z.object({ requestKey: z.string().uuid(), actorRef: z.string().min(1).max(240), targetRef: z.string().min(1).max(240), expectedVersion: z.string().min(1).max(240).nullable(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable() }).strict();
type Marker = z.infer<typeof markerSchema>;
const invalidMarkers = new Set<string>();
const markerMemory = new Map<string, Marker>();
function readMarker(key: string): Marker | null {
  try { const raw = window.sessionStorage.getItem(key); if (!raw) { invalidMarkers.delete(key); return null; } const parsed = markerSchema.safeParse(JSON.parse(raw)); if (parsed.success) return parsed.data; invalidMarkers.add(key); window.sessionStorage.setItem(key, JSON.stringify({ invalid: true })); return null; } catch { return markerMemory.get(key) ?? null; }
}
function saveMarker(key: string, marker: Marker | null) {
  try { invalidMarkers.delete(key); if (marker) window.sessionStorage.setItem(key, JSON.stringify(marker)); else window.sessionStorage.removeItem(key); markerMemory.delete(key); }
  catch { if (marker) markerMemory.set(key, marker); else markerMemory.delete(key); /* Safe metadata only. */ }
}
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);
export async function launchPayloadDigest(payload: ReadinessPayload) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(payload))))].map(v => v.toString(16).padStart(2, "0")).join(""); }
export function nativeGoHold(data: NativeReadinessView, now = Date.now()): string | null {
  if (!data.launchDate || !isCalendarDate(data.launchDate) || !data.launchDateApproved) return "Go requires a source-approved launch date.";
  if (!data.phaseAllowed) return "The source has not authorized this review phase or effective L − 4 window.";
  if (!Number.isFinite(Date.parse(data.validUntil)) || Date.parse(data.validUntil) <= now) return "Refresh expired source evidence before recording.";
  const required = data.gates.filter(g => g.required);
  if (!required.length || required.some(g => g.state !== "pass" || !g.evidenceRef)) return "Go requires every required source gate to pass with evidence.";
  return null;
}
function matchesAck(a: ActionResponse, p: Pending) { return a.actionRef === p.targetRef && a.state === "succeeded" && a.executionCertainty === "applied" && a.runRef === null && a.approvalRef === null && a.manifestRef === null && a.receiptRefs.length === 1 && !!a.receiptRefs[0] && !!a.payloadVersion && a.reasonCodes.includes("READINESS_RECORDED_RELEASE_NOT_GRANTED"); }
export function NativeLaunchDecision({ data, response, requestKey: urlRequestKey, invalidKey, readCurrent = true, refresh, onDirty }: { data: NativeReadinessView; response: ReadResponse<NativeReadinessView>; requestKey: string | null; invalidKey: boolean; readCurrent?: boolean; refresh: () => void; onDirty?: (dirty: boolean) => void }) {
  const online = useOnline();
  const ctx = useScope(), client = useQueryClient(), [, setParams] = useSearchParams();
  const pendingKey = [...scopeKey(ctx), "launch-readiness-original", data.actorRef, data.targetRef];
  const cache = useQuery<Pending | null>({ queryKey: pendingKey, queryFn: async () => null, enabled: false, gcTime: Infinity });
  const markerKey = "launch-readiness-pending:" + JSON.stringify(pendingKey);
  const [marker, setMarker] = useState<Marker | null>(() => readMarker(markerKey)), [finishedKey, setFinishedKey] = useState<string | null>(null);
  const invalidStoredMarker = invalidMarkers.has(markerKey);
  const rememberedKey = marker?.requestKey ?? cache.data?.requestKey ?? urlRequestKey;
  const requestKey = rememberedKey === finishedKey ? null : rememberedKey;
  const [open, setOpen] = useState(false), [discard, setDiscard] = useState(false), [verdict, setVerdict] = useState<ReadinessPayload["verdict"]>("hold"), [rationale, setRationale] = useState("");
  const [base, setBase] = useState(data.version), [error, setError] = useState<string | null>(null), [preparing, setPreparing] = useState(false), [verified, setVerified] = useState<"recorded" | "notApplied" | null>(null), [touched, setTouched] = useState(false);
  const [, tick] = useState(0), mounted = useRef(true);
  const action = useAction<ReadinessPayload>(), recovery = data.requestRecovery;
  const latest = useRef({ data, response, readCurrent, invalidKey, scope: scopeKey(ctx), base, rationale, verdict, requestKey, urlRequestKey });
  latest.current = { data, response, readCurrent, invalidKey, scope: scopeKey(ctx), base, rationale, verdict, requestKey, urlRequestKey };
  useEffect(() => {
    if (!requestKey || invalidStoredMarker) return;
    if (!marker) { const m: Marker = cache.data ? { requestKey, actorRef: data.actorRef, targetRef: data.targetRef, expectedVersion: cache.data.expectedVersion, payloadDigest: cache.data.payloadDigest } : { requestKey, actorRef: data.actorRef, targetRef: data.targetRef, expectedVersion: null, payloadDigest: null }; saveMarker(markerKey, m); setMarker(m); }
    if (urlRequestKey !== requestKey) setParams(old => { const next = new URLSearchParams(old); next.set("readinessRequestKey", requestKey); return next; }, { replace: true });
  }, [requestKey, invalidStoredMarker, marker, markerKey, cache.data, data.actorRef, data.targetRef, urlRequestKey, setParams]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { const delay = Math.max(0, Date.parse(data.validUntil) - Date.now() + 1); const id = setTimeout(() => tick(v => v + 1), Math.min(delay, 2_147_483_647)); return () => clearTimeout(id); }, [data.validUntil]);
  useEffect(() => { onDirty?.(!!rationale && !requestKey); return () => onDirty?.(false); }, [rationale, requestKey, onDirty]);
  const original = cache.data?.requestKey === requestKey ? cache.data : null;
  const recoveryMatchesMarker = !marker || !recovery?.intent || marker.actorRef === recovery.intent.actorRef && marker.targetRef === recovery.intent.targetRef && (marker.expectedVersion === null || marker.expectedVersion === recovery.intent.expectedVersion) && (marker.payloadDigest === null || marker.payloadDigest === recovery.intent.payloadDigest);
  const recoveryMatchesOriginal = recoveryMatchesMarker && (!original || !recovery?.intent || ["requestKey", "actorRef", "targetRef", "expectedVersion", "payload", "payloadDigest"].every(k => canonical(original[k as keyof Pending]) === canonical(recovery.intent![k as keyof Pending])));
  const effective: Pending | null = recoveryMatchesOriginal && recovery?.intent && recovery.requestKey === requestKey && recovery.intent.actorRef === data.actorRef && recovery.intent.targetRef === data.targetRef ? recovery.intent : cache.data?.requestKey === requestKey ? cache.data : null;
  useEffect(() => {
    let active = true; setVerified(null);
    if (invalidStoredMarker || !recoveryMatchesOriginal || !requestKey || !recovery || recovery.requestKey !== requestKey || !effective || effective.actorRef !== data.actorRef || effective.targetRef !== data.targetRef) return;
    void protectedRead(client, scopeKey(ctx), "launch-receipt-check", () => launchPayloadDigest(effective.payload)).then(digest => {
      if (!active || digest !== effective.payloadDigest) return;
      const r = recovery.receipt;
      if (recovery.state === "recorded" && r && r.requestKey === requestKey && r.actorRef === effective.actorRef && r.targetRef === effective.targetRef && r.expectedVersion === effective.expectedVersion && r.payloadDigest === digest && r.confersRelease === false && Number.isFinite(Date.parse(r.recordedAt)) && Date.parse(r.recordedAt) <= Date.now()) setVerified("recorded");
      if (recovery.state === "notApplied" && recovery.terminalProof && Number.isFinite(Date.parse(recovery.terminalProof.observedAt)) && Date.parse(recovery.terminalProof.observedAt) <= Date.now()) setVerified("notApplied");
    }).catch(() => { /* A permission loss fences this asynchronous check. */ });
    return () => { active = false; };
  }, [client, ctx, requestKey, recovery, effective, data.actorRef, data.targetRef, recoveryMatchesOriginal, invalidStoredMarker]);
  const goHold = nativeGoHold(data), freshnessHold = !online ? OFFLINE_ACTION_REASON : !readCurrent || !["ready", "partial"].includes(response.dataState) || Date.parse(data.validUntil) <= Date.now() ? "Refresh current source evidence before recording." : null;
  const hold = invalidStoredMarker ? "Stored recovery metadata is invalid. Ask the source owner to reconcile the unresolved request; a new key is held." : response.scope.environment !== "sandbox" || response.scope.accountIds.length !== 1 ? "One verified sandbox account is required." : invalidKey ? "Invalid recovery key. No new request can be created." : requestKey ? "Reconcile the original request before creating another decision." : blockedReason(response, "recordLaunchReadiness") ?? freshnessHold ?? (!data.phaseAllowed ? "The current source phase does not permit recording." : null);
  const changed = base !== data.version, dirty = !!rationale;
  const close = () => { if (dirty && !requestKey) setDiscard(true); else setOpen(false); };
  function remember(p: Pending) { const m = { requestKey: p.requestKey, actorRef: p.actorRef, targetRef: p.targetRef, expectedVersion: p.expectedVersion, payloadDigest: p.payloadDigest }; saveMarker(markerKey, m); setMarker(m); latest.current.requestKey = p.requestKey; client.setQueryData(pendingKey, p); setParams(old => { const next = new URLSearchParams(old); next.set("readinessRequestKey", p.requestKey); return next; }, { replace: true }); }
  async function submit(original?: Pending) {
    setTouched(true); setError(null);
    if (action.isPending || preparing || freshnessHold || (!original && (hold || changed || !rationale.trim() || rationale.trim().length > 2000 || verdict === "go" && goHold))) return;
    if (original && (original.requestKey !== requestKey || original.actorRef !== data.actorRef || original.targetRef !== data.targetRef)) return;
    setPreparing(true);
    const startedScope = canonical(scopeKey(ctx));
    const startedIntent = canonical({ base, rationale: rationale.trim(), verdict, launchDate: data.launchDate, evidenceRefs: data.evidenceRefs });
    try {
      const payload: ReadinessPayload = { verdict, launchDate: data.launchDate, rationale: rationale.trim(), evidenceRefs: [...data.evidenceRefs] };
      const p = original ?? { requestKey: crypto.randomUUID(), actorRef: data.actorRef, targetRef: data.targetRef, expectedVersion: base, payload, payloadDigest: await protectedRead(client, scopeKey(ctx), "launch-prepare", () => launchPayloadDigest(payload)) };
      const rendered = latest.current, now = Date.now();
      // Query publication can precede React rendering. Use the actual current scoped read as the final source fence.
      const query = client.getQueryCache().find({ queryKey: [...rendered.scope, SCHEMA_VERSION, "launchControl", rendered.urlRequestKey ? { requestKey: rendered.urlRequestKey } : {}, null], exact: true });
      const cached = query?.state.data as ReadResponse<NativeReadinessView> | undefined;
      const l = { ...rendered, data: cached?.data?.kind === "native-launch-readiness" ? cached.data : rendered.data, response: cached ?? rendered.response };
      const currentScope = l.response.scope.environment === "sandbox" && l.response.scope.accountIds.length === 1 && canonical(l.scope) === startedScope;
      const currentRead = !!cached?.data && query?.state.status === "success" && !query.state.error && l.readCurrent && ["ready", "partial"].includes(l.response.dataState) && Date.parse(l.data.observedAt) <= now && Date.parse(l.data.validUntil) > now;
      const currentPermission = onlineManager.isOnline() && currentScope && currentRead && !l.invalidKey && !blockedReason(l.response, "recordLaunchReadiness");
      const intentUnchanged = canonical({ base: l.base, rationale: l.rationale.trim(), verdict: l.verdict, launchDate: l.data.launchDate, evidenceRefs: l.data.evidenceRefs }) === startedIntent;
      const knownMarker = readMarker(markerKey), knownOriginal = client.getQueryData<Pending | null>(pendingKey);
      const newIntentCurrent = !invalidMarkers.has(markerKey) && (original ? l.requestKey === original.requestKey : !l.requestKey && !knownMarker && !knownOriginal && l.data.version === p.expectedVersion && l.data.phaseAllowed && intentUnchanged && (p.payload.verdict !== "go" || !nativeGoHold(l.data, now)));
      if (!mounted.current || !currentPermission || !newIntentCurrent || l.data.actorRef !== p.actorRef || l.data.targetRef !== p.targetRef) { if (mounted.current) setError("Current source evidence, permission or the draft changed during preparation. No new request was submitted."); return; }
      if (!original) remember(p);
      action.mutate({ operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", expectedVersion: p.expectedVersion, idempotencyKey: p.requestKey, approvalRef: null, manifestRef: null, runRef: null,
        entityRefs: [{ source: "launch-readiness", accountId: response.scope.accountIds[0]!, sourceId: null, canonicalId: p.targetRef, url: null, identityState: "resolved", provenanceRef: p.expectedVersion }], payload: p.payload }, {
        onSuccess: ack => { if (!mounted.current) return; setError(matchesAck(ack, p) ? null : "The acknowledgment does not match this decision. Keep the original request and check its source receipt."); refresh(); },
        onError: e => { if (!mounted.current) return; setError(e instanceof AdapterError && e.body.executionCertainty === "notApplied" ? "The request was not applied. Check its exact source result before changing the decision." : "Outcome is unknown. Check or retry only the original request; do not create another decision."); refresh(); },
      });
    } catch { if (mounted.current) setError("Authorization or source evidence changed while preparing. No new request was submitted."); }
    finally { if (mounted.current) setPreparing(false); }
  }
  function finish() {
    if (!verified) return;
    saveMarker(markerKey, null); setMarker(null); setFinishedKey(requestKey); latest.current.requestKey = null; client.setQueryData(pendingKey, null); setParams(old => { const next = new URLSearchParams(old); next.delete("readinessRequestKey"); return next; }, { replace: true });
    setRationale(""); setBase(data.version); setError(null); setVerified(null); setOpen(false); action.reset(); refresh();
  }
  return <Card labelledBy="decision-title"><div className={styles.sectionHeading}><h2 id="decision-title">Go / revise / hold</h2><p>{data.phase === "effective-l-minus-4" ? "Effective L − 4 review · source phase validation applies." : "Readiness review · effective L − 4 is a separate source gate."}</p></div>
    <div className={styles.btnRow}><Badge tone="warning" width={216}>{!data.launchDate ? "Awaiting launch date" : "Readiness record only"}</Badge></div>
    <dl className={styles.decisionDetails}><div><dt>Decision</dt><dd>{verified === "recorded" ? "Source receipt verified" : "Prior decision not supplied"}</dd></div><div><dt>Review owner</dt><dd>Named founder required by source</dd></div><div><dt>Evidence</dt><dd>{data.evidenceRefs.length} source references</dd></div></dl><hr className={styles.divider} />
    <div className={styles.options3}><h3>Go</h3><p>All required gates pass, with evidence.</p></div><div className={styles.options3}><h3>Revise</h3><p>Change the plan and re-test affected gates.</p></div><div className={styles.options3}><h3>Hold</h3><p>Keep release and execution separately gated.</p></div>
    <div className={styles.btnRow}><Button variant="secondary" style={{ minWidth: 232 }} aria-haspopup="dialog" onClick={() => setOpen(true)}>Record in Notion</Button></div>
    {invalidStoredMarker && <p role="alert">Stored recovery metadata is invalid. No new decision can be submitted; reconcile the original request with its source owner.</p>}
    {requestKey && <div className={native.recovery}><p role="status">{verified === "recorded" ? "The exact Notion readiness receipt is verified. No release was granted." : verified === "notApplied" ? "The original request has a verified terminal no-op." : "Readiness record outcome needs source readback. The original request remains held."}</p><Button variant="secondary" onClick={refresh}>Check original request</Button>{effective && <details className={native.reference}><summary>Inspect original decision</summary><dl className={styles.defs}><div><dt>Decision</dt><dd>{effective.payload.verdict}</dd></div><div><dt>Rationale</dt><dd>{effective.payload.rationale}</dd></div><div><dt>Launch date</dt><dd>{effective.payload.launchDate ?? "Not set"}</dd></div><div><dt>Version</dt><dd>{effective.expectedVersion}</dd></div><div><dt>Request</dt><dd>{effective.requestKey}</dd></div></dl></details>}{verified ? <Button onClick={finish}>Finish reconciliation</Button> : <Button loading={action.isPending} disabledReason={(invalidStoredMarker ? "Stored recovery metadata is invalid." : null) ?? freshnessHold ?? blockedReason(response, "recordLaunchReadiness") ?? (!recoveryMatchesOriginal ? "Source recovery conflicts with the original request. Do not resend or create a new key." : !effective ? "Original payload unavailable. Keep checking the exact request; absence is not permission for a new key." : null)} onClick={() => effective && void submit(effective)}>Retry original request</Button>}</div>}
    <Dialog open={open} title="Record a launch-readiness decision" onClose={close}><div className={styles.editor}><p>Founder only. This records Go / revise / hold in Notion; it does not approve L, enable any schedule or release spending.</p>
      <fieldset className={styles.options}><legend>Decision</legend>{(["go", "revise", "hold"] as const).map(value => <label key={value} className={styles.option}><input type="radio" name="native-verdict" checked={verdict === value} disabled={!!requestKey || value === "go" && !!goHold} onChange={() => setVerdict(value)} />{value[0]!.toUpperCase() + value.slice(1)}</label>)}</fieldset>{goHold && <p className={styles.small}>{goHold}</p>}
      <dl className={`${styles.defs} ${native.reference}`}><div><dt>Launch date</dt><dd>{data.launchDate ?? "Not set"} · {data.launchDateApproved ? "source approved" : "not approved"}</dd></div><div><dt>Gate snapshot</dt><dd>{dateTime(data.observedAt)}</dd></div><div><dt>Expected record version</dt><dd>{base}</dd></div><div><dt>Evidence references</dt><dd>{data.evidenceRefs.join(", ")}</dd></div></dl>
      <TextField label="Rationale" multiline value={rationale} disabled={!!requestKey || action.isPending || preparing} onChange={setRationale} error={touched && (!rationale.trim() || rationale.trim().length > 2000) ? "Enter a rationale from 1 to 2,000 characters." : null} helpText="Explain the decision using the current gate evidence. This text is never saved in browser storage." />
      {changed && !requestKey && <p role="alert">Source evidence changed. Your draft retains its original version. Refresh and explicitly rebase after reviewing the current gates.</p>}{changed && !requestKey && <Button variant="secondary" onClick={() => setBase(data.version)}>Use reviewed current version</Button>}
      <Button loading={preparing || action.isPending} disabledReason={hold ?? (changed ? "Review the changed source version." : verdict === "go" ? goHold : null)} onClick={() => void submit()}>Record decision</Button>
      {error && <p role="alert">{error}</p>}{action.error && <ActionError error={action.error} />}<Button variant="secondary" onClick={close}>Close</Button>
    </div></Dialog>
    <Dialog open={discard} title="Discard this local rationale?" onClose={() => setDiscard(false)}><p>The unsubmitted rationale has no source record.</p><Button onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="secondary" onClick={() => { setDiscard(false); setRationale(""); setBase(data.version); setOpen(false); }}>Discard and close</Button></Dialog>
  </Card>;
}
