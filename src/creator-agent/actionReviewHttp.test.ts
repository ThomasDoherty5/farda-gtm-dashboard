// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer } from "./server.ts";
import { approvalFixture, approvalTestScope as scope } from "./approvals/fixtures.testkit.ts";
import { reviewSourceFixture } from "./actions/reviewFixtures.testkit.ts";
import { SCHEMA_VERSION } from "../adapter/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(connected = true) {
  const a = approvalFixture(), review = reviewSourceFixture(() => a.state.now);
  const directory = mkdtempSync(join(tmpdir(), "farda-review-http-"));
  a.draft.phase = "other"; a.draft.acquisitionTerms = null; a.draft.effects.sendsCreator = false;
  a.humans.set("agent-reviewer", { ...a.humans.get("synthetic:requester")!, principalRef: "agent-reviewer" });
  a.humans.set("agent-reader", { ...a.humans.get("synthetic:reviewer")!, principalRef: "agent-reader" });
  const na={state:"notApplicable" as const,policyVersion:a.policy.version,reason:"Synthetic local artifact only"};
  const handler:DispatchHandler={idempotency:"source-enforced",sourceEffect:"localArtifact",policyVersion:a.policy.version,provider:na,
    resources:()=>({budget:na,stock:na,quota:na}),budgets:{maxItems:1,maxSteps:10,maxAttempts:2,maxRunMs:10000,leaseMs:1000,maxConcurrency:1,retryBaseMs:0},
    execute:async c=>({state:"applied",receipt:{receiptRef:"synthetic-local-review-artifact",dispatchKey:c.dispatchKey,payloadHash:c.intent.approval.payloadHash,
      handlerRef:c.intent.handlerRef,providerBindingHash:c.providerBindingHash,sourceEffect:"localArtifact",observedAt:a.at()}}),
    reconcile:async()=>({state:"unknown",reasonCode:"SYNTHETIC_UNKNOWN"})};
  const app = createAgentServer({ databasePath: join(directory, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, operations: { now: () => a.state.now },
    actionFoundation: { approvals: a.options,registry:new Map([[a.draft.actionKind,{handlerRef:"synthetic-review-artifact.v1"}]]),handlers:new Map([["synthetic-review-artifact.v1",handler]]),
      ...(connected ? { reviewSource: review.source, reviewLinkOrigins: ["https://review.example.test"] } : {}) } });
  const repo = app.actionFoundation.approvals, principal = { principalRef: "agent-reviewer" };
  const first = await repo.preparePreview(a.command, principal, "synthetic-http-preview");
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
  const origin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await app.close(); a.db.close(); rmSync(directory, { recursive: true, force: true }); });
  async function read(filters: Record<string, unknown> = {}, token = reviewer) {
    const response = await fetch(origin + "/v1/read", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: SCHEMA_VERSION, operation: "readView", requestId: "synthetic-review-http",
        requestedScope: { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment },
        viewKey: "approvalDetail", filters: { approvalId: first.manifest.approvalRef, ...filters }, period: null, sort: [], page: { limit: 25, cursor: null } }) });
    return { status: response.status, body: await response.json() };
  }
  async function approve(){
    const requested=await repo.requestDecision({approvalRef:first.manifest.approvalRef,expectedVersion:1},principal,"synthetic-http-request");
    const event=a.event(requested);
    return repo.observeDecision(event.locator,{ingressRef:"synthetic-http-relay"});
  }
  async function queue(){
    const approved=repo.readApproval(first.manifest.approvalRef)!;
    return app.actionFoundation.dispatch.handoffBatch([app.actionFoundation.service.toIntent(approved,approved.manifest.items[0]!.itemRef)],{principalRef:principal.principalRef,idempotencyKey:"synthetic-http-handoff"});
  }
  return { a, app, repo, principal, first, review, read,approve,queue };
}

