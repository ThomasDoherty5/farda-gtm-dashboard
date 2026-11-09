import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { useView, protectedRead } from "@/adapter/useView";
import { useSave } from "@/adapter/useSave";
import { scopeKey, useScope } from "@/adapter/scope";
import type { ReadResponse } from "@/adapter/contract";
import { Button, LinkButton } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Field, SelectField, TextField } from "@/components/Field";
import { Pending } from "@/features/creators/creatorsShared";
import { ActionError } from "@/features/approvals/shared";
import { offerTermsSchema, type OfferTerms, type OfferRecord, type OfferSaveRecovery } from "@/creator-agent/offers/contract";
import { canonicalInvitation, invitationDigest } from "./invitationRecovery";
import { RecruitmentLeaveGuard } from "./RecruitmentLeaveGuard";
import { acquisition, styles } from "./recruitmentShared";

type OfferView=OfferRecord&{saveRecovery?:OfferSaveRecovery};
type SaveMarker={requestKey:string;expectedVersion:string|null;payloadDigest:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function RecruitmentOfferTerms({offerId,creatorId,sourceCurrent,onVersion}:{offerId:string;creatorId:string;sourceCurrent:boolean;onVersion:(version:string)=>void}) {
  const ctx=useScope(),[search,setSearch]=useSearchParams();
  const key=search.get("offerRequestKey"),version=search.get("offerRequestVersion"),hash=search.get("offerRequestDigest");
  const marker:SaveMarker|null=key&&uuid.test(key)&&version&&/^v[1-9]\d*$/.test(version)&&hash&&/^[a-f0-9]{64}$/.test(hash)?{requestKey:key,expectedVersion:version,payloadDigest:hash}:null;
  const query=useView("offerDraft",{offerId,...(marker?{saveRequest:marker}:{})},null,{keepPrevious:true});
  const data=query.data?.data as OfferView|undefined;
  function remember(value:SaveMarker|null){setSearch(old=>{const next=new URLSearchParams(old);if(value){next.set("offerRequestKey",value.requestKey);next.set("offerRequestVersion",value.expectedVersion??"");next.set("offerRequestDigest",value.payloadDigest);}else["offerRequestKey","offerRequestVersion","offerRequestDigest"].forEach(k=>next.delete(k));return next;},{replace:true});}
  const current=sourceCurrent&&!query.isError&&!query.isFetching&&!query.isPlaceholderData&&data?.offerId===offerId&&data.terms.creatorId===creatorId;
  return <Pending query={query} subject="the selected saved offer">{data?.kind==="agent-offer"&&data.offerId===offerId&&data.terms.creatorId===creatorId&&query.data?<TermsEditor key={JSON.stringify([...scopeKey(ctx),offerId,creatorId])} record={data} response={query.data as ReadResponse<OfferView>} current={current} marker={marker} invalidMarker={!!key&&!marker} remember={remember} refresh={()=>void query.refetch()} onVersion={onVersion}/>:<p>No exact matching saved offer is available for this creator.</p>}</Pending>;
}
function TermsEditor({record,response,current,marker,invalidMarker,remember,refresh,onVersion}:{record:OfferView;response:ReadResponse<OfferView>;current:boolean;marker:SaveMarker|null;invalidMarker:boolean;remember:(m:SaveMarker|null)=>void;refresh:()=>void;onVersion:(version:string)=>void}) {
  const [edit,setEdit]=useState<{terms:OfferTerms;version:string}|null>(null),[errors,setErrors]=useState<string[]>([]),[busy,setBusy]=useState(false);
  const original=useRef<{marker:SaveMarker;terms:OfferTerms}|null>(null),save=useSave<OfferTerms,OfferRecord>(),ctx=useScope(),client=useQueryClient();
  const mounted=useRef(true),latest=useRef({record,current,scope:JSON.stringify(scopeKey(ctx))});
  useLayoutEffect(()=>{latest.current={record,current,scope:JSON.stringify(scopeKey(ctx))};});
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const terms=edit?.terms??record.terms,baseVersion=edit?.version??record.version,dirty=!!edit&&canonicalInvitation(terms)!==canonicalInvitation(record.terms);
  const recorded=!!marker&&record.saveRecovery?.state==="recorded"&&record.saveRecovery.requestKey===marker.requestKey&&record.saveRecovery.payloadDigest===marker.payloadDigest&&record.saveRecovery.expectedVersion===marker.expectedVersion&&record.saveRecovery.record?.offerId===record.offerId;
  const canEdit=current&&response.capabilities.some(c=>c.actionKind==="saveOfferDraft"&&c.state==="available");
  const hold=!canEdit?"Current source selection and reviewer access are required.":invalidMarker?"Invalid recovery metadata; reconcile the original request.":marker?"Finish the original request before editing.":baseVersion!==record.version?"A newer saved version exists; review it first.":null;
  const locked=!!hold||busy||save.isPending;
  const change=(value:OfferTerms)=>{if(!locked){setEdit({terms:value,version:baseVersion});setErrors([]);}};
  const deliverable=(network:string)=>terms.manifest.deliverables.find(d=>d.network===network);
  function delivery(network:string,key:"format"|"rights"|"dueAt"|"timezone",value:string) {
    const prior=deliverable(network);if(!prior)return;
    change({...terms,manifest:{...terms.manifest,deliverables:terms.manifest.deliverables.map(d=>d.id===prior.id?{...d,[key]:value||null}:d)}});
  }
  function toggleDelivery(network:string,enabled:boolean) {
    const prior=deliverable(network);if(enabled&&!prior)change({...terms,manifest:{...terms.manifest,deliverables:[...terms.manifest.deliverables,{id:`proposed-${network}-${crypto.randomUUID()}`,quantity:1,network,format:"",concept:null,dueAt:null,deadlineAnchor:null,timezone:null,disclosure:null,cta:null,previewAgreed:null,revisionLimit:null,rights:null}]}});
    else if(!enabled&&prior)change({...terms,manifest:{...terms.manifest,deliverables:terms.manifest.deliverables.filter(d=>d.id!==prior.id)}});
  }
  async function submit(retry=false) {
    if(busy||save.isPending||!current||!retry&&hold)return;
    const parsed=offerTermsSchema.safeParse(terms);if(!retry&&!parsed.success){setErrors(parsed.error.issues.map(i=>`${i.path.join(".")}: ${i.message}`));return;}
    setBusy(true);setErrors([]);
    const basis=latest.current;
    try {
      const request=retry?original.current:{marker:{requestKey:crypto.randomUUID(),expectedVersion:baseVersion,payloadDigest:await invitationDigest({id:record.offerId,expected:baseVersion,terms:parsed.success?parsed.data:terms,job:null,operation:"offer-propose"})},terms:parsed.success?parsed.data:terms};
      if(!request||!mounted.current)return;
      if(!latest.current.current||latest.current.record!==basis.record||latest.current.scope!==basis.scope){setErrors(["Source permission, scope or selected offer changed while preparing the save. No request was sent."]);return;}
      original.current=request;remember(request.marker);
      const ack=await protectedRead(client,scopeKey(ctx),request.marker.requestKey,()=>save.mutateAsync({resourceKind:"actionDraft",resourceRef:record.offerId,expectedVersion:request.marker.expectedVersion,payload:request.terms,idempotencyKey:request.marker.requestKey}));
      if(!mounted.current||latest.current.scope!==basis.scope||latest.current.record.offerId!==basis.record.offerId||latest.current.record.terms.creatorId!==basis.record.terms.creatorId)return;
      if(ack.scope.workspaceId!==response.scope.workspaceId||ack.scope.environment!==response.scope.environment||canonicalInvitation(ack.scope.accountIds)!==canonicalInvitation(response.scope.accountIds)||ack.executionCertainty!=="applied"||ack.resourceRef!==record.offerId||ack.record.offerId!==record.offerId||ack.resourceVersion!==ack.record.version||canonicalInvitation(ack.record.terms)!==canonicalInvitation(request.terms))setErrors(["The acknowledgment did not match the exact offer request. Keep its original key."]);
      refresh();
    }catch{if(mounted.current){setErrors(["The original save needs authoritative readback. An absent result does not authorize a new request."]);refresh();}}finally{if(mounted.current)setBusy(false);}
  }
  const ig=deliverable("instagram"),tt=deliverable("tiktok");
  return <><RecruitmentLeaveGuard dirty={dirty} uncertain={!!marker&&!recorded||invalidMarker}/><h2 id="rec-terms-title" className={acquisition.h2}>Terms, per publishing network.</h2><p className={acquisition.small}>{record.offerId} · {record.version} · local proposal · {record.terms.checkoutRoute}. Edits create a new exact offer revision; existing acceptance does not transfer.</p>
    <div className={styles.buttons}><Button aria-pressed>Affiliate</Button>{["Gifted","Paid","Hybrid"].map(label=><Button key={label} variant="ghost" disabledReason="Historical obligations remain readable; this offer type cannot be used for new acquisition.">{label} · history</Button>)}</div>
    <div className={styles.fields}><div><Checkbox label="Propose Instagram deliverable" checked={!!ig} disabled={locked} onChange={value=>toggleDelivery("instagram",value)}/><TextField label="Instagram deliverable" value={ig?.format??""} disabled={locked||!ig} onChange={value=>delivery("instagram","format",value)} helpText="Describe format and duration; no obligation until applicable source acceptance."/>{ig&&<Field label="Instagram deliverable count">{props=><input {...props} type="number" min="1" step="1" disabled={locked} value={ig.quantity} onChange={e=>change({...terms,manifest:{...terms.manifest,deliverables:terms.manifest.deliverables.map(d=>d.id===ig.id?{...d,quantity:Number(e.target.value)}:d)}})}/>}</Field>}</div>
      <div><Checkbox label="Propose optional TikTok post" checked={!!tt} disabled={locked} onChange={value=>toggleDelivery("tiktok",value)}/><TextField label="TikTok deliverable" value={tt?.format??""} disabled={locked||!tt} onChange={value=>delivery("tiktok","format",value)} helpText="Adding a post is a material terms change requiring new approval and acceptance."/></div>
      <div><SelectField label="Affiliate compensation basis" value={terms.commission.type} disabled={locked} options={[{value:"percentage",label:"Percentage of retained eligible merchandise"},{value:"fixed-per-sale",label:"Fixed USD per eligible sale"}]} onChange={value=>change({...terms,commission:{...terms.commission,type:value as OfferTerms["commission"]["type"],standardRateBps:null,fixedMinor:null}})}/><Field label={terms.commission.type==="percentage"?"Commission percent":"Commission USD per eligible sale"} helpText="$0 upfront and guaranteed. Provider and contribution limits are checked separately.">{props=><input {...props} disabled={locked} type="number" min="0.01" step="0.01" value={((terms.commission.type==="percentage"?terms.commission.standardRateBps:terms.commission.fixedMinor)??0)/100||""} onChange={e=>change({...terms,commission:{...terms.commission,...(terms.commission.type==="percentage"?{standardRateBps:e.target.value?Math.round(Number(e.target.value)*100):null,fixedMinor:null}:{fixedMinor:e.target.value?Math.round(Number(e.target.value)*100):null,standardRateBps:null})}})}/>}</Field></div>
      <div>{["instagram","tiktok"].filter(network=>deliverable(network)).map(network=><TextField key={network} label={`${network} rights proposal`} value={deliverable(network)?.rights??""} disabled={locked} onChange={value=>delivery(network,"rights",value)} helpText="Scope and term remain negotiable; unknown rights block applicable reuse only."/>)}{!ig&&!tt&&<p>Rights: Unknown. Add a proposed deliverable to negotiate its usage scope and term.</p>}</div>
      <div><Checkbox label="Propose sample allocation" checked={terms.sample.requested} disabled={locked} onChange={value=>change({...terms,sample:{...terms.sample,requested:value,seededCreators:value?terms.sample.seededCreators:0,unitsPerCreator:value?terms.sample.unitsPerCreator:0}})}/>{(["seededCreators","unitsPerCreator"] as const).map(key=><Field key={key} label={key==="seededCreators"?"Sample creators":"Units per creator"}>{props=><input {...props} type="number" min="0" step="1" disabled={locked||!terms.sample.requested} value={terms.sample[key]} onChange={e=>change({...terms,sample:{...terms.sample,[key]:Number(e.target.value)}})}/>}</Field>)}<p className={acquisition.small}>No reservation or release. Identity, accepted terms, budget and stock remain separate gates.</p></div>
      <div>{["instagram","tiktok"].filter(network=>deliverable(network)).map(network=><div key={network}><TextField label={`${network} delivery timestamp`} value={deliverable(network)?.dueAt??""} disabled={locked} onChange={value=>delivery(network,"dueAt",value)} placeholder="Leave unknown date unset" helpText="Only copy a source-supported proposed/agreed timestamp, including UTC offset."/><TextField label={`${network} delivery timezone`} value={deliverable(network)?.timezone??""} disabled={locked} onChange={value=>delivery(network,"timezone",value)}/></div>)}{!ig&&!tt&&<p>Delivery window: Unknown. No posting deadline has been invented.</p>}</div>
    </div>
    {errors.length>0&&<p role="alert">{errors.join(" · ")}</p>}{save.error&&<ActionError error={save.error}/>}
    {marker?<div role="status"><p>{recorded?"The exact original offer save is recorded. This is a proposal, not acceptance.":"Keep the original offer request. No terminal outcome has been verified."}</p><Button variant="secondary" onClick={refresh}>Check original offer save</Button>{recorded?<Button onClick={()=>{const saved=record.saveRecovery!.record!;setEdit(null);remember(null);onVersion(saved.version);original.current=null;refresh();}}>Use saved offer revision</Button>:<Button disabledReason={!original.current?"Original payload is unavailable after reload; keep checking its exact key.":!current?"Current source selection is required.":null} loading={busy||save.isPending} onClick={()=>void submit(true)}>Retry original offer save</Button>}</div>:<div className={styles.buttons}><Button loading={busy||save.isPending} disabledReason={hold} onClick={()=>void submit()}>Save proposed terms</Button>{baseVersion!==record.version&&<Button variant="secondary" onClick={()=>setEdit(null)}>Load current offer revision</Button>}<LinkButton variant="secondary" to={`/offers/${encodeURIComponent(record.offerId)}?offerVersion=${record.version}&phase=invitation`}>Review complete offer and history</LinkButton></div>}
  </>;
}
