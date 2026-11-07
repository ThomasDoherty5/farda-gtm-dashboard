import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { approvalFixture, approvalTestScope as scope } from "../src/creator-agent/approvals/fixtures.testkit.ts";
import { reviewSourceFixture } from "../src/creator-agent/actions/reviewFixtures.testkit.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { digest } from "../src/creator-agent/config.ts";
import type { DispatchHandler } from "../src/creator-agent/jobs/dispatchSchema.ts";
import type { RunItemRecovery } from "../src/creator-agent/actions/reviewViews.ts";
import { assertNativeTableReadability, scrollNativeTableToEnd } from "./support/native-table-readability";

// Actual authenticated HTTP/SQLite/J04/worker with fictional source boundaries.
// No real provider, person, message, session, financial commitment or payout is used.
test.setTimeout(240_000);
const machineToken="synthetic-review-browser-worker-not-for-deployment";
const cleanups:(()=>Promise<void>)[]=[];
test.afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function world(page:Page){
  const a=approvalFixture(),folder=mkdtempSync(join(tmpdir(),"farda-action-review-"));a.state.now=Date.now();
  a.policy.observedAt=a.at();a.policy.validUntil=a.until();a.draft.actionKind="synthetic-review-task";a.command.actionKind=a.draft.actionKind;
  a.draft.phase="other";a.draft.acquisitionTerms=null;a.draft.effects.sendsCreator=false;a.draft.sourceValidUntil=a.until();a.draft.expiresAt=a.until();
  for(const gate of Object.values(a.draft.gates))if(gate?.state==="satisfied")gate.validUntil=a.until();
  for(const human of a.humans.values()){human.observedAt=a.at();human.validUntil=a.until();}
  a.humans.set("agent-reviewer",{...structuredClone(a.humans.get("synthetic:requester")!),principalRef:"agent-reviewer",roles:["operator"]});
  const source=reviewSourceFixture(()=>a.state.now),state={unknown:false,closed:false,calls:0,displayLeaseMs:300000,recovery:"login" as RunItemRecovery["kind"],lane:"manualHistoricalPayable" as "manualHistoricalPayable"|"collabsAutoSettlement"|"tiktokAutoSettlement"};
  const next:Record<RunItemRecovery["kind"],RunItemRecovery["nextAction"]>={login:"signInAtSource",mfa:"completeMfaAtSource",denied:"ownerPermissionReview",throttled:"waitForSourceReset",failed:"inspectFailure",uncertain:"reconcileOriginal",notApplicable:"none",unknown:"sourceEvidenceRequired"};
  source.state.transform=value=>{value.validUntil=new Date(a.state.now+state.displayLeaseMs).toISOString();value.settlement={lane:state.lane,detail:{text:"Fictional source settlement context; no verified funds-transfer receipt.",redacted:false}};
    value.items.forEach(item=>{item.payload={text:`Fictional exact source payload v${value.binding.manifestVersion}. No real outreach.`,redacted:false};if(item.recovery){item.recovery.kind=state.recovery;item.recovery.nextAction=next[state.recovery];item.recovery.resetAt=state.recovery==="throttled"?a.until():null;}});return value;};
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Fictional local review artifact with no money, inventory or external provider effect."};
  const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,resources:()=>({budget:na,stock:na,quota:na}),
    budgets:{maxItems:1,maxSteps:50,maxAttempts:3,maxRunMs:300000,leaseMs:10000,maxConcurrency:1,retryBaseMs:0},
    execute:async c=>{state.calls++;return state.unknown?{state:"unknown",reasonCode:"SYNTHETIC_SOURCE_OUTCOME_UNKNOWN"}:{state:"applied",receipt:{receiptRef:"synthetic-review-artifact",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}};},
    reconcile:async c=>state.closed?{state:"notApplied",attemptRef:c.attemptRef,attemptNumber:c.attemptNumber,dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,receiptRef:"synthetic-original-closure",observedAt:a.at(),validUntil:a.until(),complete:true,originalAttemptClosed:true}:{state:"unknown",reasonCode:"SYNTHETIC_SOURCE_READBACK_UNKNOWN"}};
  const app=createAgentServer({databasePath:join(folder,"agent.sqlite"),workspaceId:scope.workspaceId,accountId:scope.accountId,readToken:SYNTHETIC_READ_TOKEN,reviewToken:SYNTHETIC_REVIEW_TOKEN,operations:{now:()=>a.state.now},
    actionFoundation:{approvals:{sources:a.sources,registry:a.options.registry,currentPolicy:a.options.currentPolicy},registry:new Map([[a.draft.actionKind,{handlerRef:"synthetic-review.v1"}]]),handlers:new Map([["synthetic-review.v1",handler]]),reviewSource:source.source,reviewLinkOrigins:["https://review.example.test"],
      worker:{token:machineToken,workerRef:"synthetic-review-worker",resolve:async(s,runRef)=>({scope:s,runRef,workerRef:"synthetic-review-worker",authorityVersion:"synthetic-worker-v1",observedAt:a.at(),validUntil:a.until()}),assertCurrent:proof=>{if(proof.authorityVersion!=="synthetic-worker-v1")throw new Error("Synthetic worker denied");}}}});
  await new Promise<void>((done,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT),"127.0.0.1",done);});
  cleanups.push(async()=>{await app.close();a.db.close();rmSync(folder,{recursive:true,force:true});});
  const base={schemaVersion:SCHEMA_VERSION,requestId:"synthetic-review-request",requestedScope:{workspaceId:scope.workspaceId,accountIds:[scope.accountId],environment:"sandbox" as const},entityRefs:[],approvalRef:null,manifestRef:null,runRef:null};
  const preview=await app.actionFoundation.execute({...base,operation:"previewAction",actionKind:a.draft.actionKind,expectedVersion:a.command.entityVersion,idempotencyKey:"synthetic-review-preview",payload:{entityRef:a.command.entityRef,entityVersion:a.command.entityVersion,selectionRefs:a.command.selectionRefs}},"agent-reviewer");
  async function approve(){const current=app.actionFoundation.approvals.readApproval(preview.approvalRef!)!;const event=a.event(current);await app.actionFoundation.approvals.observeDecision(event.locator,{ingressRef:"synthetic-source-ingress"});}
  async function request(){await app.actionFoundation.approvals.requestDecision({approvalRef:preview.approvalRef!,expectedVersion:1},{principalRef:"agent-reviewer"},"synthetic-review-decision-request");await approve();}
  async function handoff(){const current=app.actionFoundation.approvals.readApproval(preview.approvalRef!)!;return app.actionFoundation.execute({...base,operation:"dispatchApprovedAction",actionKind:"dispatchApprovedAction",approvalRef:preview.approvalRef,manifestRef:preview.manifestRef,expectedVersion:app.actionFoundation.service.approvalVersion(current),idempotencyKey:"synthetic-review-handoff",payload:{}},"agent-reviewer");}
  async function worker(runRef:string){return fetch(`http://127.0.0.1:${process.env.E2E_AGENT_SERVER_PORT}/v1/worker/dispatch`,{method:"POST",headers:{authorization:"Bearer "+machineToken,"content-type":"application/json"},body:JSON.stringify({runRef})});}
  expect((await page.request.get("/v1/session",{headers:{authorization:"Bearer "+SYNTHETIC_REVIEW_TOKEN}})).ok()).toBe(true);
  return{a,app,source,state,base,preview,approve,request,handoff,worker};
}
async function compare(page:Page,name:string){
  const configured=process.env.FARDA_ACTION_REVIEW_COMPARE_DIR;if(!configured)return;
  const root=resolve(".handoff")+sep,dir=resolve(configured);if(!dir.startsWith(root))throw new Error("Original comparison must remain private");
  const map=JSON.parse(readFileSync(join(dir,"originals.json"),"utf8")) as Record<string,unknown>,original=map[name];
  if(typeof original!=="string"||!resolve(original).startsWith(root))throw new Error("Missing private full original mapping");
  const out=join(dir,name),auth=join(out,"synthetic-auth.json");mkdirSync(out,{recursive:true});
  try{writeFileSync(auth,JSON.stringify(await page.context().storageState()),{mode:0o600});const url=new URL(page.url()),env={...process.env};delete env.SEGMENTS;
    const result=await promisify(execFile)(process.execPath,["scripts/compare-figma.mjs",url.pathname+url.search,resolve(original)],{env:{...env,BASE_URL:url.origin,FIGMA_COMPARE_BROWSER_CHANNEL:process.env.E2E_AGENT_BROWSER_CHANNEL,FIGMA_COMPARE_STORAGE_STATE:auth,FIGMA_COMPARE_OUTPUT_DIR:out},timeout:60000});
    writeFileSync(join(out,"comparison.json"),JSON.stringify({fullFrame:true,crop:null,segments:null,claim:"Native source-state adaptation; not pixel parity",metrics:JSON.parse(result.stdout)},null,2));
  }finally{rmSync(auth,{force:true});}
}
async function capture(page:Page,info:TestInfo,name:string,kind:"approval"|"run"|null=null,original=false){
  const dir=process.env.FARDA_ACTION_REVIEW_PROOF_DIR??info.outputPath("action-review-evidence"),captures=[];mkdirSync(dir,{recursive:true});
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===1440?1000:844});await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));
    await page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
    const ax=await new AxeBuilder({page:page as never}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();expect(ax.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))).toEqual([]);
    const paths=[join(dir,`${name}-${width}.png`)];await page.screenshot({path:paths[0],fullPage:true});
    if(kind){const table=await assertNativeTableReadability(page,kind,width,{keyboardProof:"fullTraversalFollows"});if(table.overflow){await scrollNativeTableToEnd(page,table.caption);const path=join(dir,`${name}-table-end-${width}.png`);await page.screenshot({path,fullPage:true});paths.push(path);await page.locator(`[role="region"][aria-label="${table.caption}"]`).evaluate(el=>{el.scrollLeft=0;});}}
    for(const path of paths){const bytes=readFileSync(path);captures.push({file:basename(path),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20),sha256:createHash("sha256").update(bytes).digest("hex")});}
    if(original&&width===1440)await compare(page,name);
  }
  writeFileSync(join(dir,`${name}-provenance.json`),JSON.stringify({name,source:"Actual HTTP/SQLite/J04/worker with fictional source-authorized review fixtures",providerWrites:0,realPeople:0,payments:0,displayAuthority:"Synthetic only; no live source qualification claimed",captures},null,2));
}

