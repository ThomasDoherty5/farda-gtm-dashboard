import { z } from "zod";
import { digest } from "./config.ts";
import { collaborationSnapshotSchema, type CollaborationSourceSnapshot } from "./collaborationWorkflowSchema.ts";
import type { OperationsScope } from "./operations.ts";

export type NotionWorkflowRow={id:string;last_edited_time:string;properties:Record<string,unknown>};
const property=z.object({type:z.string()}).passthrough();
const text=z.object({plain_text:z.string()});
function value(row:NotionWorkflowRow, key:string,type:string):unknown {
  const prop=property.safeParse(row.properties[key]);
  return prop.success && prop.data.type===type ? prop.data[type] : null;
}
function paragraph(row:NotionWorkflowRow,key:string,type="rich_text") {
  const p=z.array(text).max(100).safeParse(value(row,key,type));
  return p.success ? p.data.map(t=>t.plain_text).join("").trim().slice(0,1000)||null : null;
}
function choice(row:NotionWorkflowRow,key:string,type="select") {
  const p=z.object({name:z.string().trim().min(1).max(120)}).safeParse(value(row,key,type)); return p.success?p.data.name:null;
}
function date(row:NotionWorkflowRow,key:string) {
  const p=z.object({start:z.union([z.string().date(),z.string().datetime({offset:true})])}).safeParse(value(row,key,"date")); return p.success?p.data.start:null;
}
function relation(row:NotionWorkflowRow,key:string,ref:(value:string)=>string){
  const p=z.object({type:z.literal("relation"),relation:z.array(z.object({id:z.string().uuid()})).length(1),has_more:z.literal(false).optional()}).safeParse(row.properties[key]);
  return p.success?ref(p.data.relation[0]!.id):null;
}
function urlExists(row:NotionWorkflowRow,key:string) {
  const raw=value(row,key,"url"); if(typeof raw!=="string"||raw.length>2048 || !URL.canParse(raw))return false;
  const url=new URL(raw);return url.protocol==="https:" && !url.username && !url.password;
}
const unknownProof={state:"unknown" as const,receiptRef:null};
export function projectNotionCollaboration(scope:OperationsScope,row:NotionWorkflowRow,materials:NotionWorkflowRow[],coverage:"complete"|"partial",
  observedAt:string,ref:(value:string)=>string):CollaborationSourceSnapshot {
  const sourceRef=ref(row.id), evidence=urlExists(row,"Agreement evidence")?ref(row.id+"/agreement/"+row.last_edited_time):null;
  const agreement=choice(row,"Agreement type"),agreed=date(row,"Agreed"),due=date(row,"Posting due")?.slice(0,10)??null;
  const voluntary=agreement==="Gift — no posting obligation",accepted=!!evidence&&!!agreed;
  // Type, economics and a calendar date cannot establish a promised post. A separately recorded positive term is required.
  const committed = ["Agreed gifted collaboration","Paid deliverables","Affiliate collaboration"].includes(agreement??"") &&
    choice(row,"Posting obligation")==="Committed post";
  const grace=value(row,"Grace days","number");
  const stage=choice(row,"Stage","status"),delivered=date(row,"Delivered");
  const history=[["Contacted",date(row,"Contacted")],["Reply received",date(row,"Reply received")],["Agreement recorded",agreed],["Delivery recorded",delivered]]
    .flatMap(([label,at])=>at?[{label:label!,at,sourceRef}]:[]);
  const deliverables=materials.sort((a,b)=>a.id.localeCompare(b.id)).map(m=>{
    const refId=ref(m.id), stageName=choice(m,"Status","status");
    return {ref:refId,revision:ref(m.id+"/"+m.last_edited_time),title:paragraph(m,"Name","title")??"Content record",stage:stageName,
      brief:null,blocker:null,submissionVersion:null,revisions:[],review:unknownProof,rights:unknownProof,publishPermission:unknownProof,
      publisher:null,plannedSlot:null,reportedPublishedAt:date(m,"Published"),reportedLink:urlExists(m,"Live URL"),reportedRightsExpiry:date(m,"Rights expire"),publication:{state:"unknown" as const,nativeReceiptRef:null,nativePostRef:null,confirmedSlot:null,publishedAt:null,
        observedAt:null,visibility:"unknown" as const},nextAction:null,sourceRef:refId};
  });
  const snapshot={scope,id:row.id,sourceRevision:digest([row.last_edited_time,materials.map(m=>[m.id,m.last_edited_time]),coverage]),sourceRef,observedAt,coverage,
    title:paragraph(row,"Name","title")??"Collaboration",platform:choice(row,"Platform"),creatorRef:relation(row,"Creator",ref),campaignRef:relation(row,"Campaign",ref),stage,
    nextAction:paragraph(row,"Next action"),terms:{kind:agreement,agreementRef:evidence,acceptedAt:accepted?agreed:null,version:null,
      brief:accepted?paragraph(row,"Deliverables"):null,usage:paragraph(row,"Usage terms"),posting:accepted?(voluntary?"voluntary":committed?"committed":"unknown"):"unknown",
      due:accepted&&committed?due:null,graceDays:accepted&&committed&&due&&Number.isInteger(grace)&&Number(grace)>=0&&Number(grace)<=365?Number(grace):null,
      timezone:(z.object({time_zone:z.string()}).safeParse(value(row,"Posting due","date")).data?.time_zone)??null,
      observationUntil:accepted&&voluntary?date(row,"Observation due")?.slice(0,10)??null:null,retainedSampleCost:null,historicalFee:null},
    sample:{state:delivered?"Delivery recorded":null,observedAt:delivered,sourceRef:delivered?sourceRef:null},
    suppression:{state:stage==="Opted out"?"suppressed":"unknown",sourceRef:stage==="Opted out"?sourceRef:null},history,deliverables,assetBindings:materials.map(m=>({deliverableRef:ref(m.id),assetId:m.id}))};
  return collaborationSnapshotSchema.parse(snapshot);
}
