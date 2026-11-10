// @vitest-environment node
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestLimits, apiRequestKind } from "./apiRequestLimits";

const scope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" as const };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const databases: DatabaseType[] = [];
const directories: string[] = [];
const database = (path = ":memory:") => { const db = new DatabaseSync(path); databases.push(db); return db; };
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authenticated API admission", () => {
  it("admits 120 reads and 30 writes independently without giving rejected requests another allowance", () => {
    const gate = new ApiRequestLimits(database(), scope, () => 10_000);
    for (let i = 0; i < 120; i++) expect(gate.admit("agent-reader", "read").admitted).toBe(true);
    for (let i = 0; i < 30; i++) expect(gate.admit("agent-reader", "write").admitted).toBe(true);
    for (let i = 0; i < 3; i++) {
      expect(gate.admit("agent-reader", "read")).toEqual({ admitted: false, remaining: 0, retryAfterMs: 60_000 });
      expect(gate.admit("agent-reader", "write")).toEqual({ admitted: false, remaining: 0, retryAfterMs: 60_000 });
    }
  });

  it("uses a rolling minute and admits exactly when the oldest request expires", () => {
    let now = 5_000;
    const gate = new ApiRequestLimits(database(), scope, () => now);
    expect(gate.admit("agent-reviewer", "write").admitted).toBe(true);
    now = 10_000;
    for (let i = 0; i < 29; i++) gate.admit("agent-reviewer", "write");
    now = 64_999;
    expect(gate.admit("agent-reviewer", "write")).toMatchObject({ admitted: false, retryAfterMs: 1 });
    now = 65_000;
    expect(gate.admit("agent-reviewer", "write")).toMatchObject({ admitted: true, remaining: 0 });
    expect(gate.admit("agent-reviewer", "write")).toMatchObject({ admitted: false, retryAfterMs: 5_000 });
  });

  it("shares admission across connections and restart instead of resetting a process-local counter", () => {
    const dir = mkdtempSync(join(tmpdir(), "farda-api-rate-")); directories.push(dir);
    const path = join(dir, "rate.sqlite");
    const one = new ApiRequestLimits(database(path), scope, () => 10_000);
    const two = new ApiRequestLimits(database(path), scope, () => 10_000);
    for (let i = 0; i < 30; i++) expect((i % 2 ? one : two).admit("agent-reviewer", "write").admitted).toBe(true);
    expect(two.admit("agent-reviewer", "write").admitted).toBe(false);
    for (const db of databases.splice(0)) db.close();
    const helperUrl = new URL("./apiRequestLimits.ts", import.meta.url).href;
    const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      import { ApiRequestLimits } from ${JSON.stringify(helperUrl)};
      const db = new DatabaseSync(process.argv[1]);
      const gate = new ApiRequestLimits(db, ${JSON.stringify(scope)}, () => 10000);
      process.stdout.write(JSON.stringify(gate.admit('agent-reviewer', 'write')));
      db.close();
    `, path], { encoding: "utf8" }));
    expect(restarted).toMatchObject({ admitted: false, retryAfterMs: 60_000 });
  });

  it("isolates principals and authenticated account scope", () => {
    const db = database();
    const gate = new ApiRequestLimits(db, scope, () => 10_000);
    for (let i = 0; i < 30; i++) gate.admit("agent-reviewer", "write");
    expect(gate.admit("another-principal", "write").admitted).toBe(true);
    const other = new ApiRequestLimits(db, { ...scope, accountId: "another-account" }, () => 10_000);
    expect(other.admit("agent-reviewer", "write").admitted).toBe(true);
    expect(gate.admit("agent-reviewer", "write").admitted).toBe(false);
  });

  it("does not reopen capacity when the clock goes backwards", () => {
    let now = 10_000;
    const gate = new ApiRequestLimits(database(), scope, () => now);
    gate.admit("agent-reviewer", "write");
    now = 9_000;
    expect(gate.admit("agent-reviewer", "write")).toEqual({ admitted: false, remaining: 0, retryAfterMs: 1_000 });
    now = 10_000;
    expect(gate.admit("agent-reviewer", "write")).toMatchObject({ admitted: true, remaining: 28 });
  });

  it("classifies the read envelope by operation and rejects invalid internal principals/clocks", () => {
    expect(apiRequestKind("POST", "/v1/read")).toBe("read");
    expect(apiRequestKind("POST", "/v1/action")).toBe("write");
    expect(apiRequestKind("POST", "/v1/save")).toBe("write");
    expect(apiRequestKind("GET", "/v1/capabilities")).toBe("read");
    const gate = new ApiRequestLimits(database(), scope, () => NaN);
    expect(() => gate.admit("agent-reviewer", "write")).toThrow("Invalid API clock");
    expect(() => gate.admit("untrusted principal", "write")).toThrow("trusted principal");
  });
});
