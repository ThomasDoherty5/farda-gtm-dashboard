import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import type { NativeInvitationView } from "@/creator-agent/recruitment/contract";
import { dateTime } from "@/features/approvals/shared";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { acquisition, creators, styles } from "./recruitmentShared";
const observedDate = (value: string | null) => value === null ? "Unknown" : dateTime(value);

/** Source-native units are separate dimensions, never an inferred aggregate balance. */
export function RecruitmentCapacity({ values, current }: { values: NativeInvitationView["capacity"]; current: boolean }) {
  const expiries = values.flatMap(value => value.validUntil ? [Date.parse(value.validUntil)] : []);
  const earliest = expiries.length ? new Date(Math.min(...expiries)).toISOString() : null;
  const lease = useSourceLease(earliest);
  return <section className={creators.panel} aria-labelledby="recruitment-capacity-title"><h2 id="recruitment-capacity-title" className={acquisition.h2}>Recheck before each write.</h2>
    <p className={acquisition.small}>Approval is necessary. Current source access, stock, budget and quota still determine whether each item can execute. Forecast commissions never cap earned obligations.</p>
    <DataTable caption="Source capacity by native unit" columns={[{label:"Capacity"},{label:"Remaining / limit"},{label:"Unit"},{label:"Observed / reset"},{label:"Evidence"}]} rows={values.map(value=>{
      const known=current&&lease&&value.validUntil!==null;
      return [value.kind,`${known&&value.remaining!==null?value.remaining:"Unknown"} / ${known&&value.limit!==null?value.limit:"Unknown"}`,value.currency?`${value.unit} · ${value.currency}`:value.unit,`${observedDate(value.observedAt)} / ${observedDate(value.resetAt)}`,value.reasonCodes.join(" · ")||"Current source observation"];
    })}/>
    {!values.length&&<p>No source capacity observations were returned. Capacity is Unknown.</p>}
    <LinkButton variant="secondary" to="/settings/capabilities">Open capacity and access</LinkButton>
  </section>;
}

const routes={verifiedApi:"Verified API · PENDING Open request",permittedBrowser:"Independently permitted browser route",ownerHandoff:"Owner permission handoff",held:"Held · current capability required"};
export function RecruitmentSamples({ values, current }: { values: NativeInvitationView["samples"]; current: boolean }) {
  const lease = useSourceLease(values.length ? new Date(Math.min(...values.map(value => Date.parse(value.validUntil)))).toISOString() : null);
  current = current && lease;
  return <section className={creators.panel} aria-labelledby="recruitment-samples-title"><h2 id="recruitment-samples-title" className={acquisition.h2}>Approve samples inside TikTok.</h2>
    <p>Supported PENDING Open requests may use the verified API. Other routes require independent permission. Permission denial 16022020 requires the source owner; it never authorizes a browser bypass.</p>
    {!values.length&&<p>No source-confirmed sample request is available. Invitation acceptance does not approve a sample.</p>}
    {values.map(sample=><div key={sample.requestRef} className={styles.sampleGrid}><div className={styles.sampleInfo}><h3 className={creators.h3}>{sample.requestRef}</h3><dl className={styles.sampleList}>
      <div className={styles.sampleRow}><dt>Native request state</dt><dd>{sample.requestType} · {sample.nativeState}</dd></div>
      <div className={styles.sampleRow}><dt>Native deadline</dt><dd>{observedDate(sample.deadline)}</dd></div>
      <div className={styles.sampleRow}><dt>Execution route</dt><dd>{current?routes[sample.route]:"Unknown · refresh current permission"}</dd></div>
      <div className={styles.sampleRow}><dt>Capability evidence</dt><dd>{current?(sample.capabilityVersion??"Unknown"):"Unknown"}</dd></div>
    </dl><p className={acquisition.small}>{sample.reasonCodes.join(" · ")||"The owning source provides these request facts."}</p></div>
    <div className={styles.sampleBox}><h3 className={creators.h3}>Source evidence closes the step.</h3><p>Review the exact sample decision, its stock allocation and native receipt separately. Unknown results retain their original attempt.</p>
      {current&&sample.approvalRef?<LinkButton to={`/approvals/${encodeURIComponent(sample.approvalRef)}`}>Review sample decision</LinkButton>:<Button disabledReason="A source-authorized exact sample decision is required.">Review sample decision</Button>}
      {current&&sample.runRef?<LinkButton variant="secondary" to={`/runs/${encodeURIComponent(sample.runRef)}?tab=recovery`}>Review sample receipt</LinkButton>:<Button variant="secondary" disabledReason="No source-bound sample run was returned.">Review sample receipt</Button>}
      <p className={acquisition.small}>Receipt: {sample.receiptRef??"Unknown · no native decision receipt"}</p>
    </div></div>)}
  </section>;
}
