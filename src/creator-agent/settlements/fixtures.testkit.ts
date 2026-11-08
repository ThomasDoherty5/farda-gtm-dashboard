import { SettlementError, balanceKeys, type SettlementRecord, type SettlementScope } from "./contract.ts";
import type { SettlementSnapshot, SettlementSource, SettlementSourceRequest } from "./source.ts";

/** Fictional source-only fixture. No database/provider connection or payment executor. */
export function settlementSourceFixture(scope:SettlementScope,clock=Date.parse("2026-11-07T12:00:00Z")) {
  const state={now:clock,denied:false,version:"fixture-ledger-v1",partial:false,stale:false,reads:0};
  const iso=()=>new Date(clock).toISOString();
  const unknown={state:"unknown" as const,value:null,evidenceRef:null,observedAt:null,reasonCode:"NOT_OBSERVED" as const};
  const money=(minorUnits:number)=>({state:"known" as const,value:{minorUnits,currency:"USD"},evidenceRef:"fixture-evidence",observedAt:iso(),reasonCode:null});
  const number=(value:number)=>({state:"known" as const,value,evidenceRef:"fixture-rate-evidence",observedAt:iso(),reasonCode:null});
  function record(id:string,provider:SettlementRecord["provider"]):SettlementRecord{
    const balances=Object.fromEntries(balanceKeys.map(k=>[k,unknown])) as SettlementRecord["balances"];
    balances.earned=money(provider==="externalManual"?15000:9000);balances.creatorPaid=provider==="externalManual"?money(0):money(9000);balances.outstanding=money(provider==="externalManual"?15000:0);
    return {ref:id,version:"record-v1",provider,accountRef:"fixture-account-"+provider,creatorRef:"fixture-creator",programmeRef:"fixture-programme",programmeVersion:"programme-v1",componentRef:id+"-component",orderRef:provider==="externalManual"?null:id+"-order",nativeRef:null,
      currency:"USD",collaborationRef:null,budgetCategory:null,state:provider==="externalManual"?"approved":"creatorPaid",eligibleBase:money(60000),grossSales:money(60000),balances,commissionRatePct:provider==="externalManual"?unknown:number(15),fee:provider==="collabs"?money(261):unknown,feeRatePct:provider==="collabs"?number(2.9):unknown,
      facts:[{ref:id+"-event",state:provider==="externalManual"?"approved":"creatorPaid",amount:{minorUnits:provider==="externalManual"?15000:9000,currency:"USD"},eventAt:iso(),observedAt:iso(),evidenceRef:id+"-evidence",nativeRef:null}],
      receipts:provider==="externalManual"?[]:[{ref:id+"-receipt",componentRef:id+"-component",providerRef:null,amount:{minorUnits:9000,currency:"USD"},settledAt:iso(),observedAt:iso(),evidenceRef:id+"-receipt-evidence"}],adjustments:[],
      crosswalk:{state:"unresolved",payeeRef:null,orderRef:id+"-order",evidenceRefs:[],observedAt:iso()},
      accounting:{state:"unknown",qboRef:null,policyRef:null,policyVersion:null,evidenceRef:null},
      rates:provider==="tiktok"?[{lane:"standard",activePct:unknown,proposedPct:unknown,activeFrom:null,proposedFrom:null,termsVersion:null},{lane:"shopAds",activePct:unknown,proposedPct:unknown,activeFrom:null,proposedFrom:null,termsVersion:null}]:[],
      historical:provider==="externalManual"?{acceptedAt:iso(),termsRef:"terms-fixture",termsVersion:"terms-v1",contractRef:"contract-fixture",invoiceRef:"invoice-fixture",deliverableRef:"deliverable-fixture",acceptedAmount:{minorUnits:15000,currency:"USD"},payoutOwner:"externalManual",approvalRef:null,fundingRef:null,reviewDeadline:null}:null,
      candidates:provider==="collabs"?[{ref:"candidate-one",statementRef:"statement-one",componentRef:id+"-component",amount:{minorUnits:9000,currency:"USD"},periodStart:"2026-10-01T00:00:00Z",periodEnd:"2026-11-01T00:00:00Z",evidenceRef:"statement-evidence",problem:null}]:[],
      samples:[],exceptions:[],links:[{kind:"order",targetRef:null,state:"missing",url:null,observedAt:null,validUntil:null}]};
  }
  const records=[record("collabs-one","collabs"),record("tiktok-one","tiktok"),record("payable-one","externalManual")];
  const snapshot=(request:SettlementSourceRequest):SettlementSnapshot=>{
    const all=records.filter(r=>(request.targetRef===null || r.ref===request.targetRef) && (request.provider==="all" || r.provider===request.provider) && (!request.currency || r.currency===request.currency));
    const offset=request.cursor?Number(request.cursor):0,selected=all.slice(offset,offset+request.limit);
    return {scope,request:structuredClone(request),principalRef:request.principal.principalRef,viewKey:request.viewKey,snapshotRef:"fixture-snapshot-"+request.viewKey,version:state.version,permissionVersion:"permission-v1",observedAt:new Date(clock).toISOString(),sourceUpdatedAt:new Date(clock).toISOString(),validUntil:new Date(state.stale?clock+1:state.now+300000).toISOString(),access:state.denied?"denied":"allowed",state:state.partial?"partial":state.stale?"stale":"current",synthetic:true,currency:"USD",records:structuredClone(selected),total:state.partial?null:all.length,offset,complete:!state.partial,nextCursor:offset+selected.length<all.length?String(offset+selected.length):null,
      economics:null,totals:{eligible:state.partial?unknown:money(all.reduce((n,r)=>n+(r.eligibleBase.value?.minorUnits??0),0)),accrued:state.partial?unknown:money(all.reduce((n,r)=>n+(r.balances.earned.value?.minorUnits??0),0)),creatorPaid:state.partial?unknown:money(all.reduce((n,r)=>n+(r.balances.creatorPaid.value?.minorUnits??0),0)),contribution:unknown},accountingPolicy:{state:"unknown",reference:null},export:null};
  };
  const source:SettlementSource={async read(request){state.reads++;return snapshot(request);},assertCurrent(s){if(state.denied || s.version!==state.version)throw new SettlementError("SETTLEMENT_SOURCE_DENIED",403);}};
  return{state,records,source,snapshot,money,number,unknown,now:()=>state.now};
}
