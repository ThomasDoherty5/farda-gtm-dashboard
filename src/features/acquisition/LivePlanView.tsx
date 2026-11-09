import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useSourceLease } from "@/adapter/useSourceLease";
import type { NativeSourcingPlan } from "@/creator-agent/sourcing/views";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { formatCount, formatMoney } from "@/components/MetricValue";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import { runStateKeys, type CapacityKind, type MissingReason, type ObservedCount, type SourcingPlan, type SourcingPlanBody, nextActionCodes } from "@/creator-agent/sourcing/contract";
import styles from "./Acquisition.module.css";

const FILTERS: Record<string, never> = {};
const STEP_LABEL = { discovery: "Discovery", identityResolution: "Identity resolution", videoReview: "Direct video review", qualification: "Qualification", invitationPlanning: "Invitation planning" } as const;
const SCHEDULE_LABEL = { active: "Active", draft: "Draft · not active", paused: "Paused · not active", unconfigured: "Unconfigured · not active" } as const;
const ACCESS_LABEL = { verified: "Access verified", unverified: "Access unverified", loginRequired: "Login / MFA required", denied: "Access denied", unknown: "Access unknown" } as const;
const SESSION_LABEL = { open: "session open", closed: "session closed", unknown: "session unknown" } as const;
const OWNER_LABEL = { "creator-agent": "Creator agent", operator: "Operator", reviewer: "Reviewer", founder: "Founder", operations: "Operations" } as const;
const SOURCE_LABEL = { "social-cat": "Social Cat", "tiktok-shop": "TikTok Shop", shared: "Shared" } as const;
const KIND_LABEL: Record<CapacityKind, string> = { invitations: "Invitations", collaborationSlots: "Collaboration slots", apiRequests: "API requests", browserActions: "Browser actions", sampleUnits: "Approved sample units", authorizedCost: "Authorized cost" };
const RUN_LABEL: Record<typeof runStateKeys[number], string> = { queued: "Queued", running: "Running", quotaDeferred: "Quota-deferred", loginRequired: "Login / MFA required", permissionDenied: "Permission denied", paused: "Paused", confirmed: "Confirmed", failed: "Failed", uncertain: "Uncertain" };

/** Copy for the source's enumerated codes. The service forwards codes only, never source prose. */
const REASON_COPY: Record<MissingReason, string> = {
  NOT_APPLICABLE: "not applicable", NOT_READ: "not read", SOURCE_DID_NOT_REPORT: "source did not report it", SOURCE_LIMIT_NOT_PUBLISHED: "source limit not published",
  SOURCE_PERMISSION_DENIED: "source permission denied", SOURCE_LOGIN_REQUIRED: "source login required", J20_REVIEW_INCOMPLETE: "direct video review incomplete",
  IDENTITY_RESOLUTION_INCOMPLETE: "identity resolution incomplete", RELATIONSHIP_LEDGER_NOT_READ: "relationship ledger not read", SUPPRESSION_LIST_NOT_READ: "suppression list not read",
  RECEIPT_NOT_RECONCILED: "receipt not reconciled", RUN_IN_PROGRESS: "run in progress", CAPACITY_NOT_REPORTED: "capacity not reported",
};
const NEXT_ACTION_COPY: Record<typeof nextActionCodes[number], string> = {
  RESOLVE_IDENTITIES: "Resolve identities", QUEUE_VIDEO_REVIEW: "Queue direct video review", REVIEW_REMAINING_CLIPS: "Review the remaining clips",
  FINISH_VIDEO_REVIEW: "Finish direct video review first", QUALIFY_REVIEWED_CREATORS: "Qualify reviewed creators", WAIT_FOR_QUALIFIED_CREATORS: "Wait for qualified creators",
  PREPARE_FINITE_PREVIEW: "Prepare a finite preview", RESTORE_SOURCE_ACCESS: "Restore source access", NONE: "None",
};
/** A known zero reads 0, N/A reads N/A, and an unknown reads Unknown with its reason. None is ever shown as another. */
const countText = (c: ObservedCount, format: (n: number) => string = formatCount) =>
  c.value !== null ? format(c.value) : c.missingReason === "NOT_APPLICABLE" ? "N/A" : `Unknown · ${REASON_COPY[c.missingReason!]}`;
