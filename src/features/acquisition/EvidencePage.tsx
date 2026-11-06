import { useId, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useSave } from "@/adapter/useSave";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { SkeletonCard } from "@/components/EmptyState";
import { SelectField, TextField } from "@/components/Field";
import { Kpi } from "@/components/Kpi";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { ActionError, LeaveGuard, blockedReason } from "@/features/approvals/shared";
import { CATEGORY_LABEL, MODEL_FOR_ROUTE, ROUTE_LABEL, coveredSeconds, formatTime, parseTime, validateMediaUrl, validateObservation } from "./evidenceRules";
import type { CheckoutRoute, EvidenceDraft, EvidenceRecord, Observation, ObservationCategory } from "./evidenceTypes";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { QualificationDetails, rating } from "./AgentQualification";
import { evidenceReviewPath } from "./creatorReviewPaths";
import { EvidenceDisputes } from "./EvidenceDisputes";
import { SavedAnnotations, SavedSourcePlayer, type EditorKind } from "./SavedEvidenceReview";
import { scopeKey, useScope } from "@/adapter/scope";
import styles from "./Acquisition.module.css";

type Res = ReadResponse<EvidenceRecord>;
const PROMPTS: Record<ObservationCategory, string> = {
  hook: "What happens in the opening?",
  demonstration: "Show the actual product-use sequence.",
  framing: "Record framing, text and legibility.",
  audio: "Record actual speech/music; note silent review.",
};
const ROUTES = (Object.keys(ROUTE_LABEL) as CheckoutRoute[]).map((value) => ({ value, label: ROUTE_LABEL[value] }));
const CATEGORIES = (Object.keys(CATEGORY_LABEL) as ObservationCategory[]).map((value) => ({ value, label: CATEGORY_LABEL[value] }));

/** Lifestyle video evidence review (Figma source 102:364, owner THO-288). A saved draft is never a completed review. */
export function EvidencePage() {
  const { creatorId = "", evidenceId = "" } = useParams();
  const [params] = useSearchParams(), runId = params.get("run");
  const context = useScope();
  const filters = useMemo(() => ({ creatorId, evidenceId, ...(runId !== null ? {runId} : {}) }), [creatorId, evidenceId, runId]);
  const query = useView<typeof filters, EvidenceRecord>("evidenceRecord", filters);
  const returned = query.isPlaceholderData ? null : query.data?.data;
  const record = returned?.evidenceRef === evidenceId && (!returned.sourceReview ||
    returned.sourceReview.creatorId === creatorId && (!runId || returned.sourceReview.runId === runId)) ? returned : null;
  return (
    <section aria-labelledby="evidence-title" data-figma-source="102:364" className={styles.page}>
      <ReadState res={query.data} subject="This evidence record" />
      {record ? (
        <Review key={JSON.stringify([scopeKey(context),creatorId,evidenceId,record.sourceReview?.runId ?? runId])} res={query.data as Res} record={record} reviewPath={evidenceReviewPath(creatorId, evidenceId)}
          readFresh={async()=>(await query.refetch({throwOnError:true})).data?.data ?? null}/>
      ) : (
        <>
          <div className={styles.titleRow}>
            <div className={styles.heading}>
              <h1 id="evidence-title">Watch the routine. Keep the evidence.</h1>
            </div>
          </div>
          {query.isPending && <SkeletonCard label="Loading evidence…" />}
          {query.isError && <ViewError error={query.error} subject="This evidence record" onRetry={() => void query.refetch()} />}
        </>
      )}
    </section>
  );
}

