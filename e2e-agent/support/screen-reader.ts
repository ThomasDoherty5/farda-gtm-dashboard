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
 const osKeys:string[]=[],columns=key==="KP_Enter"?await focus.getByRole("columnheader").count():0;
 const tableOrdinal=columns?await focus.evaluate(element=>{
   const target=element.matches("table")?element:element.querySelector("table");
   return Array.from(document.querySelectorAll("table")).filter(table=>table.getClientRects().length>0).indexOf(target as HTMLTableElement)+1;
 }):0;
 const press=async(command:string)=>{await run("xdotool",["key","--clearmodifiers",command]);osKeys.push(command);};
 const browseFromStart=async()=>{
   // A prior form may leave focus mode active. Establish browse mode from
   // Orca's own announcement before actual document navigation.
   // https://help.gnome.org/orca/commands_reading.html
   let mode="";
   for(let attempt=0;attempt<3&&mode!=="Browse mode";attempt++){
     const modeOffset=statSync(log).size;
     await press("KP_Insert+a");
     // Orca treats a rapid second press as sticky mode, not another toggle.
     await new Promise(resolve=>setTimeout(resolve,1000));
     await expect.poll(()=>{
       mode=[...readFileSync(log).subarray(modeOffset).toString("utf8").matchAll(/SPEECH OUTPUT: '(Browse mode|Focus mode)(?: is sticky\.)?'/g)].at(-1)?.[1]??"";
       return mode;
     },{timeout:5000,message:"Actual Orca browse/focus mode announcement"}).toMatch(/^(Browse|Focus) mode$/);
   }
   expect(mode).toBe("Browse mode");
   await press("ctrl+Home");await new Promise(resolve=>setTimeout(resolve,500));
 };
 const inspectHeaders=async()=>{
   // DOM focus does not move Orca's caret into its table. DOM geometry
   // supplies only its ordinal, never the spoken evidence.
   // https://help.gnome.org/orca/commands_structural_navigation.html
   expect(tableOrdinal).toBeGreaterThan(0);
   await browseFromStart();
   for(let table=0;table<tableOrdinal;table++){await press("t");await new Promise(resolve=>setTimeout(resolve,1000));}
   for(let column=0;column<columns;column++){
     const command=column===0?"alt+shift+Home":"alt+shift+Right";
     await press(command);
     await new Promise(resolve=>setTimeout(resolve,1000));
   }
 };
 // Read source-status text from the real document, not an assumed initial live announcement.
 // Orca 46.1's recorded KP_Add checkpoint produced only '+' and no document speech.
 // For line reading, use actual heading/caret navigation; never type the expected text.
 // https://help.gnome.org/orca/howto_documents.html
 const readLines=key==="Down";
 if(key==="KP_Add"||readLines)await browseFromStart();
 if(readLines){await press("h");await new Promise(resolve=>setTimeout(resolve,500));}
 if(!readLines)await press(key);
 let lineMoves=0;
 if(columns)await inspectHeaders();
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
     osKeys.push(key);if(columns)await inspectHeaders();
   }
   if(missing.length&&readLines&&lineMoves<40){
     // A finite read-only traversal replaces the non-starting Say All command.
     // Preserve the original 60s ceiling and require the actual Orca utterance.
     await press("Down");lineMoves++;
     await new Promise(resolve=>setTimeout(resolve,1000));
   }
   return missing;
 },{timeout:key==="KP_Add"||readLines?60000:20000,intervals:readLines?[250]:[500,1000,2000],message:"Orca spoken output: "+name}).toEqual([]);
 await new Promise(resolve=>setTimeout(resolve,1800));
 appendFileSync(proof,JSON.stringify({name,startedAt:start,finishedAt:Date.now(),url:new URL(page.url()).pathname,osKey:key,osKeys,expected:words,utterances:speech(),source:"Actual Orca AT-SPI speech output; fictional native HTTP/SQLite fixture"})+"\n");
}
