import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { scopeKey, useScope } from "@/adapter/scope";
import { useView, protectedRead } from "@/adapter/useView";
import { useSave } from "@/adapter/useSave";
import { useAction } from "@/adapter/useAction";
import type { ReadResponse } from "@/adapter/contract";
import { Button, LinkButton } from "@/components/Button";
import { Badge } from "@/components/Badge";
import { Checkbox } from "@/components/Checkbox";
import { Dialog } from "@/components/Dialog";
import { SelectField, TextField } from "@/components/Field";
import { Kpi, KpiRow } from "@/components/Kpi";
import { RecruitmentLeaveGuard } from "./RecruitmentLeaveGuard";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { reviewValue, permittedReviewUrl } from "@/features/approvals/NativeReview";
import { useSourceLease } from "@/features/commercial/useSourceLease";
import { CommercialEligibility } from "@/features/commercial/CommercialEligibility";
import { PageTitle, Pending, StaleNotice } from "@/features/creators/creatorsShared";
import { invitationFiltersSchema, invitationTermsSchema, type InvitationFilters, type InvitationTerms, type InvitationSave, type InvitationSaveReceipt, type NativeInvitationView } from "@/creator-agent/recruitment/contract";
import { invitationFieldIssues } from "./invitationValidation";
import { RecruitmentCapacity, RecruitmentSamples } from "./NativeRecruitmentParts";
import { canonicalInvitation, prepareInvitation, matchesInvitationAck, recoverInvitation, type PendingInvitation } from "./invitationRecovery";
import { acquisition, ContextBox, creators, styles, Steps, NavButtons } from "./recruitmentShared";

