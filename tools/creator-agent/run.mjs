import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentServer } from "../../src/creator-agent/server.ts";
import { loadApprovedBindings, loadBindings } from "../../src/creator-agent/config.ts";
import { readRuntimeConfig } from "./runtime-config.mjs";
import { installShutdown } from "./lifecycle.mjs";

try {
  if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("The creator-agent launcher requires Node 24 or later.");
  const runtime = readRuntimeConfig();
  process.umask(0o077);
  mkdirSync(dirname(runtime.databasePath), { recursive: true, mode: 0o700 });
  const bindings = process.env.FARDA_AGENT_CONFIG ? loadBindings(process.env.FARDA_AGENT_CONFIG) : loadApprovedBindings();
  const app = createAgentServer({ databasePath: runtime.databasePath,
    readToken: process.env.FARDA_AGENT_READ_TOKEN ?? "",
    reviewToken: process.env.FARDA_AGENT_REVIEW_TOKEN ?? "",
    workspaceId: process.env.FARDA_AGENT_WORKSPACE_ID ?? "",
    accountId: process.env.FARDA_AGENT_ACCOUNT_ID ?? "",
    bindings, secureCookies: runtime.secureCookies, publicOrigin: runtime.publicOrigin,
  });
  installShutdown(app);
  app.server.listen(runtime.port, runtime.host, () => console.log(`Farda creator agent listening on ${runtime.host} port ${runtime.port}; ${bindings.length} bound model(s); sandbox reviewed-evidence mode.`));
} catch (error) {
  // Deployment values/records are private; startup errors never dump environment or configuration contents.
  console.error(error instanceof Error && /^(Invalid |FARDA_AGENT_|A non-loopback|The creator-agent launcher)/.test(error.message) ? error.message : "Creator agent initialization failed; check private configuration and volume permissions.");
  process.exitCode = 1;
}
