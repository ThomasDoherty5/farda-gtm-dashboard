import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "../src/creator-agent/store.ts";
import { JobRuntime } from "../src/creator-agent/jobs/runtime.ts";
import { RuntimeError, type RuntimeStep } from "../src/creator-agent/jobs/runtimeSchema.ts";
import { createBrowserReadExecutor } from "../src/creator-agent/jobs/runtimeExecutors.ts";
import { createRuntimeTestkit, runtimeSyntheticScope } from "../src/creator-agent/jobs/runtime.testkit.ts";

// Real Chromium Page transport and scoped SQLite; all source identities and pages are fictional.
type SourceState = "ready" | "login" | "mfa" | "captcha" | "termsChanged" | "uiDrift" | "denied";
let directory: string, store: AgentStore, kit: ReturnType<typeof createRuntimeTestkit>;
let source: Server, destination: Server, origin: string, destinationOrigin: string;
let state: SourceState, redirect: boolean, paginate: boolean, sourceResumeApproved: boolean;
let requests: { path: string; method: string; authorization: string | null; cookie: string | null }[];
let destinationReads: number;

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic loopback port unavailable");
  return `http://127.0.0.1:${address.port}`;
}
const completed: RuntimeStep = { state: "completed", recordCount: 1, evidenceRefs: ["synthetic-browser-final"], sourceReceiptRef: "receipt:synthetic-browser-final" };
function html(value: SourceState, result: RuntimeStep = completed) {
  const escaped = JSON.stringify(result).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<!doctype html><html lang="en"><head><title>Fictional source reader</title><link rel="icon" href="data:,"></head><body>
    <main data-runtime-reader data-runtime-version="${value === "uiDrift" ? "synthetic-page-v2" : "synthetic-page-v1"}" data-runtime-state="${value === "uiDrift" ? "ready" : value}">
    <h1>Fictional source reader</h1><pre data-runtime-result>${escaped}</pre>
    <form action="/must-not-submit" method="post"><label>Credential <input name="credential"></label><button>Sign in or accept terms</button></form></main></body></html>`;
}
function installBrowser(page: Page) {
  kit.registry.executors.set(kit.registration.browserExecutorRef!, createBrowserReadExecutor({ mode: "observe", endpoint: `${origin}/reader`, page,
    pageVersion: "synthetic-page-v1", ownerRef: "owner:synthetic-runtime", handoffRef: "synthetic-browser-handoff", allowSyntheticLoopback: true }));
}
function steps(runRef: string) {
  return store.database.prepare("SELECT body FROM job_runtime_steps WHERE run_ref=? ORDER BY checkpoint_version").all(runRef)
    .map(row => JSON.parse(String(row.body)) as { step: { sourceReceiptRef: string; confersRelease?: boolean } });
}

// eslint-disable-next-line no-empty-pattern
test.beforeEach(async ({}) => {
  state = "ready"; redirect = false; paginate = false; sourceResumeApproved = false; requests = []; destinationReads = 0;
  directory = mkdtempSync(join(tmpdir(), "farda-browser-runtime-"));
  store = new AgentStore(join(directory, "agent.sqlite"), runtimeSyntheticScope);
  kit = createRuntimeTestkit(store.database);
  const resolveTakeover = kit.authority.resolveTakeover, assertTakeover = kit.authority.assertTakeover;
  kit.authority.resolveTakeover = async request => {
    if (!sourceResumeApproved || request.receiptRef !== "receipt:synthetic-source-human-resolution") throw new RuntimeError("SYNTHETIC_RESOLUTION_NOT_VERIFIED", 403);
    return resolveTakeover(request);
  };
  kit.authority.assertTakeover = (proof, now) => {
    if (!sourceResumeApproved) throw new RuntimeError("SYNTHETIC_RESOLUTION_NOT_VERIFIED", 403);
    assertTakeover(proof, now);
  };
  destination = createServer((_request, response) => { destinationReads++; response.setHeader("content-type", "text/html"); response.end(html("ready")); });
  destinationOrigin = await listen(destination);
  source = createServer((request, response) => {
    const url = new URL(request.url!, origin);
    requests.push({ path: url.pathname + url.search, method: request.method!, authorization: request.headers.authorization ?? null, cookie: request.headers.cookie ?? null });
    if (url.pathname !== "/reader") { response.writeHead(405); response.end(); return; }
    if (redirect) { response.writeHead(302, { location: `${destinationOrigin}/reader` }); response.end(); return; }
    response.setHeader("content-type", "text/html");
    if (paginate && !url.searchParams.has("cursor")) {
      const first: RuntimeStep = { state: "checkpoint", recordCount: 1, evidenceRefs: ["synthetic-browser-first"], nextCursor: "synthetic-next-page", sourceReceiptRef: "receipt:synthetic-browser-first" };
      response.end(html(state, first));
    } else response.end(html(state));
  });
  origin = await listen(source);
  await kit.initialize();
});
test.afterEach(async () => {
  await Promise.all([source, destination].map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  store.close(); rmSync(directory, { recursive: true, force: true });
});

test("actual Page reads two bounded source pages only after explicit API Unsupported and persists receipts once", async ({ page }) => {
  paginate = true; installBrowser(page); kit.state.evidenceCapacity = 2;
  await kit.verify("api", "Unsupported");
  const run = await kit.fire(), runRef = run.run.runId;
  const done = await kit.runtime.work({ runRef, maxItems: 1 }, kit.machine);
  expect(done.run.state).toBe("completed");
  expect(done.run.items[0]?.checkpoint).toMatchObject({ cursor: "synthetic-next-page", processedRefs: ["synthetic-browser-first"] });
  expect(done.run.items[0]?.result).toMatchObject({ kind: "reference-recorded", sourceEffect: "none" });
  const urls = requests.map(request => new URL(request.path, origin));
  expect(urls).toHaveLength(2);
  expect(urls.map(url => url.searchParams.get("cursor"))).toEqual([null, "synthetic-next-page"]);
  for (const url of urls) {
    expect(url.pathname).toBe("/reader"); expect(url.searchParams.get("limit")).toBe("2");
    expect(url.searchParams.get("subject")).toBe("synthetic-subject-first-0");
    expect(url.searchParams.get("start")).toBe(run.window.windowStart); expect(url.searchParams.get("end")).toBe(run.window.windowEnd);
  }
  expect(requests.every(request => request.method === "GET" && request.authorization === null && request.cookie === null)).toBe(true);
  const original = steps(runRef);
  expect(original.map(row => row.step.sourceReceiptRef)).toEqual(["receipt:synthetic-browser-first", "receipt:synthetic-browser-final"]);
  expect(original[1]?.step.confersRelease).toBe(false);
  const restarted = new JobRuntime(store.database, kit.options);
  expect((await restarted.work({ runRef }, kit.machine)).run.state).toBe("completed");
  expect((await kit.fire()).run.runId).toBe(runRef); expect(requests).toHaveLength(2); expect(steps(runRef)).toEqual(original);
  expect((await restarted.readUsage(runRef))).toMatchObject({ invocations: { directApi: 0, browser: 2 }, ordinaryZapTasks: null, observedCostMinor: null });
});

for (const takeover of ["login", "mfa", "captcha", "termsChanged", "uiDrift"] as const) {
  test(`actual ${takeover} page holds without interaction and resumes only from exact source-owned takeover proof`, async ({ page }) => {
    state = takeover; installBrowser(page); await kit.verify("api", "Unsupported");
    const run = await kit.fire(), runRef = run.run.runId;
    const held = await kit.runtime.work({ runRef }, kit.machine);
    expect(held.run.state).toBe("held"); expect(held.takeovers).toMatchObject([{ kind: takeover, resolved: false }]);
    expect(await page.getByLabel("Credential").inputValue()).toBe(""); expect(steps(runRef)).toEqual([]);
    await kit.runtime.work({ runRef }, kit.machine); expect(requests).toHaveLength(1);
    const request = { runRef, itemRef: held.takeovers[0]!.itemRef, expectedVersion: held.takeovers[0]!.version,
      receiptRef: "receipt:synthetic-source-human-resolution", requestKey: "synthetic-resume" };
    await expect(kit.runtime.resolveTakeover(request, kit.machine)).rejects.toMatchObject({ code: "SYNTHETIC_RESOLUTION_NOT_VERIFIED", status: 403 });
    expect((await kit.runtime.readRun(runRef)).takeovers[0]?.resolved).toBe(false); expect(requests).toHaveLength(1);
    state = "ready"; sourceResumeApproved = true;
    await kit.runtime.resolveTakeover(request, kit.machine); await kit.runtime.resolveTakeover(request, kit.machine);
    expect((await new JobRuntime(store.database, kit.options).work({ runRef }, kit.machine)).run.state).toBe("completed");
    expect(steps(runRef)).toHaveLength(1); expect(requests).toHaveLength(2);
    expect(requests.every(row => row.method === "GET" && row.authorization === null && row.cookie === null && row.path.startsWith("/reader?"))).toBe(true);
    expect(await page.getByLabel("Credential").inputValue()).toBe("");
  });
}

test("API denial cannot fall back, and source-page denial creates no observed receipt", async ({ page }) => {
  installBrowser(page); await kit.verify("api", "Denied");
  const denied = await kit.fire();
  await expect(kit.runtime.work({ runRef: denied.run.runId }, kit.machine)).rejects.toMatchObject({ status: 403 });
  expect(requests).toEqual([]); expect(steps(denied.run.runId)).toEqual([]);
  await kit.verify("api", "Unsupported"); state = "denied";
  const next = await kit.fire("2026-11-06T10:00:00Z", "synthetic-browser-denied");
  await expect(kit.runtime.work({ runRef: next.run.runId }, kit.machine)).rejects.toMatchObject({ code: "SOURCE_SCOPE_DENIED", status: 403 });
  expect(requests).toHaveLength(1); expect(steps(next.run.runId)).toEqual([]); expect(kit.jobs.getRun(next.run.runId).counts.completed).toBe(0);
});

test("actual cross-origin redirect cannot turn a valid-looking foreign page into source evidence", async ({ page }) => {
  installBrowser(page); redirect = true; await kit.verify("api", "Unsupported");
  const run = await kit.fire();
  await expect(kit.runtime.work({ runRef: run.run.runId }, kit.machine)).rejects.toMatchObject({ code: "SOURCE_BROWSER_DESTINATION_CHANGED", status: 403 });
  expect(new URL(page.url()).origin).toBe(destinationOrigin); expect(destinationReads).toBe(1); expect(requests).toHaveLength(1);
  expect(steps(run.run.runId)).toEqual([]); expect(kit.jobs.getRun(run.run.runId).counts.completed).toBe(0);
});
