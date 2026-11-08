// @vitest-environment node
import { expect,it } from "vitest";
import { boundedSourceRead } from "./readBoundary.ts";
it("bounds a hung read and refuses a late result after cancellation",async()=>{
  await expect(boundedSourceRead(()=>new Promise(()=>{}),undefined,5)).rejects.toMatchObject({code:"SOURCE_READ_TIMEOUT",status:504});
  const abort=new AbortController();let publish!:(value:string)=>void;
  const read=boundedSourceRead(()=>new Promise<string>(resolve=>{publish=resolve;}),abort.signal);
  await Promise.resolve();abort.abort();publish("protected late data");
  await expect(read).rejects.toMatchObject({code:"REQUEST_CANCELLED"});
});
