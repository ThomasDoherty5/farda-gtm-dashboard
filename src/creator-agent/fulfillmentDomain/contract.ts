import { z } from "zod";
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { approvalRefSchema as ref, approvalInstantSchema as instant, approvalScopeSchema, approvalItemSchema } from "../approvals/contract.ts";

const count=z.number().int().nonnegative().safe(), quantity=count.positive();
// The canonical J04 budget contract currently supports USD cents only.
const money=z.object({minorUnits:count,currency:z.literal("USD")}).strict();
export const fulfillmentKind=z.enum(["shippingDecision","returnTask"]);
export type FulfillmentKind=z.infer<typeof fulfillmentKind>;
export const fulfillmentActionKinds={shippingDecision:"fulfillment.shippingDecision",returnTask:"fulfillment.returnTask"} as const;
const refund=z.object({kind:z.literal("refund"),orderRef:ref,lineRefs:z.array(ref).min(1).max(100),amount:money,
  remainingRefundable:money,balanceVersion:ref}).strict();
const replacement=z.object({kind:z.literal("replacement"),skuRef:ref,quantity,home:z.enum(["H1","H2","H3"]),
  originalOrderRef:ref.nullable(),originalShipmentRef:ref,newOrderRef:ref,newShipmentRef:ref,
  stockEvidenceRef:ref,stockVersion:ref,availableQuantity:count,addressRef:ref,costBound:money}).strict();
export const fulfillmentRemedySchema=z.discriminatedUnion("kind",[refund,replacement]);
const inspection=z.object({evidenceRef:ref,receivedQuantity:count,inspectedQuantity:quantity,restockableQuantity:count,
  condition:z.enum(["restockable","quarantine","nonRestockable"]),observedAt:instant}).strict();
export const fulfillmentPlanSchema=z.object({planRef:ref,version:ref,kind:fulfillmentKind,sourceRef:ref,sourceVersion:ref,policyVersion:ref,
  providerAccountRef:ref,providerAccountVersion:ref,caseRef:ref,shipmentRef:ref.nullable(),returnRef:ref.nullable(),
  disposition:z.enum(["none","restock","quarantine"]),inspection:inspection.nullable(),remedy:fulfillmentRemedySchema,
  items:z.array(approvalItemSchema.omit({payloadHash:true})).min(1).max(100),
}).strict().superRefine((p,c)=>{
  const fail=(message:string)=>c.addIssue({code:"custom",message});
  if(p.kind==="returnTask" && (!p.returnRef || !p.inspection || p.disposition==="none"))fail("Return plans need a received inspection and disposition.");
  if(p.kind==="shippingDecision" && (!p.shipmentRef || p.returnRef || p.inspection || p.disposition!=="none"))fail("Shipping decisions cannot assert return inspection or stock receipt.");
  if(p.inspection && (p.inspection.inspectedQuantity>p.inspection.receivedQuantity || p.inspection.restockableQuantity>p.inspection.inspectedQuantity))fail("Inspection quantities exceed received goods.");
  if(p.disposition==="restock" && (!p.inspection || p.inspection.condition!=="restockable" || p.inspection.restockableQuantity!==p.inspection.inspectedQuantity))fail("Restock requires the exact inspected restockable quantity.");
  if(p.remedy.kind==="refund"){
    if(p.remedy.amount.currency!==p.remedy.remainingRefundable.currency || p.remedy.amount.minorUnits>p.remedy.remainingRefundable.minorUnits)fail("Refund exceeds the same-currency remaining source balance.");
    if(new Set(p.remedy.lineRefs).size!==p.remedy.lineRefs.length)fail("Refund line references must be unique.");
  } else if(p.remedy.quantity>p.remedy.availableQuantity || p.remedy.newShipmentRef===p.remedy.originalShipmentRef ||
    p.remedy.newOrderRef===p.remedy.originalOrderRef || p.remedy.newOrderRef===p.remedy.newShipmentRef)fail("Replacement requires available stock and distinct new order/shipment identities.");
  if(new Set(p.items.map(i=>i.itemRef)).size!==p.items.length || new Set(p.items.map(i=>i.targetRef)).size!==p.items.length)fail("Exact plan items must be unique.");
  const spend=p.remedy.kind==="refund"?p.remedy.amount.minorUnits:p.remedy.costBound.minorUnits,units=p.remedy.kind==="replacement"?p.remedy.quantity:0;
  if(p.items.reduce((sum,i)=>sum+BigInt(i.spendMinor),0n)!==BigInt(spend) || p.items.reduce((sum,i)=>sum+BigInt(i.units),0n)!==BigInt(units))fail("Canonical items must retain the exact remedy spend and stock bounds.");
});
export type FulfillmentPlan=z.infer<typeof fulfillmentPlanSchema>;
export const fulfillmentFilters=z.object({kind:fulfillmentKind,targetRef:ref,requestKey:ref.optional()}).strict();
export const fulfillmentPreviewPayload=z.object({kind:fulfillmentKind,targetRef:ref,planRef:ref,reason:z.string().trim().min(1).max(500)}).strict();
export const fulfillmentPreviewAction=z.object({schemaVersion:z.literal(SCHEMA_VERSION),requestId:ref,operation:z.literal("previewAction"),actionKind:z.literal("previewFulfillmentDecision"),
  requestedScope:z.object({workspaceId:ref,accountIds:z.array(ref).length(1),environment:z.literal("sandbox")}).strict(),
  entityRefs:z.array(z.never()).max(0),approvalRef:z.null(),manifestRef:z.null(),expectedVersion:ref,idempotencyKey:ref,payload:fulfillmentPreviewPayload}).strict();
