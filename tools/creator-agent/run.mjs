import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createAgentServer } from "../../src/creator-agent/server.ts";
import { loadBindings } from "../../src/creator-agent/config.ts";

const databasePath = resolve(process.env.FARDA_AGENT_DATABASE ?? ".agent-data/evidence.sqlite");
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const app = createAgentServer({ databasePath,
  readToken: process.env.FARDA_AGENT_READ_TOKEN ?? "",
  reviewToken: process.env.FARDA_AGENT_REVIEW_TOKEN ?? "",
  workspaceId: process.env.FARDA_AGENT_WORKSPACE_ID ?? "",
  accountId: process.env.FARDA_AGENT_ACCOUNT_ID ?? "",
  bindings: loadBindings(process.env.FARDA_AGENT_CONFIG),
  secureCookies: process.env.FARDA_AGENT_SECURE_COOKIES === "true",
  publicOrigin: process.env.FARDA_AGENT_ORIGIN,
});
const port = Number(process.env.FARDA_AGENT_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid agent port");
app.server.listen(port, "127.0.0.1", () => console.log(`Farda creator agent listening on loopback port ${port}; ${loadBindings(process.env.FARDA_AGENT_CONFIG).length} bound model(s).`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => void app.close());
