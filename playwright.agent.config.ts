import { execFileSync } from "node:child_process";
import { defineConfig, devices } from "@playwright/test";

/** Allocate distinct free loopback ports; env overrides support a separately coordinated local run. */
function freePorts(): [number, number] {
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:net";
    const servers = [createServer(), createServer()];
    await Promise.all(servers.map(s => new Promise(resolve => s.listen(0, "127.0.0.1", resolve))));
    process.stdout.write(servers.map(s => s.address().port).join(","));
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  `], { encoding: "utf8" }).trim().split(",").map(Number);
  return [result[0]!, result[1]!];
}
const allocated = process.env.E2E_AGENT_APP_PORT && process.env.E2E_AGENT_SERVER_PORT ? null : freePorts();
const appPort = Number(process.env.E2E_AGENT_APP_PORT ?? allocated![0]);
const serverPort = Number(process.env.E2E_AGENT_SERVER_PORT ?? allocated![1]);
for (const port of [appPort, serverPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid agent browser test port.");
if (appPort === serverPort) throw new Error("Agent and browser preview need distinct ports.");
process.env.E2E_AGENT_APP_PORT = String(appPort);
process.env.E2E_AGENT_SERVER_PORT = String(serverPort);
const origin = `http://127.0.0.1:${appPort}`;
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
const vite = `${quote(process.execPath)} node_modules/vite/bin/vite.js`;

/** Actual agent service, reviewed synthetic evidence, one browser and fresh temporary SQLite per run. */
export default defineConfig({
  testDir: "./e2e-agent",
  fullyParallel: false, workers: 1, retries: 0, forbidOnly: !!process.env.CI,
  timeout: 90_000,
  outputDir: "test-results/agent",
  reporter: [["list"]],
  use: { baseURL: origin, locale: "en-US", timezoneId: "America/Los_Angeles", colorScheme: "light", reducedMotion: "reduce", trace: "off",
    // Match the existing headless capture geometry without a headed Linux scrollbar gutter.
    ...(process.env.FARDA_SCREEN_READER_LOG?{launchOptions:{args:["--force-renderer-accessibility","--hide-scrollbars"]}}:{}) },
  // A local installed Chromium channel can be selected without downloading another browser; CI defaults to managed Chromium.
  projects: [{ name: "agent-desktop-1440", use: { ...devices["Desktop Chrome"], channel: process.env.E2E_AGENT_BROWSER_CHANNEL, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
  webServer: {
    command: `${vite} build --outDir .agent-data/browser-dist --emptyOutDir && ${vite} preview --host 127.0.0.1 --port ${appPort} --strictPort --outDir .agent-data/browser-dist`,
    env: { VITE_FARDA_ADAPTER: "sandbox", VITE_FARDA_ADAPTER_BASE_URL: origin, FARDA_AGENT_PROXY_TARGET: `http://127.0.0.1:${serverPort}` },
    url: origin, reuseExistingServer: false, timeout: 180_000,
  },
});
