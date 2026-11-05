import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { readRuntimeConfig } from "./runtime-config.mjs";
import { installShutdown } from "./lifecycle.mjs";
import { createBackup, verifyBackup } from "./backup.mjs";
import { AgentStore } from "../../src/creator-agent/store.ts";
import { assessCreator } from "../../src/creator-agent/policy.ts";
import { syntheticBinding, syntheticPacket } from "../../src/creator-agent/testFixtures.ts";

const scope = { workspaceId: "synthetic-deployment-workspace", accountId: "synthetic-deployment-account" };
const quiet = { log() {}, error() {} };
const temporary = () => mkdtempSync(join(tmpdir(), "farda-deployment-test-"));

test("deployment configuration preserves loopback default and explicit-port precedence", () => {
  assert.equal(readRuntimeConfig({}).host, "127.0.0.1");
  assert.equal(readRuntimeConfig({}).port, 8787);
  assert.equal(readRuntimeConfig({ PORT: "9200" }).port, 9200);
  assert.equal(readRuntimeConfig({ PORT: "9200", FARDA_AGENT_PORT: "9300" }).port, 9300);
  for (const value of ["", "0", "65536", "-1", "3.2", "1e3", "port"]) assert.throws(() => readRuntimeConfig({ PORT: value }), /port/);
  assert.throws(() => readRuntimeConfig({ FARDA_AGENT_HOST: "api.example.invalid" }), /HOST/);
  assert.throws(() => readRuntimeConfig({ FARDA_AGENT_HOST: "127.0.0.1; command" }), /HOST/);
});

test("public binding requires deployment HTTPS origin and secure cookies", () => {
  for (const host of ["0.0.0.0", "::"]) {
    assert.throws(() => readRuntimeConfig({ FARDA_AGENT_HOST: host }), /non-loopback/);
    assert.throws(() => readRuntimeConfig({ FARDA_AGENT_HOST: host, FARDA_AGENT_ORIGIN: "https://api.example.invalid" }), /non-loopback/);
    const config = readRuntimeConfig({ FARDA_AGENT_HOST: host, FARDA_AGENT_ORIGIN: "https://api.example.invalid/", FARDA_AGENT_SECURE_COOKIES: "true" });
    assert.equal(config.publicOrigin, "https://api.example.invalid");
    assert.equal(config.secureCookies, true);
  }
  for (const origin of ["http://api.example.invalid", "https://user:password@api.example.invalid", "https://api.example.invalid/path", "https://api.example.invalid?key=value", "not-an-origin"])
    assert.throws(() => readRuntimeConfig({ FARDA_AGENT_ORIGIN: origin }), /ORIGIN/);
  assert.throws(() => readRuntimeConfig({ FARDA_AGENT_SECURE_COOKIES: "yes" }), /COOKIES/);
  assert.equal(readRuntimeConfig({ FARDA_AGENT_ORIGIN: "http://localhost:8787" }).publicOrigin, "http://localhost:8787");
});

test("shutdown is single-flight across both process signals", async () => {
  const processRef = new EventEmitter();
  processRef.exit = () => assert.fail("Successful shutdown must not force exit.");
  let closeCalls = 0;
  let release;
  const app = { server: new EventEmitter(), close: () => { closeCalls += 1; return new Promise((resolve) => { release = resolve; }); } };
  const shutdown = installShutdown(app, { processRef, logger: quiet });
  processRef.emit("SIGTERM");
  processRef.emit("SIGINT");
  const completion = shutdown("repeat");
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  release();
  await completion;
  assert.equal(processRef.exitCode, 0);
});

test("shutdown failure or an exceeded deadline terminates unsuccessfully", async () => {
  const processRef = new EventEmitter();
  const exits = [];
  processRef.exit = (code) => exits.push(code);
  const failed = installShutdown({ server: new EventEmitter(), close: async () => { throw new Error("synthetic failure"); } }, { processRef, logger: quiet });
  await failed("failure");
  assert.deepEqual(exits, [1]);
  const timedProcess = new EventEmitter();
  const timedExits = [];
  timedProcess.exit = (code) => timedExits.push(code);
  let release;
  const timed = installShutdown({ server: new EventEmitter(), close: () => new Promise((resolve) => { release = resolve; }) }, { processRef: timedProcess, logger: quiet, deadlineMs: 10 });
  const completion = timed("timeout");
  await delay(25);
  assert.deepEqual(timedExits, [1]);
  release();
  await completion;
});

