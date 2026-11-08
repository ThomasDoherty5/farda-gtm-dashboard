import {expect,type Locator,type Page} from "@playwright/test";
import {execFile} from "node:child_process";
import {appendFileSync,readFileSync,statSync} from "node:fs";
import {promisify} from "node:util";

const run=promisify(execFile);
/** Actual Linux AT-SPI/Orca only. Normal native tests retain their existing assertions. */
export async function screenReaderCheckpoint(page:Page,name:string,focus:Locator,words:string[]){
 const log=process.env.FARDA_SCREEN_READER_LOG,proof=process.env.FARDA_SCREEN_READER_PROOF;
 if(!log&&!proof)return;
 if(process.platform!=="linux"||!log||!proof)throw new Error("An actual configured Linux screen-reader session is required.");
 const start=Date.now(),offset=statSync(log).size;
 await page.bringToFront();
 const windows=(await run("xdotool",["search","--onlyvisible","--class","[Cc]hromium|[Cc]hrome"])).stdout.trim().split(/\s+/);
 const window=windows.at(-1);if(!window)throw new Error("No visible Chromium AT window");
 await run("xdotool",["windowactivate","--sync",window]);
 await focus.focus();
 // An OS keyboard event reaches Orca's Where Am I command, rather than a CDP/AX snapshot.
 await run("xdotool",["key","--clearmodifiers","KP_Enter"]);
 const speech=()=>readFileSync(log).subarray(offset).toString("utf8").split("\n").filter(line=>line.includes("SPEECH OUTPUT:"));
 const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
 await expect.poll(()=>{const text=normalize(speech().join(" "));return words.filter(word=>!text.includes(normalize(word)));},{timeout:12000,message:"Orca spoken output: "+name}).toEqual([]);
 await new Promise(resolve=>setTimeout(resolve,1800));
 appendFileSync(proof,JSON.stringify({name,startedAt:start,finishedAt:Date.now(),url:new URL(page.url()).pathname,osKey:"KP_Enter",expected:words,utterances:speech(),source:"Actual Orca AT-SPI speech output; fictional native HTTP/SQLite fixture"})+"\n");
}
