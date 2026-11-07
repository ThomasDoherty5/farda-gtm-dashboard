import { expect, test, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createAgentServer } from "../src/creator-agent/server.ts";
import { offerPolicyFixture } from "../src/creator-agent/offers/policyFixture.testkit.ts";
import { providerMaterial } from "../src/creator-agent/offers/policy.ts";
import { approvalFixture } from "../src/creator-agent/approvals/fixtures.testkit.ts";
import { approvalDispatchBinding } from "../src/creator-agent/approvals/repository.ts";
import { commercialPolicyFixture } from "../src/creator-agent/commercialPolicy/fixtures.testkit.ts";
import { acquisitionTermsOf } from "../src/creator-agent/commercialPolicy/evaluate.ts";
import { RecruitmentSourceError, type RecruitmentSourceSnapshot, type RecruitmentSource } from "../src/creator-agent/commercialPolicy/recruitment.ts";
import { digest } from "../src/creator-agent/config.ts";
import { assessCreator } from "../src/creator-agent/policy.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, SYNTHETIC_SCOPE } from "../src/creator-agent/testFixtures.ts";
import { SCHEMA_VERSION } from "../src/adapter/contract.ts";
import { scorecardPreviewPath } from "../src/creator-agent/scorecardPreview.ts";
import type { DispatchHandler } from "../src/creator-agent/jobs/dispatchSchema.ts";

