import { useEffect } from "react";
import { useBlocker } from "react-router-dom";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";

const identity=(location:{pathname:string;search:string})=>{const query=new URLSearchParams(location.search);["draftId","requestKey","previewRequestKey","previewVersion","offerRequestKey","offerRequestVersion","offerRequestDigest"].forEach(key=>query.delete(key));query.sort();return location.pathname+query.toString();};
/** Recovery URL bookkeeping never interrupts its own save. An unresolved original cannot be discarded. */
export function RecruitmentLeaveGuard({dirty,uncertain}:{dirty:boolean;uncertain:boolean}) {
  const blocker=useBlocker(({currentLocation,nextLocation})=>(dirty||uncertain)&&identity(currentLocation)!==identity(nextLocation));
  useEffect(()=>{if(!dirty&&!uncertain)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",warn);return()=>window.removeEventListener("beforeunload",warn);},[dirty,uncertain]);
  return <Dialog open={blocker.state==="blocked"} title={uncertain?"Reconcile the original request":"Discard unsaved edits?"} onClose={()=>blocker.reset?.()}><p>{uncertain?"Keep the original request key until its authoritative outcome is recorded. A missing result is not permission to start again.":"These local invitation or offer edits have not been saved."}</p><Button onClick={()=>blocker.reset?.()}>Keep current task</Button>{!uncertain&&<Button variant="secondary" onClick={()=>blocker.proceed?.()}>Discard and leave</Button>}</Dialog>;
}
