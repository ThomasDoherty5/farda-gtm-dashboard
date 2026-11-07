import type { DatabaseSync } from "node:sqlite";
import type { OperationsScope } from "./operations.ts";

const WINDOW_MS = 60_000;
const LIMITS = { read: 120, write: 30 } as const;
export type ApiRequestKind = keyof typeof LIMITS;
export type ApiAdmission =
  | { admitted: true; remaining: number; retryAfterMs: null }
  | { admitted: false; remaining: 0; retryAfterMs: number };

/** Transport admission only. Provider quota and financial/resource grants belong to their source owners. */
export class ApiRequestLimits {
  private readonly db: DatabaseSync;
  private readonly scope: string;
  private readonly now: () => number;

  constructor(db: DatabaseSync, scope: OperationsScope, now: () => number = Date.now) {
    if (!scope.workspaceId || !scope.accountId || scope.environment !== "sandbox") throw new TypeError("Explicit sandbox API scope is required.");
    this.db = db;
    this.scope = JSON.stringify([scope.workspaceId, scope.accountId, scope.environment]);
    this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS api_principal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL, principal TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('read','write')),
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS api_principal_window
      ON api_principal_events(scope,principal,kind,occurred_at);`);
  }

  /** Principal must be a server-resolved reference, never a credential or a client role claim. */
  admit(principalRef: string, kind: ApiRequestKind): ApiAdmission {
    if (typeof principalRef !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/.test(principalRef) || (kind !== "read" && kind !== "write")) {
      throw new TypeError("A trusted principal and API request kind are required.");
    }
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + WINDOW_MS)) throw new RangeError("Invalid API clock.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM api_principal_events WHERE scope=? AND principal=? AND kind=? AND occurred_at<=?")
        .run(this.scope, principalRef, kind, now - WINDOW_MS);
      const row = this.db.prepare("SELECT COUNT(*) AS total, MIN(occurred_at) AS first, MAX(occurred_at) AS last FROM api_principal_events WHERE scope=? AND principal=? AND kind=?")
        .get(this.scope, principalRef, kind) as { total: number; first: number | null; last: number | null };
      let admission: ApiAdmission;
      // A backward clock cannot discard newer admissions and open another allowance.
      if (row.last !== null && row.last > now) {
        admission = { admitted: false, remaining: 0, retryAfterMs: Math.max(1, row.last - now) };
      } else if (row.total >= LIMITS[kind]) {
        admission = { admitted: false, remaining: 0, retryAfterMs: Math.max(1, row.first! + WINDOW_MS - now) };
      } else {
        this.db.prepare("INSERT INTO api_principal_events(scope,principal,kind,occurred_at) VALUES(?,?,?,?)")
          .run(this.scope, principalRef, kind, now);
        admission = { admitted: true, remaining: LIMITS[kind] - row.total - 1, retryAfterMs: null };
      }
      this.db.exec("COMMIT");
      return admission;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* Preserve the original database error. */ }
      throw error;
    }
  }
}

/** POST read envelopes are reads; action previews and saves are admitted as writes. */
export function apiRequestKind(method: string, pathname: string): ApiRequestKind {
  return method === "GET" || method === "HEAD" || (method === "POST" && pathname === "/v1/read") ? "read" : "write";
}
