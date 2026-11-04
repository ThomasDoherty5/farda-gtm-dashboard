import { useState } from "react";
import type { ActionResponse, ReadResponse } from "@/adapter/contract";
import type { BatchApprovalPayload } from "@/adapter/demoDiscovery";
import { useAction } from "@/adapter/useAction";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { formatMoney } from "@/components/MetricValue";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { DEMO_BATCH_ID } from "@/fixtures/ids";
import { heldReasons, seedItems } from "@/fixtures/batch";
import { RUN_STATES, type DiscoveryData } from "@/fixtures/discovery";
import styles from "./Acquisition.module.css";

const usd = (minorUnits: number) => formatMoney({ minorUnits, currency: "USD" });

/** A schedule reads Active only when its source account is known and access is verified. Anything unconfigured stays a draft. */
export function scheduleLabel(v: DiscoveryData["versions"]) {
  return v.scheduleStatus === "active" && v.sourceAccount.state === "known" && v.accessStatus === "Verified" ? "Active" : "Draft · not active";
}

/** Identity funnel arithmetic: what is left after merging duplicates and removing suppressed profiles. */
export function identityCounts(i: DiscoveryData["identity"]) {
  const suppressed = i.suppressed.optedOut + i.suppressed.declinedRecently + i.suppressed.existingRelationship;
  return { suppressed, unique: i.surfaced - i.mergedDuplicates, remaining: i.surfaced - i.mergedDuplicates - suppressed };
}

const sumOwners = (r: (typeof heldReasons)[number]) => Object.values(r.byOwner).reduce((x, y) => x + y, 0);
export const heldTotal = () => heldReasons.reduce((a, r) => a + sumOwners(r), 0);
export const reasonTotal = (key: string) => sumOwners(heldReasons.find((r) => r.key === key)!);

/** Counts for the run states from the sample batch's own items. A state the batch has no item in is a known 0. */
export function runStateCounts() {
  const items = seedItems();
  return RUN_STATES.map((r) => ({ ...r, count: r.batchState ? items.filter((i) => i.state === r.batchState).length : 0 }));
}

