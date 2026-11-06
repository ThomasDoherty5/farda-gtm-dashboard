import { z } from "zod";
import { AgentConflict } from "../store.ts";
import { OfferRepository, OfferSourceUnavailable } from "./repository.ts";
const ref=z.string().trim().min(1).max(180);
const propose=z.object({expectedVersion:ref.nullable(),terms:z.unknown()}).strict();
const decision=z.object({version:ref,sourceRef:ref,kind:z.enum(["owner-approved","creator-accepted"])}).strict();
const source=z.object({sourceRef:ref}).strict();
export function handleOfferRoute(input:{method:string;path:string;role:"reviewer"|"reader";body?:unknown;idempotencyKey?:string},repo:OfferRepository) {
  const url=new URL(input.path,"http://localhost"),match=/^\/v1\/offers\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,119})(?:\/(decisions|rewards|onboarding|proposals))?$/.exec(url.pathname);
  if(!match)return null;
  const [,id,operation]=match;
  const fail=(status:number,code:string)=>({status,body:{code,executionCertainty:"notApplied"}});
  try {
    if(input.method==="GET") {
      const revision=url.searchParams.get("revision");
      if(revision!==null && (operation || !/^[1-9]\d{0,6}$/.test(revision)))return fail(400,"INVALID_REVISION");
      if(operation==="proposals" && !ref.safeParse(url.searchParams.get("correlationId")).success)return fail(400,"CORRELATION_REQUIRED");
      const record=operation==="proposals"?repo.readJobReceipt(id!,url.searchParams.get("correlationId")!):operation==="rewards"?repo.readRewards(id!):operation==="onboarding"?repo.onboarding(id!):!operation?repo.readOffer(id!,revision?Number(revision):undefined):null;
      return record?{status:200,body:record}:fail(404,"OFFER_RECORD_UNAVAILABLE");
    }
    if(input.method!=="POST")return fail(405,"UNSUPPORTED_METHOD");
    if(input.role!=="reviewer")return fail(403,"REVIEWER_REQUIRED");
    const key=input.idempotencyKey;
    if(!key?.trim() || key.length>240)return fail(400,"IDEMPOTENCY_KEY_REQUIRED");
    if(!operation){const p=propose.parse(input.body);return {status:200,body:repo.saveFromAdapter(id!,p.expectedVersion,p.terms,key)};}
    if(operation==="proposals")return {status:200,body:repo.proposeJob(id!,input.body,key)};
    if(operation==="decisions")return {status:200,body:repo.decision(id!,decision.parse(input.body),key)};
    if(operation==="rewards")return {status:200,body:repo.recordReward(id!,source.parse(input.body).sourceRef,key)};
    return fail(405,"UNSUPPORTED_METHOD");
  } catch(e) {
    if(e instanceof z.ZodError)return fail(422,"INVALID_OFFER_TERMS");
    if(e instanceof AgentConflict)return fail(409,e.message);
    if(e instanceof OfferSourceUnavailable)return fail(503,e.message);
    throw e;
  }
}