const time = (iso: string | null, empty: string) => iso ? <time dateTime={iso}>{iso}</time> : empty;

/** The served daily plan detail (THO-287, Figma 102:555 plan view) on a live adapter. Read-only: it starts nothing, approves nothing and sends nothing. */
export function LivePlanView() {
  const query = useView<Record<string, never>, SourcingPlan>("sourcingPlan", FILTERS);
  const res = query.data;
  const data = query.isError ? null : res?.data ?? null;
  const native = data?.datasetKey === "sourcing-plan-native" ? data as NativeSourcingPlan : null;
  const expired = useSourceLease(native?.provenance.validUntil);
  const unconfigured = query.error instanceof AdapterError && query.error.body.code === "SOURCING_SOURCE_UNCONFIGURED";
  return <>
    <div className={styles.actions}><LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 190 }}>Back to the daily plan</LinkButton></div>
    <ReadState res={query.isError || expired ? undefined : res} subject="Daily sourcing plan" only={["stale", "partial"]} />
    {query.isPending && <SkeletonCard label="Loading the daily sourcing plan…" />}
    {query.isError && (unconfigured ? <EmptyState state="Error" title="Daily sourcing source not connected" alert><p>No qualified daily sourcing source is connected. Schedules, capacity and run counts remain Unknown.</p><Button onClick={() => void query.refetch()}>Refresh sourcing evidence</Button></EmptyState> : <ViewError error={query.error} subject="Daily sourcing plan" onRetry={() => void query.refetch()} />)}
    {expired && <EmptyState state="Error" title="Sourcing access lease expired" alert><p>Refresh to verify current access before viewing plan evidence.</p><Button onClick={() => void query.refetch()}>Refresh sourcing evidence</Button></EmptyState>}
    {native && !expired && <p className={styles.small} role="status">{native.provenance.synthetic ? "Synthetic owner evidence · sandbox" : "Source-owned plan evidence"}. Read only; this does not start discovery or authorize an invitation.</p>}
    {res && data && !expired && (data.plan ? <PlanDetail res={res} data={data} plan={data.plan} /> : <NoSource data={data} />)}
    {native && !expired && <Button variant="secondary" onClick={() => void query.refetch()} loading={query.isFetching}>Refresh sourcing evidence</Button>}
  </>;
}

function NoSource({ data }: { data: SourcingPlan }) {
  const unconfigured = data.sourceState === "unconfigured";
  return <EmptyState state={unconfigured ? "Empty" : "Error"} title={unconfigured ? "Daily sourcing source not connected" : "Daily sourcing source unavailable"} alert={!unconfigured}>
    <p>{unconfigured ? "No J19 daily sourcing source is configured for this workspace." : "The daily sourcing source did not answer."} No schedule, step count, capacity or run is shown, nothing here is demo data, and no value is assumed to be zero.</p>
    <p className={styles.small}>Reason: {data.missingReason} · read <time dateTime={data.observedAt}>{data.observedAt}</time></p>
  </EmptyState>;
}

