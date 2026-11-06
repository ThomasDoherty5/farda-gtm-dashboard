import { LeaveGuard } from "@/components/LeaveGuard";
import { useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, LinkButton } from "@/components/Button";
import { Field, SelectField, TextField } from "@/components/Field";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { Badge } from "@/components/Badge";
import { useView } from "@/adapter/useView";
import { useSave } from "@/adapter/useSave";
import { AdapterError } from "@/adapter/errors";
import { BUNDLES, TIERS, costKeys, newOfferTerms, offerTermsSchema, type OfferTerms, type OfferRecord, type RewardRecord } from "@/creator-agent/offers/contract";
import { Card, KpiCard, KpiGrid } from "@/features/analytics/parts";
import a from "@/features/analytics/Analytics.module.css";
import s from "./Scorecards.module.css";

const money=(minor:number|null)=>minor===null?"Unknown":new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(minor/100);
const rate=(bps:number|null)=>bps===null?"Unknown":`${bps/100}%`;
const opts=(values:string[])=>values.map(value=>({label:value,value}));

export function NewOffer() {
  const [params]=useSearchParams(), navigate=useNavigate();
  const [creator,setCreator]=useState(params.get("creator")??"");
  const [brief,setBrief]=useState(params.get("brief")??"");
  const [route,setRoute]=useState<OfferTerms["checkoutRoute"]>(params.get("route")==="tiktok-shop"?"tiktok-shop":"website");
  const [id]=useState(()=>`offer-${crypto.randomUUID()}`);
  const [error,setError]=useState("");
  const save=useSave<OfferTerms,OfferRecord>();
  const permissions=useView<{offerId:string},OfferRecord>("offerDraft",{offerId:"new"});
  const canEdit=permissions.data?.capabilities.some(c=>c.actionKind==="saveOfferDraft" && c.state==="available")===true;
  const create=()=>{
    if(!canEdit)return;
    const parsed=offerTermsSchema.safeParse(newOfferTerms(creator.trim(),route,brief.trim()));
    if(!parsed.success){setError("Enter a canonical creator ID and production brief reference.");return;}
    setError("");
    save.mutate({resourceKind:"actionDraft",resourceRef:id,expectedVersion:null,payload:parsed.data},{onSuccess:r=>navigate(`/offers/${encodeURIComponent(r.resourceRef)}`,{replace:true})});
  };
  return <section className={a.page} data-figma-source="65:634" aria-labelledby="offer-title">
    <div className={a.titleRow}><div className={a.heading}><h1 id="offer-title">Draft creator offer</h1><p>Start an inactive, commission-only proposal for a canonical creator.</p></div></div>
    <form onSubmit={e=>{e.preventDefault();create();}}><Card labelledBy="new-offer" className={a.card20}>
      <h2 id="new-offer">Offer identity</h2><fieldset disabled={!canEdit} className={s.editorFields}><legend className="visually-hidden">Offer identity</legend><div className={s.fieldsRow}>
        <TextField label="Creator ID" value={creator} onChange={setCreator}/><TextField label="Production brief reference" value={brief} onChange={setBrief}/>
        <SelectField label="Checkout route" value={route} onChange={v=>setRoute(v as typeof route)} options={opts(["website","tiktok-shop"])}/>
      </div></fieldset><Button type="submit" disabledReason={canEdit?null:permissions.isPending?"Checking reviewer access":"Reviewer access is required to create a draft."} loading={save.isPending}>Create offer draft</Button>
      {(error || save.error) && <p role="alert">{error || save.error?.message}</p>}
    </Card></form>
  </section>;
}

