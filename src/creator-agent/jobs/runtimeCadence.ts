import { digest } from "../config.ts";
import { nextRun } from "../scheduleCadence.ts";
import { RuntimeError, runtimeInstant, type RuntimeRegistration, type RuntimeCadence, type RuntimeWindow } from "./runtimeSchema.ts";

export function nextRuntimeSlot(cadence:RuntimeCadence,after:number):number {
  if(!Number.isFinite(after))throw new RuntimeError("RUNTIME_INVALID_TIME",422);
  if(cadence.kind==="event")throw new RuntimeError("RUNTIME_EVENT_HAS_NO_CALENDAR",422);
  const minimum=Math.max(after,Date.parse(cadence.startsAt)-1);
  if(cadence.kind==="hourly"){
    // All supported zones have whole-hour UTC offsets. Actual UTC hours retain both fall-back occurrences.
    const candidate=Math.floor(minimum/3600000)*3600000+cadence.minute*60000;
    return candidate>minimum?candidate:candidate+3600000;
  }
  const next=nextRun(cadence.draft,new Date(minimum));if(!next)throw new RuntimeError("RUNTIME_CADENCE_UNRESOLVABLE",422);return next.at.getTime();
}
export function runtimeWindow(registration:RuntimeRegistration,intendedAt:string,eventRef:string):RuntimeWindow {
  const at=Date.parse(runtimeInstant.parse(intendedAt)),cadence=registration.cadence;
  const canonical=new Date(at).toISOString();let start=at;
  if(cadence.kind!=="event"){
    if(at<Date.parse(cadence.startsAt)||nextRuntimeSlot(cadence,at-1)!==at)throw new RuntimeError("RUNTIME_INTENDED_SLOT_INVALID",422);
    if(cadence.kind==="hourly")start=at-3600000;
    else {
      // At most eight preceding days cover all three supported calendar cadences.
      const first=nextRun(cadence.draft,new Date(at-9*86400000))?.at.getTime();
      if(first===undefined)throw new RuntimeError("RUNTIME_CADENCE_UNRESOLVABLE",422);let previous:number=first;
      for(let n=0;n<10;n++){const next:number|undefined=nextRun(cadence.draft,new Date(previous))?.at.getTime();if(next===undefined||next>=at)break;previous=next;}
      start=previous;
    }
  }
  const identity={registrationRef:registration.registrationRef,registrationVersion:registration.version,cadence,at:canonical,eventRef:cadence.kind==="event"?eventRef:null};
  return{windowRef:`window:${digest(identity)}`,registrationRef:registration.registrationRef,registrationVersion:registration.version,intendedAt:canonical,windowStart:new Date(start).toISOString(),windowEnd:canonical,eventRef:identity.eventRef};
}
export function runtimeSlots(registration:RuntimeRegistration,through:number,limit:number,cursor?:string){
  if(!Number.isInteger(limit)||limit<1||limit>24||!Number.isFinite(through))throw new RuntimeError("RUNTIME_CATCHUP_BOUND_INVALID",422);
  const cadence=registration.cadence;if(cadence.kind==="event")throw new RuntimeError("RUNTIME_EVENT_HAS_NO_CALENDAR",422);
  let next=nextRuntimeSlot(cadence,cursor?Date.parse(runtimeInstant.parse(cursor))-1:Date.parse(cadence.startsAt)-1);
  const slots:string[]=[];
  while(next<=through&&slots.length<limit){slots.push(new Date(next).toISOString());next=nextRuntimeSlot(cadence,next);}
  return{slots,nextCursor:next<=through?new Date(next).toISOString():null,hasMore:next<=through,enumerated:slots.length,total:next<=through?null:slots.length};
}