describe("exact approval review through the actual authenticated adapter", () => {
  it("returns exact source-granted display while preserving Slack-only decision authority", async () => {
    const f = await fixture(), response = await f.read();
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ kind: "native-approval", review: { state: "complete", confersAuthority: false }, appDecision: { allowed: false }, approvedIsSent: false });
    expect(response.body.data.review.items[0].payload.value).toContain("No real outreach");
    expect(response.body.data.review.links.approval.url).toBe("https://review.example.test/archives/synthetic/p1");
    expect(f.a.state.writes).toBe(0);
  });
  it("reads the actual immutable historical version and never grants its old commands", async () => {
    const f = await fixture();
    f.a.draft.configVersion = "synthetic-config-v2";
    const latest = await f.repo.preparePreview({ ...f.a.command, approvalRef: f.first.manifest.approvalRef, expectedVersion: 1 }, f.principal, "synthetic-http-edited");
    expect(latest.manifest.manifestVersion).toBe(2);
    const response = await f.read({ manifestVersion: 1, history: true }); expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ manifestVersion: 1, current: { state: "held", reasonCodes: expect.arrayContaining(["HISTORICAL_VIEW_READ_ONLY"]) },
      history: { selectedVersion: 1, latestVersion: 2, totalVersions: 2, mode: "history" } });
    expect(response.body.data.manifestRef).toBe("manifest-" + f.first.manifest.manifestHash);
    expect(response.body.capabilities.every((value: { state: string }) => value.state === "held")).toBe(true);
    expect((await f.read({ manifestVersion: 3 })).status).toBe(404);
  });
  it("rejects malformed history selection and unrelated authenticated principals", async () => {
    const f = await fixture();
    for (const filters of [{ manifestVersion: "1" }, { manifestVersion: 0 }, { history: "true" }, { beforeVersion: -1 }, { role: "founder" }])
      expect((await f.read(filters)).status).toBe(400);
    const denied = await f.read({}, reader); expect(denied.status).toBe(403); expect(denied.body).not.toHaveProperty("data");
  });
  it.each(["source", "actor", "lease"])("clears the protected read when %s changes during the source await", async condition => {
    const f = await fixture();
    f.review.state.afterRead = () => {
      if (condition === "source") f.review.state.permitted = false;
      else if (condition === "actor") f.a.humans.get("agent-reviewer")!.active = false;
      else f.a.state.now += 60_000;
    };
    const response = await f.read(); expect(response.status).toBe(condition === "lease" ? 409 : 403); expect(response.body).not.toHaveProperty("data");
    expect(f.a.state.writes).toBe(0);
  });
  it("keeps unavailable and redacted material explicit instead of claiming an exact complete preview", async () => {
    const unbound = await fixture(false), missing = await unbound.read();
    expect(missing.status).toBe(200); expect(missing.body.data.review).toMatchObject({ state: "unavailable", links: { approval: { state: "unavailable", url: null } } });
    const f = await fixture(); f.review.state.redactPayload = true;
    const partial = await f.read(); expect(partial.status).toBe(200);
    expect(partial.body.data.review).toMatchObject({ state: "partial", items: [{ payload: { state: "redacted" } }] });
    expect(f.a.state.writes).toBe(0);
  });
  it("recovers canonical run and receipt context on a reopened approval without browser handoff state",async()=>{
    const f=await fixture();await f.approve();const run=await f.queue();
    const pending=await f.read();expect(pending.status).toBe(200);
    expect(pending.body.data.execution).toMatchObject({coverage:{returned:1,total:1,complete:true},runs:[{runRef:run.runRef,confirmedItems:0,providerAcceptedItems:0,unknownOutcomeItems:0}]});
    expect(pending.body.capabilities.find((c:{actionKind:string})=>c.actionKind==="dispatchApprovedAction")).toMatchObject({state:"held",reasonCodes:["EXISTING_CANONICAL_EXECUTION"]});
    await f.app.actionFoundation.dispatch.execute(run.runRef);
    const complete=await f.read();expect(complete.status).toBe(200);
    expect(complete.body.data.execution.runs[0]).toMatchObject({state:"completed",confirmedItems:1,localArtifactItems:1,providerAcceptedItems:0,providerRejectedItems:0,unknownOutcomeItems:0});
    f.a.draft.configVersion="synthetic-next-config";
    await f.repo.preparePreview({...f.a.command,approvalRef:f.first.manifest.approvalRef,expectedVersion:1},f.principal,"synthetic-next-preview");
    expect((await f.read()).body.data.execution.coverage.total).toBe(0);
    expect((await f.read({manifestVersion:1,history:true})).body.data.execution.runs[0].runRef).toBe(run.runRef);
  });
  it("does not publish empty execution linkage when a canonical run appears during source resolution",async()=>{
    const f=await fixture();await f.approve();f.review.state.afterRead=async()=>{await f.queue();};
    const response=await f.read();expect(response.status).toBe(409);expect(response.body).not.toHaveProperty("data");
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);
  });
});
