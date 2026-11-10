// Test-only native process harness. Never included in the allowlisted API image.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentServer } from "../../src/creator-agent/server.ts";
import { loadApprovedBindings } from "../../src/creator-agent/config.ts";
import { loadCreatorSourceRuntime } from "../../src/creator-agent/sourceRuntime.ts";
import { readRuntimeConfig } from "../../tools/creator-agent/runtime-config.mjs";
import { installShutdown } from "../../tools/creator-agent/lifecycle.mjs";

// The parent supplies a monotonic admission clock over local IPC, never a public HTTP route.
// This allows all201 synthetic HTTP seeds and the restart to exercise the unchanged rate limit.
let admissionClock = Number(process.env.FARDA_TEST_ADMISSION_CLOCK);
if (!Number.isSafeInteger(admissionClock) || admissionClock <= 0 || !process.send) throw new Error("Missing synthetic admission clock");
const runtime = readRuntimeConfig();
process.umask(0o077);
mkdirSync(dirname(runtime.databasePath), { recursive: true, mode: 0o700 });
const scope = { workspaceId: process.env.FARDA_AGENT_WORKSPACE_ID ?? "", accountId: process.env.FARDA_AGENT_ACCOUNT_ID ?? "" };
const app = createAgentServer({ databasePath: runtime.databasePath, ...scope,
  readToken: process.env.FARDA_AGENT_READ_TOKEN ?? "", reviewToken: process.env.FARDA_AGENT_REVIEW_TOKEN ?? "",
  bindings: loadApprovedBindings(), secureCookies: runtime.secureCookies, publicOrigin: runtime.publicOrigin,
  ...loadCreatorSourceRuntime(process.env, scope), operations: { now: () => admissionClock },
});
process.on("message", value => {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.admissionClock) || value.admissionClock <= admissionClock) return;
  admissionClock = value.admissionClock;
  process.send?.({ admissionClock });
});
process.channel?.unref();
installShutdown(app);
app.server.listen(runtime.port, runtime.host);
