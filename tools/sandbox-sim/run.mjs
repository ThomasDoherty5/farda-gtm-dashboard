// One-command local simulated environment (dev only): the real creator-agent service in sandbox mode with
// every synthetic source injected (tools/sandbox-sim/agent.ts), plus the dashboard built in sandbox adapter
// mode and served by `vite preview` with the agent proxy, exactly as playwright.agent.config.ts does.
// Usage: npm run sim [-- --open | --open=reviewer]. See docs/sandbox-sim.md.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const port = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}.`);
  return value;
};
const appPort = port("FARDA_SIM_APP_PORT", 4400), agentPort = port("FARDA_SIM_AGENT_PORT", 4401);
if (appPort === agentPort) throw new Error("The app and agent need distinct ports.");
const openArg = process.argv.slice(2).find(arg => arg === "--open" || arg.startsWith("--open="));
const openRole = openArg ? (openArg === "--open=reviewer" ? "reviewer" : "reader") : null;
const origin = `http://127.0.0.1:${appPort}`, agentOrigin = `http://127.0.0.1:${agentPort}`;
const dataDir = ".agent-data/sim", distDir = `${dataDir}/dist`;
// Fresh per run, server-only, never committed (.agent-data/ is gitignored) and never baked into the client.
const readToken = randomBytes(32).toString("hex"), reviewToken = randomBytes(32).toString("hex");
const vite = ["node_modules/vite/bin/vite.js"];

process.umask(0o077);
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
writeFileSync(`${dataDir}/session.json`, JSON.stringify({ origin, agentOrigin, readToken, reviewToken }, null, 2) + "\n", { mode: 0o600 });

const children = new Set();
let browser = null, stopping = false;
function start(name, args, env) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, ...env } });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping && name !== "build") { console.error(`sandbox-sim: ${name} exited (${signal ?? code}); stopping.`); void stop(1); }
  });
  return child;
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  await browser?.close().catch(() => {});
  const exits = [...children].map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
  }));
  await Promise.all(exits);
  console.log("sandbox-sim: stopped.");
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

async function waitFor(url, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stopping) throw new Error("stopped");
    try { if ((await fetch(url)).status < 500) return; } catch { /* not listening yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not answer at ${url} within ${timeoutMs / 1000}s.`);
}
const finished = child => new Promise((resolve, reject) => child.once("exit", code => code === 0 ? resolve() : reject(new Error(`build failed (${code})`))));

try {
  start("agent", ["tools/sandbox-sim/agent.ts"], { FARDA_AGENT_READ_TOKEN: readToken, FARDA_AGENT_REVIEW_TOKEN: reviewToken,
    FARDA_SIM_AGENT_PORT: String(agentPort), FARDA_SIM_DATABASE: `${dataDir}/agent.sqlite` });
  await waitFor(`${agentOrigin}/health`, "Agent service");
  const adapterEnv = { VITE_FARDA_ADAPTER: "sandbox", VITE_FARDA_ADAPTER_BASE_URL: origin, FARDA_AGENT_PROXY_TARGET: agentOrigin };
  if (process.env.FARDA_SIM_SKIP_BUILD === "1" && existsSync(`${distDir}/index.html`)) console.log("sandbox-sim: reusing the previous sandbox build.");
  else await finished(start("build", [...vite, "build", "--outDir", distDir, "--emptyOutDir", "--logLevel", "warn"], adapterEnv));
  start("preview", [...vite, "preview", "--host", "127.0.0.1", "--port", String(appPort), "--strictPort", "--outDir", distDir], adapterEnv);
  await waitFor(origin, "Dashboard preview");
  console.log(`
Farda sandbox simulation is running (synthetic data only; see docs/sandbox-sim.md).
  Dashboard  ${origin}/overview   (use 127.0.0.1, not localhost: the session cookie is host-only)
  Agent      ${agentOrigin}/health
Sign in as reader:
  1. Open ${origin}/v1/session in the browser.
  2. At the "Farda agent reader" prompt enter user name  reader  and password:
     ${readToken}
  3. Open ${origin}/overview. The session lasts one hour; repeat step 1 when it ends.
Reviewer (approve/save) sessions use a bearer token only: run  npm run sim -- --open=reviewer
Tokens for scripts: ${dataDir}/session.json. Press Ctrl-C to stop both servers.
`);
  if (openRole) {
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: false, channel: process.env.E2E_AGENT_BROWSER_CHANNEL });
    const context = await browser.newContext({ viewport: null });
    const signedIn = await context.request.get(`${origin}/v1/session`, { headers: { authorization: `Bearer ${openRole === "reviewer" ? reviewToken : readToken}` } });
    if (!signedIn.ok()) throw new Error(`Sign-in failed (${signedIn.status()}).`);
    await (await context.newPage()).goto(`${origin}/overview`);
    console.log(`sandbox-sim: opened a ${openRole} browser session.`);
  }
} catch (error) {
  if (!stopping) { console.error(`sandbox-sim: ${error instanceof Error ? error.message : error}`); await stop(1); }
}