export type FulfillmentPreviewAction=z.infer<typeof fulfillmentPreviewAction>;
export const fulfillmentIntentSchema=z.object({intentRef:ref,digest:z.string().regex(/^[a-f0-9]{64}$/),scope:approvalScopeSchema,
  principalRef:ref,personRef:ref,directoryVersion:ref,kind:fulfillmentKind,targetRef:ref,baseVersion:ref,
  permissionVersion:ref,sourceVersion:ref,plan:fulfillmentPlanSchema,reason:z.string().trim().min(1).max(500),createdAt:instant}).strict();
export type FulfillmentIntent=z.infer<typeof fulfillmentIntentSchema>;
export const fulfillmentPublicPlanSchema=z.object({planRef:ref,summary:z.string(),disposition:z.enum(["none","restock","quarantine"]),
  inspectedQuantity:quantity.nullable(),inspectionEvidenceRef:ref.nullable(),remedy:fulfillmentRemedySchema,
  capability:z.object({state:z.enum(["available","held"]),reasonCodes:z.array(ref)}).strict()}).strict();
export const fulfillmentProposalSchema=z.object({kind:z.literal("native-fulfillment-proposal"),target:z.object({kind:fulfillmentKind,ref}).strict(),version:ref,
  source:z.object({synthetic:z.boolean(),observedAt:instant,validUntil:instant}).strict(),plans:z.array(fulfillmentPublicPlanSchema).max(100),
  capability:z.object({state:z.enum(["available","held"]),reasonCodes:z.array(ref)}).strict(),
  recovery:z.object({requestKey:ref,state:z.enum(["absent","pending","recorded","rejected"]),approvalRef:ref.nullable(),manifestRef:ref.nullable(),version:ref.nullable()}).strict().nullable(),
}).strict();
export type FulfillmentProposal=z.infer<typeof fulfillmentProposalSchema>;
export class FulfillmentError extends Error {
  constructor(readonly code:string,readonly status=409,readonly executionCertainty:"notApplied"|"applied"|"uncertain"="notApplied"){super(code);this.name="FulfillmentError";}
}
