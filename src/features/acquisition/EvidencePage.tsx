import { useId, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
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
import { ViewError } from "@/components/ViewError";
import { ActionError, LeaveGuard, blockedReason } from "@/features/approvals/shared";
import { CATEGORY_LABEL, MODEL_FOR_ROUTE, ROUTE_LABEL, coveredSeconds, formatTime, parseTime, validateMediaUrl, validateObservation } from "./evidenceRules";
import type { CheckoutRoute, EvidenceDraft, EvidenceRecord, Observation, ObservationCategory } from "./evidenceTypes";
import { AcquisitionTabs } from "./AcquisitionTabs";
import { EvidenceDisputes } from "./EvidenceDisputes";
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
  const filters = useMemo(() => ({ creatorId, evidenceId }), [creatorId, evidenceId]);
  const query = useView<{ creatorId: string; evidenceId: string }, EvidenceRecord>("evidenceRecord", filters);
  const record = query.data?.data ?? null;
  return (
    <section aria-labelledby="evidence-title" data-figma-source="102:364" className={styles.page}>
      {record ? (
        <Review key={record.evidenceRef} res={query.data as Res} record={record} />
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

function Review({ res, record }: { res: Res; record: EvidenceRecord }) {
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

  const saveBlocked = blockedReason(res, "saveEvidenceDraft");
  const watchedBlocked = blockedReason(res, "markWatched") ?? "Not available.";
  const onSave = () => {
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
          <p>Selected review · lifestyle-only Instagram or TikTok Shop footage · source access to validate</p>
        </div>
        <Button variant="secondary" style={{ minWidth: 180 }} loading={save.isPending} disabledReason={saveBlocked} onClick={onSave}>Save partial review</Button>
        <Button style={{ minWidth: 164 }} disabledReason={watchedBlocked} reasonFor={watchedReasonId}>Mark watched</Button>
      </div>
      <AcquisitionTabs current="Video evidence" />
      <div className={styles.context}>
        <p className={styles.contextTitle}>A caption is context. Playback is evidence.</p>
        <p className={styles.small}>Review actual GRWM, workday, organizing, travel or product-in-routine footage. Clinical lectures, IVF explainers and generic medical education do not qualify.</p>
      </div>
      {(save.data || record.savedAt) && (
        <p role="status" data-testid="save-status" className={styles.status}>
          {noChange ? "Nothing to save: the draft matches version " : "Saved as version "}{record.version.replace("v", "")}. A saved draft is not a completed review.
        </p>
      )}
      {save.error && <ActionError error={save.error} />}

      <div className={styles.twoCol}>
        <section className={styles.card} aria-labelledby="player-title" style={{ gap: "var(--space-20)" }}>
          <div className={styles.sectionTitle}>
            <h2 id="player-title" className={styles.h2}>Original lifestyle video</h2>
            <p className={styles.small}>{validUrl ? "Clip address recorded · playback isn't connected, so no visual or audio observation counts as watched." : "No clip loaded · no visual or audio observation has been completed."}</p>
          </div>
          <div className={styles.player} data-testid="player">
            <Badge tone="violet" width={168}>{validUrl ? "Playback not verified" : "Playback pending"}</Badge>
            <p className={styles.playerTitle}>Open the permitted original.</p>
            <p className={styles.playerText}>A preview, caption or product list cannot establish the hook, demonstration, sound or story.</p>
            <div className={styles.playerActions}>
              <LinkButton to="/settings/capabilities" style={{ minWidth: 208 }}>Validate video access</LinkButton>
              {validUrl && <a href={validUrl} target="_blank" rel="noreferrer">Open the original in a new tab</a>}
            </div>
          </div>
          <TextField label="Original video URL" helpText="Keep the original asset identity; do not substitute a profile." error={shownUrlError} value={mediaUrl} placeholder="Awaiting validated source URL" onChange={(v) => { setMediaUrl(v); setUrlError(null); }} />
          {stale > 0 && <p role="status" className={styles.small}>{stale} earlier {stale === 1 ? "observation was" : "observations were"} recorded against a different video, so {stale === 1 ? "it doesn't" : "they don't"} count here.</p>}
          <div className={styles.pairTight}>
            <Kpi label="Visual coverage" context="Record actual watched intervals" testId="metric-Visual coverage">{coverage(visual)}</Kpi>
            <Kpi label="Audio coverage" context="Silent viewing is not audio review" testId="metric-Audio coverage">{coverage(audio)}</Kpi>
          </div>
        </section>

        <section className={styles.card} aria-labelledby="fit-title">
          <div className={styles.sectionTitle}>
            <h2 id="fit-title" className={styles.h2}>Separate fit from sales proof.</h2>
            <p className={styles.small}>The destination selects the commerce model.</p>
          </div>
          <SelectField label="Checkout route" helpText="Recruitment and publishing network remain independent." value={route} onChange={(v) => setRoute(v as CheckoutRoute)} options={ROUTES} />
          <div><Badge tone="violet" width={258} testId="model-badge">{MODEL_FOR_ROUTE[route]}</Badge></div>
          <Kpi hug label="Published model" context={record.modelPublication.note} testId="metric-Published model">{record.modelPublication.label}</Kpi>
          <div className={styles.pairTight}>
            <Kpi hug label="Creative quality" context="Actual framing, hook and story" testId="metric-Creative quality">{record.assessments.creative.state === "known" ? record.assessments.creative.value : "Unknown"}</Kpi>
            <Kpi hug label="Routine compatibility" context="Observed product format + use" testId="metric-Routine compatibility">{record.assessments.routine.state === "known" ? record.assessments.routine.value : "Unknown"}</Kpi>
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
          rows={(Object.keys(CATEGORY_LABEL) as ObservationCategory[]).map((category) => {
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
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 252 }} disabledReason={validUrl ? null : addReason} reasonFor={addReasonId} onClick={() => setDialog("observation")}>Add time-coded observation</Button>
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
            { tone: "neutral" as const, status: "Not accepted", title: "Commission-only proposal", note: "An authorized invitation may precede willingness; activation requires real acceptance" },
            { tone: "warning" as const, status: visual + audio > 0 ? "Partial" : "Pending", title: "Video review completion", note: "Visual/audio ranges, review depth and reviewer must be recorded" },
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
      <EvidenceDisputes res={res} record={record} draftDirty={dirty} draftMedia={validUrl} />

      <ObservationDialog open={dialog === "observation"} mediaUrl={validUrl} onClose={() => setDialog(null)} onAdd={(o) => { setObservations((all) => [...all, o]); setDialog(null); }} />
      <Dialog open={dialog === "model"} title="Model status" onClose={() => setDialog(null)}>
        <p>Checkout route: {ROUTE_LABEL[route]}. Current model: {MODEL_FOR_ROUTE[route]}. Publication: {record.modelPublication.label}. Version: none published.</p>
        <p>{record.modelPublication.note} Weights stay unpublished until the lifestyle video research is complete (THO-286). Earlier v2 examples are historical and can't authorize new acquisition.</p>
        <p>Evidence coverage: visual {coverage(visual).toLowerCase()}, audio {coverage(audio).toLowerCase()}.</p>
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
