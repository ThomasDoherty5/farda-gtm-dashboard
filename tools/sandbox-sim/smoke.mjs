// Smoke check for the sandbox simulation (dev only): boots `npm run sim` on free ports with its own data folder
// (.agent-data/sim/smoke, so a running simulation is untouched), checks the dashboard and the agent API through
// the preview proxy, loads key screens headless as reader and reviewer, then stops everything it started.
// Usage: npm run sim:smoke. Set E2E_AGENT_BROWSER_CHANNEL=chrome to use the installed Chrome. See docs/sandbox-sim.md.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";

const dataDir = ".agent-data/sim/smoke";
const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().once("error", reject);
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const appPort = await freePort(), agentPort = await freePort();
const origin = `http://127.0.0.1:${appPort}`, agentOrigin = `http://127.0.0.1:${agentPort}`;
rmSync(`${dataDir}/session.json`, { force: true });

let output = "";
const sim = spawn(process.execPath, ["tools/sandbox-sim/run.mjs"], { stdio: ["ignore", "pipe", "pipe"], detached: false,
  env: { ...process.env, FARDA_SIM_APP_PORT: String(appPort), FARDA_SIM_AGENT_PORT: String(agentPort), FARDA_SIM_DATA_DIR: dataDir } });
for (const stream of [sim.stdout, sim.stderr]) stream.on("data", chunk => { output += chunk; });
const exited = new Promise(resolve => sim.once("exit", resolve));

const failures = [];
function check(label, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}
async function ready(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (sim.exitCode !== null) throw new Error(`the simulation exited early (${sim.exitCode}).`);
    if (output.includes("Farda sandbox simulation is running")) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`the simulation was not ready within ${timeoutMs / 1000}s.`);
}
const json = async response => { try { return await response.json(); } catch { return null; } };

let browser = null;
try {
  await ready();
  const { readToken, reviewToken } = JSON.parse(readFileSync(`${dataDir}/session.json`, "utf8"));

  const health = await fetch(`${agentOrigin}/health`);
  check("agent /health answers", health.ok && (await json(health))?.service === "farda-creator-agent", String(health.status));
  const page = await fetch(`${origin}/overview`);
  check("dashboard serves /overview", page.ok && /<div id="root">/.test(await page.text()), String(page.status));
  const anonymous = await fetch(`${origin}/v1/session`);
  check("proxied /v1/session refuses an anonymous caller", anonymous.status === 401, String(anonymous.status));
  for (const [role, token] of [["reader", readToken], ["reviewer", reviewToken]]) {
    const session = await fetch(`${origin}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
    check(`proxied /v1/session signs in the ${role}`, session.ok && (await json(session))?.role === role, String(session.status));
  }
  const basic = await fetch(`${origin}/v1/session`, { headers: { authorization: `Basic ${Buffer.from(`reader:${readToken}`).toString("base64")}` } });
  check("reader sign-in with the browser prompt credentials", basic.ok, String(basic.status));
  const read = await fetch(`${origin}/v1/read`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${readToken}` },
    body: JSON.stringify({ schemaVersion: "2026-11-02.proposed", operation: "readView", requestId: "sandbox-sim-smoke", viewKey: "mirrorFreshness", filters: {},
      requestedScope: { workspaceId: "synthetic-workspace", accountIds: ["synthetic-account"], environment: "sandbox" }, period: null, sort: [], page: { cursor: null, limit: 100 } }) });
  const freshness = await json(read);
  check("proxied /v1/read returns mirror freshness", read.ok && freshness?.data?.kind === "mirror-freshness" && freshness.data.configured === true, `${read.status} ${freshness?.code ?? ""}`);

  const { chromium } = await import("@playwright/test");
  browser = await chromium.launch({ channel: process.env.E2E_AGENT_BROWSER_CHANNEL });
  for (const [role, token, screens] of [
    ["reader", readToken, [["/overview", "Overview"], ["/finance", "Finance"], ["/operations", "Operations"], ["/creators/discovery", "Find the next right fit."]]],
    ["reviewer", reviewToken, [["/settings/connections", "Connections & source health"], ["/collaborations/synthetic-collaboration", "One collaboration. The whole story."]]],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "America/Los_Angeles" });
    await context.request.get(`${origin}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
    for (const [route, heading] of screens) {
      const tab = await context.newPage(), errors = [];
      tab.on("pageerror", error => errors.push(error.message));
      tab.on("response", response => { if (response.url().startsWith(`${origin}/v1/`) && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
      await tab.goto(`${origin}${route}`);
      const shown = await tab.getByRole("heading", { level: 1, name: heading, exact: true }).waitFor({ timeout: 20_000 }).then(() => true, () => false);
      await tab.waitForLoadState("networkidle").catch(() => {});
      check(`${role} sees ${route}`, shown && errors.length === 0, shown ? errors.slice(0, 3).join("; ") : "heading missing");
      if (route === "/settings/connections" && shown)
        check("mirror freshness shows a current orders mirror", (await tab.getByTestId("mirror-state-orders").textContent({ timeout: 10_000 }).catch(() => null)) === "Current");
      await tab.close();
    }
    await context.close();
  }
} catch (error) {
  check("simulation smoke run", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser?.close().catch(() => {});
  if (sim.exitCode === null) sim.kill("SIGINT");
  const timer = setTimeout(() => sim.kill("SIGKILL"), 20_000);
  await exited;
  clearTimeout(timer);
}
if (failures.length) {
  console.error(`\nsandbox-sim smoke: ${failures.length} check(s) failed. Simulation output:\n${output}`);
  process.exitCode = 1;
} else console.log(`\nsandbox-sim smoke: all checks passed${existsSync(`${dataDir}/dist`) ? ` (build kept in ${dataDir}/dist)` : ""}.`);
