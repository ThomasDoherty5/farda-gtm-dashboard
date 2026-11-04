import { useId, useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useSave } from "@/adapter/useSave";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Dialog } from "@/components/Dialog";
import { SelectField, TextField } from "@/components/Field";
import { ActionError, blockedReason, dateTime } from "@/features/approvals/shared";
import { CATEGORY_LABEL, READINESS_TEXT, formatTime, parseTime, readinessOf, validateDispute } from "./evidenceRules";
import type { Dispute, DisputeDraft, DisputeStance, EvidenceRecord, Observation, ObservationCategory } from "./evidenceTypes";
import styles from "./EvidenceDisputes.module.css";
import page from "./Acquisition.module.css";

const CATEGORIES = (Object.keys(CATEGORY_LABEL) as ObservationCategory[]).map((value) => ({ value, label: CATEGORY_LABEL[value] }));
const span = (o: Pick<Observation, "startSec" | "endSec">) => `${formatTime(o.startSec)}–${formatTime(o.endSec)}`;
const describe = (o: Pick<Observation, "category" | "startSec" | "endSec" | "text">) => `${CATEGORY_LABEL[o.category]} · ${span(o)} · ${o.text}`;

/**
 * Reviewer disagreement and override (VE-08, CTRL-154's contract). The first reviewer's record is shown as it was
 * recorded and never edited. A disagreement or override is added beside it with a reason, and the page says what it
 * does not do: it doesn't change coverage, mark anything watched, make the evidence ready or authorize outreach.
 * Recording one is its own save against the saved version, so it can't ride along with an unsaved draft.
 */
export function EvidenceDisputes({ res, record, draftDirty, draftMedia }: { res: ReadResponse<EvidenceRecord>; record: EvidenceRecord; draftDirty: boolean; /** The address in the draft, which may not be saved yet. A dispute only applies to the video it was recorded against. */ draftMedia: string | null }) {
  const [target, setTarget] = useState<Observation | null>(null);
  const [recorded, setRecorded] = useState<{ version: string; noChange: boolean } | null>(null);
  const first = record.firstReview;
  const readiness = readinessOf(record);
  const disputedIds = new Set(record.disputes.map((d) => d.observationId));
  const capabilityReason = blockedReason(res, "recordDisagreement");
  const reason = capabilityReason ?? (draftDirty ? "Save or discard your draft first. A disagreement is recorded against the saved version." : null);
  const reasonId = useId();

  return (
    <section className={page.card} aria-labelledby="dispute-title" data-testid="disputes">
      <div className={page.sectionTitle}>
        <h2 id="dispute-title" className={page.h2}>Disagree without erasing.</h2>
        <p className={page.small}>The first reviewer's record stays as recorded. A disagreement or override is added beside it, with a reason. It doesn't change coverage, mark the clip watched, make the evidence ready or authorize outreach.</p>
      </div>

      <div className={styles.readiness} data-testid="readiness" role="status">
        <strong>Not ready.</strong>
        <ul>{readiness.reasonCodes.map((code) => <li key={code}>{READINESS_TEXT[code] ?? code}</li>)}</ul>
      </div>
      {recorded && (
        <p role="status" className={page.small} data-testid="dispute-status">
          {recorded.noChange ? "Already on file: this disagreement matches one recorded at version " : "Recorded at version "}{recorded.version.replace("v", "")}. The first reviewer's record is unchanged.
        </p>
      )}

      {first ? (
        <>
          <div>
            <p className={styles.label}>First reviewer's record</p>
            <p className={page.small}>Recorded by {first.reviewerRole} at version {first.version.replace("v", "")}, {dateTime(first.recordedAt)}. Read-only.</p>
          </div>
          <ul className={styles.log} aria-label="First reviewer's observations">
            {first.observations.map((o) => (
              <li key={o.id} className={styles.entry}>
                <div className={styles.entryHead}>
                  <Badge tone={disputedIds.has(o.id) ? "warning" : "neutral"} width={132}>{disputedIds.has(o.id) ? "Disputed" : "Recorded"}</Badge>
                  <p className={styles.label}>{CATEGORY_LABEL[o.category]} · {span(o)}</p>
                </div>
                <p>{o.text}</p>
                <div>
                  <Button
                    variant="secondary"
                    aria-haspopup="dialog"
                    aria-label={`Disagree or override ${CATEGORY_LABEL[o.category].toLowerCase()} ${formatTime(o.startSec)} to ${formatTime(o.endSec)}`}
                    disabledReason={reason}
                    reasonFor={reasonId}
                    style={{ minWidth: 224 }}
                    onClick={() => setTarget(o)}
                  >Disagree or override</Button>
                </div>
              </li>
            ))}
          </ul>
          {reason && <p id={reasonId} className={page.small}>Disagree or override: {reason}</p>}
        </>
      ) : (
        <p className={page.small} data-testid="no-first-review">No review is on file to dispute. Save a partial review first; the first observations saved become the first reviewer's record.</p>
      )}

      {record.disputes.length > 0 && (
        <>
          <p className={styles.label}>Disagreements and overrides</p>
          <ul className={styles.log} aria-label="Disagreements and overrides">
            {record.disputes.map((d) => <DisputeEntry key={d.id} dispute={d} current={draftMedia} />)}
          </ul>
        </>
      )}

      {/* Always mounted, so the browser's own close() hands focus back to the control that opened it. The form inside mounts fresh each time. */}
      <Dialog open={target !== null && first !== null} title="Disagree or override" onClose={() => setTarget(null)}>
        {target && (
          <DisputeForm
            record={record}
            target={target}
            onClose={() => setTarget(null)}
            onRecorded={(version, noChange) => { setTarget(null); setRecorded({ version, noChange }); }}
          />
        )}
      </Dialog>
    </section>
  );
}

