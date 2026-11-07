import type { NativeRunView } from "@/creator-agent/actions/views";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { Details, dateTime } from "./shared";
import { reviewValue } from "./NativeReview";
import styles from "./Approvals.module.css";
import native from "./NativeApproval.module.css";

const actions = {
  signInAtSource: "Source owner must sign in through the permitted source handoff.",
  completeMfaAtSource: "Source owner must complete MFA in the owning source.",
  ownerPermissionReview: "Source owner must review the explicit denial; another route cannot bypass it.",
  waitForSourceReset: "Wait for the source-confirmed reset, then recheck current access and quota.",
  inspectFailure: "Inspect the recorded failure and current source evidence before continuation.",
  reconcileOriginal: "Reconcile the exact original attempt. Do not resend or generate a new key.",
  none: "No source recovery task is recorded for this item.",
  sourceEvidenceRequired: "Current source recovery evidence is required.",
};
const outcomes = { unstarted: "No provider attempt started", open: "Original attempt remains open", applied: "Exact attempt applied", closedNotApplied: "Exact original attempt closed as not applied", unknown: "Attempt outcome unknown" };
export function NativeRunRecovery({data,current}:{data:Pick<NativeRunView,"items">;current:boolean}) {
  return <section className={styles.card} aria-labelledby="native-item-recovery-title"><h2 id="native-item-recovery-title" className={styles.h2}>Item state and recovery evidence</h2><p className={styles.small}>Runner progress, source access and exact attempt closure are separate. A missing receipt is not proof that an action was unsent.</p><ol className={native.receiptList}>{data.items.map((item,index)=><RecoveryItem key={item.itemRef} item={item} index={index} current={current}/>)}</ol></section>;
}
function RecoveryItem({item,index,current}:{item:NativeRunView["items"][number];index:number;current:boolean}) {
  const execution=item.execution, recovery=execution?.recovery;
  const leased=useSourceLease(recovery?.validUntil), permitted=Boolean(current && leased && recovery?.observedAt && Date.parse(recovery.observedAt)<=Date.now());
  return <li><h3 className={styles.h3}>Item {index+1}</h3><p className={native.ref}>{item.itemRef}</p><Details columns={2} rows={[
    ["Runner state",execution ? `${execution.state}${current ? "" : " · retained snapshot"}` : "Unknown · state not returned"],
    ["Runner attempts",execution ? String(execution.attempts) : "Unknown"],
    ["Checkpoint version",execution ? String(execution.checkpointVersion) : "Unknown"],
    ["Next due",execution ? dateTime(execution.dueAt) : "Unknown"],
    ["Runner reason",execution?.reasonCode ?? "No reason returned"],
    ["Original attempt",execution ? outcomes[execution.attemptOutcome.state] : outcomes.unknown],
    ["Provider attempt number",execution?.attemptOutcome.attemptNumber ? String(execution.attemptOutcome.attemptNumber) : "Unknown or not applicable"],
    ["Attempt evidence",execution?.attemptOutcome.receiptRef ?? "No exact attempt receipt returned"],
    ["Source recovery",permitted && recovery ? recovery.kind : "Unknown · current source evidence required"],
    ["Source owner",reviewValue(recovery?.owner,permitted)],
    ["Source deadline",permitted && recovery?.deadline ? dateTime(recovery.deadline) : "Unknown · no current source deadline"],
    ["Source reset",permitted && recovery?.resetAt ? dateTime(recovery.resetAt) : "Unknown · no current source reset"],
  ]}/><p>{permitted && recovery ? actions[recovery.nextAction] : actions.sourceEvidenceRequired}</p>
  {execution?.attemptOutcome.state === "closedNotApplied" && <p className={styles.small}>The recorded closure applies only to this original attempt. Current approval, account, policy, capacity and resource checks still gate guarded continuation; no new source key is authorized here.</p>}
  {(execution?.attemptOutcome.state === "open" || execution?.attemptOutcome.state === "unknown" || !execution) && <p className={styles.small}>Keep any unresolved original attempt held until its source result is reconciled.</p>}
  </li>;
}
