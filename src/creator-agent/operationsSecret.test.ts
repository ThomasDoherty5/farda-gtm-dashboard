// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStore } from "./store.ts";
import { createOperations } from "./operations.ts";
import { loadOperationsSecret } from "./operationsSecret.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "./testFixtures.ts";

const scope = { workspaceId: "synthetic-key-workspace", accountId: "synthetic-key-account", environment: "sandbox" as const };
it("keeps private schedule links stable across restarts without using a client authenticator as key material", () => {
  const directory = mkdtempSync(join(tmpdir(), "farda-operations-key-"));
  const path = join(directory, "agent.sqlite");
  const first = new AgentStore(path, scope);
  const operations = createOperations(first.database, scope);
  let ref: string;
  let secret: string;
  try {
    secret = loadOperationsSecret(first.database, scope);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect([SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN]).not.toContain(secret);
    ref = sealOperationsToken(scope, secret, "schedule-job", "synthetic-private-job");
  } finally { operations.close(); first.close(); }
  const second = new AgentStore(path, scope);
  const resumed = createOperations(second.database, scope);
  try {
    expect(loadOperationsSecret(second.database, scope)).toBe(secret!);
    expect(openOperationsToken(scope, loadOperationsSecret(second.database, scope), "schedule-job", ref!)).toBe("synthetic-private-job");
    expect(() => loadOperationsSecret(second.database, { ...scope, accountId: "other-account" })).toThrow("DATABASE_SCOPE_MISMATCH");
    second.database.prepare("UPDATE saved_operations_key SET version=2").run();
    expect(() => loadOperationsSecret(second.database, scope)).toThrow("INVALID_OPERATIONS_KEY_STORAGE");
  } finally { resumed.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});