test("source-granted exact approval proceeds to a receipt and real historical versions remain read-only",async({page},info)=>{
  const w=await world(page);await page.goto(`/approvals/${w.preview.approvalRef}`);await expect(page.getByTestId("native-review-payload")).toHaveText("Fictional exact source payload v1. No real outreach.");
  await expect(page.getByRole("button",{name:"Approve this version"})).toBeDisabled();await capture(page,info,"approval-source-current","approval",true);
  await page.getByRole("button",{name:"Open approval channel",exact:true}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByRole("dialog").getByRole("link",{name:"Open in a new tab",exact:true})).toHaveAttribute("href",/review.example.test/);await page.keyboard.press("Escape");await expect(page.getByRole("button",{name:"Open approval channel",exact:true})).toBeFocused();
  await page.getByRole("button",{name:"Request source approval"}).click();await expect(page.getByText("Command acknowledged.",{exact:false})).toBeVisible();await w.approve();await page.getByRole("button",{name:"Refresh approval evidence"}).click();
  await page.getByRole("button",{name:"Queue selected approved items"}).click();await page.getByRole("link",{name:"Open recorded run"}).click();const runRef=new URL(page.url()).pathname.split("/").at(-1)!;
  expect((await w.worker(runRef)).status).toBe(200);await page.getByRole("button",{name:"Refresh run evidence"}).click();await expect(page.getByText("Local artifact confirmed",{exact:true})).toBeVisible();expect(w.state.calls).toBe(1);await capture(page,info,"run-source-receipt","run",true);
  await page.goto(`/approvals/${w.preview.approvalRef}`);await expect(page.getByRole("link",{name:"Open recorded execution",exact:true})).toHaveAttribute("href",`/runs/${runRef}?tab=approval`);await expect(page.getByText("Item receipts recorded",{exact:true})).toBeVisible();await expect(page.getByTestId("native-approval-status")).toHaveText("Approval recorded");await expect(page.getByRole("button",{name:"Queue selected approved items"})).toBeDisabled();await capture(page,info,"approval-reopened-receipt","approval");
  const previous=w.app.actionFoundation.approvals.readApproval(w.preview.approvalRef!)!;w.a.draft.payloadHash=digest("synthetic changed review v2");w.a.draft.items[0]!.payloadHash=w.a.draft.payloadHash;w.a.draft.sourceBasisVersion="synthetic-review-basis-v2";
  await w.app.actionFoundation.execute({...w.base,operation:"previewAction",actionKind:w.a.draft.actionKind,approvalRef:previous.manifest.approvalRef,manifestRef:w.app.actionFoundation.service.manifestRef(previous),expectedVersion:w.app.actionFoundation.service.approvalVersion(previous),idempotencyKey:"synthetic-review-v2",payload:{entityRef:w.a.command.entityRef,entityVersion:w.a.command.entityVersion,selectionRefs:w.a.command.selectionRefs}},"agent-reviewer");
  await page.goto(`/approvals/${w.preview.approvalRef}?version=v1`);await expect(page.getByText(/Selected immutable version 1 of 2/)).toBeVisible();await expect(page.getByTestId("native-review-payload")).toHaveText("Fictional exact source payload v1. No real outreach.");await expect(page.getByRole("button",{name:"Queue selected approved items"})).toHaveCount(0);await capture(page,info,"approval-history-v1","approval");
  await page.getByRole("link",{name:"Return to current approval"}).click();await expect(page.getByTestId("native-review-payload")).toHaveText("Fictional exact source payload v2. No real outreach.");expect(w.state.calls).toBe(1);
});

