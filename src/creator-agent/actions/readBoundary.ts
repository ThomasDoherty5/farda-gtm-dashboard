import { ActionServiceError } from "./contract.ts";

/** A legacy source may ignore cancellation; a late result still cannot be published. This never wraps effect execution. */
export async function boundedSourceRead<T>(read:()=>Promise<T>, signal?:AbortSignal, timeoutMs=10_000):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  let cancel=()=>{};
  try {
    return await new Promise<T>((resolve,reject)=>{
      let settled=false;
      const finish=(callback:()=>void)=>{if(settled)return;settled=true;callback();};
      cancel=()=>finish(()=>reject(new ActionServiceError("REQUEST_CANCELLED",499,"notApplied")));
      if(signal?.aborted)return cancel();
      signal?.addEventListener("abort",cancel,{once:true});
      timer=setTimeout(()=>finish(()=>reject(new ActionServiceError("SOURCE_READ_TIMEOUT",504,"notApplied"))),timeoutMs);
      Promise.resolve().then(()=>{if(!settled)return read();}).then(value=>finish(()=>resolve(value as T)),error=>finish(()=>reject(error)));
    });
  } finally {if(timer)clearTimeout(timer);signal?.removeEventListener("abort",cancel);}
}