function Review({ res, record, reviewPath, readFresh }: { res: Res; record: EvidenceRecord; reviewPath: string; readFresh:()=>Promise<EvidenceRecord|null> }) {
  const qualification = record.qualification;
  const source = record.sourceReview;
  const selectedPost = source && record.agentEvidence?.posts.find(p=>p.postId === source.postId);
  const [editor,setEditor] = useState<EditorKind|null>(null);
  const [mediaUrl, setMediaUrl] = useState(record.mediaUrl ?? "");
  const [route, setRoute] = useState<CheckoutRoute>(record.checkoutRoute);
  const [observations, setObservations] = useState<Observation[]>(record.observations);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"observation" | "model" | null>(null);
  const save = useSave<EvidenceDraft, EvidenceRecord>();
  const watchedReasonId = useId();
  const addReasonId = useId();
  const addReason = "needs a valid original video URL first, because an observation is tied to the video it came from.";

  const trimmed = mediaUrl.trim();
  const liveUrlError = validateMediaUrl(mediaUrl);
  const validUrl = trimmed && !liveUrlError ? trimmed : null;
  const dirty = trimmed !== (record.mediaUrl ?? "") || route !== record.checkoutRoute || JSON.stringify(observations) !== JSON.stringify(record.observations);
  // Follow the server to a newer version only while there is no unsaved draft, so a conflict never discards one.
  const [syncedVersion, setSyncedVersion] = useState(record.version);
  if (syncedVersion !== record.version && !dirty) {
    setSyncedVersion(record.version);
    setMediaUrl(record.mediaUrl ?? "");
    setRoute(record.checkoutRoute);
    setObservations(record.observations);
  }
  const serverErrors = save.error instanceof AdapterError ? save.error.body.fieldErrors ?? {} : {};
  const shownUrlError = urlError ?? serverErrors.mediaUrl ?? null;

  const active = observations.filter((o) => o.recordedAgainst === validUrl);
  const stale = observations.length - active.length;
  const visual = coveredSeconds(observations, "visual", validUrl);
  const audio = coveredSeconds(observations, "audio", validUrl);
  const coverage = (s: number) => (s > 0 ? `Partial · ${formatTime(s)} observed` : "Not reviewed");

  const intervalMissing = selectedPost && !selectedPost.review.watchedIntervals.length && !selectedPost.review.heardIntervals?.length;
  const saveBlocked = blockedReason(res, "saveEvidenceDraft") ?? (intervalMissing ? "No continuous visual or heard-audio intervals were recorded." : null);
  const watchedBlocked = blockedReason(res, "markWatched") ?? "Not available.";
  const onSave = () => {
    if (source) { setEditor("observation"); return; }
    if (liveUrlError) {
      setUrlError(liveUrlError);
      return;
    }
    setUrlError(null);
    save.mutate({ resourceKind: "evidenceDraft", resourceRef: record.evidenceRef, expectedVersion: record.version, payload: { mediaUrl: validUrl, checkoutRoute: route, observations } });
  };
  const noChange = save.data?.reasonCodes.includes("NO_CHANGE");

  return (
    <>
      <LeaveGuard dirty={dirty && !save.isPending} />
      <div className={styles.titleRow}>
        <div className={styles.heading}>
          <h1 id="evidence-title">Watch the routine. Keep the evidence.</h1>
          <p>{qualification ? "Selected review · server-owned creator evidence · partial draft kept separate" : "Selected review · lifestyle-only Instagram or TikTok Shop footage · source access to validate"}</p>
        </div>
        <Button variant="secondary" style={{ minWidth: 180 }} loading={save.isPending} disabledReason={saveBlocked} onClick={onSave}>Save partial review</Button>
        <Button style={{ minWidth: 164 }} disabledReason={watchedBlocked} reasonFor={watchedReasonId}>Mark watched</Button>
      </div>
      <AcquisitionTabs current="Video evidence" evidencePath={reviewPath} />
      <div className={styles.context}>
        <p className={styles.contextTitle}>A caption is context. Playback is evidence.</p>
        <p className={styles.small}>Review actual GRWM, workday, organizing, travel or product-in-routine footage. Clinical lectures, IVF explainers and generic medical education do not qualify.</p>
      </div>
      {!source && (save.data || record.savedAt) && (
        <p role="status" data-testid="save-status" className={styles.status}>
          {noChange ? "Nothing to save: the draft matches version " : "Saved as version "}{record.version.replace("v", "")}. A saved draft is not a completed review.
        </p>
      )}
      {save.error && <ActionError error={save.error} />}

      <div className={styles.twoCol}>
        <section className={styles.card} aria-labelledby="player-title" style={{ gap: "var(--space-20)" }}>
          <div className={styles.sectionTitle}>
            <h2 id="player-title" className={styles.h2}>Original lifestyle video</h2>
            <p className={styles.small}>{selectedPost ? "Recorded media provenance and source access for this selected post." : validUrl ? "Clip address recorded · playback isn't connected, so no visual or audio observation counts as watched." : "No clip loaded · no visual or audio observation has been completed."}</p>
          </div>
          {source && selectedPost ? <SavedSourcePlayer source={source} post={selectedPost}/> : <><div className={styles.player} data-testid="player">
            <Badge tone="violet" width={168}>{validUrl ? "Playback not verified" : "Playback pending"}</Badge>
            <p className={styles.playerTitle}>Open the permitted original.</p>
            <p className={styles.playerText}>A preview, caption or product list cannot establish the hook, demonstration, sound or story.</p>
            <div className={styles.playerActions}>
              <LinkButton to="/settings/capabilities" style={{ minWidth: 208 }}>Validate video access</LinkButton>
              {validUrl && <a href={validUrl} target="_blank" rel="noreferrer">Open the original in a new tab</a>}
            </div>
          </div>
          <TextField label="Original video URL" helpText="Keep the original asset identity; do not substitute a profile." error={shownUrlError} value={mediaUrl} placeholder="Awaiting validated source URL" onChange={(v) => { setMediaUrl(v); setUrlError(null); }} />
          </>}
          {stale > 0 && <p role="status" className={styles.small}>{stale} earlier {stale === 1 ? "observation was" : "observations were"} recorded against a different video, so {stale === 1 ? "it doesn't" : "they don't"} count here.</p>}
          <div className={styles.pairTight}>
            <Kpi label="Visual coverage" context="Record actual watched intervals" testId="metric-Visual coverage">{selectedPost ? selectedPost.review.visualMethod === "sampledFrames" ? `${selectedPost.review.sampledPoints.length} sampled points` : selectedPost.review.visualMethod === "continuous" ? `${selectedPost.review.watchedIntervals.length} recorded intervals` : "Not assessed" : coverage(visual)}</Kpi>
            <Kpi label="Audio coverage" context="Silent viewing is not audio review" testId="metric-Audio coverage">{selectedPost ? selectedPost.review.audioMethod : coverage(audio)}</Kpi>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="fit-title">
          <div className={styles.sectionTitle}>
            <h2 id="fit-title" className={styles.h2}>Separate fit from sales proof.</h2>
            <p className={styles.small}>The destination selects the commerce model.</p>
          </div>
          <SelectField label="Checkout route" disabled={Boolean(source)} helpText="Recruitment and publishing network remain independent." value={route} onChange={(v) => setRoute(v as CheckoutRoute)} options={ROUTES} />
          <div><Badge tone="violet" width={258} testId="model-badge">{MODEL_FOR_ROUTE[route]}</Badge></div>
          <Kpi hug label={qualification ? "Saved model" : "Published model"} context={qualification ? `${qualification.modelId} · as-assessed configuration ${qualification.config.version ?? "Unknown"}` : "Current agent configuration not returned."} testId={qualification ? "metric-Saved model" : "metric-Published model"}>{qualification ? (qualification.config.status === "bound" ? "Bound when assessed" : "Unbound when assessed") : record.modelPublication.label}</Kpi>
          <div className={styles.pairTight}>
            <Kpi hug label={qualification ? "Demonstration / story" : "Creative quality"} context={qualification ? "Agent rating · independent floor ≥3" : "Actual framing, hook and story"} testId="metric-Creative quality">{qualification ? rating(qualification.criteria.demo) : record.assessments.creative.state === "known" ? record.assessments.creative.value : "Unknown"}</Kpi>
            <Kpi hug label="Routine compatibility" context={qualification ? "Agent rating · independent floor ≥3" : "Observed product format + use"} testId="metric-Routine compatibility">{qualification ? rating(qualification.criteria.routine) : record.assessments.routine.state === "known" ? record.assessments.routine.value : "Unknown"}</Kpi>
          </div>
          <Kpi hug label="Commerce confidence" context="Comparable attributed outcomes; views alone are not sales proof." testId="metric-Commerce confidence">{record.assessments.commerce.state === "known" ? record.assessments.commerce.value : "Unknown"}</Kpi>
          <p className={styles.small}>TikTok Shop checkout uses TIKTOK-SHOP-AFFILIATE-v3. Earlier 84/82/86 examples are prior proposed snapshots, not validated sales predictions.</p>
          <div><Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 214 }} onClick={() => setDialog("model")}>Inspect model status</Button></div>
        </section>
      </div>

      <section className={styles.card} aria-labelledby="obs-title">
        <div className={styles.sectionTitle}>
          <h2 id="obs-title" className={styles.h2}>Say what you saw, and where.</h2>
          <p className={styles.small}>Observed intervals, not inferred health status. Bottle interaction does not prove ingestion.</p>
        </div>
        <DataTable
          caption="Time-coded review evidence"
          columns={[{ label: "Observation", width: "20.833%" }, { label: "Playback interval", width: "15.224%" }, { label: "Evidence status", width: "15.224%" }, { label: "Record" }]}
          testId="observation-table"
          rows={selectedPost ? [
            ...selectedPost.review.observedActions.map(a=>["Visual action",formatTime(a.atSec),selectedPost.review.visualMethod,a.action]),
            ...selectedPost.review.claims.map(c=>["Spoken or caption claim",formatTime(c.atSec),c.method,c.text]),
            ...selectedPost.review.inferences.map(text=>["Reviewer inference","Time not supplied","Inference",text]),
            ...selectedPost.review.watchedIntervals.map(i=>["Visual coverage",`${formatTime(i.startSec)}–${formatTime(i.endSec)}`,"Continuous","Source-recorded interval"]),
            ...selectedPost.review.sampledPoints.map(t=>["Visual coverage",formatTime(t),"Sampled frame","Discrete sample"]),
            ...(selectedPost.review.heardIntervals ?? []).map(i=>["Audio coverage",`${formatTime(i.startSec)}–${formatTime(i.endSec)}`,"Heard audio","Source-recorded interval"]),
          ] : (Object.keys(CATEGORY_LABEL) as ObservationCategory[]).map((category) => {
            const here = observations.filter((o) => o.category === category);
            return [
              CATEGORY_LABEL[category],
              here.length ? here.map((o) => `${formatTime(o.startSec)}–${formatTime(o.endSec)}`).join(", ") : category === "audio" ? "Not heard" : "Not observed",
              here.length ? (here.every((o) => o.recordedAgainst === validUrl) ? "Reviewer-recorded" : "Invalidated: different video") : "Unknown",
              here.length ? (
                <div key={category} className={styles.recordCell}>
                  {here.map((o) => (
                    <span key={o.id}>{o.text} <button type="button" className={styles.link} aria-label={`Remove observation ${formatTime(o.startSec)} to ${formatTime(o.endSec)}`} onClick={() => setObservations((all) => all.filter((x) => x.id !== o.id))}>Remove</button></span>
                  ))}
                </div>
              ) : PROMPTS[category],
            ];
          })}
        />
        <div className={styles.rowActions}>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 252 }} disabledReason={source ? saveBlocked : validUrl ? null : addReason} reasonFor={addReasonId} onClick={() => source ? setEditor("observation") : setDialog("observation")}>Add time-coded observation</Button>
          <Button variant="secondary" style={{ minWidth: 184 }} loading={save.isPending} disabledReason={saveBlocked} onClick={onSave}>Save partial review</Button>
          <Button style={{ minWidth: 164 }} disabledReason={watchedBlocked} reasonFor={watchedReasonId}>Mark watched</Button>
        </div>
        <ul className={styles.reasons}>
          {!validUrl && <li id={addReasonId}>Add time-coded observation: {addReason}</li>}
          <li id={watchedReasonId}>Mark watched: {watchedBlocked}</li>
        </ul>
      </section>

      <section className={styles.card} aria-labelledby="gates-title">
        <div className={styles.sectionTitle}>
          <h2 id="gates-title" className={styles.h2}>Keep the denominator attached.</h2>
          <p className={styles.small}>Views, reach, native GMV and retained net sales are different facts.</p>
        </div>
        <ul className={styles.gates}>
          {[
            { tone: "warning" as const, status: "Needs source", title: "Metric definition + window", note: "Exact native label, asset set, observation time and paid/organic scope" },
            { tone: "neutral" as const, status: "If applicable", title: "TikTok Shop product linkage", note: "A TikTok post alone is not proof of a Shop product or checkout route" },
            { tone: "neutral" as const, status: qualification?.routeEvidence?.acceptedTerms ? "Accepted terms on file" : "Not accepted", title: "Commission-only proposal", note: "An authorized invitation may precede willingness; activation requires real acceptance" },
            { tone: "warning" as const, status: selectedPost?.review.status ?? (visual + audio > 0 ? "Partial" : "Pending"), title: "Video review completion", note: "Visual/audio ranges, review depth and reviewer must be recorded" },
          ].map((g) => (
            <li key={g.title} className={styles.gate}>
              <div><Badge tone={g.tone} width={140}>{g.status}</Badge></div>
              <p className={styles.gateTitle}>{g.title}</p>
              <p className={styles.small}>{g.note}</p>
            </li>
          ))}
        </ul>
        <p className={styles.small}>Observed views and interactions need comparable definitions and complete inputs. Attractive lifestyle footage may still have unknown Farda routine or product-format fit; attributed sales require separate provider <br className="wide-break" />evidence.</p>
      </section>
      <p className={styles.small}>Evidence-review template · no source footage or metrics are fabricated · full, partial, captions-only and inaccessible states remain distinct.</p>
      {source ? <SavedAnnotations res={res} record={record} kind={editor} open={setEditor} readFresh={readFresh}/> : <EvidenceDisputes res={res} record={record} draftDirty={dirty} />}

      <ObservationDialog open={dialog === "observation"} mediaUrl={validUrl} onClose={() => setDialog(null)} onAdd={(o) => { setObservations((all) => [...all, o]); setDialog(null); }} />
      <Dialog open={dialog === "model"} title="Model status" onClose={() => setDialog(null)}>
        {qualification ? <QualificationDetails assessment={qualification} packet={record.agentEvidence} savedConfiguration /> : <>
          <p>Checkout route: {ROUTE_LABEL[route]}. Current model: {MODEL_FOR_ROUTE[route]}. Publication: {record.modelPublication.label}. Version: not returned.</p>
          <p>The evidence policy is approved. A current agent assessment and bound configuration have not been returned for this record. Earlier v2 snapshots remain historical and cannot authorize new acquisition.</p>
        </>}
        {qualification && <p className={styles.small}>This is the saved server assessment, independent of this partial-review draft. Editing the clip, route or observations here does not change its qualification or authorize an action. Its configuration is the one used when assessed; current model publications are listed in daily sourcing.</p>}
        <p>{selectedPost ? `Selected source review: ${selectedPost.review.status}. Visual ${selectedPost.review.visualMethod}, audio ${selectedPost.review.audioMethod}.` : `Evidence coverage: visual ${coverage(visual).toLowerCase()}, audio ${coverage(audio).toLowerCase()}.`}</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </>
  );
}

