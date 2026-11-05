/** Cloud-only synthetic deployment probe. The Docker allowlist excludes *.test.mjs from the image. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { loadApprovedBindings } from "../../src/creator-agent/config.ts";
import { POLICY_VERSION } from "../../src/creator-agent/assessmentSchema.ts";
import { syntheticAgentEvidence } from "../../src/test/creatorQualification.ts";

function command(program, args, { env = process.env, allowFailure = false, timeout = 30_000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(-1_000_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_000); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 || allowFailure) resolveCommand({ code, stdout, stderr });
      // Never print Docker environment, tokens, source packets or full inspect output.
      else reject(new Error(`${program} failed with exit code ${code}; see the failed probe step.`));
    });
  });
}

test("API container preserves authenticated synthetic evidence across restart and online backup", {
  skip: process.env.FARDA_RUN_CONTAINER_SMOKE !== "1" ? "Cloud Docker verification is opt-in." : false,
  timeout: 180_000,
}, async (t) => {
  assert.equal(process.platform, "linux", "This probe runs on the isolated Ubuntu CI runner.");
  const nonce = randomBytes(8).toString("hex");
  const container = `farda-agent-ci-${nonce}`;
  const root = resolve(process.env.FARDA_CONTAINER_SMOKE_ROOT ?? join(tmpdir(), `farda-agent-container-${nonce}`));
  assert.notEqual(root, "/");
  assert.ok(!existsSync(root), "The synthetic data directory must be new.");
  mkdirSync(root, { mode: 0o700 });
  const data = join(root, "data");
  mkdirSync(data, { mode: 0o700 });
  const env = {
    ...process.env,
    FARDA_AGENT_READ_TOKEN: randomBytes(32).toString("hex"),
    FARDA_AGENT_REVIEW_TOKEN: randomBytes(32).toString("hex"),
    FARDA_AGENT_WORKSPACE_ID: "synthetic-container-workspace",
    FARDA_AGENT_ACCOUNT_ID: "synthetic-container-account",
  };
  // Credentials are generated in memory, passed by environment name and never echoed or written to a file.
  const docker = (args, options = {}) => command("docker", args, { env, ...options });
  let origin;
  const request = async (path, { token = env.FARDA_AGENT_READ_TOKEN, ...init } = {}) => {
    const headers = new Headers(init.headers);
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${origin}${path}`, { ...init, headers, signal: AbortSignal.timeout(5_000) });
    return { status: response.status, body: await response.json() };
  };
  const waitHealthy = async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const answer = await request("/health", { token: null });
        if (answer.status === 200 && answer.body.service === "farda-creator-agent") return;
      } catch { /* Startup/restart is bounded by the explicit deadline. */ }
      await delay(200);
    }
    assert.fail("The synthetic API container did not become healthy within 30 seconds.");
  };

  try {
    // The image runs as node (UID 1000); do not weaken the private mounted directory to world-writable.
    await command("sudo", ["chown", "1000:1000", data]);
    await docker(["run", "--detach", "--name", container, "--label", "com.farda.creator-agent.ci=true",
      "--publish", "127.0.0.1::8787", "--mount", `type=bind,source=${data},target=/data`,
      "--env", "FARDA_AGENT_READ_TOKEN", "--env", "FARDA_AGENT_REVIEW_TOKEN",
      "--env", "FARDA_AGENT_WORKSPACE_ID", "--env", "FARDA_AGENT_ACCOUNT_ID",
      "--env", "FARDA_AGENT_DATABASE=/data/evidence.sqlite", "--env", "FARDA_AGENT_HOST=0.0.0.0",
      // This is private loopback CI with simulated TLS ingress configuration, not public HTTPS verification.
      "--env", "FARDA_AGENT_ORIGIN=https://agent.invalid", "--env", "FARDA_AGENT_SECURE_COOKIES=true",
      "--env", "PORT=8787", process.env.FARDA_CONTAINER_IMAGE ?? "farda-creator-agent:ci"]);
    const ports = JSON.parse((await docker(["inspect", "--format", "{{json .NetworkSettings.Ports}}", container])).stdout);
    const binding = ports["8787/tcp"]?.[0];
    assert.equal(binding?.HostIp, "127.0.0.1");
    assert.match(binding.HostPort, /^\d+$/);
    origin = `http://127.0.0.1:${binding.HostPort}`;
    await waitHealthy();
    await docker(["exec", container, "node", "tools/creator-agent/healthcheck.mjs"]);
    assert.equal((await request("/v1/capabilities", { token: null })).status, 401);
    assert.equal((await request("/v1/capabilities", { token: randomBytes(32).toString("hex") })).status, 401);

    const capabilities = await request("/v1/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(capabilities.body.environment, "sandbox");
    assert.equal(capabilities.body.sourceAutomation, "notConnected");
    assert.equal(capabilities.body.policyVersion, POLICY_VERSION);
    const approved = loadApprovedBindings();
    assert.equal(approved.length, 2);
    assert.deepEqual(capabilities.body.models, approved.map((model) => ({ modelId: model.current.modelId, configHash: model.hash })));

    const packet = syntheticAgentEvidence({ creatorId: "synthetic-container-creator" });
    packet.ratings.routine = 0;
    const model = approved.find((item) => item.current.modelId === "WEBSITE-AFFILIATE-v3");
    assert.ok(model);
    const path = `/v1/creators/${encodeURIComponent(packet.creatorId)}`;
    const write = { method: "PUT", headers: { "content-type": "application/json", "idempotency-key": "synthetic-container-save-v1" },
      body: JSON.stringify({ expectedVersion: 0, policyVersion: POLICY_VERSION, configHash: model.hash, packet }) };
    assert.equal((await request(path, write)).status, 403, "Reader credentials must not save evidence.");
    const saved = await request(path, { ...write, token: env.FARDA_AGENT_REVIEW_TOKEN });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 1);
    assert.equal(typeof saved.body.runId, "string");
    assert.equal(saved.body.assessment.state, "hold");
    assert.equal(saved.body.assessment.criteria.routine, 0);
    assert.equal(saved.body.assessment.score.total, null, "Missing evidence is not a numeric zero or an invented complete score.");
    assert.equal(saved.body.assessment.config.hash, model.hash);
    assert.equal(saved.body.assessment.config.baselineHash, model.baselineHash);
    assert.equal(saved.body.assessment.config.numericHash, model.numericHash);
    const replay = await request(path, { ...write, token: env.FARDA_AGENT_REVIEW_TOKEN });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.runId, saved.body.runId);
    assert.equal(replay.body.revision, 1);

    await docker(["restart", "--time", "10", container]);
    await waitHealthy();
    const persisted = await request(path);
    assert.equal(persisted.status, 200);
    assert.equal(persisted.body.runId, saved.body.runId);
    assert.equal(persisted.body.revision, 1);
    assert.equal(persisted.body.stale, false);
    assert.equal(persisted.body.assessment.config.hash, model.hash);
    assert.equal(persisted.body.assessment.state, "hold");
    const restartReplay = await request(path, { ...write, token: env.FARDA_AGENT_REVIEW_TOKEN });
    assert.equal(restartReplay.status, 200);
    assert.equal(restartReplay.body.runId, saved.body.runId);
    assert.equal(restartReplay.body.revision, 1);

    const backup = JSON.parse((await docker(["exec", container, "node", "tools/creator-agent/backup.mjs", "create", "/data/evidence.sqlite", "/data/backups/synthetic.sqlite"])).stdout);
    assert.equal(backup.restored, true);
    assert.equal(backup.assessmentCount, 1);
    assert.equal(backup.requestCount, 1);
    assert.ok(backup.pages > 0);
    const restored = JSON.parse((await docker(["exec", container, "node", "tools/creator-agent/backup.mjs", "verify", "/data/backups/synthetic.sqlite"])).stdout);
    assert.equal(restored.restored, true);
    assert.equal(restored.assessmentCount, 1);
    assert.equal(restored.requestCount, 1);
    await docker(["exec", container, "node", "--input-type=module", "-e",
      "import assert from 'node:assert/strict'; import { statSync } from 'node:fs'; assert.equal(process.getuid(), 1000); for (const p of ['/data', '/data/evidence.sqlite', '/data/backups', '/data/backups/synthetic.sqlite']) assert.equal(statSync(p).mode & 0o077, 0);"]);
    t.diagnostic("Synthetic container authentication, two approved bindings, idempotency, restart persistence and online backup/restore verified. No provider or production action was performed.");
  } finally {
    try { await docker(["rm", "--force", container], { allowFailure: true }); }
    finally { await command("sudo", ["rm", "--recursive", "--force", "--", root]); }
  }
});
