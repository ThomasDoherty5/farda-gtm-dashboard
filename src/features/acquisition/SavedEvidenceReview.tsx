import { useState } from "react";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import { scopeKey,useScope } from "@/adapter/scope";
import { AdapterError,mustClearProtectedData } from "@/adapter/errors";
import { Link } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useSave } from "@/adapter/useSave";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField, TextField } from "@/components/Field";
import { LeaveGuard, ActionError, blockedReason } from "@/features/approvals/shared";
import { evidenceAnnotation, reviewInputSchema, type EvidenceAnnotation, type ReviewInput, type SourceReview } from "@/creator-agent/evidenceReviewContract";
import type { PostEvidence } from "@/creator-agent/evidence";
import type { EvidenceRecord } from "./evidenceTypes";
import { evidenceReviewPath } from "./creatorReviewPaths";
import { CATEGORY_LABEL, formatTime, parseTime } from "./evidenceRules";
import styles from "./Acquisition.module.css";

export type EditorKind = "observation" | "disagree" | "override";
const accessLabels = { permitted: "Original access permitted when checked", loginRequired: "Source login required", permissionDenied: "Source permission denied", unavailable: "Original unavailable", deleted: "Original deleted" } as const;
export function SavedSourcePlayer({ source, post }: { source: SourceReview; post: PostEvidence }) {
  const status = source.access ? accessLabels[source.access.state] : "Current playback access unverified";
  const accessible = !source.access || source.access.state === "permitted";
  const path = evidenceReviewPath(source.creatorId,source.postId);
  return <>
    <div className={styles.player} data-testid="player">
      <p className={styles.playerTitle}>{status}</p>
      <p className={styles.playerText}>Saved source review: {post.review.status}. Visual method: {post.review.visualMethod}. Audio method: {post.review.audioMethod}.</p>
      {accessible && <a href={post.sourceUrl} target="_blank" rel="noreferrer">Open the original {post.network} post</a>}
      {!accessible && <Link to="/settings/capabilities">Inspect source access</Link>}
    </div>
    <p className={styles.small}>Native post {source.nativeIdentity} · Media {source.canonicalMediaId} · Published {post.publishedAt ?? "Unknown"} · Source observation {post.observedAt}.</p>
    <p className={styles.small}>{source.access ? `Access observed ${source.access.observedAt} · ${source.access.sourceRef}` : "The saved assessment supplies no current playback authorization."} Playback stays on the original service.</p>
    <p className={styles.small}>Review receipt {post.review.sourceRef ?? "Unknown"} · Reviewer {post.review.reviewerRef ?? "Unknown"} · Review time {post.review.reviewedAt ?? "Unknown"} · Saved {source.recordedAt}.</p>
    {source.superseded && <p role="status">Historical evidence. A later creator assessment superseded this run.</p>}
    <nav className={styles.rowActions} aria-label="Evidence revisions">
      {source.olderRunId && <Link to={path+"?run="+encodeURIComponent(source.olderRunId)}>Previous saved evidence</Link>}
      {source.newerRunId && <Link to={path+"?run="+encodeURIComponent(source.newerRunId)}>Next saved evidence</Link>}
      {!source.superseded && <Link to={path+"?run="+encodeURIComponent(source.runId)}>Link to this exact saved revision</Link>}
    </nav>
  </>;
}

function label(annotation: EvidenceAnnotation) {
  const input = annotation.input;
  return input.kind === "observation" ? `${CATEGORY_LABEL[input.note.category]} · ${formatTime(input.note.startSec)}–${formatTime(input.note.endSec)} · ${input.note.text}`
    : `${input.kind === "override" ? "Proposed override" : "Disagreement"} · ${input.reason}${input.kind === "override" ? ` · Proposed replacement: ${input.replacement}` : ""}`;
}

