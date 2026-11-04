import { useState } from "react";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Card, HandoffDialog, SectionHeading } from "@/features/analytics/parts";
import { DEMO_ASSESSMENT_CONTENT_ID, DEMO_ASSESSMENT_SC_ID, DEMO_ASSESSMENT_TIKTOK_ID, DEMO_EVIDENCE_ID, type ScorecardRecord } from "@/fixtures/scorecards";
import { bandOf, pointsOf, scoreOf } from "./scorecardMath";
import { HistoryDialog, RatingAnchorsDialog } from "./dialogs";
import a from "@/features/analytics/Analytics.module.css";
import s from "./Scorecards.module.css";

const GAUGE_R = 72;
const CIRC = 2 * Math.PI * GAUGE_R;
const pts = (n: number) => String(Math.round(n * 100) / 100);

/** The Content quality (37:74) and TikTok commerce (37:251) scorecards: one read-only historical v2 layout. */
export function ScorecardView({ record }: { record: ScorecardRecord }) {
  const [dialog, setDialog] = useState<"sheet" | "decision" | "anchors" | "history" | "evidence" | null>(null);
  const [evidence, setEvidence] = useState<ScorecardRecord["evidence"][number] | null>(null);
  const score = scoreOf(record.criteria);
  const band = bandOf(score.total);
  const tiktok = record.kind === "tiktok-commerce-v2";
  const gatesPending = record.gates.some((g) => g.tone === "warning");
  const noteId = `hold-note-${record.assessmentId}`;
  const primary = tiktok ? { label: "Prepare invitation", to: "/creators/tiktok/invitations/new" } : { label: "Recruitment queue", to: "/creators/social-cat/recruitment" };
  const verdict = band === "Needs data" ? "Needs data" : `Recommend ${band.toLowerCase()}`;
  return (
    <>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="assessment-title">{record.title}</h1>
          <p>{record.subtitle}</p>
        </div>
        <Button variant="secondary" style={{ minWidth: 176 }} aria-haspopup="dialog" onClick={() => setDialog("sheet")}>Open score sheet</Button>
        <Button style={{ minWidth: 176 }} aria-haspopup="dialog" onClick={() => setDialog("decision")}>Review decision</Button>
      </div>
      <nav aria-label="Recruitment sections" className={a.actions}>
        <LinkButton variant="secondary" to="/creators/social-cat?view=dashboard" style={{ minWidth: 206 }}>Social Cat dashboard</LinkButton>
        <LinkButton variant={tiktok ? "secondary" : "primary"} to={`/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_CONTENT_ID}`} style={{ minWidth: 206 }} aria-current={tiktok ? undefined : "page"}>SC scorecard</LinkButton>
        <LinkButton variant="secondary" to="/creators/social-cat/recruitment" style={{ minWidth: 206 }}>Recruitment queue</LinkButton>
        <LinkButton variant="secondary" to="/creators/tiktok?view=dashboard" style={{ minWidth: 206 }}>TikTok dashboard</LinkButton>
        <LinkButton variant={tiktok ? "primary" : "secondary"} to={`/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_TIKTOK_ID}`} style={{ minWidth: 206 }} aria-current={tiktok ? "page" : undefined}>TT scorecard</LinkButton>
        <LinkButton variant="secondary" to="/creators/tiktok/invitations/new" style={{ minWidth: 206 }}>Prepare invitation</LinkButton>
      </nav>
      <HistoricalContext note={record.historicalNote} creatorId={record.creatorId} />
      <div className={s.ctxRow}>
        <Badge tone="warning" width={268}>Synthetic example · not vetted</Badge>
        <Badge width={196}>{record.modelId}</Badge>
        <p className={a.small}>Public research examples are references only, never scored candidates.</p>
      </div>
      <div className={a.split} style={{ gridTemplateColumns: "400fr 876fr", gap: 20 }}>
        <section className={s.dark} aria-labelledby="priority-title">
          <h2 id="priority-title-handle">{record.handle}</h2>
          <div className={s.gauge} role="img" aria-label={score.total === null ? "Score unavailable: a criterion has no evidence" : `Score ${score.total} of 100`}>
            <svg width="180" height="180" viewBox="0 0 180 180" fill="none" aria-hidden="true">
              <circle cx="90" cy="90" r={GAUGE_R} stroke="var(--color-violetSoft)" strokeWidth="12" />
              {score.total !== null && <circle cx="90" cy="90" r={GAUGE_R} stroke="var(--color-violet)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${(score.total / 100) * CIRC} ${CIRC}`} transform="rotate(-90 90 90)" />}
            </svg>
            <div className={s.gaugeText} aria-hidden="true"><span className={s.gaugeScore} data-testid="score">{score.total === null ? "N/A" : score.total}</span><span className={s.gaugeOf}>OF 100</span></div>
          </div>
          <h2 id="priority-title">Priority score.</h2>
          <p className={s.darkText}>{score.total === null ? "A criterion has no evidence, so there is no total. Unknown is not zero." : "The score recommends review. Unverified hard gates still block an invitation."}</p>
          <div><Badge tone="warning" width={220}>{gatesPending ? "Hard gates pending" : "Hard gates verified"}</Badge></div>
          <hr className={s.darkRule} />
          <dl className={s.darkDetails} style={{ gap: 16 }}>
            <div><dt>Evidence coverage</dt><dd>{record.coveragePct === null ? "Unknown" : `${record.coveragePct}% · synthetic`}</dd></div>
            <div><dt>Confidence</dt><dd>Demo only</dd></div>
            <div><dt>Decision</dt><dd>Not approved to send</dd></div>
          </dl>
        </section>
        <Card labelledBy="weighted-title" className={a.gap18}>
          <h2 id="weighted-title" className={a.cardH2} style={{ margin: 0 }}>Six criteria. One clear recommendation.</h2>
          <p className={a.small}>Earned / maximum points · bars show criterion attainment</p>
          <ul className={s.criteria} aria-label="Weighted criteria">
            {record.criteria.map((c) => {
              const p = pointsOf(c);
              return (
                <li key={c.label} className={s.criterion}>
                  <span className={s.criterionLabel}><strong>{c.label}</strong><span>{c.rating === null ? "Needs data" : `Rating ${c.rating} / 5`} · weight {c.weight}</span></span>
                  <span className={`${a.track} ${s.barTrack}`} aria-hidden="true"><span className={a.fill} style={{ width: `${p === null ? 0 : (100 * p) / c.weight}%` }} /></span>
                  <span className={s.criterionPoints}>{p === null ? "Needs data" : `${pts(p)} / ${c.weight}`}</span>
                </li>
              );
            })}
          </ul>
          <hr className={a.divider} />
          <p className={a.small}>Points = weight × rating / 5. Unknown evidence is not zero and is never rescaled.</p>
        </Card>
      </div>
      <Card labelledBy="evidence-title" className={a.gap18}>
        <h2 id="evidence-title" className={a.cardH2} style={{ margin: 0 }}>Make the evidence inspectable.</h2>
        <p className={a.small}>Illustrative evidence records · actual source URL, observation date and metric window required before action.</p>
        <div className={s.evGrid}>
          {record.evidence.map((e) => (
            <div key={e.title} className={s.evCard}>
              <p className={s.evTitle}>{e.title}</p>
              <p className={s.evHeadline}>{e.headline}</p>
              <p className={a.small}>{e.note}</p>
              <Badge width={220}>{e.observed}</Badge>
              <Button variant="secondary" aria-haspopup="dialog" aria-label={`View evidence: ${e.title}`} onClick={() => { setEvidence(e); setDialog("evidence"); }}>View evidence</Button>
            </div>
          ))}
        </div>
      </Card>
      <Card labelledBy="gates-title">
        <h2 id="gates-title" className={a.cardH2} style={{ margin: 0 }}>Pass the gates before proposing an action.</h2>
        <div className={s.gateGrid}>
          {record.gates.map((g) => (
            <div key={g.label} className={s.gateCard}><strong>{g.label}</strong><Badge tone={g.tone} width={260}>{g.badge}</Badge></div>
          ))}
        </div>
        <p className={a.small}>Required: all hard gates verified, at least 80% evidence-weight coverage, and evidence refreshed within 7 days before outbound action. These are proposed operating defaults.</p>
      </Card>
      <section className={s.decision} aria-labelledby="decision-title">
        <div className={s.decisionRow}>
          <div className={s.decisionCopy}>
            <h2 id="decision-title">{verdict}. Keep the human gate.</h2>
            <p>80–100 priority · 65–79 manual review · below 65 hold. Missing critical evidence stays Needs data. Any failed hard gate overrides the score.</p>
          </div>
          <Button variant="secondary" style={{ minWidth: 190 }} disabledReason="Read-only historical snapshot" reasonFor={noteId}>Hold candidate</Button>
          <LinkButton to={primary.to} style={{ minWidth: 208 }}>{primary.label}</LinkButton>
        </div>
        <p id={noteId} className={a.small}>{record.decisionNote} Hold candidate is read-only: no current opportunity.</p>
      </section>
      <Card labelledBy="model-title">
        <SectionHeading id="model-title" level={3} title="Select the model for the job." />
        <p className={a.small}>{record.modelNote}</p>
        <div className={s.controls}>
          <LinkButton variant="secondary" to={`/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_CONTENT_ID}`} style={{ minWidth: 200 }} aria-current={tiktok ? undefined : "page"}>Content quality</LinkButton>
          <LinkButton variant="secondary" to={`/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_SC_ID}`} style={{ minWidth: 218 }}>Website commerce</LinkButton>
          <LinkButton variant="secondary" to={`/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_TIKTOK_ID}`} style={{ minWidth: 234 }} aria-current={tiktok ? "page" : undefined}>Native Shop commerce</LinkButton>
          <Button variant="ghost" style={{ minWidth: 190 }} aria-haspopup="dialog" onClick={() => setDialog("anchors")}>Rating anchors</Button>
          <Button variant="ghost" style={{ minWidth: 210 }} aria-haspopup="dialog" onClick={() => setDialog("history")}>Assessment history</Button>
        </div>
      </Card>
      <RatingAnchorsDialog open={dialog === "anchors"} onClose={() => setDialog(null)} modelId={record.modelId} criteria={record.criteria} />
      <HistoryDialog open={dialog === "history"} onClose={() => setDialog(null)} history={record.history} />
      <HandoffDialog open={dialog === "sheet"} onClose={() => setDialog(null)} title="Score sheet" rows={[{ label: "Model", value: `${record.modelId} (historical, proposed)` }, { label: "Link", value: "No verified score-sheet link in this build" }]}>
        <p>The sheet belongs to the scoring tool. Nothing opens, and the score here can't be edited.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "decision"} onClose={() => setDialog(null)} title="Decision" rows={[{ label: "Decision", value: "Not approved to send" }, { label: "Snapshot", value: `${record.modelId}, ${record.history.at(-1)?.at ?? ""}` }, { label: "Review owner", value: "Founder" }]}>
        <p>A historical snapshot can't qualify a new candidate or authorize an invitation. Open a current opportunity to decide.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "evidence"} onClose={() => { setDialog(null); setEvidence(null); }} title={evidence ? `Evidence · ${evidence.title}` : ""}
        rows={evidence ? [{ label: "Record", value: evidence.headline }, { label: "Observed", value: `${evidence.observed.replace("Observed ", "")}` }, { label: "Reviewer", value: "Demo reviewer (synthetic)" }, { label: "Model version", value: record.modelId }, { label: "Source URL", value: "Not recorded: required before any action" }, { label: "Unknowns", value: "Metric window and source URL" }] : []}>
        <p>Original evidence is read-only here, and unknowns stay unknown. The current evidence review is the lifestyle video review.</p>
        <LinkButton variant="secondary" to={`/creators/${record.creatorId}/evidence/${DEMO_EVIDENCE_ID}`} onClick={() => setDialog(null)}>Open lifestyle evidence review</LinkButton>
      </HandoffDialog>
    </>
  );
}

export function HistoricalContext({ note, creatorId, title = "Historical model snapshot" }: { note: string; creatorId: string; title?: string }) {
  return (
    <section className={s.hist} aria-label={title}>
      <p className={a.label}>{title}</p>
      <p className={a.small}>{note}</p>
      <div className={s.histActions}>
        <LinkButton variant="secondary" to={`/creators/${creatorId}/evidence/${DEMO_EVIDENCE_ID}`} style={{ minWidth: 224 }}>Review lifestyle evidence</LinkButton>
        <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
      </div>
    </section>
  );
}
