import { useState } from "react";
import type { ApprovalReview, ReviewField, ReviewLink } from "@/creator-agent/actions/reviewViews";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { useClockCheck, useSourceLease } from "@/features/commercial/useSourceLease";
import { Details, dateTime } from "./shared";
import styles from "./Approvals.module.css";

export function useReviewAccess(review: ApprovalReview | undefined, current: boolean) {
  const leased = useSourceLease(review?.validUntil);
  const observed = useClockCheck(now => Boolean(review?.observedAt && Date.parse(review.observedAt) <= now));
  return Boolean(current && leased && observed);
}
export function reviewValue(field: ReviewField | undefined, permitted: boolean): string {
  if (!permitted) return "Unavailable · current display permission required";
  if (!field || field.state === "unavailable") return "Unavailable · " + (field?.reasonCode ?? "REVIEW_FIELD_UNAVAILABLE");
  return field.state === "redacted" ? "Source redacted · " + field.value : field.value;
}
export function permittedReviewUrl(link: ReviewLink | undefined, permitted: boolean) { return permitted && link?.state === "available" ? link.url : null; }

const settlementLabels: Record<NonNullable<ApprovalReview>["settlement"]["lane"], string> = {
  manualHistoricalPayable: "Historical manual payable · read-only",
  collabsAutoSettlement: "Shopify Collabs automatic settlement",
  tiktokAutoSettlement: "TikTok Shop automatic settlement",
  notApplicable: "Not applicable for this action", unknown: "Unknown · source lane not returned",
};

/** Source-granted display only. This panel never creates approval or execution permission. */
export function NativeReview({ review, current, heading = "Source-authorized action review" }: { review?: ApprovalReview; current: boolean; heading?: string }) {
  const permitted = useReviewAccess(review, current);
  const [settlementOpen,setSettlementOpen]=useState(false);
  const lane=permitted && review ? review.settlement.lane : "unknown";
  return <section className={styles.panel} aria-label={heading}>
    <h3 className={styles.h3}>{heading}</h3>
    <p className={styles.small}>{!permitted ? "Source display permission is missing, stale or expired. Protected fields and links are withheld until refreshed." : review?.state === "complete" ? "The current source permits the operational fields shown below for this exact version." : "This is a partial source review. Redacted or unavailable fields are not an exact complete payload."}</p>
    <Details columns={2} rows={[
      ["Provider",reviewValue(review?.context.provider,permitted)], ["Source account",reviewValue(review?.context.account,permitted)],
      ["Requested by",reviewValue(review?.context.requestedBy,permitted)], ["Reviewer",reviewValue(review?.context.reviewer,permitted)],
      ["Role recorded for this version",reviewValue(review?.context.historicalRole,permitted)],
      ["Display permission valid until",review?.validUntil ? dateTime(review.validUntil) : "Unknown"],
    ]}/>
    {review?.items.map((item,index)=><div className={styles.payload} key={item.itemRef}>
      <p className={styles.payloadTitle}>Item {index+1} · exact version review</p>
      <Details rows={[["Recipient",reviewValue(item.recipient,permitted)],["Product",reviewValue(item.product,permitted)],["Terms",reviewValue(item.terms,permitted)]]}/>
      <p className={styles.label}>Source payload</p><p className={styles.message} data-testid="native-review-payload">{reviewValue(item.payload,permitted)}</p>
      <p className={styles.payloadNote}>The immutable manifest binds this item. Display permission is separate from decision and dispatch authority.</p>
    </div>)}
    {!review?.items.length && <p className={styles.message}>Exact payload, recipient and product context were not returned. No source content is inferred from opaque references.</p>}
    <div className={styles.handoff}><h3 className={styles.h3}>Settlement context</h3><p>{settlementLabels[lane]}</p><p className={styles.small}>{reviewValue(review?.settlement.detail,permitted)}</p><p className={styles.small}>A historical payable is not a new acquisition offer. Native platform settlement is not a manual payment instruction. This view cannot pay or initiate settlement.</p><Button variant="secondary" aria-haspopup="dialog" onClick={()=>setSettlementOpen(true)}>Inspect settlement reconciliation</Button></div>
    <div className={styles.actionsRow}>{review && Object.entries(review.links).map(([kind,link])=> {
      const url=permittedReviewUrl(link,permitted);
      return url?<a key={kind} href={url} target="_blank" rel="noopener noreferrer">{link.label}</a>:<span key={kind} className={styles.small}>{link.label}: unavailable</span>;
    })}</div>
    <Dialog open={settlementOpen} title={"Reconciliation · "+settlementLabels[lane]} onClose={()=>setSettlementOpen(false)}>
      <p>{lane==="manualHistoricalPayable"?"Review the already accepted historical obligation and its owning payable record. No new fee or payment is authorized by this dialog.":lane==="collabsAutoSettlement"?"Shopify Collabs owns this native commission settlement. Do not create a duplicate manual per-sale payable.":lane==="tiktokAutoSettlement"?"TikTok Shop owns this native affiliate settlement. This route does not convert it into a manual payment.":lane==="notApplicable"?"This source-bound action does not have a settlement task.":"The service has not returned current permission for a provider-specific settlement context."}</p>
      <p>{reviewValue(review?.settlement.detail,permitted)}</p><p>Financial receipt: Unknown · no separately verified payment receipt is included in this review. The action receipt does not establish that funds settled.</p>
      {permittedReviewUrl(review?.links.settlement,permitted)?<a href={permittedReviewUrl(review?.links.settlement,permitted)!} target="_blank" rel="noopener noreferrer">Open permitted settlement record</a>:<p>No permitted settlement source link is available.</p>}
      <Button variant="secondary" onClick={()=>setSettlementOpen(false)}>Close reconciliation</Button>
    </Dialog>
  </section>;
}
