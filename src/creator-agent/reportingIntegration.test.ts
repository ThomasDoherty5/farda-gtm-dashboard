// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentServer, type AgentServerOptions } from "./server.ts";
import { createReportingSourceFixture, reportingScope as scope } from "./slackReporting/fixtures.testkit.ts";
import { reportReadSchema } from "./slackReporting/contract.ts";
import { SYNTHETIC_READ_TOKEN as reader, SYNTHETIC_REVIEW_TOKEN as reviewer } from "./testFixtures.ts";

const reporter = "synthetic-report-machine-credential-000000000000";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(configured = true) {
  const directory = mkdtempSync(join(tmpdir(), "farda-reporting-http-"));
  const source = createReportingSourceFixture();
  const state = { asynchronousFence: null as null | "resolve" | "reject" };
  const requests: { operation: string; reference: string }[] = [];
  const options: AgentServerOptions = { databasePath: join(directory, "agent.sqlite"), workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: reader, reviewToken: reviewer, operations: { now: () => source.now },
    ...(configured ? { actionFoundation: { reporting: { token: reporter, workerRef: source.machine.workerRef, source: source.source,
      assertCurrent(request) { requests.push(request); source.machine.assertCurrent();
        if(state.asynchronousFence) return state.asynchronousFence==="resolve" ? Promise.resolve() : Promise.reject(new Error("Synthetic asynchronous authority refusal"));
      },
    } } } : {}),
  };
  const app = createAgentServer(options);
  await new Promise<void>((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
  const address = app.server.address(); if (!address || typeof address === "string") throw new Error("Missing local test address");
  const origin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  async function post(path: string, body: unknown, token = reporter) {
    const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function get(ref: string, token = reporter) {
    const response = await fetch(origin + "/v1/reports/" + encodeURIComponent(ref), { headers: { authorization: "Bearer " + token } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  const accept = (key = "synthetic-http-request", extra = {}) => post("/v1/reports/accept", { locator: source.locator, idempotencyKey: key, ...extra });
  return { app, source, options, requests, state, post, get, accept };
}

describe("internal reporting through the actual machine HTTP boundary and shared SQLite", () => {
  it("holds an unconfigured source without manufacturing a sender", async () => {
    const f = await fixture(false);
    expect(await f.accept()).toMatchObject({ status: 503, body: { code: "REPORTING_MACHINE_UNCONFIGURED", executionCertainty: "uncertain" } });
    expect(f.source.state.calls).toHaveLength(0);
  });
  it("requires a distinct reporting machine and rejects caller-supplied content or authority", async () => {
    const f = await fixture();
    for (const token of [reader, reviewer, "synthetic-other-machine"]) expect(await f.post("/v1/reports/accept", {}, token)).toMatchObject({ status: 401 });
    expect((await f.accept("forged-body", { body: "untrusted private content", channelId: "CSYNTHETIC", actor: "founder", approved: true })).status).toBe(400);
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM report_records").get()?.n).toBe(0);
    expect(() => createAgentServer({ ...f.options, actionFoundation: { reporting: { ...f.options.actionFoundation!.reporting!, token: reader } } })).toThrow("distinct");
    expect(f.source.state.calls).toHaveLength(0);
  });
  it("uses one existing job, one native effect and a private-safe durable readback across repeated requests", async () => {
    const f = await fixture(), accepted = await f.accept(); expect(accepted.status).toBe(200);
    const queued = reportReadSchema.parse(accepted.body);
    expect(queued).toMatchObject({ executionCertainty: "notApplied", grantsBusinessAuthority: false });
    const worked = await f.post("/v1/reports/work", { reportRef: queued.reportRef }); expect(worked.status).toBe(200);
    expect(reportReadSchema.parse(worked.body)).toMatchObject({ executionCertainty: "applied", sourceEffect: "internalReport", usage: { zapierTasks: "unknown", cost: "unknown" } });
    expect((await f.accept("synthetic-another-request")).body.reportRef).toBe(queued.reportRef);
    await f.post("/v1/reports/work", { reportRef: queued.reportRef });
    const read = await f.get(queued.reportRef); expect(read.status).toBe(200);
    expect(reportReadSchema.parse(read.body).receipt).not.toBeNull();
    expect(f.source.state.calls).toHaveLength(1);
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM job_runs").get()?.n).toBe(1);
    expect(JSON.stringify(read.body)).not.toMatch(/CSYNTHETIC|USYNTHETIC|BSYNTHETIC|native-receipt|chat-write|route:synthetic|Order SYNTHETIC/);
    expect(f.requests.some(value => value.operation === "work" && value.reference === queued.reportRef)).toBe(true);
  });
  it("reconciles the original lost acknowledgment instead of repeating the post", async () => {
    const f = await fixture(), queued = reportReadSchema.parse((await f.accept()).body);
    f.source.state.mode = "lostAck";
    expect(await f.post("/v1/reports/work", { reportRef: queued.reportRef })).toMatchObject({ status: 200, body: { executionCertainty: "uncertain" } });
    const original = f.source.state.calls[0]!.requestKey;
    expect(await f.post("/v1/reports/reconcile", { reportRef: queued.reportRef })).toMatchObject({ status: 200, body: { executionCertainty: "applied" } });
    expect(f.source.state.calls).toHaveLength(1);
    expect(f.source.state.lookups.map(value => value.requestKey)).toEqual([original]);
  });
  it("withholds protected reads when machine authority changes during source resolution", async () => {
    const f = await fixture(), queued = reportReadSchema.parse((await f.accept()).body);
    f.source.state.afterRead = () => { f.source.state.actorAllowed = false; };
    expect(await f.get(queued.reportRef)).toMatchObject({ status: 403, body: { executionCertainty: "uncertain" } });
    expect(f.source.state.calls).toHaveLength(0);
  });
  it("retains a verified durable outcome while clearing protected data after authority loss", async () => {
    const f = await fixture(), queued = reportReadSchema.parse((await f.accept()).body);
    f.source.state.afterDeliver = () => { f.source.state.actorAllowed = false; };
    const answer = await f.post("/v1/reports/work", { reportRef: queued.reportRef });
    // The exact native receipt is already stored. Revocation clears the response,
    // without relabeling an applied effect or authorizing another post.
    expect(answer.status).toBe(403); expect(answer.body.executionCertainty).toBe("applied");
    expect(f.source.state.calls).toHaveLength(1);
    expect(answer.body).not.toHaveProperty("receipt");
    f.source.state.actorAllowed = true; f.source.state.afterDeliver = undefined;
    expect(await f.post("/v1/reports/reconcile", { reportRef: queued.reportRef })).toMatchObject({ status: 200, body: { executionCertainty: "applied" } });
    expect(f.source.state.calls).toHaveLength(1);
  });
  it("does not treat a changed or revoked programme as send authority", async () => {
    const f = await fixture(), queued = reportReadSchema.parse((await f.accept()).body);
    f.source.state.sendAllowed = false;
    expect((await f.post("/v1/reports/work", { reportRef: queued.reportRef })).status).toBe(403);
    expect(f.source.state.calls).toHaveLength(0);
  });
  it.each(["resolve", "reject"] as const)("refuses an asynchronous %s machine fence before effects", async mode => {
    const f = await fixture(), queued = reportReadSchema.parse((await f.accept()).body);
    f.state.asynchronousFence=mode;
    expect(await f.post("/v1/reports/work",{reportRef:queued.reportRef})).toMatchObject({status:403,body:{code:"REPORT_MACHINE_AUTHORITY_INVALID"}});
    expect(f.source.state.calls).toHaveLength(0);
    expect(f.app.store.database.prepare("SELECT COUNT(*) AS n FROM report_attempts").get()?.n).toBe(0);
  });
  it("returns bounded transport retry timing without treating admission as a provider outcome", async () => {
    const f = await fixture();
    for(let i=0;i<30;i++)expect((await f.accept("same-synthetic-request")).status).toBe(200);
    expect(await f.accept("same-synthetic-request")).toMatchObject({status:429,body:{code:"RATE_LIMITED",executionCertainty:"uncertain",retryAfterMs:60_000}});
    expect(f.source.state.calls).toHaveLength(0);
  });
});
