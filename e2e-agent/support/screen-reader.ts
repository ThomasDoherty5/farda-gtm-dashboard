import {expect,type Locator,type Page} from "@playwright/test";
import {execFile} from "node:child_process";
import {appendFileSync,readFileSync,statSync} from "node:fs";
import {promisify} from "node:util";

const run=promisify(execFile);
/** Actual Linux AT-SPI/Orca only. Normal native tests retain their existing assertions. */
export async function screenReaderCheckpoint(page:Page,name:string,focus:Locator,words:string[],key="KP_Enter",transition?:()=>Promise<void>){
 const log=process.env.FARDA_SCREEN_READER_LOG,proof=process.env.FARDA_SCREEN_READER_PROOF;
 if(!log&&!proof){await transition?.();return;}
 if(process.platform!=="linux"||!log||!proof)throw new Error("An actual configured Linux screen-reader session is required.");
 const start=Date.now(),offset=statSync(log).size;
 await page.bringToFront();
 // Axe may create another Chromium page. Activate this page's actual titled
 // window, rather than choosing whichever Chromium window was created last.
 let window:string|undefined;
 // The document title can update before the window manager publishes it.
 await expect.poll(async()=>{
   const title=(await page.title()).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
   try { window=(await run("xdotool",["search","--onlyvisible","--name",title])).stdout.trim().split(/\s+/).filter(Boolean).at(-1); }
   catch { window=undefined; }
   return Boolean(window);
 },{timeout:5000,message:"Visible Chromium window with the current page title"}).toBe(true);
 if(!window)throw new Error("No visible Chromium AT window");
 const activeWindow=window;
 await run("xdotool",["windowactivate","--sync",activeWindow]);
 await transition?.();
 await focus.focus();
 await expect(focus).toBeFocused();
 // DOM focus resolves before Chromium publishes its AT-SPI focus event.
 await new Promise(resolve=>setTimeout(resolve,500));
 // An OS keyboard event reaches Orca's Where Am I command, rather than a CDP/AX snapshot.
 await run("xdotool",["key","--clearmodifiers",key]);
 const speech=()=>readFileSync(log).subarray(offset).toString("utf8").split("\n").filter(line=>line.includes("SPEECH OUTPUT:"));
 const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
 await expect.poll(async()=>{
   const text=normalize(speech().join(" ")),missing=words.filter(word=>!text.includes(normalize(word)));
   // Chromium may finish publishing the AT-SPI document after DOM focus and
   // the first inspection. Repeat only the read-only Where Am I command;
   // never repeat Return, a transition callback, or a business action.
   if(missing.length&&key==="KP_Enter"){
     await page.bringToFront();await run("xdotool",["windowactivate","--sync",activeWindow]);
     await focus.focus();await new Promise(resolve=>setTimeout(resolve,500));
     await run("xdotool",["key","--clearmodifiers",key]);
   }
   return missing;
 },{timeout:20000,intervals:[500,1000,2000],message:"Orca spoken output: "+name}).toEqual([]);
 await new Promise(resolve=>setTimeout(resolve,1800));
 appendFileSync(proof,JSON.stringify({name,startedAt:start,finishedAt:Date.now(),url:new URL(page.url()).pathname,osKey:key,expected:words,utterances:speech(),source:"Actual Orca AT-SPI speech output; fictional native HTTP/SQLite fixture"})+"\n");
}