function ObservationDialog({ open, mediaUrl, onClose, onAdd }: { open: boolean; mediaUrl: string | null; onClose: () => void; onAdd: (o: Observation) => void }) {
  const [category, setCategory] = useState<ObservationCategory>("hook");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = () => {
    const startSec = parseTime(start);
    const endSec = parseTime(end);
    const found = validateObservation({ category, startSec: startSec ?? NaN, endSec: endSec ?? NaN, text });
    if (startSec === null) found.start = "Enter the start time as m:ss, for example 0:08.";
    if (endSec === null) found.end = "Enter the end time as m:ss, for example 0:31.";
    setErrors(found);
    if (Object.keys(found).length || !mediaUrl || startSec === null || endSec === null) return;
    onAdd({ id: `obs-${crypto.randomUUID().slice(0, 8)}`, category, startSec, endSec, text: text.trim(), recordedAgainst: mediaUrl });
    setStart(""); setEnd(""); setText("");
  };
  return (
    <Dialog open={open} title="Add time-coded observation" onClose={onClose}>
      <form className={styles.editor} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <p className={styles.small}>Record only what you actually watched or heard in the original video. This doesn't mark it watched, and nothing is saved until you save the review.</p>
        <SelectField label="What was observed" value={category} onChange={(v) => setCategory(v as ObservationCategory)} options={CATEGORIES} error={errors.category} helpText={category === "audio" ? "Counts toward audio coverage." : "Counts toward visual coverage."} />
        <div className={styles.editorRow}>
          <TextField label="From (m:ss)" value={start} onChange={setStart} error={errors.start} placeholder="0:00" />
          <TextField label="To (m:ss)" value={end} onChange={setEnd} error={errors.end} placeholder="0:08" />
        </div>
        <TextField label="Observation" value={text} onChange={setText} error={errors.text} multiline rows={3} helpText="Describe what is on screen or audible. Don't infer anyone's health." />
        <Button type="submit">Add observation</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </form>
    </Dialog>
  );
}