function DisputeEntry({ dispute: d, current }: { dispute: Dispute; current: string | null }) {
  const applies = d.recordedAgainst === current;
  const says = d.proposed === "remove" ? "Remove this observation." : d.proposed ? describe(d.proposed) : "Disagrees. Proposes no replacement.";
  return (
    <li className={styles.entry} data-testid="dispute-entry" data-stance={d.stance}>
      <div className={styles.entryHead}>
        <Badge tone={d.stance === "override" ? "violet" : "neutral"} width={132}>{d.stance === "override" ? "Override" : "Disagreement"}</Badge>
        {!applies && <Badge tone="warning" width={190}>Invalidated: different video</Badge>}
      </div>
      <div className={styles.prior}>
        <p className={page.small}>First reviewer recorded</p>
        <p>{describe(d.prior)}</p>
      </div>
      <p><span className={styles.label}>Says: </span>{says}</p>
      <p><span className={styles.label}>Reason: </span>{d.reason}</p>
      <p className={page.small}>Recorded by {d.reviewerRole}, {dateTime(d.recordedAt)}.</p>
    </li>
  );
}

function DisputeForm({ record, target, onClose, onRecorded }: { record: EvidenceRecord; target: Observation; onClose: () => void; onRecorded: (version: string, noChange: boolean) => void }) {
  const save = useSave<DisputeDraft, EvidenceRecord>();
  const [stance, setStance] = useState<DisputeStance>("disagree");
  const [remove, setRemove] = useState(false);
  const [category, setCategory] = useState<ObservationCategory>(target.category);
  const [start, setStart] = useState(formatTime(target.startSec));
  const [end, setEnd] = useState(formatTime(target.endSec));
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const groupId = useId();

  const serverErrors = save.error instanceof AdapterError ? save.error.body.fieldErrors ?? {} : {};
  const shown = (field: string) => errors[field] ?? serverErrors[field];

  const submit = () => {
    const startSec = parseTime(start);
    const endSec = parseTime(end);
    const proposed: DisputeDraft["proposed"] = stance === "disagree" ? null : remove ? "remove" : { category, startSec: startSec ?? NaN, endSec: endSec ?? NaN, text };
    const found = validateDispute({ stance, reason, proposed });
    if (stance === "override" && !remove) {
      if (startSec === null) found["proposed.start"] = "Enter the start time as m:ss, for example 0:08.";
      if (endSec === null) found["proposed.end"] = "Enter the end time as m:ss, for example 0:31.";
    }
    setErrors(found);
    if (Object.keys(found).length) return;
    save.mutate(
      { resourceKind: "reviewerAssessment", resourceRef: record.evidenceRef, expectedVersion: record.version, payload: { kind: "dispute", observationId: target.id, stance, reason: reason.trim(), proposed: proposed && proposed !== "remove" ? { ...proposed, text: proposed.text.trim() } : proposed } },
      { onSuccess: (r) => onRecorded(r.resourceVersion, r.reasonCodes.includes("NO_CHANGE")) },
    );
  };

  return (
      <form className={page.editor} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <div className={styles.prior}>
          <p className={page.small}>First reviewer recorded. This stays as it is.</p>
          <p>{describe(target)}</p>
        </div>
        <fieldset className={styles.fields} aria-describedby={`${groupId}-help`}>
          <legend>What are you recording?</legend>
          <label className={styles.radio}><input type="radio" name={`${groupId}-stance`} checked={stance === "disagree"} onChange={() => setStance("disagree")} /><span>Disagree. I don't think this is right, but I'm not proposing a replacement.</span></label>
          <label className={styles.radio}><input type="radio" name={`${groupId}-stance`} checked={stance === "override"} onChange={() => setStance("override")} /><span>Override. I'm proposing what it should say, or that it should be removed.</span></label>
          <p id={`${groupId}-help`} className={page.small}>Either way, the first record is kept and this is added beside it.</p>
        </fieldset>

        {stance === "override" && (
          <>
            <Checkbox label="Remove this observation instead of replacing it" checked={remove} onChange={setRemove} />
            {!remove && (
              <>
                <SelectField label="What was observed" value={category} onChange={(v) => setCategory(v as ObservationCategory)} options={CATEGORIES} error={shown("proposed.category")} />
                <div className={page.editorRow}>
                  <TextField label="From (m:ss)" value={start} onChange={setStart} error={shown("proposed.start")} placeholder="0:00" />
                  <TextField label="To (m:ss)" value={end} onChange={setEnd} error={shown("proposed.end")} placeholder="0:08" />
                </div>
                <TextField label="What it should say" value={text} onChange={setText} error={shown("proposed.text")} multiline rows={3} helpText="Only what is on screen or audible. Don't infer anyone's health." />
              </>
            )}
            {shown("proposed") && <p role="alert" className={page.small}>{shown("proposed")}</p>}
          </>
        )}

        <TextField label="Reason" value={reason} onChange={setReason} error={shown("reason")} multiline rows={3} helpText="Required. The next reviewer reads this beside the original." />
        {(shown("observationId") || shown("stance") || shown("kind")) && <p role="alert" className={page.small}>{shown("observationId") ?? shown("stance") ?? shown("kind")}</p>}
        {save.error && !(save.error instanceof AdapterError && save.error.category === "validation") && <ActionError error={save.error} />}
        <Button type="submit" loading={save.isPending}>Record {stance === "override" ? "override" : "disagreement"}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </form>
  );
}
