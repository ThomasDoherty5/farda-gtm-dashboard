import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button,LinkButton } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { SelectField } from "@/components/Field";
import { Kpi,KpiRow } from "@/components/Kpi";
import { FactList,FlatTable,Meter,Notice,PageHeader,Panel,TwoColumns } from "@/components/Panels";
import { OpsTabs } from "@/features/operations/OpsTabs";
import { RecordShell } from "@/features/operations/RecordShell";
import { available,positionHold,nativeInventorySchema,type NativeStock } from "@/creator-agent/stockSupportSchema";
import { StockSupportProposal } from "./StockSupportProposal";
import styles from "./Inventory.module.css";

export function NativeInventoryPage(){
  const [proposalTarget,setProposalTarget]=useState<HTMLElement|null>(null);
  const [search,setSearch]=useSearchParams();
  const filters=Object.fromEntries(["home","sku","windowRef"].flatMap(k=>search.get(k)?[[k,search.get(k)!]]:[]));
  const query=useView<typeof filters,NativeStock>("inventoryOverview",filters);
  const [dialog,setDialog]=useState<"filters"|"source"|"transfer"|null>(null),[detail,setDetail]=useState<string|null>(null);
  const [transferRef,setTransferRef]=useState<string|null>(null);
  const [draft,setDraft]=useState<Record<string,string>>({});
  const apply=()=>{const next=new URLSearchParams(search);for(const k of ["home","sku","windowRef"]){if(draft[k])next.set(k,draft[k]);else next.delete(k);}setSearch(next);setDialog(null);};
  return <RecordShell query={query} id="stock-title" title="Stock by home" subject="inventory" figma="7:129">{(res,raw)=>{
    const parsed=nativeInventorySchema.safeParse(raw);
    if(!parsed.success || parsed.data.revision!==res.dataVersion || Object.entries(filters).some(([k,v])=>parsed.data.selected[k as keyof typeof parsed.data.selected]!==v)
      || Object.keys(parsed.data.selected).length!==Object.keys(filters).length)
      return <p role="alert">The stock response could not be verified for these filters. Refresh the inventory source.</p>;
    const data=parsed.data,p=data.period,positions=p?.positions??[], movements=p?.movements??[];
    const whole=positions.length>0 && data.coverage==="complete";
    const total=(f:(r:typeof positions[number])=>number|null)=>{const vals=positions.map(f);return whole && vals.every(v=>v!==null)?vals.reduce<number>((n,v)=>n+(v??0),0):"Unknown";};
    const selected=positions.find(r=>r.home+"/"+r.sku===detail),transfer=p?.transfers.find(t=>t.ref===transferRef);
    return <>
      <PageHeader id="stock-title" title="Stock by home" subtitle="One inventory truth. Every reservation and movement accounted for.">
        <Button variant="secondary" style={{minWidth:160}} aria-haspopup="dialog" onClick={()=>{setDraft(filters);setDialog("filters");}}>{filters.home?"Home "+filters.home:"All homes"}</Button>
        <Button style={{minWidth:190}} aria-haspopup="dialog" onClick={()=>{setDetail(null);setDialog("source");}}>Open inventory</Button>
      </PageHeader><OpsTabs current="stock" includeHub={false}/>
      <Notice tone={data.stale||data.coverage==="partial"?"warning":"violet"} label="Source" title="Movement ledger and Shopify observation">{p?p.window.start+" through "+p.window.end:"No reporting window recorded"}. Observed {data.observedAt}. Balances require canonical movement and reservation receipts.</Notice>
      {data.pending.total>0&&<Panel title="Transfer proposals awaiting review" subtitle={data.pending.rows.length+" of "+data.pending.total+" local proposals · source balances are unchanged"}>
        {data.pending.rows.map(r=><p key={r.id}>{r.id} · {r.sku} · {r.from} → {r.to} · {r.units} units · {r.reasonCode}</p>)}</Panel>}
      <KpiRow><Kpi label="On hand" context="Movement-derived physical balance">{total(r=>r.onHand?.units??null)}</Kpi><Kpi label="Reserved" context="Active order and sample reservations">{total(r=>r.reserved?.units??null)}</Kpi>
      <Kpi label="Available" context="Physical less reserved">{total(available)}</Kpi>
      <Kpi label="At risk" context="Locations below their SKU threshold">{whole&&positions.every(r=>available(r)!==null&&r.threshold!==null)?new Set(positions.filter(r=>available(r)!<r.threshold!).map(r=>r.home)).size:"Unknown"}</Kpi></KpiRow>
      <Panel title="Inventory by location" subtitle="Stock is counted once per home × SKU">
        {positions.length?<FlatTable caption="Inventory by location" columns={[{label:"Location / SKU",width:400},{label:"On hand",width:136},{label:"Reserved",width:136},{label:"Available",width:136},{label:"Health",width:200},{label:"Source",width:240}]} rows={positions.map(r=>{
          const held=positionHold(r),health=held==="STOCK_CONFLICT"?"Conflicting balances":held||r.threshold===null?"Evidence incomplete":available(r)!<r.threshold?"Low stock":"Healthy";
          return {key:r.home+"/"+r.sku,cells:["Home "+r.home+" / "+r.sku,r.onHand?.units??"Unknown",r.reserved?.units??"Unknown",available(r)??"Unknown",<Badge key="health" tone={health==="Healthy"?"success":"warning"} width={116}>{health}</Badge>,<Button key="source" style={{minWidth:160}} variant="secondary" aria-label={"Open source for Home "+r.home+" / "+r.sku} aria-haspopup="dialog" onClick={()=>{setDetail(r.home+"/"+r.sku);setDialog("source");}}>Open source</Button>]};})}/>:<p className={styles.note}>No position is recorded for this scope. On-hand and reserved balances are unknown.</p>}
      </Panel>
      <TwoColumns><Panel title="Every movement leaves a trace" subtitle="Incomplete rows are excluded from balance calculations">
        {movements.length?<FlatTable caption="Movement log" columns={[{label:"Movement key",width:260},{label:"Type",width:230},{label:"Home",width:130},{label:"Units",width:156}]} rows={movements.map(m=>({key:m.ref,cells:[m.ref,m.type,"Home "+m.home,!m.receipt?"Not counted · missing receipt":m.physicalDelta===null||m.reserveDelta===null?"Unknown":`${m.physicalDelta>0?"+":""}${m.physicalDelta} on hand · ${m.reserveDelta>0?"+":""}${m.reserveDelta} reserved`]}))}/>:<p className={styles.note}>No movement records in this period and scope.</p>}
        <p className={styles.note}>Reservation release, cancellation and damaged return are distinct movement types.</p><details><summary className={styles.note}>Inspect movement receipts</summary>{movements.map(m=><FactList key={m.ref} label={m.ref} rows={[["Movement",m.ref],["Order",m.orderRef??"Unknown"],["Home / SKU",m.home+" / "+m.sku],["Receipt",m.receipt??"Missing · excluded"]]}/>)}</details>
      </Panel><div>{p?.transfers.length?p.transfers.map(t=><Panel key={t.ref} title={"Transfer · Home "+t.from+" → Home "+t.to} subtitle="Home transfer · receipt-backed status"><span><Badge tone={t.received?"success":"violet"} width={124}>{t.received?"Received":t.dispatchReceipt?"In transit":"Dispatch unconfirmed"}</Badge></span><FactList label={t.ref} rows={[["Transfer key",t.ref],["Expected units",t.units],["Received units",t.received?t.received.units:"Not confirmed"]]}/>
        {(t.received||t.dispatchReceipt)&&<Meter percent={t.received?100:200/3} label={t.received?"Transfer receipt recorded":"Dispatch receipt recorded; destination receipt unconfirmed"}/>}
        <p className={styles.steps}>Requested → Dispatched → Received<br/>If counts differ, hold the adjustment and review in the source.</p>{t.received&&t.received.units!==t.units&&<p className={styles.warn} role="status">Receipt quantity differs. Review both source records.</p>}{!t.received&&t.expectedBy&&t.expectedBy<data.observedAt.slice(0,10)&&<p className={styles.warn} role="status">Destination receipt is overdue. No units were credited here.</p>}
        <Button variant="secondary" style={{minWidth:230,alignSelf:"flex-start"}} aria-haspopup="dialog" onClick={()=>{setTransferRef(t.ref);setDialog("transfer");}}>Open source transfer</Button></Panel>):<Panel title="Home transfer" subtitle="Dispatch and destination receipt are separate events"><p className={styles.note}>No transfers recorded for these filters.</p><Button variant="secondary" aria-haspopup="dialog" onClick={()=>{setTransferRef(null);setDialog("transfer");}}>Review transfer evidence</Button></Panel>}</div></TwoColumns>
      <Dialog open={dialog==="transfer"} title="Source transfer evidence" onClose={()=>setDialog(null)}>{transfer?<FactList label="Transfer receipts" rows={[["Transfer",transfer.ref],["Dispatch",transfer.dispatchReceipt??"Unconfirmed"],["Received",transfer.received?.receipt??"Not confirmed"],["Deadline",transfer.expectedBy??"Unknown"]]}/>:<p>No exact transfer is selected.</p>}<p>No verified external transfer URL was supplied. A transfer request records a proposal only; inventory does not move here.</p><LinkButton variant="secondary" to="/operations?view=hub">Shipping hub</LinkButton><div ref={setProposalTarget}/><Button variant="secondary" onClick={()=>setDialog(null)}>Close transfer evidence</Button></Dialog>
      <Dialog open={dialog==="filters"} title="Stock filters" onClose={()=>setDialog(null)}>
        <SelectField label="Home" value={draft.home??""} onChange={v=>setDraft({...draft,home:v})} options={[{value:"",label:"All homes"},...["H1","H2","H3"].map(value=>({value,label:value}))]}/>
        <SelectField label="SKU" value={draft.sku??""} onChange={v=>setDraft({...draft,sku:v})} options={[{value:"",label:"All SKUs"},...data.skus.map(value=>({value,label:value}))]}/>
        <SelectField label="Reporting period" value={draft.windowRef??""} onChange={v=>setDraft({...draft,windowRef:v,sku:""})} options={[{value:"",label:"Current source period"},...data.windows.map(w=>({value:w.ref,label:w.start+" through "+w.end}))]}/>
        <Button onClick={apply}>Apply filters</Button><Button variant="secondary" onClick={()=>setDialog(null)}>Cancel</Button></Dialog>
      <Dialog open={dialog==="source"} title={selected?"Position evidence":"Inventory evidence"} onClose={()=>setDialog(null)}>
        <p>Movement and reservation balances are owned by the inventory ledger. Shopify's observed location quantity is a separate snapshot.</p>
        {selected?<><FactList label="Position evidence" rows={[["Location",selected.home+" / "+selected.sku],["Shopify observed",selected.shopify?.units??"Unknown"],["Physical receipt",selected.onHand?.receipt??"Unknown"],["Reservation receipt",selected.reserved?.receipt??"Unknown"],["Shopify receipt",selected.shopify?.receipt??"Unknown"]]}/>
          {selected.reservations.map(r=><p key={r.ref}>{r.ref} · {r.kind} {r.orderRef} · {r.units} reserved</p>)}</>:<p>Version {data.revision}. No verified external ledger link was supplied.</p>}
        <LinkButton variant="secondary" to="/operations?view=hub">Shipping hub</LinkButton><div ref={setProposalTarget}/><Button onClick={()=>setDialog(null)}>Close evidence</Button></Dialog>
      <StockSupportProposal key={JSON.stringify(data.selected)} data={data} res={res} portalTarget={proposalTarget} hideTrigger={true}/>
    </>;
  }}</RecordShell>;
}