test("typed source recovery reconciles the original attempt before guarded continuation",async({page},info)=>{
  const w=await world(page);await w.request();const queued=await w.handoff();w.state.unknown=true;expect((await w.worker(queued.runRef!)).status).toBe(502);expect(w.state.calls).toBe(1);
  await page.goto(`/runs/${queued.runRef}?tab=recovery`);await expect(page.getByRole("button",{name:"Continue guarded original work"})).toBeDisabled();await expect(page.getByText("Original attempt remains open",{exact:true})).toBeVisible();await capture(page,info,"run-login-recovery","run",true);
  for(const kind of ["mfa","denied","throttled","failed","uncertain"] as const){w.state.recovery=kind;w.source.state.version="synthetic-review-"+kind;await page.getByRole("button",{name:"Refresh run evidence"}).click();await expect(page.getByText("Source recovery",{exact:true}).locator("..")).toContainText(kind);await capture(page,info,`run-${kind}-recovery`,"run");}
  await page.getByRole("button",{name:"Request human takeover"}).click();await expect(page.getByRole("dialog").getByRole("link",{name:"Open permitted source handoff"})).toHaveAttribute("href","https://review.example.test/handoff/synthetic");await page.keyboard.press("Escape");
  w.state.closed=true;await page.getByRole("button",{name:"Verify and record source result"}).click();await expect(page.getByText("Exact original attempt closed as not applied",{exact:true})).toBeVisible();expect(w.state.calls).toBe(1);await capture(page,info,"run-original-closed","run");
  w.state.unknown=false;expect((await w.worker(queued.runRef!)).status).toBe(200);expect(w.state.calls).toBe(2);await page.getByRole("button",{name:"Refresh run evidence"}).click();await expect(page.getByText("Local artifact confirmed",{exact:true})).toBeVisible();
});

