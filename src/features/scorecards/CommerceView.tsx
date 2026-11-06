import { useState } from "react";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { SectionTabs } from "@/components/SectionTabs";
import { Card, HandoffDialog, KpiCard, Table } from "@/features/analytics/parts";
import { DEMO_ASSESSMENT_CONTENT_ID, DEMO_ASSESSMENT_TIKTOK_ID, DEMO_OFFER_DRAFT_ID, offerDraftSeed, type CommerceScorecardRecord } from "@/fixtures/scorecards";
import { HistoryDialog } from "./dialogs";
import { HistoricalContext } from "./ScorecardView";
import { bandOf, economics, pointsOf, scoreOf, usdAuto, usd2 } from "./scorecardMath";
import { ReadinessNote } from "./readiness";
import a from "@/features/analytics/Analytics.module.css";
import s from "./Scorecards.module.css";

const GATE_NOTE = "Historical payment and content-only records remain readable. New acquisition requires commission-only terms; select the current model by checkout destination.";

/** The Social Cat commerce scorecard (Figma 65:814, CTRL-115, CTRL-116): a read-only SC-COMMERCE-v2 snapshot beside the independent content score. */
export function CommerceView({ record }: { record: CommerceScorecardRecord }) {
  const [dialog, setDialog] = useState<"eligibility" | "evidence" | "cohort" | "history" | null>(null);
  const score = scoreOf(record.criteria);
  const band = bandOf(score.total);
  const offer = economics(offerDraftSeed.assumptions, offerDraftSeed.payload);
  return (
    <>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="assessment-title">Commercial fit, with evidence.</h1>
          <p>Synthetic candidate {record.handle} · {record.route}</p>
        </div>
        <LinkButton variant="secondary" to={`/offers/${DEMO_OFFER_DRAFT_ID}`} style={{ minWidth: 198 }}>Open offer</LinkButton>
        <Button style={{ minWidth: 200 }} aria-haspopup="dialog" onClick={() => setDialog("eligibility")}>Review eligibility</Button>
      </div>
      <div className={s.tabsFixed}>
      <SectionTabs label="Assessment models" tabs={[
        { label: "Content quality", to: `/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_CONTENT_ID}`, width: 137 },
        { label: "Website commerce", to: `/creators/${record.creatorId}/assessments/${record.assessmentId}`, width: 144, current: true },
        { label: "Native Shop commerce", to: `/creators/${record.creatorId}/assessments/${DEMO_ASSESSMENT_TIKTOK_ID}`, width: 172 },
      ]} />
      </div>
      <HistoricalContext creatorId={record.creatorId} note="The 82-point example belongs to the earlier proposed SC-COMMERCE-v2 model and AFF-01 draft. Current website acquisition uses WEBSITE-AFFILIATE-v3 after lifestyle evidence review and model publication." />
      <ReadinessNote record={record} />
      <section className={s.hist} aria-label="SC-COMMERCE-v2 prior proposed snapshot">
        <p className={a.label}>SC-COMMERCE-v2 · prior proposed snapshot</p>
        <p className={a.small}>Read-only historical example: {score.total ?? "no"} points for affiliate-only AFF-01 with $0 fixed fee. Creative quality, routine compatibility and attributed sales remain separate evidence dimensions.</p>
      </section>
      <Card labelledBy="score-title" className={a.card20}>
        <h2 id="score-title" className="visually-hidden">Commerce score and evidence</h2>
        <div className={s.score2}>
          <div className={s.col}>
            <KpiCard label="Commerce fit" context="Proposed priority band · score alone does not authorize action" testId="metric-commerce-fit">{score.total === null ? "N/A" : `${score.total} / 100`}</KpiCard>
            <KpiCard label="Evidence coverage" context="Synthetic complete evidence · refresh within 7 days" testId="metric-coverage">{record.coveragePct === null ? "Unknown" : `${record.coveragePct}%`}</KpiCard>
            <KpiCard label="Content quality" context="CONTENT-v2 · independent score, never averaged with commerce" testId="metric-content-score">{record.contentScore} / 100</KpiCard>
            <span><Badge tone="warning" width={224}>Execution gates pending</Badge></span>
          </div>
          <div className={s.col}>
            <div className={s.heading54}>
              <h3 style={{ margin: 0, font: "var(--text-h2)" }}>A score you can explain.</h3>
              <p>Integer ratings 0–5 · points = weight × rating ÷ 5.</p>
            </div>
            <Table
              cell12
              caption="Weighted assessment"
              columns={[{ label: "Criterion", width: 516 }, { label: "Weight", width: 132 }, { label: "Rating", width: 132 }, { label: "Points", width: 132 }]}
              rows={record.criteria.map((c) => ({ key: c.label, cells: [c.label, String(c.weight), c.rating === null ? "Needs data" : `${c.rating} / 5`, pointsOf(c) === null ? "Needs data" : String(pointsOf(c))] }))}
            />
            <div className={s.legend}>
              <Badge tone={band === "Priority review" ? "violet" : "neutral"} width={150}>80+ priority</Badge>
              <Badge width={160}>65–79 review</Badge>
              <Badge width={132}>&lt;65 hold</Badge>
            </div>
            <p className={a.small}>These earlier bands and weights belong to this historical snapshot. The current v3 model is published by the creator agent.</p>
          </div>
        </div>
      </Card>
      <section className={`${s.hist} ${s.histSubtle}`} aria-label="Offer-bound economics AFF-01">
        <p className={a.label}>Offer-bound economics · AFF-01</p>
        <p className={a.small}>Historical affiliate-only draft: $0 fixed fee + {usdAuto(offerDraftSeed.payload.sampleShippingMinor / 100)} sample; forecast contribution {usd2(offer.base.contribution)} at {offer.base.orders} orders / {usd2(offer.downside.contribution)} at {offer.downside.orders} orders. New upfront-fee offers are blocked under the current policy.</p>
      </section>
      <Card labelledBy="unknowns-title" className={a.card20}>
        <div className={s.heading54}>
          <h2 id="unknowns-title">Commerce evidence is more than reach.</h2>
          <p>Orders, conversion and refunds need a comparable denominator, cohort and window.</p>
        </div>
        <Table
          cell12
          caption="Commerce evidence and unknowns"
          columns={[{ label: "Evidence", width: 360 }, { label: "Window / source", width: 420 }, { label: "Coverage", width: 240 }, { label: "Action", width: 228 }]}
          rows={record.evidenceRows.map((r) => ({
            key: r.evidence,
            cells: [
              r.evidence, r.window, r.coverage,
              r.target === "offer"
                ? <LinkButton key="a" variant="secondary" to={`/offers/${DEMO_OFFER_DRAFT_ID}`} style={{ minWidth: 164 }}>{r.action}</LinkButton>
                : <Button key="a" variant="ghost" style={{ minWidth: 164 }} aria-haspopup="dialog" onClick={() => setDialog(r.target === "evidence" ? "evidence" : "cohort")}>{r.action}</Button>,
            ],
          }))}
        />
        <section className={`${s.hist} ${s.histSubtle}`} aria-label="If commerce history is unknown">
          <p className={a.label}>If commerce history is unknown</p>
          <p className={a.small}>Keep missing commerce evidence unknown. Attractive lifestyle footage or high view counts do not establish retained sales. Any exploration route needs explicit current policy, source access and budget approval.</p>
        </section>
      </Card>
      <Card labelledBy="gates-title" className={a.card20}>
        <div className={s.heading54}>
          <h2 id="gates-title">Check eligibility for the next action.</h2>
          <p>Score {score.total ?? "N/A"} belongs to the affiliate-only example. A later-stage requirement does not block an earlier legitimate step.</p>
        </div>
        <ul className={s.rowGates} aria-label="Execution gates">
          {record.gates.map((g) => (
            <li key={g.title} className={s.rowGate}><span><Badge tone={g.tone} width={140}>{g.badge}</Badge></span><strong>{g.title}</strong><span>{g.detail}</span></li>
          ))}
        </ul>
        <p className={a.small}>{GATE_NOTE}</p>
      </Card>
      <p className={s.footer}>Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.</p>
      <HandoffDialog open={dialog === "eligibility"} onClose={() => setDialog(null)} title="Eligibility for the next action"
        rows={record.gates.map((g) => ({ label: g.title, value: `${g.badge}. ${g.detail}` }))}>
        <p>This is a read-only check of a historical snapshot. It doesn't approve, invite or ship anything.</p>
        <Button variant="ghost" onClick={() => setDialog("history")}>Assessment history</Button>
      </HandoffDialog>
      <HandoffDialog open={dialog === "evidence"} onClose={() => setDialog(null)} title="Attributable retained orders"
        rows={[{ label: "Source", value: "Verified provider record + matched contract (synthetic)" }, { label: "Coverage", value: "Complete demo" }, { label: "Reviewer and time", value: "Demo reviewer · 29 Oct 2026" }, { label: "Model version", value: "SC-COMMERCE-v2 (proposed)" }, { label: "Unknowns", value: "Native order records aren't in this fixture" }]}>
        <p>Original evidence belongs to the commerce source. Nothing opens from here, and the unknowns stay unknown.</p>
      </HandoffDialog>
      <HandoffDialog open={dialog === "cohort"} onClose={() => setDialog(null)} title="Conversion and refund cohort"
        rows={[{ label: "Cohort", value: "Comparable website cohort, synthetic" }, { label: "Opportunity grain", value: "One creator, one campaign" }, { label: "Numerator and denominator", value: "Retained orders over attributed sessions; counts aren't in this fixture" }, { label: "As of", value: "29 Oct 2026" }, { label: "Stage facts", value: "Achievement counts, not current-stage exclusive counts" }]}>
        <p>Membership and filters are read-only here. Current-stage counts and achievement counts are never mixed.</p>
      </HandoffDialog>
      <HistoryDialog open={dialog === "history"} onClose={() => setDialog(null)} history={record.history} />
    </>
  );
}
