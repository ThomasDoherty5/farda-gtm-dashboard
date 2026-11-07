import { useState } from "react";
import { Link,useParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { Kpi,KpiRow } from "@/components/Kpi";
import { BarRows,FactList,FlatTable,HalfColumns,Notice,PageHeader,Panel,TwoColumns } from "@/components/Panels";
import { RecordShell } from "@/features/operations/RecordShell";
import { OpsTabs } from "@/features/operations/OpsTabs";
import { StockSupportProposal } from "@/features/inventory/StockSupportProposal";
import { nativeSupportSchema,type NativeSupport } from "@/creator-agent/stockSupportSchema";
import styles from "./Support.module.css";

function ratio(n:number|null|undefined,d:number|null|undefined){return n==null||d==null?"Unknown":d===0?"N/A":((100*n)/d).toFixed(1)+"%";}
export function NativeSupportPage(){
  const {caseId="queue"}=useParams();
  const query=useView<{caseId:string},NativeSupport>("supportWorkspace",{caseId});
  const [dialog,setDialog]=useState<"cohort"|"case"|null>(null);
  return <RecordShell query={query} id="support-title" title="Support & returns" subject="support case" figma="7:317">{(res,raw)=>{
    const parsed=nativeSupportSchema.safeParse(raw);
    if(!parsed.success||parsed.data.revision!==res.dataVersion||parsed.data.caseId!==caseId)return <p role="alert">The support response could not be verified for this case.</p>;
    const d=parsed.data,c=d.cases.find(c=>c.id===caseId),co=d.cohort;
    const n=co?.tickets?Object.values(co.tickets).reduce((a,b)=>a+b,0):null;
    return <>
      <PageHeader id="support-title" title="Support & returns" subtitle="Keep customer details in the owning support system.">
        <Button variant="secondary" aria-haspopup="dialog" onClick={()=>setDialog("cohort")}>14-day cohort</Button>
        <Button aria-haspopup="dialog" onClick={()=>setDialog("case")}>Open source case</Button>
      </PageHeader><OpsTabs current="support"/>
      <Notice tone={d.coverage==="partial"||d.stale?"warning":"violet"} label="Source" title="Only safe operational fields are mirrored">Case and order references, issue category, owner and outcome. Observed {d.observedAt}.</Notice>
      {d.pending.total>0&&<Panel title="Local handoff proposals" subtitle={d.pending.rows.length+" of "+d.pending.total+" recorded for review"}>{d.pending.rows.map(r=><p key={r.id}>{r.id} · {r.reasonCode}</p>)}</Panel>}
      <KpiRow><Kpi label="All-time open queue" context={(co?.open??"Unknown")+" open in the 14-day cohort"}>{d.allTimeOpen??"Unknown"}</Kpi>
        <Kpi label="First contact resolution" context={(co?.firstContact??"Unknown")+" of "+(n??"unknown")+" cohort tickets"}>{ratio(co?.firstContact,n)}</Kpi>
        <Kpi label="Returns" context={(co?.returns??"Unknown")+" / "+(co?.delivered??"unknown")+" delivered units"}>{ratio(co?.returns,co?.delivered)}</Kpi>
        <Kpi label="Fin cost" context="A billing receipt is required">Unknown</Kpi></KpiRow>
      <TwoColumns><Panel title="Handoffs that need an owner" subtitle="All-time source queue">
        {d.cases.length?<FlatTable caption="Handoffs that need an owner" columns={["Issue / order","Type","State","Owner"].map((label,i)=>({label,width:[288,180,172,136][i]!}))}
          rows={d.cases.map(r=>({key:r.id,cells:[<Link key="link" className={styles.issue} aria-current={r.id===caseId?"page":undefined} to={"/support/cases/"+encodeURIComponent(r.id)}>{r.id} / {r.orderRef??"Unknown"}</Link>,r.category,r.state,r.owner]}))}/>:<p>No support cases were returned. See source coverage before interpreting the queue.</p>}
        </Panel><Panel title={c?.id??"Case details"} subtitle={c?.category??"Select a source case"}>
          {c?<><FactList label="Case" rows={[["Status",c.state],["Source case",c.sourceRef],["Owner",c.owner],["Order",c.orderRef??"Unknown"],["Shipment",c.shipmentRef??"Unknown"],["Return",c.returnRef??"Unknown"],["Last updated",c.updatedAt]]}/>
            <StockSupportProposal key={caseId} data={d} res={res}/></>:<p>Select an issue to inspect its assignment, source and permitted handoff.</p>}
        </Panel></TwoColumns>
      <HalfColumns><Panel title="What people need help with" subtitle={n===null?"Cohort ticket breakdown unavailable":"14-day cohort · "+n+" tickets"}>
        {co?.tickets?<BarRows label="Tickets by type" max={Math.max(1,...Object.values(co.tickets))} rows={Object.entries(co.tickets).map(([label,value])=>({label,value}))}/>:<p>Category counts are unknown.</p>}</Panel>
        <Panel title="After a handoff" subtitle="Source-confirmed subsets in the same cohort"><FactList label="After a handoff" rows={[["Refunded orders",co?.refundedOrders??"Unknown"],["Replacement shipments",co?.replacements??"Unknown"],["Support load",n===null||co?.delivered==null?"Unknown":co.delivered===0?"N/A":Math.round(100*n/co.delivered)+" tickets / 100 delivered"]]}/></Panel></HalfColumns>
      <Dialog open={dialog==="cohort"} title="The 14-day cohort" onClose={()=>setDialog(null)}>
        <p>{co?co.start+" through "+co.end+" · "+co.timezone+" · receipt "+co.receipt:"No matched support and delivery cohort has been verified."}</p>
        <p>All-time open includes cases outside the 14-day period.</p><Button onClick={()=>setDialog(null)}>Close cohort</Button></Dialog>
      <Dialog open={dialog==="case"} title="Support source handoff" onClose={()=>setDialog(null)}>
        <p>{c?"Use the source case reference "+c.sourceRef+" in the authorized support workspace.":"Select a case in the queue first."}</p>
        <p>No verified external conversation link was supplied. Replies, refunds and replacements remain with their source owners.</p>
        <Button onClick={()=>setDialog(null)}>Close handoff</Button></Dialog>
    </>;
  }}</RecordShell>;
}
