import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { useIsDemo } from "@/features/analytics/parts";
import type { Criterion, HistoryEntry } from "@/fixtures/scorecards";
import a from "@/features/analytics/Analytics.module.css";

/** The displayed anchors belong to the historical proposed model (CTRL-066), separate from saved current-v3 assessments. */
export function RatingAnchorsDialog({ open, onClose, modelId, criteria }: { open: boolean; onClose: () => void; modelId: string; criteria: Criterion[] }) {
  const demo = useIsDemo();
  return (
    <Dialog open={open} title={`Rating anchors · ${modelId}`} badge={demo ? "Demo" : "Historical"} onClose={onClose}>
      <p>Historical, proposed anchors. Integer ratings 0 to 5; points = weight × rating ÷ 5. These anchors describe the historical model; current v3 configuration is shown in its saved agent assessment.</p>
      <dl className={a.defs}>
        {criteria.map((c) => <div key={c.label}><dt>{c.label}</dt><dd>Weight {c.weight} · anchor wording isn't part of this fixture</dd></div>)}
        <div><dt>Bands</dt><dd>80–100 priority · 65–79 manual review · below 65 hold</dd></div>
      </dl>
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}

/** Immutable evidence, model, policy and offer versions with the reason for each change (CTRL-067). Nothing here overwrites or requalifies. */
export function HistoryDialog({ open, onClose, history }: { open: boolean; onClose: () => void; history: HistoryEntry[] }) {
  const demo = useIsDemo();
  return (
    <Dialog open={open} title="Assessment history" badge={demo ? "Demo" : undefined} onClose={onClose}>
      <dl className={a.defs}>
        {history.map((h) => (
          <div key={h.version}><dt>{h.version} · {h.at}</dt><dd>Model {h.model} · policy {h.policy} · offer {h.offer}. {h.reason}</dd></div>
        ))}
      </dl>
      <p>Earlier versions are immutable. Viewing them doesn't overwrite a record or qualify a new candidate.</p>
      <Button variant="secondary" onClick={onClose}>Close</Button>
    </Dialog>
  );
}