test("online backup captures open WAL state and restores an isolated application-readable copy", async (t) => {
  const directory = temporary();
  const source = join(directory, "live.sqlite");
  const target = join(directory, "backup.sqlite");
  const store = new AgentStore(source, scope);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const packet = syntheticPacket();
  store.save(packet, assessCreator(packet, syntheticBinding()), 0, "synthetic-backup-request");
  const result = await createBackup(source, target, { expectedScope: scope });
  assert.equal(result.restored, true);
  assert.equal(result.assessmentCount, 1);
  assert.equal(result.requestCount, 1);
  assert.ok(result.pages > 0);
  assert.equal(statSync(target).mode & 0o077, 0);
  const later = { ...syntheticPacket(), creatorId: "synthetic-later-creator" };
  store.save(later, assessCreator(later, syntheticBinding()), 0, "synthetic-later-request");
  assert.equal((await verifyBackup(target, { expectedScope: scope })).assessmentCount, 1);
  await assert.rejects(verifyBackup(target, { expectedScope: { ...scope, accountId: "synthetic-wrong-account" } }), /scope/);
});

test("backup refuses overwrites, missing sources and corrupt restored data", async (t) => {
  const directory = temporary();
  const source = join(directory, "live.sqlite");
  const existing = join(directory, "existing-backup.sqlite");
  const store = new AgentStore(source, scope);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  writeFileSync(existing, "synthetic-existing-content");
  await assert.rejects(createBackup(source, existing), /new writable/);
  assert.equal(readFileSync(existing, "utf8"), "synthetic-existing-content");
  await assert.rejects(createBackup(join(directory, "missing.sqlite"), join(directory, "new.sqlite")), /existing database/);
  await assert.rejects(verifyBackup(existing));
});

test("the actual launcher accepts platform PORT, keeps authentication, uses restrictive data permissions and exits cleanly", { timeout: 30_000 }, async (t) => {
  const directory = temporary();
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const databasePath = join(directory, "private-data", "evidence.sqlite");
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const child = spawn(process.execPath, ["tools/creator-agent/run.mjs"], { cwd: repo,
    env: { PATH: process.env.PATH, PORT: String(port), FARDA_AGENT_DATABASE: databasePath,
      FARDA_AGENT_READ_TOKEN: "synthetic-deployment-reader-not-a-secret-0001", FARDA_AGENT_REVIEW_TOKEN: "synthetic-deployment-reviewer-not-a-secret-0002",
      FARDA_AGENT_WORKSPACE_ID: scope.workspaceId, FARDA_AGENT_ACCOUNT_ID: scope.accountId }, stdio: ["ignore", "pipe", "pipe"] });
  let exited = false;
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); }));
  // Drain bounded startup diagnostics without persisting them or exposing environment values.
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => { if (!exited) { child.kill("SIGKILL"); await exit; } rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  let healthy = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok && (await response.json()).service === "farda-creator-agent") { healthy = true; break; }
    } catch { /* Startup is bounded by the deadline. */ }
    await delay(100);
  }
  assert.equal(healthy, true);
  assert.equal((await fetch(`${origin}/v1/capabilities`)).status, 401);
  const capabilities = await fetch(`${origin}/v1/capabilities`, { headers: { authorization: "Bearer synthetic-deployment-reader-not-a-secret-0001" } });
  assert.equal(capabilities.status, 200);
  const data = await capabilities.json();
  assert.equal(data.environment, "sandbox");
  assert.equal(data.sourceAutomation, "notConnected");
  assert.equal(data.models.length, 2);
  assert.equal(statSync(join(directory, "private-data")).mode & 0o077, 0);
  assert.equal(statSync(databasePath).mode & 0o077, 0);
  child.kill("SIGTERM");
  assert.deepEqual(await exit, { code: 0, signal: null });
});
