import type { NativeApprovalView } from "@/creator-agent/actions/views";
import { LinkButton } from "@/components/Button";
import { Details } from "./shared";
import styles from "./Approvals.module.css";
import native from "./NativeApproval.module.css";

export function NativeApprovalExecution({data,current}:{data:NativeApprovalView;current:boolean}) {
  const execution=data.execution;
  return <section className={styles.card} aria-labelledby="native-approval-execution-title"><h2 id="native-approval-execution-title" className={styles.h2}>Recorded execution outcomes</h2>
    {!execution?<p>Unknown · canonical run linkage has not been returned. Local browser history is not substituted for source execution evidence.</p>:<>
      <p>{execution.coverage.returned} of {execution.coverage.total} canonical runs shown for immutable manifest version {data.manifestVersion}.{execution.coverage.complete?" This exact-version run query is complete.":" Coverage is partial; additional runs are not shown."}{!current?" Retained snapshot; refresh current state before taking an action.":""}</p>
      {execution.coverage.total===0?<p>No canonical run is recorded for this exact version. Approval alone does not confirm execution.</p>:<ol className={native.receiptList}>{execution.runs.map(run=><li key={run.runRef}><h3 className={styles.h3}>{run.providerRejectedItems?"Provider rejection recorded":run.executionCertainty==="uncertain"?"Original outcome uncertain":run.state==="failed"?"Execution failed":run.confirmedItems===run.totalItems?"Item receipts recorded":"Work remains in progress or held"}</h3><Details columns={2} rows={[
        ["Run",run.runRef],["Recorded runner state",run.state],["Execution certainty",run.executionCertainty],["Bound items",String(run.totalItems)],
        ["Receipt-confirmed",String(run.confirmedItems)],["Provider operations acknowledged",String(run.providerAcceptedItems)],["Provider operations rejected",String(run.providerRejectedItems)],
        ["Local artifacts confirmed",String(run.localArtifactItems)],["Without confirmed receipt",String(run.totalItems-run.confirmedItems)],["Unresolved attempted outcomes",String(run.unknownOutcomeItems)],
      ]}/><p className={styles.small}>Provider acknowledgment is an operation result, not a blanket delivery or business-success claim. Local artifacts are not sent messages. Confirmed receipts are retained when current authority changes.</p><div className={styles.actionsRow}><LinkButton variant="secondary" to={`/runs/${encodeURIComponent(run.runRef)}?tab=approval`}>Open recorded execution</LinkButton><LinkButton variant="secondary" to={`/runs/${encodeURIComponent(run.runRef)}?tab=recovery`}>Inspect execution recovery</LinkButton></div></li>)}</ol>}
    </>}
  </section>;
}