type PendingEntry = { expected:string; input:ReviewInput; key:string };
type FreshRead = () => Promise<EvidenceRecord|null>;
export function SavedAnnotations({record,res,kind,open,readFresh}:{record:EvidenceRecord;res:ReadResponse<EvidenceRecord>;kind:EditorKind|null;open:(kind:EditorKind|null)=>void;readFresh:FreshRead}) {
  const source = record.sourceReview!;
  const blocked = blockedReason(res,"recordDisagreement");
  const client = useQueryClient(), ctx = useScope();
  const key = [...scopeKey(ctx),"pending-review-entry",source.basisHash];
  const held = useQuery<PendingEntry|null>({queryKey:key,queryFn:()=>null,initialData:null,enabled:false,gcTime:Infinity}).data ?? null;
  const hold = (entry:PendingEntry|null) => client.setQueryData(key,entry);
  return <section className={styles.card} aria-labelledby="saved-annotations">
    <h2 className={styles.h2} id="saved-annotations">Reviewer observations and disagreements</h2>
    <p>{source.contested ? "This assessment has disputed evidence. Review is required before dependent work can proceed." :
      "Reviewer entries are stored beside the original evidence. Only the source review can establish playback or qualification."}</p>
    {source.annotations.length ? <ol aria-label="Immutable annotation history">{source.annotations.map(a => <li key={a.id}>
      <p>{label(a)}</p>{a.original && <p>Original evidence: {a.original.label}</p>}
      <p className={styles.small}>{a.reviewer} · {a.recordedAt} · revision {a.revision}</p>
    </li>)}</ol> : <p>No reviewer annotations on this exact revision.</p>}
    <div className={styles.rowActions}>
      <Button variant="secondary" disabledReason={held ? "Inspect the pending entry before starting another." : blocked} onClick={()=>open("disagree")}>Record disagreement</Button>
      <Button variant="secondary" disabledReason={held ? "Inspect the pending entry before starting another." : blocked} onClick={()=>open("override")}>Propose an override</Button>
      {held && !kind && <Button onClick={()=>open(held.input.kind)}>Inspect pending reviewer entry</Button>}
    </div>
    {kind && <AnnotationEditor key={source.basisHash} record={record} initialKind={held?.input.kind ?? kind} onClose={()=>open(null)} held={held} hold={hold} readFresh={readFresh}/>}
  </section>;
}

