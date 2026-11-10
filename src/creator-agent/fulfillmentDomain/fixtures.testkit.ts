import { approvalFixture, approvalTestScope } from "../approvals/fixtures.testkit.ts";
import type { ApprovalDraft } from "../approvals/contract.ts";
import { createOperations } from "../operations.ts";
import { createActionFoundation } from "../actionFoundation.ts";
import { actionTestSecret } from "../actions/fixtures.testkit.ts";
import type { DispatchHandler } from "../jobs/dispatchSchema.ts";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { FulfillmentError, fulfillmentActionKinds, type FulfillmentPlan, type FulfillmentPreviewAction, type FulfillmentKind } from "./contract.ts";
import type { FulfillmentOwner, FulfillmentSource, FulfillmentSnapshot } from "./source.ts";
import { createFulfillmentDomain, fulfillmentBounds, fulfillmentItemHash, fulfillmentPayloadHash } from "./service.ts";

/** Fictional source-owned plans and canonical repositories. No provider credentials, activation or physical effects. */
export function fulfillmentFixture(kind:FulfillmentKind="shippingDecision"){
  const a=approvalFixture(),scope=approvalTestScope,principal={principalRef:"synthetic:requester"};
  const state={version:"source-v1",permissionVersion:"permission-v1",denied:false,historyDenied:false,canPropose:true,unresolved:null as string|null,effects:0,ownerReads:0,sourceReads:0};
  const plan:FulfillmentPlan={planRef:"fictional-plan",version:"plan-v1",kind,sourceRef:"fictional-source",sourceVersion:state.version,policyVersion:a.policy.version,
    providerAccountRef:"fictional-provider-account",providerAccountVersion:"account-v1",caseRef:"fictional-case",shipmentRef:kind==="shippingDecision"?"fictional-shipment":null,
    returnRef:kind==="returnTask"?"fictional-return":null,disposition:kind==="returnTask"?"restock":"none",
    inspection:kind==="returnTask"?{evidenceRef:"fictional-inspection",receivedQuantity:1,inspectedQuantity:1,restockableQuantity:1,condition:"restockable",observedAt:a.at()}:null,
    remedy:{kind:"refund",orderRef:"fictional-order",lineRefs:["fictional-line"],amount:{minorUnits:3499,currency:"USD"},remainingRefundable:{minorUnits:3499,currency:"USD"},balanceVersion:"refund-balance-v1"},
    items:[{itemRef:"fictional-remedy-item",itemVersion:"item-v1",targetRef:"fictional-case",targetVersion:"case-v1",sourceRef:"fictional-source",spendMinor:3499,units:0}]};
  const source:FulfillmentSource={async read(request){state.sourceReads++;return {request:structuredClone(request),version:state.version,permissionVersion:state.permissionVersion,policyVersion:a.policy.version,
    observedAt:a.at(),validUntil:a.until(),access:state.denied?"denied":"allowed",canPropose:state.canPropose,synthetic:true,
    historicalIntentAccess:request.history?(state.historyDenied?"denied":"allowed"):null,unresolvedActionRef:state.unresolved,plans:[{...structuredClone(plan),sourceVersion:state.version}]};},
    assertCurrent(snapshot){if(state.denied||snapshot.request.history&&state.historyDenied)throw new FulfillmentError("FULFILLMENT_SOURCE_DENIED",403);
      if(snapshot.version!==state.version||snapshot.permissionVersion!==state.permissionVersion)throw new FulfillmentError("FULFILLMENT_SOURCE_CHANGED");}};
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional source declares no resource requirement for this isolated proposal test."};
  const handler:DispatchHandler={policyVersion:a.policy.version,idempotency:"source-enforced",sourceEffect:"providerApplied",provider:{state:"required",binding:{...scope,
    provider:"shopify",providerAccountId:plan.providerAccountRef,action:"refund",mode:"executeApproved",route:"api",routeRef:"route:fictional",authorizationScopeVersion:"v1",toolVersion:"v1",requiredScopes:["refunds.write"],connectionRef:null,secretRef:null}},
    resources:()=>({budget:na,stock:na,quota:na}),budgets:{maxItems:10,maxSteps:10,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
    execute:async()=>{state.effects++;return {state:"unknown",reasonCode:"FICTIONAL_OWNER_NOT_EXECUTED"};},reconcile:async()=>({state:"unknown",reasonCode:"FICTIONAL_SOURCE_UNBOUND"})};
  const owner:FulfillmentOwner={registration:{handlerRef:"fulfillment-fictional-owner.v1"},handlers:new Map([["fulfillment-fictional-owner.v1",handler]]),
    async resolveDraft({intent,snapshot}){state.ownerReads++;const bounds=fulfillmentBounds(intent.plan),base=structuredClone(a.draft),gate={state:"satisfied" as const,sourceRef:"fictional-gate",sourceVersion:"gate-v1",validUntil:snapshot.validUntil};
      return {...base,actionKind:fulfillmentActionKinds[intent.kind],phase:intent.plan.remedy.kind==="replacement"?"shipment":"other",providerAccountRef:intent.plan.providerAccountRef,providerAccountVersion:intent.plan.providerAccountVersion,
        sourceBasisRef:intent.intentRef,sourceBasisVersion:intent.digest,sourceValidUntil:snapshot.validUntil,expiresAt:snapshot.validUntil,policyVersion:intent.plan.policyVersion,
        payloadRef:intent.intentRef,payloadHash:fulfillmentPayloadHash(intent),acquisitionTerms:null,historicalLiability:null,
        effects:{spendsMoney:bounds.spend>0,sendsCreator:false,changesPolicy:false},items:intent.plan.items.map(item=>({...item,payloadHash:fulfillmentItemHash(intent,item.itemRef)})),
        bounds:{maxItems:intent.plan.items.length,maxUnits:bounds.units,maxSpendMinor:bounds.spend,currency:"USD"},exposure:{state:"known",minor:bounds.spend,currency:"USD"},
        gates:{...base.gates,acceptedTerms:gate,sampleAuthority:gate,sourcePermission:gate}} satisfies ApprovalDraft;},
    assertCurrent({snapshot},draft){source.assertCurrent(snapshot,snapshot.request,a.state.now);if(draft.policyVersion!==a.policy.version)throw new FulfillmentError("POLICY_CHANGED");}};
  const operations=createOperations(a.db,scope,{now:()=>a.state.now});
  let foundation:ReturnType<typeof createActionFoundation>;
  const bindings={source,authority:a.sources,owners:new Map([[kind,owner]])};
  const build=()=>createFulfillmentDomain({db:a.db,scope,secret:actionTestSecret,bindings,now:()=>a.state.now,timeoutMs:50,
    actions:()=>foundation.service,approvals:()=>foundation.approvals});
  let domain=build();
  const compose=()=>{foundation=createActionFoundation({db:a.db,scope,secret:actionTestSecret,jobs:operations.jobs,ledger:operations.ledger,now:()=>a.state.now,
    bindings:{registry:domain.domain.actions,handlers:domain.domain.handlers,approvals:{sources:a.sources,currentPolicy:a.options.currentPolicy,registry:domain.domain.registry}}});};compose();
  const filters={kind,targetRef:kind==="shippingDecision"?"public-shipment-exception":"public-return"};
  async function input(requestKey="original-fulfillment"):Promise<FulfillmentPreviewAction>{const read=await domain.read(filters,principal);return {schemaVersion:SCHEMA_VERSION,requestId:"fictional-preview",operation:"previewAction",actionKind:"previewFulfillmentDecision",
    requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox"},entityRefs:[],approvalRef:null,manifestRef:null,
    expectedVersion:read.data.version,idempotencyKey:requestKey,payload:{...filters,planRef:read.data.plans[0]!.planRef,reason:"Inspected source evidence requires review"}};}
  return {a,scope,principal,state,plan,source,owner,handler,bindings,filters,input,get domain(){return domain;},get foundation(){return foundation;},
    restart(){domain=build();compose();return domain;},close(){operations.close();a.db.close();}};
}
export type FictionalFulfillmentSnapshot=FulfillmentSnapshot;
