import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OperationsScope } from "./operations.ts";

/** Cursor integrity must not depend on a credential held by an authenticated API client. */
export function loadOperationsSecret(db: DatabaseSync, scope: OperationsScope): string {
  const storedScope = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
  if (!storedScope || storedScope.workspace_id !== scope.workspaceId || storedScope.account_id !== scope.accountId || storedScope.environment !== scope.environment)
    throw new Error("DATABASE_SCOPE_MISMATCH");
  db.exec("CREATE TABLE IF NOT EXISTS saved_operations_key(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,key_hex TEXT NOT NULL)");
  // Concurrent startups reuse the winning key. The private database also owns the durable schedule references.
  db.prepare("INSERT OR IGNORE INTO saved_operations_key(id,version,key_hex) VALUES(1,1,?)").run(randomBytes(32).toString("hex"));
  const row = db.prepare("SELECT version,key_hex FROM saved_operations_key WHERE id=1").get();
  if (row?.version !== 1 || typeof row.key_hex !== "string" || !/^[a-f0-9]{64}$/.test(row.key_hex))
    throw new Error("INVALID_OPERATIONS_KEY_STORAGE");
  return row.key_hex;
}
