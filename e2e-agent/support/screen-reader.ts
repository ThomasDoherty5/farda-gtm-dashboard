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
 const osKeys:string[]=[],diagnostic:Record<string,unknown>={phase:"window"};
 try {
 await page.bringToFront();
 // Axe may create another Chromium page. Activate this page's actual titled
 // window, rather than choosing whichever Chromium window was created last.
 let window:string|undefined;
 // The document title can update before the window manager publishes it.
 await expect.poll(async()=>{
   const pageTitle=await page.title(),title=pageTitle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
   diagnostic.pageTitle=pageTitle;
   try { window=(await run("xdotool",["search","--onlyvisible","--name",title])).stdout.trim().split(/\s+/).filter(Boolean).at(-1); }
   catch { window=undefined; }
   return Boolean(window);
 },{timeout:5000,message:"Visible Chromium window with the current page title"}).toBe(true);
 if(!window)throw new Error("No visible Chromium AT window");
 const activeWindow=window;
 diagnostic.selectedWindow=activeWindow;diagnostic.phase="focus";
 await run("xdotool",["windowactivate","--sync",activeWindow]);
 await transition?.();
 await focus.focus();
 await expect(focus).toBeFocused();
 // DOM focus resolves before Chromium publishes its AT-SPI focus event.
 await new Promise(resolve=>setTimeout(resolve,500));
 // An OS keyboard event reaches Orca's Where Am I command, rather than a CDP/AX snapshot.
 const columns=key==="KP_Enter"?await focus.getByRole("columnheader").count():0;
 const normalize=(s:string)=>s.toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
 const tableTarget=columns?await focus.evaluate(element=>{
   const target=element.matches("table")?element:element.querySelector("table");
   const tables=Array.from(document.querySelectorAll("table")).filter(table=>table.getClientRects().length>0);
   return {index:tables.indexOf(target as HTMLTableElement),captions:tables.map(table=>table.caption?.textContent?.trim()??""),columns:tables.map(table=>table.querySelectorAll("thead th").length)};
 }):null;
 const press=async(command:string)=>{await run("xdotool",["key","--clearmodifiers",command]);osKeys.push(command);};
 const requireTime=(deadline:number,wait:number)=>{if(Date.now()+wait>=deadline)throw new Error("Orca navigation exhausted the remaining speech checkpoint budget");};
 const speechSince=(from:number)=>readFileSync(log).subarray(from).toString("utf8").split("\n").filter(line=>line.includes("SPEECH OUTPUT:"));
 let tableFocusRecovered=false,tableCellRecovered=false;
 const browseFromStart=async(deadline=Infinity)=>{
   diagnostic.phase="browse-mode";
   // A prior form may leave focus mode active. Establish browse mode from
   // Orca's own announcement before actual document navigation.
   // https://help.gnome.org/orca/commands_reading.html
   let mode="";
   for(let attempt=0;attempt<3&&mode!=="Browse mode";attempt++){
     requireTime(deadline,1000);
     const modeOffset=statSync(log).size;
     await press("KP_Insert+a");
     // Orca treats a rapid second press as sticky mode, not another toggle.
     await new Promise(resolve=>setTimeout(resolve,1000));
     await expect.poll(()=>{
       mode=[...readFileSync(log).subarray(modeOffset).toString("utf8").matchAll(/SPEECH OUTPUT: '(Browse mode|Focus mode)(?: is sticky\.)?'/g)].at(-1)?.[1]??"";
       return mode;
     },{timeout:Math.max(1,Math.min(5000,deadline-Date.now())),message:"Actual Orca browse/focus mode announcement"}).toMatch(/^(Browse|Focus) mode$/);
   }
   expect(mode).toBe("Browse mode");
   diagnostic.phase="document-start";
   requireTime(deadline,500);
   await press("ctrl+Home");await new Promise(resolve=>setTimeout(resolve,500));
 };
 const inspectHeaders=async(deadline=Infinity)=>{
   // After dialog focus return, Ctrl+Home can leave Orca's structural table
   // cursor at a different table. The a6a2 trace selected the two-column
   // contribution table instead of the seven-column ledger on every retry.
   // DOM captions guide read-only navigation; only a NEW Orca announcement
   // confirms the target before reading its headers. Never supply speech text.
   // https://help.gnome.org/orca/commands_structural_navigation.html
   if(!tableTarget||tableTarget.index<0)throw new Error("No visible target table for Orca header inspection");
   const captions=tableTarget.captions.map(normalize),targetCaption=captions[tableTarget.index];
   diagnostic.targetCaption=targetCaption;diagnostic.targetIndex=tableTarget.index;
   expect(targetCaption,"A named table is required for actual Orca targeting").toBeTruthy();
   expect(captions.filter(caption=>caption===targetCaption),"Orca table targeting requires a unique caption").toHaveLength(1);
   await browseFromStart(deadline);
   let announced=-1,command="t";
   for(let move=0;move<Math.min(captions.length+1,12)&&announced!==tableTarget.index;move++){
     diagnostic.phase="table-target";
     requireTime(deadline,1000);
     const tableOffset=statSync(log).size;
     await press(command);await new Promise(resolve=>setTimeout(resolve,1000));
     announced=-1;let candidate=-1;
     const tableSpeech=speechSince(tableOffset);
     for(const line of tableSpeech){
       const utterance=line.match(/SPEECH OUTPUT: '(.*)'(?: \{|$)/)?.[1];
       if(!utterance)continue;
       const said=normalize(utterance),index=captions.findIndex(caption=>caption!==""&&(said===caption||said===`${caption} caption`||said===`${caption} table`));
       const dimensions=said.match(/^table with \d+ rows? (\d+) columns?$/);
       if(dimensions)announced=candidate>=0&&Number(dimensions[1])===tableTarget.columns[candidate]?candidate:-1;
       // Pair adjacent speech utterances, and let a later table announcement
       // invalidate an earlier match from this command's output window.
       candidate=index;
     }
     diagnostic.announcedTable=announced;
     if(announced<0&&!tableFocusRecovered&&tableSpeech.some(line=>/SPEECH OUTPUT: 'No more tables[.']/.test(line))){
       // 77ef's stock trace had DOM region focus, then "invalid" and no
       // document tables. One native Tab enters a real existing descendant;
       // it never activates that control or changes the page's semantics.
       // https://help.gnome.org/orca/preferences_web.html
       tableFocusRecovered=true;diagnostic.tableFocusRecovered=true;diagnostic.phase="table-focus-recovery";
       requireTime(deadline,500);
       await focus.focus({timeout:Math.max(1,Math.min(1000,deadline-Date.now()))});
       await expect(focus).toBeFocused({timeout:Math.max(1,Math.min(1000,deadline-Date.now()))});
       requireTime(deadline,500);
       await press("Tab");await new Promise(resolve=>setTimeout(resolve,500));
       expect(await focus.evaluate(element=>{
         const table=element.matches("table")?element:element.querySelector("table");
         return Boolean(table?.contains(document.activeElement));
       }),"Native Tab must enter the actual target table before restoring Orca navigation").toBe(true);
       await browseFromStart(deadline);command="t";
     }
     if(announced>=0)command=announced>tableTarget.index?"shift+t":"t";
   }
   expect(announced,"Actual Orca caption must identify the target table before header traversal").toBe(tableTarget.index);
   const readFirstCell=async()=>{
     diagnostic.phase="first-table-cell";
     requireTime(deadline,1000);
     const cellOffset=statSync(log).size;
     await press("alt+shift+Home");await new Promise(resolve=>setTimeout(resolve,1000));
     return speechSince(cellOffset);
   };
   let firstCell=await readFirstCell();
   if(!tableCellRecovered&&firstCell.some(line=>/SPEECH OUTPUT: 'Not in a table[.']/.test(line))){
     // 77ef announced the correct table, then its enclosing region reclaimed
     // Orca's position. Enter its next document line once, then verify the
     // first cell again instead of sending all remaining keys outside a table.
     // https://help.gnome.org/orca/howto_documents.html
     tableCellRecovered=true;diagnostic.tableCellRecovered=true;diagnostic.phase="table-cell-recovery";
     requireTime(deadline,1000);
     await press("Down");await new Promise(resolve=>setTimeout(resolve,1000));
     firstCell=await readFirstCell();
   }
   // Every successful c0 table checkpoint used these actual coordinates.
   // Only the new Home response may establish the position, not older speech.
   expect(normalize(firstCell.join(" ")),"Actual Orca first-cell coordinates before header traversal").toMatch(/\brow 1 column 1\b/);
   for(let column=1;column<columns;column++){
     diagnostic.phase="table-header-"+(column+1);
     requireTime(deadline,1000);
     await press("alt+shift+Right");
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
 let lineMoves=0,statusPresented=false;
 if(columns)await inspectHeaders();
 const speech=()=>speechSince(offset);
 const speechTimeout=key==="KP_Add"||readLines?60000:20000,speechDeadline=Date.now()+speechTimeout;
 await expect.poll(async()=>{
   const text=normalize(speech().join(" ")),missing=words.filter(word=>!text.includes(normalize(word)));
   // Chromium may finish publishing the AT-SPI document after DOM focus and
   // the first inspection. Repeat only the read-only Where Am I command;
   // never repeat Return, a transition callback, or a business action.
   if(missing.length&&key==="KP_Enter"){
     requireTime(speechDeadline,500);
     await page.bringToFront();await run("xdotool",["windowactivate","--sync",activeWindow]);
     await focus.focus();await new Promise(resolve=>setTimeout(resolve,500));
     await run("xdotool",["key","--clearmodifiers",key]);
     osKeys.push(key);if(columns)await inspectHeaders(speechDeadline);
   }
   if(missing.length&&readLines&&lineMoves<40){
     // A finite read-only traversal replaces the non-starting Say All command.
     // Preserve the original 60s ceiling and require the actual Orca utterance.
     const lineOffset=statSync(log).size;
     await press("Down");lineMoves++;
     await new Promise(resolve=>setTimeout(resolve,1000));
     // Actual 4b32 speech reached "statusbar." but caret Down exposed two
     // blank lines instead of its contents. Ask Orca to present the status
     // bar using its documented desktop command, once, within this same
     // 60s budget. This reads AT-SPI; it never supplies expected text.
     // https://help.gnome.org/orca/commands_where_am_i.html
     if(!statusPresented&&/SPEECH OUTPUT: 'statusbar[.']/.test(readFileSync(log).subarray(lineOffset).toString("utf8"))){
       statusPresented=true;
       await run("xdotool",["key","--clearmodifiers","--repeat","2","--delay","100","KP_Insert+KP_Enter"]);
       osKeys.push("KP_Insert+KP_Enter","KP_Insert+KP_Enter");
       await new Promise(resolve=>setTimeout(resolve,1000));
     }
   }
   const latest=normalize(speech().join(" "));
   return words.filter(word=>!latest.includes(normalize(word)));
 },{timeout:speechTimeout,intervals:readLines?[250]:[500,1000,2000],message:"Orca spoken output: "+name}).toEqual([]);
 await new Promise(resolve=>setTimeout(resolve,1800));
 appendFileSync(proof,JSON.stringify({name,startedAt:start,finishedAt:Date.now(),url:new URL(page.url()).pathname,osKey:key,osKeys,expected:words,utterances:speech(),source:"Actual Orca AT-SPI speech output; fictional native HTTP/SQLite fixture"})+"\n");
 } catch(error) {
   // The existing uploaded browser.log retains bounded failure evidence even
   // when a checkpoint cannot be appended to the successful speech proof.
   let tail:string[]=[];
   try {tail=readFileSync(log).subarray(offset).toString("utf8").split("\n").filter(line=>line.includes("SPEECH OUTPUT:")).slice(-16).map(line=>line.split(" {'established'")[0]!.slice(0,500));} catch { /* Preserve the original failure if the log is unavailable. */ }
   console.error("Orca checkpoint failure "+JSON.stringify({name,elapsedMs:Date.now()-start,...diagnostic,osKeys,speechTail:tail}));
   throw error;
 }
}
