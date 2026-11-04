import { useSearchParams, useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { LinkButton } from "@/components/Button";
import { SelectField } from "@/components/Field";
import { FactList, Meter, Notice, Panel } from "@/components/Panels";
import { KpiCard, KpiGrid, Table, ViewShell } from "@/features/analytics/parts";
import { CEO_V1_COMMISSION_PCT, DEFAULT_REWARD_SCENARIO, EXAMPLE_NET_ORDER_MINOR, REWARD_CURRENCY, type RewardsRecord } from "@/fixtures/rewards";
import { summarize, tierStatusText, type Amount } from "./rewardLadder";
import { usd2, usdAuto } from "./scorecardMath";
import a from "@/features/analytics/Analytics.module.css";
import s from "./Scorecards.module.css";

const money = (minor: number) => usdAuto(minor / 100);
/** Unknown reads N/A with its reason. It is never shown or summed as $0. */
const amount = (v: Amount) => (v.state === "known" ? money(v.minor) : <span data-state="unknown">N/A <span className={s.reason}>{v.reason}</span></span>);

const PROVIDER_COMPAT = [
  { provider: "Shopify website · Collabs candidate", currency: `${REWARD_CURRENCY} only`, percentage: "Documented", fixed: "Not supported on the documented route", verified: "Account access unverified" },
  { provider: "TikTok Shop · native affiliate program", currency: `${REWARD_CURRENCY} only in this build`, percentage: "Unverified in this build", fixed: "Unverified in this build", verified: "Account access unverified" },
];

/** Creator Offer Economics v1 (THO-297): the reward ladder as a recommendation pending owner approval. Read-only; no purchase or payout control. */
export function RewardsPage() {
  const { offerId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const scenario = params.get("scenario") ?? DEFAULT_REWARD_SCENARIO;
  const query = useView<{ offerId: string; scenario: string }, RewardsRecord>("offerRewards", { offerId, scenario }, null, { keepPrevious: true });
  return (
    <section aria-labelledby="rewards-title" className={a.page}>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="rewards-title">Milestone rewards, earned on matured sales.</h1>
          <p>Creator Offer Economics v1 · recommendation pending owner approval · demo scenarios</p>
        </div>
        <LinkButton variant="secondary" to={`/offers/${offerId}`} style={{ minWidth: 176 }}>Back to the offer</LinkButton>
      </div>
      <ViewShell query={query} subject="The reward ladder" emptyTitle="No reward data" emptyBody="The source responded, but there is no reward record to show.">
        {(record) => <Rewards record={record} onScenario={(v) => setParams({ scenario: v }, { replace: true })} />}
      </ViewShell>
    </section>
  );
}

function Rewards({ record, onScenario }: { record: RewardsRecord; onScenario: (id: string) => void }) {
  const sc = record.scenario;
  const sum = summarize(sc);
  const replays = sum.tiers.reduce((n, t) => n + t.replays, 0);
  return (
    <>
      <Notice tone="warning" label="Recommendation" title="Pending owner approval" role="status" testId="rewards-recommendation">
        This is the consolidated v1 recommendation, not a live commercial activation. Provider and cost evidence is pending. No outreach, inventory reservation, commission funding or reward purchase is authorized here, and this page has no purchase or payout control.
      </Notice>
      <Panel id="scenario-title" title="Demo scenario" subtitle="Synthetic fixtures. Pick one to see how the ladder behaves.">
        <SelectField label="Fixture scenario" helpText={sc.description} value={sc.scenarioId} onChange={onScenario} options={record.scenarios.map((x) => ({ value: x.scenarioId, label: x.label }))} />
      </Panel>
      <KpiGrid>
        <KpiCard label="Canonical matured revenue" context={sum.refundedMinor || sum.excludedMinor ? `${money(sum.grossMaturedMinor)} matured − ${money(sum.refundedMinor)} refunds · ${money(sum.excludedMinor)} excluded${sum.refundExcessMinor ? ` · ${money(sum.refundExcessMinor)} of refunds exceed matured revenue, counted as $0` : ""}` : "Each canonical order counted once"} testId="metric-matured">{money(sum.maturedMinor)}</KpiCard>
        <KpiCard label="Pending orders" context={`${sum.pendingOrders} orders not yet matured · not counted`} testId="metric-pending">{money(sum.pendingMinor)}</KpiCard>
        <KpiCard label="Earned reward obligation" context="Allowance earned from claimed milestones" testId="metric-earned">{money(sum.earnedMinor)}</KpiCard>
        <KpiCard label="Outstanding obligation" context="Earned less redeemed" warn={sum.outstanding.state === "unknown"} testId="metric-outstanding">{amount(sum.outstanding)}</KpiCard>
      </KpiGrid>
      {sum.duplicateRowIds.length > 0 && (
        <Notice tone="violet" label="Deduplicated" title="Source mirror rows were ignored" role="status" testId="rewards-duplicates">
          {sum.duplicateRowIds.join(", ")} repeat orders already counted under the same canonical ID. Revenue counts once.
        </Notice>
      )}
      {sum.refundAdjustments.length > 0 && (
        <Notice tone="warning" label="Refund after claim" title="Earned rewards are preserved after a refund" role="status" testId="rewards-refund-adjustment">
          {sum.refundAdjustments.map((x) => `${sum.tiers.find((t) => t.tier.id === x.tier)!.tier.label}: matured revenue is now ${money(x.shortfallMinor)} under the ${money(sum.tiers.find((t) => t.tier.id === x.tier)!.tier.thresholdMinor)} threshold`).join("; ")}. The earned allowance is preserved and stays in the obligation. The refund is a separate adjustment for the owner to decide; it is never deducted from earned or outstanding.
        </Notice>
      )}
      {replays > 0 && (
        <Notice tone="violet" label="Replay" title="Replayed events claim nothing new" role="status" testId="rewards-replay">
          {replays} repeated deliveries of an unlock event were ignored. Each milestone is claimed once.
        </Notice>
      )}
      {sc.newCommitmentsPaused && (
        <Notice tone="warning" label="Paused" title="New reward commitments are paused" role="status" testId="rewards-paused">
          Earned obligations are preserved and stay payable under their own approvals. Pausing does not cancel or reduce what a creator has already earned.
        </Notice>
      )}
      <Panel id="progress-title" title="Progress to the next milestone" subtitle="Canonical cross-platform matured revenue, net of refunds and exclusions.">
        {sum.next ? (
          <>
            <Meter percent={sum.next.progressPct} label={`${Math.floor(sum.next.progressPct)} percent of the way to the ${sum.next.tier.label} milestone`} />
            <p className={a.small} data-testid="next-progress">
              {money(sum.maturedMinor)} of {money(sum.next.tier.thresholdMinor)} toward {sum.next.tier.label} · {money(sum.next.remainingMinor)} to go
            </p>
          </>
        ) : (
          <p className={a.small} data-testid="next-progress">Every milestone is earned. There is no next tier.</p>
        )}
      </Panel>
      <Panel id="ladder-title" title="The reward ladder" subtitle={`CEO-v1 recommendation · ${REWARD_CURRENCY}. A milestone is claimed once and the allowance is all-in.`}>
        <Table
          caption="Reward ladder"
          testId="reward-ladder"
          columns={[{ label: "Milestone", width: 200 }, { label: "Matured revenue", width: 150 }, { label: "Additional", width: 130 }, { label: "Cumulative cap", width: 150 }, { label: "Example orders", width: 150 }, { label: "Status", width: 260 }]}
          rows={sum.tiers.map((t) => ({
            key: t.tier.id,
            cells: [
              t.tier.label,
              money(t.tier.thresholdMinor),
              money(t.tier.additionalMinor),
              money(t.tier.cumulativeCapMinor),
              `≈ ${sum.orderEquivalents[t.tier.id].toLocaleString("en-US")}`,
              <span key="st" data-testid={`tier-${t.tier.id}`}>
                {t.earned ? <Badge tone="success">Earned{t.claimedAt ? " · claimed once" : ""}{t.belowThreshold ? " · kept after refund" : ""}</Badge> : <Badge>Locked</Badge>}{" "}
                {tierStatusText(t, money)}
              </span>,
            ],
          }))}
        />
        <p className={a.small}>Allowances are all-in: tax, shipping and fees come out of the allowance, not on top of it. There is no monthly reset. Order counts are examples at a {money(EXAMPLE_NET_ORDER_MINOR)} average net order, not a promise.</p>
      </Panel>
      <Panel id="obligations-title" title="Obligations beside cash commissions and Farda contribution" subtitle="Rewards are earned obligations. Cash commissions are paid separately.">
        <FactList
          label="Obligations"
          rows={[
            ["Earned reward obligation", <span key="e" data-testid="obl-earned">{money(sum.earnedMinor)}</span>],
            ["Redeemed", <span key="r" data-testid="obl-redeemed">{amount(sum.redeemed)}</span>],
            ["Outstanding", <span key="o" data-testid="obl-outstanding">{amount(sum.outstanding)}</span>],
            [`Creator cash commission (${CEO_V1_COMMISSION_PCT}%)`, <span key="c" data-testid="obl-commission">{usd2(sum.creatorCommissionMinor / 100)} on matured revenue</span>],
            ["Farda contribution", <span key="f" data-testid="obl-contribution">{amount(sum.fardaContribution)}</span>],
          ]}
        />
        <p className={a.small}>Contribution is illustrative: matured revenue less 45% commerce cost, commission, processing on commission and the earned allowance. It stays N/A until provider and cost evidence is complete.</p>
      </Panel>
      <Panel id="fees-title" title="Earned rewards are not upfront fees" subtitle="Two different things, kept apart.">
        <div className={s.compare}>
          <div>
            <Badge tone="success">Allowed</Badge>
            <h3>Guaranteed earned reward</h3>
            <p>Owed only after matured revenue reaches a milestone. It follows sales and cannot be paid before them.</p>
          </div>
          <div>
            <Badge tone="danger">Prohibited</Badge>
            <h3>Guaranteed upfront content fee</h3>
            <p>Money promised before any sale. New offers lock this at $0, and historical fees stay read-only and labeled.</p>
          </div>
        </div>
      </Panel>
      <Panel id="compat-title" title="Currency and provider compatibility" subtitle="Rate and base come from the offer; compatibility comes from the provider route.">
        <Table
          caption="Provider compatibility"
          testId="provider-compat"
          columns={[{ label: "Provider route", width: 280 }, { label: "Currency", width: 170 }, { label: "Percentage commission", width: 190 }, { label: "Fixed per qualified sale", width: 230 }, { label: "Access", width: 180 }]}
          rows={PROVIDER_COMPAT.map((p) => ({ key: p.provider, cells: [p.provider, p.currency, p.percentage, p.fixed, p.verified] }))}
        />
      </Panel>
      <p className={s.footer}>Synthetic workspace · recommendation pending owner approval · no reward is purchased, reserved or paid.</p>
    </>
  );
}