// One real HTTP service/SQLite and fictional qualified source bindings. No external writes or adopted company policy.
// The actual assessment engine evaluates the reviewed synthetic packet; no passing qualification DTO is substituted.
test.setTimeout(180_000);
const cleanups: (() => Promise<void>)[] = [];
test.afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function world(connected = true) {
  const dir = mkdtempSync(join(tmpdir(), "farda-commercial-read-")), path = join(dir, "agent.sqlite");
  const scope = { workspaceId: SYNTHETIC_SCOPE.workspaceId, accountId: SYNTHETIC_SCOPE.accountIds[0]!, environment: "sandbox" as const };
  const h = offerPolicyFixture(path, scope);
  h.advance(Date.now()-h.now());
  h.source.state.current=commercialPolicyFixture(scope,h.now());
  h.terms.expiresAt=new Date(h.now()+3600000).toISOString();h.terms.commission.effectiveAt=new Date(h.now()-1000).toISOString();
  const offer = h.save(), a = approvalFixture(), binding = syntheticBinding();
  a.state.now = h.now(); a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  for (const human of a.humans.values()) { human.observedAt = a.at(); human.validUntil = a.until(); }
  a.humans.set("agent-reviewer", { ...a.humans.get("synthetic:requester")!, principalRef: "agent-reviewer" });
  h.auth.assertCurrent = proof => {
    const actual = app.store.latest(proof.assessment?.creatorId ?? "");
    const expected = actual ? { creatorId: actual.packet.creatorId, runId: actual.runId, route: actual.packet.checkoutRoute, modelId: actual.assessment.modelId,
      configHash: actual.assessment.config.hash, policyVersion: actual.assessment.policyVersion, termsRevision: actual.packet.termsRevision, state: actual.assessment.state, stale: false } : null;
    const provider = h.auth.provider?.(h.terms, scope) as { facts: NonNullable<typeof proof.provider> };
    if (digest(proof.assessment) !== digest(expected) || digest(proof.suppression) !== digest(h.auth.suppression?.(h.terms.creatorId, scope)) ||
      digest(providerMaterial(proof.provider)) !== digest(providerMaterial(provider.facts))) throw new Error("Synthetic backing association changed");
  };
  const d = a.draft; d.expiresAt = a.until(); d.sourceValidUntil = a.until();
  for (const gate of Object.values(d.gates)) if (gate?.state === "satisfied") gate.validUntil = a.until();
  d.providerAccountRef = offer.provider!.providerAccountRef!; d.productVersion = { state: "required", version: h.terms.manifest.productRevision! };
  d.termsVersion = { state: "required", version: offer.version }; d.acquisitionTerms = acquisitionTermsOf(h.terms);
  d.gates.sampleAuthority = structuredClone(d.gates.providerTerms);
  d.items[0]!.targetRef = h.terms.creatorId; d.commercialOffers = [{ itemRef: d.items[0]!.itemRef, offerRef: offer.offerId }];
  const na = { state: "notApplicable" as const, policyVersion: a.policy.version, reason: "Synthetic read review never executes this handler." };
  const handler: DispatchHandler = { idempotency: "source-enforced", sourceEffect: "localArtifact", policyVersion: a.policy.version, provider: na,
    resources: () => ({ budget: na, stock: na, quota: na }), budgets: { maxItems: 1, maxSteps: 10, maxAttempts: 1, maxRunMs: 10000, leaseMs: 1000, maxConcurrency: 1, retryBaseMs: 0 },
    execute: async () => { throw new Error("This read integration test must never execute"); }, reconcile: async () => ({ state: "unknown", reasonCode: "SYNTHETIC_NOT_EXECUTED" }) };
  let duringRead: (() => void) | null = null, duringAssert: (() => void) | null = null;
  const recruitmentSource: RecruitmentSource = {
    read: async () => { const copy = structuredClone(source); duringRead?.(); return copy; },
    assertCurrent: snapshot => { duringAssert?.(); if (source.permission === "denied") throw new RecruitmentSourceError("SOURCE_SCOPE_DENIED", 403);
      if (digest(snapshot) !== digest(source)) throw new RecruitmentSourceError("RECRUITMENT_SOURCE_CHANGED", 409); },
  };
  const app = createAgentServer({ databasePath: path, workspaceId: scope.workspaceId, accountId: scope.accountId, readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN,
    bindings: [binding], operations: { now: h.now }, offerAuthority: h.auth, commercialPolicy: h.source.source, recruitmentSource: connected ? recruitmentSource : undefined,
    actionFoundation: { approvals: a.options, registry: new Map([[d.actionKind, { handlerRef: "synthetic-commercial-read.v1" }]]), handlers: new Map([["synthetic-commercial-read.v1", handler]]) } });
  cleanups.push(async () => { await app.close(); h.store.close(); a.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const packet = { ...syntheticPacket(), termsRevision: offer.manifestHash };
  const saved = app.store.save(packet, assessCreator(packet, binding), 0, "synthetic-commercial-assessment");
  expect(saved.assessment.state).toBe("prospectiveInviteEligible");
  const source: RecruitmentSourceSnapshot = { scope, principalRef: "agent-reviewer", filters: { networks: "both", route: "queue" }, sourceRef: "synthetic-private-recruitment-source", sourceVersion: "v1",
    observedAt: a.at(), validUntil: a.until(), permission: "permitted", rows: [{ opportunityRef: "synthetic-private-opportunity", creatorId: packet.creatorId, runId: saved.runId,
      offerId: offer.offerId, offerVersion: offer.version, phase: "invitation", network: "instagram", route: "inbound" }], total: 1, complete: true };
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(Number(process.env.E2E_AGENT_SERVER_PORT), "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Expected local test server");
  const origin = `http://127.0.0.1:${address.port}`;
  const selection = { creatorId: packet.creatorId, runId: saved.runId, offerId: offer.offerId, offerVersion: offer.version, phase: "invitation" as const };
  async function read(viewKey: string, filters: object, token: string | null = SYNTHETIC_READ_TOKEN, limit = 100) {
    const response = await fetch(origin + "/v1/read", { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-commercial-read", requestedScope: SYNTHETIC_SCOPE, viewKey, filters, period: null, sort: [], page: { cursor: null, limit } }) });
    return { status: response.status, body: await response.json() };
  }
  async function approvedRun() {
    const repo = app.actionFoundation.approvals, principal = { principalRef: "agent-reviewer" };
    const preview = await repo.preparePreview(a.command, principal, "synthetic-preview");
    const requested = await repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: 1 }, principal, "synthetic-request");
    const event = a.event(requested); const approved = await repo.observeDecision(event.locator, { ingressRef: "synthetic-verified-relay" });
    const manifest = approved.manifest;
    const run = await app.actionFoundation.dispatch.handoff({ handlerRef: "synthetic-commercial-read.v1", payloadRef: d.payloadRef,
      approval: approvalDispatchBinding(manifest, manifest.items[0]!.itemRef) }, { principalRef: principal.principalRef, idempotencyKey: "synthetic-read-run" });
    return { approved, run };
  }
  return { h, a, app, offer, saved, source, read, selection, approvedRun,
    onRead: (fn: () => void) => { duringRead = fn; }, onAssert: (fn: () => void) => { duringAssert = fn; } };
}

let captures: {file:string;width:number;height:number;sha256:string;state:string}[]=[];
const proofDirectory = (info: TestInfo) => process.env.FARDA_COMMERCIAL_PARITY_PROOF_DIR ?? info.outputPath("commercial-parity-evidence");
const originalComparisonStates = new Set(["assessment-current", "offer-current", "recruitment-current", "preview-current", "approval-current", "run-current"]);
async function compareOriginal(page: Page, state: string) {
  const configured = process.env.FARDA_COMMERCIAL_PARITY_COMPARE_DIR;
  if (!configured || !originalComparisonStates.has(state)) return;
  const privateRoot = resolve(".handoff") + sep, directory = resolve(configured);
  if (!directory.startsWith(privateRoot)) throw new Error("Original comparisons must remain in the ignored private handoff directory.");
  // Caller-owned private mapping, never bundled or copied into a public test artifact.
  const originals: unknown = JSON.parse(readFileSync(join(directory, "originals.json"), "utf8"));
  const original = originals && typeof originals === "object" ? (originals as Record<string, unknown>)[state] : undefined;
  if (typeof original !== "string" || !resolve(original).startsWith(privateRoot)) throw new Error("Missing private original capture mapping.");
  const output = join(directory, state), authState = join(output, "auth-state.json");
  mkdirSync(output, { recursive: true });
  try {
    writeFileSync(authState, JSON.stringify(await page.context().storageState()), { mode: 0o600 });
    const location = new URL(page.url()), environment = { ...process.env };
    delete environment.SEGMENTS;
    const result = await promisify(execFile)(process.execPath,
      ["scripts/compare-figma.mjs", location.pathname + location.search, resolve(original)], {
        env: { ...environment, BASE_URL: location.origin, FIGMA_COMPARE_BROWSER_CHANNEL: process.env.E2E_AGENT_BROWSER_CHANNEL,
          FIGMA_COMPARE_STORAGE_STATE: authState, FIGMA_COMPARE_OUTPUT_DIR: output }, timeout: 60000,
      });
    const metrics: unknown = JSON.parse(result.stdout);
    writeFileSync(join(output, "metrics.json"), JSON.stringify({ state, fullFrame: true, crop: null, segments: null,
      claim: "Source-state adaptation comparison; differing heights mean the script percentage covers the common rectangle, not the entire union.",
      metrics }, null, 2));
    if (result.stderr) writeFileSync(join(output, "comparison-stderr.txt"), result.stderr);
  } finally { rmSync(authState, { force: true }); }
}
async function capture(page: Page, info: TestInfo, state: string) {
  const output = proofDirectory(info); mkdirSync(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if(width===1440&&state==="preview-current") {
      const region=page.locator('[role="region"][aria-label="Selected invitation assessments"]');
      expect(await region.evaluate(element=>element.scrollWidth-element.clientWidth)).toBe(0);
    }
    if(width===390&&state==="preview-current") {
      const evidence=page.getByRole("table",{name:"Selected invitation assessments"}).locator("tbody tr").first().locator("td").nth(1);
      expect(await evidence.evaluate(element=>element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(152);
    }
    const result = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
    const path = join(output, `${state}-${width}.png`);
    await page.screenshot({ path, fullPage: true });
    const png = readFileSync(path);
    captures.push({ file: basename(path), width: png.readUInt32BE(16), height: png.readUInt32BE(20),
      sha256: createHash("sha256").update(png).digest("hex"), state });
    if (width === 1440) await compareOriginal(page, state);
  }
  writeFileSync(join(output, `provenance-${info.testId.replace(/[^a-zA-Z0-9]/g, "").slice(-40)}.json`), JSON.stringify({
    source: "Actual authenticated dashboard HTTP and shared SQLite with fictional source-owned commercial policy, recruitment membership and evaluated assessment bindings.",
    providerBusinessWrites: 0, sourceContacts: 0, adoptedCompanyPolicy: false, syntheticPacketsEvaluated: 1, qualificationDTOOverrides: 0,
    sourceMapping: { assessment: "102:364", offer: "65:634", recruitment: "38:131", preview: "66:821", approval: "6:234", run: "5:13" },
    visualClaim: "Native source-state adaptations; no pixel-parity claim and no original Figma media included.",
    captures,
  }, null, 2));
}
async function keyboardTable(page: Page, name: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  const region = page.locator(`[role="region"][aria-label="${name}"][tabindex="0"]`);
  await region.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await region.evaluate(element => { element.scrollLeft = 0; });
}

async function login(page: Page) {
  expect((await page.request.get("/v1/session", {headers:{authorization:`Bearer ${SYNTHETIC_REVIEW_TOKEN}`}})).status()).toBe(200);
}
async function contexts(w: Awaited<ReturnType<typeof world>>) {
  const {approved,run}=await w.approvedRun();
  const approval=await w.read("approvalDetail",{approvalId:approved.manifest.approvalRef},SYNTHETIC_REVIEW_TOKEN);
  const nativeRun=await w.read("runDetail",{runId:run.runRef},SYNTHETIC_REVIEW_TOKEN);
  expect(approval.status,JSON.stringify(approval.body)).toBe(200);expect(nativeRun.status,JSON.stringify(nativeRun.body)).toBe(200);
  const q=new URLSearchParams({offerId:w.offer.offerId,offerVersion:w.offer.version,phase:"invitation"});
  return [
    {state:"assessment",path:`/creators/${encodeURIComponent(w.selection.creatorId)}/assessments/${encodeURIComponent(w.saved.runId)}?${q}`,view:"assessmentRecord",filters:{creatorId:w.selection.creatorId,assessmentId:w.saved.runId,offerId:w.offer.offerId,offerVersion:w.offer.version,phase:"invitation"}},
    {state:"offer",path:`/offers/${w.offer.offerId}?offerVersion=${w.offer.version}&phase=invitation`,view:"offerDraft",filters:{offerId:w.offer.offerId,offerVersion:w.offer.version,phase:"invitation"}},
    {state:"recruitment",path:"/creators/social-cat/recruitment",view:"recruitmentQueue",filters:{}},
    {state:"preview",path:scorecardPreviewPath([w.selection]),view:"batchDetail",filters:{batchId:"scorecard-preview",selection:[w.selection]}},
    {state:"approval",path:`/approvals/${encodeURIComponent(approval.body.data.approvalRef)}`,view:"approvalDetail",filters:{approvalId:approved.manifest.approvalRef}},
    {state:"run",path:`/runs/${encodeURIComponent(nativeRun.body.data.runRef)}?tab=approval`,view:"runDetail",filters:{runId:run.runRef}},
  ].map(view=>({...view,approvalRef:approved.manifest.approvalRef}));
}
async function parity(w: Awaited<ReturnType<typeof world>>, views: Awaited<ReturnType<typeof contexts>>, expected:"eligible"|"held", reason?:string) {
  const projections:unknown[]=[];
  for (const view of views) {
    const filters=view.state==="assessment"?{creatorId:w.selection.creatorId,assessmentId:w.saved.runId,offerId:w.offer.offerId,offerVersion:w.offer.version,phase:"invitation"}:view.filters;
    const result=await w.read(view.view,filters,SYNTHETIC_REVIEW_TOKEN);expect(result.status,JSON.stringify(result.body)).toBe(200);
    const data=result.body.data;
    const value=view.state==="recruitment"?data.rows[0].commercialEligibility:["preview","approval","run"].includes(view.state)?data.items[0].commercialEligibility:data.commercialEligibility;
    expect(value.state).toBe(expected);if(reason)expect(value.reasonCodes).toContain(reason);projections.push(value);
  }
  for(const value of projections)expect(value).toEqual(projections[0]);
  expect(w.app.store.findRun(w.selection.creatorId,w.saved.runId)).toEqual(w.saved);
}

test("the exact selected commercial basis is consistent across all six native views",async({page},info)=>{
  captures=[];const w=await world(),views=await contexts(w);await parity(w,views,"eligible");await page.clock.install({time:w.h.now()});await login(page);
  for(const view of views) {
    await page.goto(view.path);await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toBeVisible();
    await expect(page.getByText(/This check grants no approval/)).toBeVisible();
    await capture(page,info,`${view.state}-current`);
  }
  await page.goto(views.find(v=>v.state==="preview")!.path);await expect(page.getByRole("heading",{name:"Invitation preview",exact:true})).toBeVisible();await keyboardTable(page,"Selected invitation assessments");
  await page.goto(views.find(v=>v.state==="recruitment")!.path);await expect(page.getByLabel("Select source row 1")).toBeVisible();
  await page.getByLabel("Select source row 1").focus();await page.keyboard.press("Space");
  await expect(page.getByRole("link",{name:"Review selected invitation set"})).toHaveAttribute("href",scorecardPreviewPath([w.selection]));
  await keyboardTable(page,"Recruitment queue");
  await page.goto(views.find(v=>v.state==="offer")!.path);await page.getByRole("button",{name:"Review commitment",exact:true}).focus();await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog",{name:"Review commitment"})).toBeVisible();await expect(page.getByRole("dialog",{name:"Review commitment"}).getByText("Commercially eligible for invitation")).toBeVisible();
  await capture(page,info,"offer-current-review");await page.getByRole("button",{name:"Close review"}).focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog",{name:"Review commitment"})).not.toBeVisible();
});

test("fee request and withdrawn policy hold the same exact items without rewriting assessment or approval history",async({page},info)=>{
  captures=[];const w=await world(),views=await contexts(w);const decision=w.app.actionFoundation.approvals.readApproval(views[0]!.approvalRef)!.decisionReceipt;
  const fee=w.h.reply(w.offer);w.h.repo.observeReply(w.offer.offerId,w.offer.version,fee.sourceRef,"synthetic-browser-fee-request","synthetic-reader");
  await parity(w,views,"held","CREATOR_FEE_REQUEST");await page.clock.install({time:w.h.now()});await login(page);
  for(const view of views){await page.goto(view.path);await expect(page.getByRole("region",{name:"Commercial eligibility",exact:true}).getByText("CREATOR_FEE_REQUEST",{exact:true})).toBeVisible();await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toHaveCount(0);await capture(page,info,`${view.state}-fee-held`);}
  w.h.source.state.permitted=false;await parity(w,views,"held","COMMERCIAL_POLICY_SOURCE_HELD");await page.goto(views.find(v=>v.state==="offer")!.path);await expect(page.getByRole("region",{name:"Commercial eligibility",exact:true}).getByText("COMMERCIAL_POLICY_SOURCE_HELD",{exact:true})).toBeVisible();await capture(page,info,"offer-policy-withdrawn");
  expect(w.app.actionFoundation.approvals.readApproval(views[0]!.approvalRef)?.decisionReceipt).toEqual(decision);
});

test("missing explicit selection and revoked source membership remain held and disclose no synthetic queue",async({page},info)=>{
  captures=[];const w=await world();await page.clock.install({time:w.h.now()});await login(page);
  await page.goto(`/creators/${encodeURIComponent(w.selection.creatorId)}/assessments/${encodeURIComponent(w.saved.runId)}`);await expect(page.getByText("No exact offer selected",{exact:true})).toBeVisible();await capture(page,info,"assessment-unbound");
  await page.goto(`/offers/${w.offer.offerId}`);await expect(page.getByText("OFFER_VERSION_REQUIRED",{exact:true})).toBeVisible();await page.getByRole("link",{name:`Select displayed saved version ${w.offer.version}`}).click();await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toBeVisible();
  await page.goto("/creators/social-cat/recruitment");await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toBeVisible();
  await page.clock.fastForward(300001);await expect(page.getByText(/source membership lease expired/)).toBeVisible();await expect(page.getByLabel("Select source row 1")).toBeDisabled();await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toHaveCount(0);await capture(page,info,"recruitment-source-expired");
  w.h.advance(300001);w.source.observedAt=new Date(w.h.now()).toISOString();w.source.validUntil=new Date(w.h.now()+300000).toISOString();w.source.sourceVersion="v2";
  await page.getByRole("button",{name:"Refresh recruitment evidence"}).click();await expect(page.getByLabel("Select source row 1")).toBeEnabled();w.source.permission="denied";
  await page.getByRole("button",{name:"Refresh recruitment evidence"}).click();await expect(page.getByRole("table",{name:"Recruitment queue"})).toHaveCount(0);await expect(page.getByText(w.selection.creatorId,{exact:true})).toHaveCount(0);await expect(page.getByText("Commercially eligible for invitation",{exact:true})).toHaveCount(0);await capture(page,info,"recruitment-source-denied");
});