/** The daily plan in detail (DS-01, DS-02, DS-04, DS-06, DS-07). Requesting approval is an intent: nothing is approved, sent or reserved. */
export function PlanView({ res, data }: { res: ReadResponse<DiscoveryData>; data: DiscoveryData }) {
  const action = useAction<BatchApprovalPayload>();
  const [ack, setAck] = useState<ActionResponse | null>(null);
  const { batch, versions, identity } = data;
  const counts = identityCounts(identity);
  const blocked = blockedReason(res, "requestBatchApproval");
  const payload: BatchApprovalPayload = { batchId: batch.batchId, recipients: batch.eligible, rateLabel: batch.rateLabel, sampleUnits: batch.sampleUnits, sampleUnitCostMinor: batch.sampleUnitCost.minorUnits, upfrontFeeMinor: 0, policyVersion: versions.policyVersion };
  const request = () =>
    action.mutate(
      { operation: "requestApproval", actionKind: "requestBatchApproval", entityRefs: [], expectedVersion: res.dataVersion, approvalRef: null, manifestRef: null, payload },
      { onSuccess: (response) => setAck(response) },
    );
  const sourceAccount = versions.sourceAccount.state === "known" && versions.sourceAccount.value ? versions.sourceAccount.value : "N/A · account not read";
  return (
    <>
      <div className={styles.actions}><LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 190 }}>Back to the daily plan</LinkButton></div>
      <section className={styles.card} aria-labelledby="versions-title" data-testid="plan-versions">
        <div className={styles.sectionTitle}>
          <h2 id="versions-title" className={styles.h2}>What this plan is built on.</h2>
          <p className={styles.small}>A schedule is never active until a source account, timezone and access are configured.</p>
        </div>
        <dl className={styles.details}>
          <div><dt>Schedule</dt><dd data-testid="plan-schedule">{scheduleLabel(versions)}</dd></div>
          <div><dt>Source account</dt><dd data-testid="plan-source-account">{sourceAccount}</dd></div>
          <div><dt>ICP version</dt><dd>{versions.icpVersion}</dd></div>
          <div><dt>Policy version</dt><dd>{versions.policyVersion}</dd></div>
          <div><dt>Access status</dt><dd>{versions.accessStatus}</dd></div>
        </dl>
      </section>

      <section className={styles.card} aria-labelledby="steps-title">
        <div className={styles.sectionTitle}>
          <h2 id="steps-title" className={styles.h2}>Every step has an owner and a next action.</h2>
          <p className={styles.small}>Counts are from this synthetic example. A step with no count yet is N/A, not zero.</p>
        </div>
        <DataTable
          caption="Plan steps"
          columns={[{ label: "Step" }, { label: "Count" }, { label: "Owner" }, { label: "Evidence" }, { label: "Next action" }]}
          rows={data.steps.map((s) => [s.title, s.count === null ? `N/A · ${s.countLabel}` : `${s.count} ${s.countLabel}`, s.owner, s.evidence, s.next])}
          testId="plan-steps"
          minWidth={720}
        />
      </section>

      <section className={styles.card} aria-labelledby="identity-title">
        <div className={styles.sectionTitle}>
          <h2 id="identity-title" className={styles.h2}>One creator, counted once, and never contacted when suppressed.</h2>
          <p className={styles.small}>Profiles are merged by identity first, then suppressed profiles are removed. The rest is what the batch selects from.</p>
        </div>
        <DataTable
          caption="Identity, duplicates and suppression"
          columns={[{ label: "Stage" }, { label: "Profiles" }, { label: "Why" }]}
          rows={[
            ["Surfaced", String(identity.surfaced), "Permitted source search"],
            ["Merged as duplicates", `−${identity.mergedDuplicates}`, "The same creator on both networks or under a changed handle"],
            ["Opted out", `−${identity.suppressed.optedOut}`, "Suppressed permanently"],
            ["Declined recently", `−${identity.suppressed.declinedRecently}`, "Suppressed for this opportunity"],
            ["Existing relationship", `−${identity.suppressed.existingRelationship}`, "Already in an active collaboration"],
            ["Selected for review", String(identity.selected), `${counts.unique} unique identities − ${counts.suppressed} suppressed`],
          ]}
          testId="identity-table"
          minWidth={560}
        />
        <p className={styles.small}>Of the {identity.selected} selected, {batch.eligible} are eligible and {heldTotal()} are held, including {reasonTotal("duplicate")} for a duplicate offer.</p>
      </section>

      <section className={styles.card} aria-labelledby="states-title">
        <div className={styles.sectionTitle}>
          <h2 id="states-title" className={styles.h2}>What each run state means.</h2>
          <p className={styles.small}>Counts are the sample batch's own items. Nothing here has been sent.</p>
        </div>
        <DataTable
          caption="Run states"
          columns={[{ label: "State" }, { label: "Items" }, { label: "Meaning" }, { label: "Next" }]}
          rows={runStateCounts().map((r) => [r.label, String(r.count), r.meaning, r.next])}
          testId="run-states"
          minWidth={640}
        />
        <div><LinkButton variant="secondary" to={`/batches/${DEMO_BATCH_ID}`} style={{ minWidth: 190 }}>Open sample batch</LinkButton></div>
      </section>

      <section className={styles.card} aria-labelledby="intent-title" data-testid="approval-intent">
        <div className={styles.sectionTitle}>
          <h2 id="intent-title" className={styles.h2}>Ask for approval of this finite batch.</h2>
          <p className={styles.small}>This requests a decision on exactly these recipients and terms. It does not approve, send or reserve anything.</p>
        </div>
        <dl className={styles.details}>
          <div><dt>Batch</dt><dd>{batch.batchId}</dd></div>
          <div><dt>Recipients</dt><dd>{batch.eligible} named, eligible</dd></div>
          <div><dt>Terms</dt><dd>{batch.rateLabel} · {usd(0)} upfront fee</dd></div>
          <div><dt>Sample allocation</dt><dd>{batch.sampleUnits} × {usd(batch.sampleUnitCost.minorUnits)} = {usd(batch.sampleUnits * batch.sampleUnitCost.minorUnits)}</dd></div>
          <div><dt>Policy</dt><dd>{versions.policyVersion}</dd></div>
        </dl>
        <div className={styles.actions}>
          <Button loading={action.isPending} disabledReason={blocked ?? undefined} onClick={request} style={{ minWidth: 252 }}>Request approval for this batch</Button>
        </div>
        {action.error && <ActionError error={action.error} />}
        {ack && (
          <p className={styles.small} role="status" data-testid="approval-ack">
            <Badge tone="warning">Approval pending</Badge> Requested as {ack.approvalRef}, waiting for {ack.nextAction?.ownerRef ?? "the approver"}. Not approved and not sent: a send needs the approval, then a source receipt.
          </p>
        )}
      </section>
    </>
  );
}