const validKey=(key:string|null)=>key!==null&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key);
export function invitationFilters(search:URLSearchParams):InvitationFilters|null {
  const raw={context:"recruitment",...Object.fromEntries(["draftId","creatorId","offerId","offerVersion","requestKey"].flatMap(key=>search.has(key)?[[key,search.get(key)]]:[]))};
  const parsed=invitationFiltersSchema.safeParse(raw);return parsed.success?parsed.data:null;
}
export function NativeInvitationPage() {
  const [search,setSearch]=useSearchParams();const filters=invitationFilters(search);
  return <section aria-labelledby="inv-title" data-figma-source="38:348" className={acquisition.page}>
    {filters?<InvitationReader filters={filters} search={search} setSearch={setSearch}/>:<><PageTitle id="inv-title" title="One precise request. A verifiable outcome." subtitle="Invalid invitation selection">{null}</PageTitle><p role="alert">Select an exact creator, offer and version from recruitment. An invalid recovery key cannot authorize a new request.</p><LinkButton to="/creators/social-cat/recruitment">Return to recruitment</LinkButton></>}
  </section>;
}
function InvitationReader({filters,search,setSearch}:{filters:InvitationFilters;search:URLSearchParams;setSearch:ReturnType<typeof useSearchParams>[1]}) {
  const ctx=useScope(),client=useQueryClient(),pendingKey=[...scopeKey(ctx),"recruitment-draft-pending",filters.draftId??"new"];
  const pending=useQuery<PendingInvitation|null>({queryKey:pendingKey,queryFn:()=>null,enabled:false,initialData:null,gcTime:Infinity});
  const query=useView<InvitationFilters,NativeInvitationView>("invitationDraft",filters,null,{keepPrevious:true});
  const data=query.data?.data,lease=useSourceLease(data?.validUntil);
  const current=Boolean(data?.kind==="native-invitation"&&lease&&!query.isError&&!query.isFetching&&!query.isPlaceholderData&&query.data?.dataState==="ready"&&canonicalInvitation(data.filters)===canonicalInvitation(filters));
  function remember(value:PendingInvitation|null) {
    const draftId=value?.payload.draftId??filters.draftId;
    if(draftId)client.setQueryData([...scopeKey(ctx),"recruitment-draft-pending",draftId],value);
    setSearch(old=>{const next=new URLSearchParams(old);if(value){next.set("draftId",value.payload.draftId);next.set("requestKey",value.requestKey);}else next.delete("requestKey");return next;},{replace:true});
  }
  function selectCreator(creatorId:string) {
    const next=new URLSearchParams(search);next.set("creatorId",creatorId);["offerId","offerVersion","draftId","requestKey","previewRequestKey"].forEach(key=>next.delete(key));setSearch(next);
  }
  return <><Pending query={query} subject="the source-bound invitation catalog">{data?.kind==="native-invitation"&&query.data&&<InvitationEditor key={JSON.stringify([...scopeKey(ctx),data.actorRef,filters.creatorId,filters.offerId,filters.offerVersion,filters.draftId??"new"])} data={data} response={query.data} current={current} pending={pending.data??null} requestKey={filters.requestKey??null} previewKey={search.get("previewRequestKey")} previewVersion={search.get("previewVersion")} remember={remember} selectCreator={selectCreator} rememberPreview={(key,version)=>setSearch(old=>{const next=new URLSearchParams(old);next.set("previewRequestKey",key);next.set("previewVersion",version);return next;},{replace:true})} refresh={()=>void query.refetch()}/>}</Pending>
    {!data&&<PageTitle id="inv-title" title="One precise request. A verifiable outcome." subtitle="Current creator, product, program and template evidence required">{null}</PageTitle>}</>;
}
function initialTerms(data:NativeInvitationView):InvitationTerms|null {
  if(data.draft)return data.draft.terms;
  const offer=data.offer,template=data.templates[0];
  if(!offer)return null;
  return {creatorId:offer.creatorId,offerId:offer.offerId,offerVersion:offer.version,productRef:"",programRef:"",sourceVersion:data.sourceVersion,templateRef:template?.ref??"",templateVersion:template?.version??"",claimsVersion:template?.claimsVersion??"",message:template?.text.state==="visible"?template.text.value:"",startsAt:"",expiresAt:"",timezone:data.limits.timezone??"",sampleRequested:offer.sampleUnits>0};
}
function InvitationEditor({data,response,current,pending,requestKey,previewKey,previewVersion,remember,selectCreator,rememberPreview,refresh}:{data:NativeInvitationView;response:ReadResponse<NativeInvitationView>;current:boolean;pending:PendingInvitation|null;requestKey:string|null;previewKey:string|null;previewVersion:string|null;remember:(p:PendingInvitation|null)=>void;selectCreator:(id:string)=>void;rememberPreview:(key:string,version:string)=>void;refresh:()=>void}) {
  const ctx=useScope(),client=useQueryClient(),save=useSave<InvitationSave,InvitationSaveReceipt>(),preview=useAction<{entityRef:string;entityVersion:string;selectionRefs:string[]}>();
  const [edit,setEdit]=useState<{terms:InvitationTerms;version:string|null}|null>(null),[error,setError]=useState<string|null>(null),[dialog,setDialog]=useState(false),[shown,setShown]=useState(false),[preparing,setPreparing]=useState(false);
  const [resolved,setResolved]=useState<Awaited<ReturnType<typeof recoverInvitation>>>(null);
  const mounted=useRef(true),latest=useRef({data,current});useLayoutEffect(()=>{latest.current={data,current};});
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const scope={workspaceId:response.scope.workspaceId,accountId:response.scope.accountIds[0]??"",environment:"sandbox" as const},scopeId=JSON.stringify(scope);
  const [basis,setBasis]=useState([data,requestKey,pending,scopeId] as const);
  if(basis[0]!==data||basis[1]!==requestKey||basis[2]!==pending||basis[3]!==scopeId){setBasis([data,requestKey,pending,scopeId]);setResolved(null);}
  useEffect(()=>{let active=true;if(requestKey)void recoverInvitation(JSON.parse(scopeId),data,requestKey,pending).then(result=>{if(active)setResolved(result);}).catch(()=>{if(active)setResolved(null);});return()=>{active=false;};},[data,requestKey,pending,scopeId]);
  const draft=edit?.terms??initialTerms(data),version=edit?.version??data.draft?.version??null;
  const dirty=!!edit&&canonicalInvitation(edit.terms)!==canonicalInvitation(initialTerms(data));
  const conflict=!!edit&&(edit.version!==(data.draft?.version??null)||edit.terms.sourceVersion!==data.sourceVersion||edit.terms.offerVersion!==data.offer?.version);
  const parsed=invitationTermsSchema.safeParse(draft),validation=invitationFieldIssues(draft,data),issues=shown?validation:{};
  const hold=!current?"Refresh current source evidence.":requestKey?"Reconcile the original save before making another edit.":previewKey?"Review the original preview before changing this invitation.":blockedReason(response,"saveRecruitmentInvitation")??(!data.canSaveDraft?"Select a supported creator and exact saved offer.":null);
  const locked=!!hold||save.isPending||preparing;
  const change=<K extends keyof InvitationTerms>(key:K,value:InvitationTerms[K])=>{if(!draft||locked)return;setEdit({terms:{...draft,[key]:value},version});setError(null);};
  const source=permittedReviewUrl(data.sourceLink,current),offer=data.offer;
  const quota=data.capacity.find(capacity=>capacity.kind==="invitations"),quotaCurrent=useSourceLease(quota?.validUntil);
  const [hasOriginalPreview,setHasOriginalPreview]=useState(false);
  const originalPreview=useRef<{key:string;version:string;payload:{entityRef:string;entityVersion:string;selectionRefs:string[]}}|null>(null);
  const previewRef=current&&(!previewKey||previewVersion===data.draft?.version)?data.previewApprovalRef:null;
  async function submit(original?:PendingInvitation) {
    setShown(true);setError(null);if(!original&&(hold||conflict||!parsed.success||Object.keys(validation).length>0))return;
    setPreparing(true);
    try {
      const start=latest.current.data;
      const intent=original??await prepareInvitation(scope,data.actorRef,{kind:"recruitmentInvitation",draftId:data.filters.draftId??`invitation-${crypto.randomUUID()}`,expectedVersion:version as `invitation-v${number}`|null,terms:parsed.success?parsed.data:draft!});
      if(!mounted.current)return;
      if(!latest.current.current||latest.current.data.actorRef!==intent.actorRef||!original&&latest.current.data!==start){setError("Source evidence changed while preparing the draft. Refresh and review it.");return;}
      remember(intent);
      const ack=await protectedRead(client,scopeKey(ctx),intent.requestKey,()=>save.mutateAsync({resourceKind:"configurationDraft",resourceRef:intent.payload.draftId,expectedVersion:intent.payload.expectedVersion,payload:intent.payload,idempotencyKey:intent.requestKey}));
      if(!mounted.current)return;
      if(!matchesInvitationAck(ack,intent))setError("The acknowledgment did not match the exact saved request. Keep its original key for recovery.");
      else setResolved({pending:intent,receipt:ack.record});
      refresh();
    } catch {if(mounted.current){setError("Save outcome needs authoritative readback. An error or absent lookup does not authorize a new request.");refresh();}}
    finally {if(mounted.current)setPreparing(false);}
  }
  async function previewExact() {
    const saved=data.draft;if(!saved||!current||dirty||conflict||requestKey||!data.canPreview||previewRef||preview.isPending)return;
    if(previewKey&&!validKey(previewKey)){setError("Invalid original preview key; owner recovery is required.");return;}
    if(previewKey&&(!originalPreview.current||originalPreview.current.key!==previewKey||originalPreview.current.version!==previewVersion)){setError("Original preview payload is unavailable after reload or changed source version. Check its original readback; no replacement request is allowed.");return;}
    const original=originalPreview.current??{key:crypto.randomUUID(),version:saved.version,payload:{entityRef:saved.draftId,entityVersion:saved.version,selectionRefs:[...data.previewSelectionRefs]}};
    const key=original.key;originalPreview.current=original;setHasOriginalPreview(true);rememberPreview(key,original.version);setError(null);
    try {await protectedRead(client,scopeKey(ctx),key,()=>preview.mutateAsync({operation:"previewAction",actionKind:"recruitment.invitation",entityRefs:[],expectedVersion:original.version,approvalRef:null,manifestRef:null,runRef:null,payload:original.payload,idempotencyKey:key}));}
    catch {if(mounted.current)setError("Preview outcome needs its original source readback. No invitation was authorized by this page.");}
    finally {if(mounted.current)refresh();}
  }
  return <>
    <RecruitmentLeaveGuard dirty={dirty} uncertain={Boolean(requestKey&&!resolved)||Boolean(previewKey&&!previewRef)}/>
    <PageTitle id="inv-title" title="One precise request. A verifiable outcome." subtitle={`${data.provider} · ${reviewValue(data.account,current)} · ${data.provenance.synthetic?"Fictional integration evidence":"Source evidence"}`}>
      {source?<a href={source} target="_blank" rel="noopener noreferrer">Open permitted source</a>:<Button variant="secondary" disabledReason="No current permitted source link was returned.">Open source</Button>}
      <Button aria-haspopup="dialog" onClick={()=>{setShown(true);setDialog(true);}}>Review exact request</Button>
    </PageTitle>
    <NavButtons current="Prepare invitation" items={[{label:"Social Cat dashboard",to:"/creators/social-cat?view=dashboard"},{label:"SC scorecard",to:"/creators/discovery"},{label:"Recruitment queue",to:"/creators/social-cat/recruitment"},{label:"TikTok dashboard",to:"/creators/tiktok?view=dashboard"},{label:"Prior TikTok score",to:"/creators/discovery"},{label:"Prepare invitation",to:"/creators/tiktok/invitations/new"}]}/>
    <ContextBox title="Commission-only acquisition" text="An invitation proposes commission-only collaboration. $0 upfront and $0 guaranteed fees remain fixed. Unknown willingness permits a proposal, never accepted terms or activation."><div className={styles.buttons}><LinkButton variant="secondary" to="/creators/pipeline">Full acquisition funnel</LinkButton><LinkButton variant="secondary" to="/creators/discovery">Daily sourcing</LinkButton><LinkButton variant="secondary" to="/creators/discovery">Review lifestyle evidence</LinkButton></div></ContextBox>
    <StaleNotice res={response}/>{!current&&<p role="status">Current source permission or freshness is unavailable. Refresh before editing or previewing.</p>}
    <KpiRow><Kpi label="Creator willingness" context="A proposal is not acceptance">{current?data.willingness:"Unknown"}</Kpi><Kpi label="Live quota remaining" context="Separate source-native capacities below">{current&&quotaCurrent?quota?.remaining??"Unknown":"Unknown"}</Kpi><Kpi label="Conditional samples" context="Allocation is not a reservation">{offer?.sampleUnits??"Unknown"}</Kpi><Kpi label="Sample decision" context="Invitation acceptance is not sample approval">Separate review</Kpi></KpiRow>
    {requestKey&&<section className={creators.panel} aria-labelledby="inv-save-result"><h2 id="inv-save-result" className={acquisition.h2}>{resolved?"Local revision recorded":"Keep the original save request"}</h2><p role="status">{resolved?`Saved ${resolved.receipt.version}. No invitation was sent and no terms were accepted.`:"An absent result is not terminal proof. Reconcile this exact scoped key before another edit."}</p><div className={styles.buttons}><Button variant="secondary" onClick={refresh}>Check original save</Button>{resolved?<Button onClick={()=>{setEdit(null);remember(null);setResolved(null);save.reset();refresh();}}>Continue with saved revision</Button>:<Button disabledReason={!pending?"The original payload is unavailable after reload. Keep checking its scoped key.":!current?"Refresh current source permission.":null} loading={save.isPending} onClick={()=>pending&&void submit(pending)}>Retry original save</Button>}</div></section>}
    {error&&<p role="alert">{error}</p>}{save.error&&<ActionError error={save.error}/>}
    {conflict&&!requestKey&&<p role="alert">The selected draft, offer or source changed. Review current evidence before replacing your edits. <Button variant="secondary" onClick={()=>{setEdit(null);setError(null);}}>Load current source revision</Button></p>}
    <div className={creators.pairWide}><section className={`${creators.panel} ${styles.form}`} aria-labelledby="inv-terms-title"><h2 id="inv-terms-title" className={acquisition.h2}>Make every term explicit.</h2><p className={acquisition.small}>Exact creator, product, saved commission, sample proposal, timestamps and message form one immutable request.</p>
      <div className={styles.fields}>
        <SelectField label="Creator" error={issues.creatorId} value={draft?.creatorId??data.filters.creatorId??""} disabled={!current||!!requestKey||!!previewKey||dirty} options={[{value:"",label:"Choose a canonical creator"},...data.creators.map(c=>({value:c.creatorId,label:reviewValue(c.label,current)}))]} helpText="Exact provider profile and suppression are validated by the source." onChange={selectCreator}/>
        <SelectField label="Product" value={draft?.productRef??""} disabled={locked||!draft} options={[{value:"",label:"Choose a permitted listing"},...data.products.map(p=>({value:p.ref,label:reviewValue(p.label,current)}))]} error={issues.productRef} helpText="Listing, category, market and program stay source-bound." onChange={ref=>{const product=data.products.find(p=>p.ref===ref);if(draft&&product)setEdit({terms:{...draft,productRef:ref,programRef:product.programRef},version});}}/>
        <div><TextField label="Commission" error={issues.commission} value={offer?offer.standardRateBps!==null?`${offer.standardRateBps/100}% · USD retained eligible merchandise`:offer.fixedPerSaleMinor!==null?`USD ${(offer.fixedPerSaleMinor/100).toFixed(2)} per eligible sale`:"Unknown":"Select an exact saved offer"} disabled onChange={()=>{}} helpText="Edit supported per-sale terms in the versioned offer; $0 upfront and guaranteed."/>{offer&&<LinkButton variant="secondary" to={`/offers/${encodeURIComponent(offer.offerId)}?offerVersion=${offer.version}&phase=invitation`}>Edit supported commission and sample terms</LinkButton>}</div>
        <div><Checkbox label="Propose a separately approved sample" checked={draft?.sampleRequested??false} disabled={locked||!draft} onChange={value=>change("sampleRequested",value)}/><p className={acquisition.small}>Must match the exact saved offer. Accepted terms, stock and cost approval precede any order.</p></div>
        <TextField label="Invitation starts" value={draft?.startsAt??""} disabled={locked||!draft} onChange={value=>change("startsAt",value)} error={issues.startsAt} placeholder="YYYY-MM-DDTHH:mm:ss±HH:mm" helpText={`Explicit timestamp required · source timezone ${data.limits.timezone??"Unknown"}`}/>
        <TextField label="Invitation expires" value={draft?.expiresAt??""} disabled={locked||!draft} onChange={value=>change("expiresAt",value)} error={issues.expiresAt} placeholder="YYYY-MM-DDTHH:mm:ss±HH:mm" helpText={data.limits.maxValiditySeconds===null?"Source validity limit unknown":`Maximum source validity ${data.limits.maxValiditySeconds} seconds; must follow start.`}/>
      </div>
      {!offer&&<p role="status">Select a saved offer from a recruitment source row. This page does not infer a creator's terms.</p>}
      <div className={styles.notice}><p className={styles.noticeTitle}>Native automated invitations: not enabled here.</p><p className={acquisition.small}>No source automation, outreach or sample approval is activated by saving or previewing.</p></div>
    </section><section className={`${creators.panel} ${creators.panelDark} ${creators.panelBare} ${styles.invitationMessage}`} aria-labelledby="inv-message-title"><Badge tone="warning">{data.draft?.version??"Unsaved draft"} · not authorized</Badge><h2 id="inv-message-title" className={acquisition.h2} style={{color:"var(--color-onDark)"}}>A request worth responding to.</h2>
      <SelectField label="Approved message basis" disabled={locked||!draft} value={draft?.templateRef??""} options={[{value:"",label:"Choose permitted template"},...data.templates.map(t=>({value:t.ref,label:reviewValue(t.label,current)}))]} onChange={ref=>{const t=data.templates.find(value=>value.ref===ref);if(t&&draft&&t.text.state==="visible")setEdit({terms:{...draft,templateRef:t.ref,templateVersion:t.version,claimsVersion:t.claimsVersion,message:t.text.value},version});}}/>
      <TextField label="Invitation message" value={draft?.message??""} disabled={locked||!draft} multiline rows={7} error={issues.message} onChange={value=>change("message",value)} helpText="Use permitted product claims. The server rechecks the exact saved template and claims version."/>
      <Button disabledReason={hold??(conflict?"Load current source revision before saving.":!draft?"An exact saved offer is required.":null)} loading={preparing||save.isPending} onClick={()=>void submit()}>Save invitation draft</Button>
      <Button variant="secondary" aria-haspopup="dialog" onClick={()=>{setShown(true);setDialog(true);}}>Review exact request</Button><Button disabledReason="Dispatch requires the current canonical approval and runner gates; this composer cannot send directly.">Send request · blocked</Button>
    </section></div>
    {offer&&<CommercialEligibility data={offer.commercialEligibility} current={current} compact/>}
    <section className={creators.panel} aria-labelledby="inv-flow-title"><h2 id="inv-flow-title" className={acquisition.h2}>From approval to source evidence.</h2><Steps label="Approval to source evidence" steps={["Save exact terms","Review immutable manifest","Approve exact action","Recheck live gates","Capture source receipt","Track response"]}/><p>Only the owning runner executes an approved request. Login, quota and uncertain outcomes keep their original attempt and recovery path.</p>{previewRef?<LinkButton to={`/approvals/${encodeURIComponent(previewRef)}`}>Open immutable invitation preview</LinkButton>:previewKey?<p role="status">Original preview outcome is unverified. Refresh or retry its exact saved revision; no new key is permitted.</p>:<p>No immutable approval preview has been recorded for this draft.</p>}</section>
    <RecruitmentSamples values={data.samples} current={current}/><RecruitmentCapacity values={data.capacity} current={current}/>
    <section className={acquisition.context} aria-labelledby="inv-after-title"><h2 id="inv-after-title" className={acquisition.h2}>Acceptance unlocks the next review, not a free sample.</h2><Steps label="After invitation acceptance" steps={["Accepted","Sample approved","Native order","Delivered","Live verified","Reconciled"]}/><p>Follow the source order, agreed posting deadline and actual content receipt. Accepted terms, stock and sample authority remain separate; no completion is inferred from these process steps.</p><div className={styles.buttons}><LinkButton variant="secondary" to="/inventory">View sample handoff</LinkButton><LinkButton to="/content">Open content monitor</LinkButton><LinkButton variant="secondary" to="/finance/commissions">Review settlement</LinkButton></div></section><section className={creators.panel} aria-labelledby="inv-rates-title"><h2 id="inv-rates-title" className={acquisition.h2}>Approve terms before native commitment.</h2><p>Standard and Shop Ads commission, proposed and effective terms, and any historical fee obligation stay separate. Affiliation grants no usage rights. Forecast commission never caps amounts actually earned.</p><div className={styles.buttons}><LinkButton to="/finance/commissions">Native settlement &amp; rates</LinkButton><LinkButton variant="secondary" to="/automations">Bulk operations</LinkButton><LinkButton variant="secondary" to="/settings/capabilities">Channel access</LinkButton></div></section>
    <Button variant="secondary" onClick={refresh}>Refresh source evidence</Button>
    <Dialog open={dialog} title="Review exact invitation request" onClose={()=>setDialog(false)}><p>This preview is not approval, sending, acceptance or sample release.</p>{draft?<dl className={styles.exactTerms}>{Object.entries(draft).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>:<p>No complete source-bound draft is available.</p>}<p>Saved revision: {data.draft?.version??"Not saved"}. Provider: {data.provider}. Offer: {offer?`${offer.offerId} / ${offer.version}`:"Not selected"}. $0 upfront and guaranteed fees.</p>
      {Object.entries(issues).length>0&&<p role="alert">{Object.entries(issues).map(([key,value])=>`${key}: ${value}`).join(" · ")}</p>}
      {previewRef?<LinkButton to={`/approvals/${encodeURIComponent(previewRef)}`}>Open immutable invitation preview</LinkButton>:<Button loading={preview.isPending} disabledReason={!current?"Refresh current source evidence.":requestKey?"Reconcile the saved request first.":dirty||conflict?"Save and verify these exact edits first.":!data.draft?"Save the exact invitation before preview.":!data.canPreview?"Current source owner and approval gates are required.":previewKey&&!hasOriginalPreview?"Original payload unavailable after reload; refresh its authoritative readback.":null} onClick={()=>void previewExact()}>{previewKey?"Recover original preview":"Create immutable approval preview"}</Button>}
      <Button variant="secondary" onClick={()=>setDialog(false)}>Close exact request</Button>
    </Dialog>
  </>;
}