function PlanDetail({ res, data, plan }: { res: ReadResponse<SourcingPlan>; data: SourcingPlan; plan: SourcingPlanBody }) {
  const { schedule, latestRun, identity } = plan;
  const approvalCapability = res.capabilities.find((c) => c.actionKind === "requestBatchApproval");
  // This view never requests approval itself; the approvals work owns that action, and it is not connected for anyone yet.
  const approval = approvalCapability?.state === "denied"
    ? "Requires the reviewer role. Batch approval is also not connected yet, so no role can request it here today."
    : "Batch approval is not connected yet. It belongs to the approvals work, not this plan view.";
  return <>
    <section className={styles.card} aria-labelledby="live-versions-title" data-testid="live-plan-versions">
      <div className={styles.sectionTitle}>
        <h2 id="live-versions-title" className={styles.h2}>What this plan is built on.</h2>
        <p className={styles.small}>Read from the daily sourcing source{data.sourceAsOf ? <> as of <time dateTime={data.sourceAsOf}>{data.sourceAsOf}</time></> : ""}. A schedule is active only when every source account is verified with an open session, a timezone and next run exist, and the read is current.</p>
      </div>
      <dl className={styles.details}>
        <div><dt>Schedule</dt><dd data-testid="live-plan-schedule"><Badge tone={schedule.effectiveState === "active" ? "success" : "warning"}>{SCHEDULE_LABEL[schedule.effectiveState]}</Badge>{schedule.declaredState !== schedule.effectiveState && <> · source claims {schedule.declaredState}</>}</dd></div>
        <div><dt>Cadence / timezone</dt><dd>{schedule.cadence ?? "Not set"} · {schedule.timezone ?? "Timezone not set"}</dd></div>
        <div><dt>Last run</dt><dd>{time(schedule.lastRunAt, "No run yet")}</dd></div>
        <div><dt>Next run</dt><dd>{time(schedule.nextRunAt, "Unknown")}</dd></div>
        {plan.sources.map((a) => <div key={a.source}><dt>{SOURCE_LABEL[a.source]} account</dt>
          <dd data-testid={`live-plan-account-${a.source}`}>{a.accountRef ? "Account read" : "Account unknown"} · {ACCESS_LABEL[a.access]} · {SESSION_LABEL[a.session]}</dd></div>)}
        <div><dt>ICP version</dt><dd>{plan.icpVersion ?? "Unknown"}</dd></div>
        <div><dt>Commission-only policy version</dt><dd>{plan.policyVersion ?? "Unknown"}</dd></div>
      </dl>
      {schedule.holdReasons.length > 0 && <p className={styles.small} data-testid="live-plan-schedule-holds">Not active because: {schedule.holdReasons.join(", ")}</p>}
    </section>

    <section className={styles.card} aria-labelledby="live-steps-title">
      <div className={styles.sectionTitle}>
        <h2 id="live-steps-title" className={styles.h2}>Every step has an owner and a next action.</h2>
        <p className={styles.small}>Counts are the source's own. A step the source has not counted is Unknown, not zero. A discovered or caption-only profile is never counted as video-reviewed or qualified.</p>
      </div>
      <DataTable caption="Daily plan steps" testId="live-plan-steps" minWidth={720}
        columns={[{ label: "Step" }, { label: "Count" }, { label: "Owner" }, { label: "Evidence" }, { label: "Next action" }]}
        rows={plan.steps.map((s) => [STEP_LABEL[s.step], countText(s.count), s.owner ? OWNER_LABEL[s.owner] : "Unassigned",
          s.evidenceRefs.length ? `${s.evidenceRefs.length} source receipt${s.evidenceRefs.length === 1 ? "" : "s"}` : "No receipt", NEXT_ACTION_COPY[s.nextAction]])} />
    </section>

    <section className={styles.card} aria-labelledby="live-capacity-title">
      <div className={styles.sectionTitle}>
        <h2 id="live-capacity-title" className={styles.h2}>Respect each source's limits.</h2>
        <p className={styles.small}>Each row stays in its own unit and is never added to another. Unknown, stale or exhausted capacity blocks dependent dispatch. There is no fixed daily maximum.</p>
      </div>
      <DataTable caption="Source capacity in native units" testId="live-plan-capacity" minWidth={860}
        columns={[{ label: "Source / capacity" }, { label: "Limit" }, { label: "Used" }, { label: "Remaining" }, { label: "Reading" }, { label: "Dispatch" }]}
        rows={plan.capacity.map((r) => {
          const format = r.kind === "authorizedCost" && r.currency ? (n: number) => formatMoney({ minorUnits: n, currency: r.currency! }) : (n: number) => `${formatCount(n)} ${r.unit}`;
          return [`${SOURCE_LABEL[r.source]} · ${KIND_LABEL[r.kind]}`, countText(r.limit, format), countText(r.used, format), countText(r.remaining, format),
            <span key="reading"><Badge tone={r.state === "current" ? "success" : r.state === "notApplicable" ? "neutral" : "warning"}>{{ current: "Current", stale: "Stale", unknown: "Unknown", notApplicable: "N/A" }[r.state]}</Badge>{r.resetAt && <> · resets {time(r.resetAt, "")}</>}</span>,
            r.dispatchBlocked ? `Blocked · ${r.blockReason}` : r.state === "notApplicable" ? "Not a limit for this source" : "Not blocked by this row"];
        })} />
    </section>

    <section className={styles.card} aria-labelledby="live-identity-title">
      <div className={styles.sectionTitle}>
        <h2 id="live-identity-title" className={styles.h2}>One creator, counted once, and never contacted when suppressed.</h2>
        <p className={styles.small}>Suppressed and already-invited opportunities cannot enter a new send set.</p>
      </div>
      <DataTable caption="Identity, duplicates and suppression" testId="live-plan-identity" minWidth={560}
        columns={[{ label: "Stage" }, { label: "Profiles" }]}
        rows={[["Surfaced", countText(identity.surfaced)], ["Merged as duplicates", countText(identity.mergedDuplicates)], ["Opted out", countText(identity.suppressedOptedOut)],
          ["Declined recently", countText(identity.suppressedDeclinedRecently)], ["Existing relationship", countText(identity.suppressedExistingRelationship)],
          ["Already invited", countText(identity.alreadyInvited)], ["Selected for review", countText(identity.selected)]]} />
    </section>

    <section className={styles.card} aria-labelledby="live-run-title">
      <div className={styles.sectionTitle}>
        <h2 id="live-run-title" className={styles.h2}>What the latest run did.</h2>
        <p className={styles.small}>{latestRun ? <>Started <time dateTime={latestRun.startedAt}>{latestRun.startedAt}</time>. Attempts, distinct opportunities and confirmed invitations are counted separately; every confirmed invitation has its own source receipt.</> : "N/A · no run has been read from the source yet."}</p>
      </div>
      {latestRun && <>
        <dl className={styles.details} data-testid="live-plan-run-totals">
          <div><dt>Execution attempts</dt><dd>{countText(latestRun.attempts)}</dd></div>
          <div><dt>Distinct opportunities attempted</dt><dd>{countText(latestRun.distinctOpportunities)}</dd></div>
          <div><dt>Confirmed unique invitations</dt><dd>{countText(latestRun.confirmedInvitations)} · {latestRun.receiptRefs.length} receipt{latestRun.receiptRefs.length === 1 ? "" : "s"}</dd></div>
        </dl>
        <DataTable caption="Latest run states" testId="live-plan-run-states" minWidth={480}
          columns={[{ label: "State" }, { label: "Items" }]} rows={runStateKeys.map((k) => [RUN_LABEL[k], countText(latestRun.states[k])])} />
      </>}
    </section>

    <section className={styles.card} aria-labelledby="live-holds-title" data-testid="live-plan-holds">
      <div className={styles.sectionTitle}>
        <h2 id="live-holds-title" className={styles.h2}>Why nothing is dispatched from here.</h2>
        <p className={styles.small}>Reading this plan never starts discovery, reserves capacity, approves a batch or sends an invitation.</p>
      </div>
      <ul>{plan.dispatchHoldReasons.map((r) => <li key={r} className={styles.small}>{r}</li>)}</ul>
      <div className={styles.actions}>
        <Button style={{ minWidth: 252 }} disabledReason={approval}>Request approval for a batch</Button>
      </div>
    </section>
  </>;
}