function NumberField({label,value,onChange,scale=1}:{label:string;value:number|null;onChange:(n:number|null)=>void;scale?:number}) {
  return <Field label={label}>{props=><input {...props} type="number" min="0" step={1/scale} value={value===null?"":value/scale}
    onChange={e=>onChange(e.target.value===""?null:Math.round(Number(e.target.value)*scale))}/>}</Field>;
}
const costLabels: Record<keyof OfferTerms["costs"],string> = {
  landedUnit:"Landed cost per bottle", fulfillmentPerOrder:"Shipping and fulfillment per order", providerFeePerOrder:"Provider fee per order",
  returnDefectPerOrder:"Returns and defects per order", samplePostagePerCreator:"Sample postage per creator", recruitment:"Cohort recruitment",
  advertising:"Cohort advertising", earnedRewards:"Already earned rewards", commissionAlreadyPaid:"Commission paid against accrual",
};
function ScenarioFields({label,scenario,onChange}:{label:"Base"|"Downside";scenario:OfferTerms["base"];onChange:(v:OfferTerms["base"])=>void}) {
  const set=(key:keyof typeof scenario,value:string|number|null)=>onChange({...scenario,[key]:value});
  return <fieldset><legend>{label} scenario</legend><div className={s.fieldsRow}>
    <SelectField label={`${label} bundle`} value={scenario.bundle} options={opts(["single","duo","trio"])} onChange={v=>set("bundle",v)}/>
    <NumberField label={`${label} orders`} value={scenario.orders} onChange={n=>set("orders",n??0)}/>
    <NumberField label={`${label} Shop Ads orders`} value={scenario.shopAdsOrders} onChange={n=>set("shopAdsOrders",n??0)}/>
    {([["refundPerOrderMinor","Refund per order"],["sellerDiscountMinor","Seller discount"],["platformCouponMinor","Platform coupon"],["fundedCouponMinor","Verified coupon reimbursement"]] as const)
      .map(([key,title])=><NumberField key={key} label={`${label} ${title} (USD)`} value={scenario[key]} scale={100} onChange={n=>set(key,key==="fundedCouponMinor"?n:n??0)}/>)}
  </div></fieldset>;
}
export function AgentOffer({record,canEdit}:{record:OfferRecord;canEdit:boolean}) {
  const baseTerms=useRef(record.terms);
  const [draft,setDraft]=useState(record.terms), [editingVersion,setEditingVersion]=useState(record.version);
  const [errors,setErrors]=useState<string[]>([]), [review,setReview]=useState(false);
  const save=useSave<OfferTerms,OfferRecord>();
  const change=<K extends keyof OfferTerms>(key:K,value:OfferTerms[K])=>setDraft(d=>({...d,[key]:value}));
  const submit=()=>{
    if(!canEdit)return;
    const parsed=offerTermsSchema.safeParse(draft);
    if(!parsed.success){setErrors(parsed.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`));return;}
    setErrors([]);
    save.mutate({resourceKind:"actionDraft",resourceRef:record.offerId,expectedVersion:editingVersion,payload:parsed.data},
      {onSuccess:r=>{baseTerms.current=r.record.terms;setDraft(r.record.terms);setEditingVersion(r.resourceVersion);}});
  };
  const reload=()=>{baseTerms.current=record.terms;setDraft(record.terms);setEditingVersion(record.version);setErrors([]);save.reset();};
  const provider=record.provider, saved=record.terms;
  return <>
    <LeaveGuard dirty={JSON.stringify(draft)!==JSON.stringify(baseTerms.current)} subject="offer draft" />
    <div className={a.titleRow}><div className={a.heading}><h1 id="offer-title">Terms that make sense.</h1><p>{saved.creatorId} · {saved.recruitmentSource} · {saved.publishingNetwork} · {saved.checkoutRoute}</p></div>
      <Button variant="secondary" loading={save.isPending} disabledReason={canEdit?null:"Read-only access. A reviewer can save draft changes."} onClick={submit}>Save offer draft</Button>
      <Button aria-haspopup="dialog" onClick={()=>setReview(true)}>Review commitment</Button></div>
    {(save.error||errors.length>0) && <div role="alert"><p>{save.error?.message ?? errors.join(" · ")}</p>
      {save.error instanceof AdapterError && save.error.category==="conflict" && <Button variant="secondary" onClick={reload}>Load latest saved terms</Button>}</div>}
    {save.isSuccess && <p role="status">Draft saved as {save.data.resourceVersion}.</p>}
    {record.version!==editingVersion && <p role="status">There is a newer saved version. <Button variant="ghost" onClick={reload}>Load latest saved terms</Button></p>}
    <div className={a.btnRow}>{record.assessment && <LinkButton variant="secondary" to={`/creators/${encodeURIComponent(saved.creatorId)}/assessments/${encodeURIComponent(record.assessment.runId)}`}>Saved scorecard</LinkButton>}
      <LinkButton variant="secondary" to={`/offers/${record.offerId}/rewards`}>Milestone rewards</LinkButton></div>
    <section className={s.hist} aria-label="Draft scenario"><Badge tone={record.state==="proposed"?"warning":"violet"}>{record.state}</Badge>
      <p className={a.small}>{record.offerId} · {record.version} · {record.assessment ? `${record.assessment.modelId} · ${record.assessmentCurrent?"current assessment":"review this terms revision"}` : "No saved route-matched assessment"}.</p></section>
    <Card labelledBy="agreement" className={a.card20}><h2 id="agreement">Define the agreement</h2><fieldset disabled={!canEdit} className={s.editorFields}><legend className="visually-hidden">Proposed commercial terms</legend>
      <div className={s.fieldsRow}><TextField label="Recruitment source" value={draft.recruitmentSource} onChange={v=>change("recruitmentSource",v)}/>
        <TextField label="Publishing network" value={draft.publishingNetwork} onChange={v=>change("publishingNetwork",v)}/>
        <SelectField label="Checkout provider" value={draft.provider} onChange={v=>change("provider",v as OfferTerms["provider"])} options={opts(draft.checkoutRoute==="website"?["shopify-collabs","external-affiliate"]:["tiktok-shop"])}/>
        <TextField label="Provider program reference" value={draft.programRef??""} onChange={v=>change("programRef",v||null)}/>
        <SelectField label="Commission structure" value={draft.commission.type} options={opts(["percentage","fixed-per-sale"])}
          onChange={v=>change("commission",{...draft.commission,type:v as OfferTerms["commission"]["type"],standardRateBps:v==="percentage"?2000:null,fixedMinor:null})}/>
        {draft.commission.type==="percentage"?<NumberField label="Creator commission (%)" scale={100} value={draft.commission.standardRateBps} onChange={n=>change("commission",{...draft.commission,standardRateBps:n})}/>:
          <NumberField label="Fixed per sale (USD)" scale={100} value={draft.commission.fixedMinor} onChange={n=>change("commission",{...draft.commission,fixedMinor:n})}/>}
        {draft.checkoutRoute==="tiktok-shop" && <NumberField label="Shop Ads commission (%)" scale={100} value={draft.commission.shopAdsRateBps} onChange={n=>change("commission",{...draft.commission,shopAdsRateBps:n})}/>}
        <TextField label="Product revision" value={draft.manifest.productRevision??""} onChange={v=>change("manifest",{...draft.manifest,productRevision:v||null})}/>
      </div><p className={a.small}>Guaranteed content fee · $0.00. Shipping, samples, ad spend and earned rewards have separate cost lines.</p>
      <details><summary>Edit production brief, samples and costs</summary>
        <div className={s.fieldsRow}>
          <TextField label="Campaign reference" value={draft.manifest.campaignRef} onChange={v=>change("manifest",{...draft.manifest,campaignRef:v})}/>
          <TextField label="Product reference" value={draft.manifest.productRef??""} onChange={v=>change("manifest",{...draft.manifest,productRef:v||null})}/>
          <TextField label="Contact route" value={draft.manifest.contactRoute??""} onChange={v=>change("manifest",{...draft.manifest,contactRoute:v||null})}/>
          <TextField label="Approved claims source references" helpText="Separate references with commas." value={draft.manifest.claimsRefs.join(", ")} onChange={v=>change("manifest",{...draft.manifest,claimsRefs:v.split(",").map(x=>x.trim())})}/>
          <TextField label="Product setup source references" helpText="Separate references with commas." value={draft.manifest.guidanceRefs.join(", ")} onChange={v=>change("manifest",{...draft.manifest,guidanceRefs:v.split(",").map(x=>x.trim())})}/>
          <TextField label="Proposal expiry" helpText="Include the time zone, for example +00:00." value={draft.expiresAt??""} onChange={v=>change("expiresAt",v||null)}/>
          <TextField label="Commission effective time" value={draft.commission.effectiveAt??""} onChange={v=>change("commission",{...draft.commission,effectiveAt:v||null})}/>
          <SelectField label="Include samples" value={draft.sample.requested?"yes":"no"} options={opts(["no","yes"])} onChange={v=>change("sample",{...draft.sample,requested:v==="yes",seededCreators:v==="yes"?Math.max(1,draft.sample.seededCreators):0,unitsPerCreator:v==="yes"?Math.max(1,draft.sample.unitsPerCreator):0})}/>
          <NumberField label="Seeded creators" value={draft.sample.seededCreators} onChange={n=>change("sample",{...draft.sample,seededCreators:n??0})}/>
          <NumberField label="Sample units per creator" value={draft.sample.unitsPerCreator} onChange={n=>change("sample",{...draft.sample,unitsPerCreator:n??0})}/>
          <NumberField label="Sample product cap per creator (USD)" value={draft.sample.merchandiseCapMinor} scale={100} onChange={n=>change("sample",{...draft.sample,merchandiseCapMinor:n})}/>
          <NumberField label="Sample shipping cap per creator (USD)" value={draft.sample.shippingCapMinor} scale={100} onChange={n=>change("sample",{...draft.sample,shippingCapMinor:n})}/>
        </div><p className={a.small}>Enter planning assumptions in USD. Source references are verified by the agent before any commitment.</p>
        {costKeys.map(key=><div key={key} className={s.fieldsRow}>
          <NumberField label={`${costLabels[key]} (USD)`} value={draft.costs[key].minor} scale={100} onChange={n=>change("costs",{...draft.costs,[key]:{...draft.costs[key],minor:n}})}/>
          <TextField label={`${costLabels[key]} source reference`} value={draft.costs[key].sourceRef??""} onChange={v=>change("costs",{...draft.costs,[key]:{...draft.costs[key],sourceRef:v||null}})}/>
        </div>)}
        <ScenarioFields label="Base" scenario={draft.base} onChange={v=>change("base",v)}/>
        <ScenarioFields label="Downside" scenario={draft.downside} onChange={v=>change("downside",v)}/>
      </details>
      </fieldset>
      <details><summary>Production brief and onboarding</summary><DataTable caption="Saved production brief" columns={[{label:"Field"},{label:"Saved value"}]} rows={[
        ["Campaign / brief",`${saved.manifest.campaignRef} / ${saved.manifest.briefRef} · ${saved.manifest.briefVersion}`],["Product / revision",[saved.manifest.productRef,saved.manifest.productRevision].map(v=>v??"Unknown").join(" / ")],
        ["Claims and setup sources",[...saved.manifest.claimsRefs,...saved.manifest.guidanceRefs].join(", ")||"Unknown"],["Contact",saved.manifest.contactRoute??"Unknown"],["Link / code",saved.manifest.linkOrCode??"Unissued"],["Sample shipping cap",money(saved.sample.shippingCapMinor)],
        ["Deliverables",saved.manifest.deliverables.length?saved.manifest.deliverables.map(x=>`${x.id} · ${x.quantity} × ${x.format} · ${x.network} · ${x.dueAt??"No date agreed"}`).join("; "):"No agreed posting obligation"],
      ]}/></details>
    </Card>
    <Card labelledBy="projection" className={a.card20}><h2 id="projection">Offer economics</h2><p className={a.small}>Candidate CEO-v1 buyer prices · USD · shipping before tax.</p>
      <DataTable caption="Buyer prices" columns={[{label:"Bundle"},{label:"Merchandise"},{label:"Shipping"},{label:"Delivered before tax"}]} rows={BUNDLES.map(b=>[b.id,money(b.merchandiseMinor),money(b.shippingMinor),money(b.merchandiseMinor+b.shippingMinor)])}/>
      <KpiGrid>{record.scenarios.map(x=><KpiCard key={x.label} label={`${x.label} cohort contribution`} context={`${x.orders} orders · ${x.seededCreators} seeded creators`}>{money(x.contributionMinor)}</KpiCard>)}</KpiGrid>
      <DataTable caption="Saved cohort scenarios" columns={[{label:"Scenario"},{label:"Commission accrued"},{label:"Sample and postage"},{label:"Planning reserve"},{label:"Break-even orders"},{label:"Missing inputs"}]} rows={record.scenarios.map(v=>[v.label,money(v.commissionMinor),money(v.sampleMinor),money(v.reserveMinor),v.breakEvenOrders??"Unknown or unprofitable",v.missing.join(", ")||"None"])}/>
      <p className={a.small}>Provider rate {provider?rate(provider.actualCommission.standardRateBps):"Unknown"} · eligible retained merchandise · refund rule {provider?.refundRule??"Unknown"} · attribution {provider?.attributionWindowDays==null?"Unknown":`${provider.attributionWindowDays} days`} · payout {provider?.payoutSchedule??"Unknown"}.</p>
    </Card>
    <Card labelledBy="gates" className={a.card20}><h2 id="gates">Commitment gates</h2>
      <p>Owner approval · {record.ownerApprovalRef??"Awaiting exact-version receipt"} · Creator acceptance · {record.acceptedRef??"Awaiting source-confirmed terms"}.</p>
      <ul>{record.blockers.map(x=><li key={x}>{x}</li>)}</ul>
      <details><summary>Version history ({record.historyTotal})</summary><DataTable caption="Immutable offer versions" columns={[{label:"Version"},{label:"Saved"},{label:"Manifest"}]} rows={record.history.map(v=>[v.version,v.at,v.hash.slice(0,12)])}/></details>
    </Card>
    <Dialog open={review} title="Review commitment" onClose={()=>setReview(false)}>
      <p>{record.state} · {record.version} · {record.blockers.length} unresolved commercial conditions.</p>
      <p>Owner approval, source-confirmed terms and separate fulfillment approvals control commitments.</p><Button variant="secondary" onClick={()=>setReview(false)}>Close review</Button>
    </Dialog>
  </>;
}
export function AgentRewards({record:r}:{record:RewardRecord}) {
  return <><p role="status">{r.status==="unobserved"?"No authorized sales or reward snapshot has been observed.":`Observed ${r.observedAt} · ${r.sourceRef}`}</p>
    {r.unknowns.length>0 && <ul>{r.unknowns.map(x=><li key={x}>{x}</li>)}</ul>}
    <KpiGrid><KpiCard label="Canonical matured merchandise" context="Across website and TikTok Shop">{money(r.maturedMinor)}</KpiCard>
      <KpiCard label="Pending orders" context={`${r.pendingOrders??"Unknown"} orders`}>{money(r.pendingMinor)}</KpiCard>
      <KpiCard label="Earned reward obligation" context="Once per milestone">{money(r.earnedMinor)}</KpiCard>
      <KpiCard label="Outstanding obligation" context="Earned less redeemed">{money(r.outstandingMinor)}</KpiCard></KpiGrid>
    <Card labelledBy="reward-levels" className={a.card20}><h2 id="reward-levels">Milestone rewards</h2><p>Candidate allowances include tax and shipping. Each milestone is earned once, with no monthly reset.</p>
      <DataTable caption="Reward ladder" columns={["Reward","Matured merchandise","Additional / cumulative","Remaining to threshold","Order example at $50","Earned","Selection / redemption"].map(label=>({label}))}
        rows={TIERS.map((t,i)=>[t.label,money(t.thresholdMinor),`${money(t.additionalMinor)} / ${money(t.cumulativeMinor)}`,r.maturedMinor===null?"Unknown":money(Math.max(0,t.thresholdMinor-r.maturedMinor)),
          Math.ceil(t.thresholdMinor/5000),r.tiers[i]?.earned==null?"Unknown":r.tiers[i]?.earned?"Earned":"Pending",`${r.tiers[i]?.selection??"No selection observed"} / ${money(r.tiers[i]?.redeemedMinor??null)}`])}/>
    </Card><Card labelledBy="settlement" className={a.card20}><h2 id="settlement">Revenue and obligations</h2>
      <DataTable caption="Reward reconciliation" columns={[{label:"Item"},{label:"Amount"}]} rows={[["Refunds",money(r.refundedMinor)],["Exclusions",money(r.excludedMinor)],["Creator cash commission",money(r.commissionMinor)],["Redeemed",money(r.redeemedMinor)],["Farda contribution",money(r.contributionMinor)],["Mirror rows ignored",r.duplicateMirrors]]}/>
      {r.paused && <p>New commitments are paused. Earned allowances remain payable.</p>}</Card></>;
}