function AnnotationEditor({record,initialKind,onClose,held,hold,readFresh}:{record:EvidenceRecord;initialKind:EditorKind;onClose:()=>void;
  held:PendingEntry|null;hold:(entry:PendingEntry|null)=>void;readFresh:FreshRead}) {
  const source = record.sourceReview!;
  const [expected,setExpected] = useState(record.version);
  const [target,setTarget] = useState(source.targets[0]?.id ?? "");
  const [category,setCategory] = useState<"hook"|"demonstration"|"framing"|"audio">("demonstration");
  const [start,setStart] = useState(""), [end,setEnd] = useState("");
  const [reason,setReason] = useState(""), [replacement,setReplacement] = useState("");
  const [error,setError] = useState(""), [ack,setAck] = useState("");
  const [discard,setDiscard] = useState(false), [retryChecked,setRetryChecked] = useState(false);
  const save = useSave<ReviewInput,EvidenceAnnotation>();
  const targets = [...source.targets, ...source.annotations.flatMap(a => a.input.kind === "observation" ? [{id:a.id,label:label(a)}] : [])];
  const dirty = !ack && Boolean(reason || replacement || start || end);
  const changed = !ack && !held && expected !== record.version;
  const close = () => { if (save.isPending) return; if (dirty && !held) setDiscard(true); else onClose(); };
  const send = (entry:PendingEntry) => {
    const sent = entry.input;
    hold(entry); setRetryChecked(false);
    save.mutate({resourceKind:sent.kind === "observation" ? "evidenceDraft" : "reviewerAssessment",resourceRef:source.postId,
      expectedVersion:entry.expected,payload:sent,idempotencyKey:entry.key},{
      onSuccess: receipt => {
        const result = evidenceAnnotation.safeParse(receipt.record);
        if (!result.success || receipt.executionCertainty !== "applied" || receipt.resourceRef !== source.postId ||
          JSON.stringify(result.data.input) !== JSON.stringify(sent) || receipt.persistedByRef !== result.data.reviewer ||
          result.data.postId !== source.postId || receipt.persistedAt !== result.data.recordedAt || !Number.isFinite(Date.parse(receipt.persistedAt)) ||
          entry.expected !== `er-${source.basisHash}-${result.data.revision-1}` ||
          receipt.resourceVersion !== `er-${source.basisHash}-${result.data.revision}`) {
          setError("The response could not confirm this exact entry. Inspect saved history before retrying."); return;
        }
        hold(null); setAck(`Saved reviewer entry ${result.data.revision} at ${receipt.persistedAt}.`);
      }, onError: cause => {
        if (cause instanceof AdapterError && (mustClearProtectedData(cause.category) || cause.body.executionCertainty === "notApplied")) hold(null);
        else setError("The result is uncertain. Check saved history before retrying.");
      },
    });
  };
  const inspect = async () => {
    if (!held) return;
    setRetryChecked(false);
    try {
      const fresh=(await readFresh())?.sourceReview;
      if (!fresh || fresh.basisHash !== held.input.basisHash || fresh.runId !== held.input.runId) {setError("This read did not verify the pending evidence revision."); return;}
      const entry=fresh.annotations.find(a=>a.input.intentId === held.input.intentId &&
        JSON.stringify(a.input)===JSON.stringify(held.input) && a.postId===source.postId &&
        held.expected===`er-${fresh.basisHash}-${a.revision-1}`);
      if(entry) {hold(null);setError("");setAck(`Confirmed reviewer entry ${entry.revision} in saved history.`);return;}
      const occupied=fresh.annotations.some(a=>held.expected===`er-${fresh.basisHash}-${a.revision-1}`);
      if (occupied) {hold(null);setError("Another saved entry occupies the expected version. Review its history before starting a new entry.");return;}
      setRetryChecked(!fresh.stale && !fresh.superseded);
      setError("The exact entry is absent from the new read. Only the original request can be retried.");
    } catch {setError("Saved history could not be verified. The pending request is retained.");}
  };
  const submit = () => {
    if (held || changed) return;
    const identity = { creatorId:source.creatorId,runId:source.runId,basisHash:source.basisHash,intentId:crypto.randomUUID() };
    const draft = initialKind === "observation" ? {...identity,kind:initialKind,note:{category,startSec:parseTime(start),endSec:parseTime(end),text:reason}} :
      initialKind === "override" ? {...identity,kind:initialKind,targetId:target,reason,replacement} : {...identity,kind:initialKind,targetId:target,reason};
    const parsed = reviewInputSchema.safeParse(draft);
    if (!parsed.success) { setError(initialKind === "observation" ? "Enter ordered m:ss times and a description of the observed evidence." :
      "Choose source evidence and enter a reason of 12–500 characters. An override also needs replacement text."); return; }
    setError("");
    send({expected,input:parsed.data,key:crypto.randomUUID()});
  };
  return <Dialog open title={initialKind === "observation" ? "Add time-coded observation" : initialKind === "override" ? "Propose an override" : "Record disagreement"} onClose={close}>
    <LeaveGuard dirty={dirty && !save.isPending} subject="reviewer entry"/>
    <p>Evidence {source.postId} · {source.evidenceRevision} · policy {source.policyVersion} · terms {source.termsRevision}.</p>
    {!held && !ack && <>{initialKind === "observation" ? <>
      <SelectField label="Observation category" value={category} onChange={v=>setCategory(v as typeof category)} options={Object.entries(CATEGORY_LABEL).map(([value,label])=>({value,label}))}/>
      <TextField label="Start (m:ss)" value={start} onChange={setStart}/><TextField label="End (m:ss)" value={end} onChange={setEnd}/>
      <p>Use an interval covered by the saved continuous visual or heard-audio review. Sampled frames and captions do not supply that interval.</p>
    </> : <SelectField label="Original evidence" value={target} onChange={setTarget} options={targets.map(t=>({value:t.id,label:t.label}))}/>}
    <TextField label={initialKind === "observation" ? "Observed evidence" : "Reason"} multiline value={reason} onChange={setReason}/>
    {initialKind === "override" && <TextField label="Proposed replacement" multiline value={replacement} onChange={setReplacement}/>}</>}
    {save.error && <ActionError error={save.error}/>}
    {error && <p role="alert">{error}</p>}{ack && <p role="status">{ack}</p>}
    {changed && <p role="status">A newer review version is available. Inspect its history before keeping this entry.
      <Button variant="secondary" onClick={()=>{setExpected(record.version); save.reset();}}>Keep draft against the displayed version</Button></p>}
    <Button loading={save.isPending} disabledReason={ack || (held ? "Check the pending entry." : changed ? "Review the updated version." : null)} onClick={submit}>Save reviewer entry</Button>
    {held && <><p>Pending {held.input.kind} · {held.input.kind === "observation" ? held.input.note.text : held.input.reason}</p>
      <Button variant="secondary" disabledReason={save.isPending ? "Save is pending." : null} onClick={()=>void inspect()}>Check saved history</Button>
      {retryChecked && <Button onClick={()=>send(held)}>Retry the exact request</Button>}</>}
    {discard && <div role="alert">Discard the unsaved reviewer entry?
      <Button variant="secondary" onClick={()=>setDiscard(false)}>Keep editing</Button><Button onClick={onClose}>Discard draft</Button></div>}
    <Button variant="secondary" onClick={close}>Close</Button>
  </Dialog>;
}