test("provider settlement dialogs, partial display and expiry never create authority or retain protected source content",async({page},info)=>{
  const w=await world(page);await page.goto(`/approvals/${w.preview.approvalRef}`);await expect(page.getByTestId("native-review-payload")).toBeVisible();
  for(const lane of ["manualHistoricalPayable","collabsAutoSettlement","tiktokAutoSettlement"] as const){w.state.lane=lane;w.source.state.version="synthetic-review-"+lane;await page.getByRole("button",{name:"Refresh approval evidence"}).click();await page.getByRole("button",{name:"Inspect settlement reconciliation"}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog")).toBeVisible();await expect(page.getByText(/Financial receipt: Unknown/)).toBeVisible();await capture(page,info,"settlement-"+lane);await page.getByRole("button",{name:"Close reconciliation"}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Inspect settlement reconciliation"})).toBeFocused();}
  w.source.state.withheld=true;await page.getByRole("button",{name:"Refresh approval evidence"}).click();await expect(page.getByTestId("native-review-payload")).toContainText("Unavailable");await capture(page,info,"approval-partial","approval");
  w.source.state.withheld=false;w.a.state.now=Date.now();w.state.displayLeaseMs=2000;await page.getByRole("button",{name:"Refresh approval evidence"}).click();await expect(page.getByTestId("native-review-payload")).toContainText("Fictional exact");await expect(page.getByText("Fictional exact source payload v1. No real outreach.",{exact:true})).toHaveCount(0);await expect(page.getByRole("link",{name:"Open exact approval in Slack"})).toHaveCount(0);await capture(page,info,"approval-display-expired","approval");
  // Test-only storage inspection: protected labels/payloads must never enter browser persistence.
  // eslint-disable-next-line no-restricted-globals
  expect(await page.evaluate(()=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]))).not.toMatch(/Fictional exact source payload|Synthetic recipient|Fictional source settlement/);
  w.a.state.now=Date.now();for(const human of w.a.humans.values()){human.observedAt=w.a.at();human.validUntil=w.a.until();}w.source.state.permitted=false;const denied=page.waitForResponse(response=>response.url().endsWith("/v1/read")&&response.request().postDataJSON()?.viewKey==="approvalDetail"&&response.status()===403);await page.getByRole("button",{name:"Refresh approval evidence"}).click();const response=await denied;expect(await response.json()).toMatchObject({code:"REVIEW_SOURCE_DENIED",executionCertainty:"notApplied"});await expect(page.getByTestId("native-review-payload")).toHaveCount(0);await capture(page,info,"approval-source-denied");expect(w.state.calls).toBe(0);
});
