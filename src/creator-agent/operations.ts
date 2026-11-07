import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CapabilityLedger, CapabilityConflict } from "./connections/ledger.ts";
import { registrationSchema, type ReceiptResolver } from "./connections/schema.ts";
import { JobRepository, JobConflict, type JobOptions } from "./jobs/repository.ts";
import { jobDefinitionSchema, jobEventSchema } from "./jobs/schema.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
export const OPERATIONS_SCHEMA_VERSION = "farda.operations.v1" as const;
export type OperationsScope = { workspaceId: string; accountId: string; environment: "sandbox" };
export type OperationsOptions = { now?: () => number; resolveReceipt?: ReceiptResolver; resolveJobActivation?: JobOptions["resolveActivation"] };
type HttpContext = { req: IncomingMessage; res: ServerResponse; role: "reader" | "reviewer";
  reply: (res: ServerResponse, status: number, body: unknown) => void; bodyOf: (req: IncomingMessage) => Promise<unknown> };
const version = z.number().int().nonnegative().safe();
const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(100) }).strict();
const empty = z.object({}).strict();
const registerConnection = z.object({ registration: registrationSchema, expectedRevision: version }).strict();
const verifyConnection = z.object({ receiptRef: z.string().min(1).max(200), expectedRevision: version }).strict();
const revokeConnection = z.object({ reasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), expectedRevision: version }).strict();
const registerJob = z.object({ definition: jobDefinitionSchema, expectedVersion: version }).strict();
const pauseJob = z.object({ version: z.number().int().positive().safe() }).strict();
const controlRun = z.object({ command: z.enum(["pause", "cancel"]) }).strict();

/** Strip private references recursively from every nested job/read/mutation/history response. */
export function safeOperationsProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeOperationsProjection);
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "secretRef") { output.hasCredentialReference = child !== null; continue; }
    if (key === "connectionRef") { output.hasConnectionReference = child !== null; continue; }
    if (key === "leaseToken" || key === "lease_token") continue;
    output[key] = safeOperationsProjection(child);
  }
  return output;
}

const query = (url: URL) => {
  if (new Set(url.searchParams.keys()).size !== [...url.searchParams.keys()].length) throw new SyntaxError("Duplicate query key");
  return Object.fromEntries(url.searchParams);
};
const identifier = (encoded: string) => { try { return decodeURIComponent(encoded); } catch { throw new SyntaxError("Invalid encoded identifier"); } };

/** Composes repositories on the existing private agent path; caller invokes only after shared auth/CSRF. */
export function createOperations(database: string | DatabaseType, scope: OperationsScope, options: OperationsOptions = {}) {
  const ownsDatabase = typeof database === "string";
  let ledger: CapabilityLedger | undefined;
  let db: DatabaseType | undefined;
  let jobs: JobRepository;
  try {
    db = typeof database === "string" ? new DatabaseSync(database) : database;
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    ledger = new CapabilityLedger(db, scope, { now: options.now, resolveReceipt: options.resolveReceipt });
    const capabilities = ledger;
    jobs = new JobRepository(db, { scope, now: options.now, resolveActivation: options.resolveJobActivation, resolveCapability: (binding) => capabilities.requireReady(binding) });
  } catch (error) { try { ledger?.close(); } finally { if (ownsDatabase) db?.close(); } throw error; }
  if (!ledger || !db) throw new Error("OPERATIONS_INITIALIZATION_FAILED");
  const connectionLedger = ledger;
  const operationDb = db;
  let closed = false;
  const close = () => { if (closed) return; closed = true; try { connectionLedger.close(); } finally { if (ownsDatabase) operationDb.close(); } };
  const safeScope = { workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment, authorizationScopeVersion: "operations.scope.v1" };
  const sourceOwned = (handler: string) => handler === "dispatch-approved.v1" || handler === "export-ledger-snapshot.v1";
  const publicJobPredicate = "json_extract(d.body,'$.handler') NOT IN ('dispatch-approved.v1','export-ledger-snapshot.v1')";
  const publicRunPredicate = "json_extract(definition,'$.handler') NOT IN ('dispatch-approved.v1','export-ledger-snapshot.v1')";

  async function handle({ req, res, role, reply, bodyOf }: HttpContext): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!/^\/v1\/(connections|jobs|job-runs)(\/|$)/.test(path)) return false;
    const respond = (status: number, data: unknown) => { reply(res, status, { schemaVersion: OPERATIONS_SCHEMA_VERSION, scope: safeScope, data: safeOperationsProjection(data), sourceEffect: "none" }); return true; };
    const notFound = () => { reply(res, 404, { code: "RECORD_NOT_FOUND", executionCertainty: "notApplied" }); return true; };
    // Source-owned actions use the current named actor, immutable key/version and protected projection boundary.
    // A generic reviewer credential cannot control them, and a legacy read cannot reveal their private references.
    const sourceBoundary = () => { reply(res, 403, { code: "SOURCE_ACTION_BOUNDARY_REQUIRED", executionCertainty: "uncertain" }); return true; };
    if (req.method === "GET") {
      const collection = ["/v1/connections", "/v1/jobs", "/v1/job-runs"].includes(path);
      const history = path.endsWith("/history");
      const limit = collection || history ? querySchema.parse(query(url)).limit : (empty.parse(query(url)), 100);
      if (path === "/v1/connections") return respond(200, connectionLedger.list(limit));
      const connection = /^\/v1\/connections\/([a-f0-9]{64})(?:\/(history))?$/.exec(path);
      if (connection) {
        if (!connectionLedger.get(connection[1]!)) return notFound();
        return respond(200, connection[2] ? connectionLedger.historyPage(connection[1]!, limit) : connectionLedger.get(connection[1]!));
      }
      if (path === "/v1/jobs") {
        const total = Number(operationDb.prepare("SELECT COUNT(*) AS total FROM job_heads").get()?.total ?? 0);
        const restricted = Number(operationDb.prepare(`SELECT COUNT(*) AS n FROM job_heads h JOIN job_definitions d ON d.job_id=h.job_id AND d.version=h.version WHERE NOT (${publicJobPredicate})`).get()?.n ?? 0);
        const records = operationDb.prepare(`SELECT h.job_id FROM job_heads h JOIN job_definitions d ON d.job_id=h.job_id AND d.version=h.version WHERE ${publicJobPredicate} ORDER BY h.job_id LIMIT ?`).all(limit).map((row) => jobs.getJob(String(row.job_id)));
        return respond(200, { records, total, partial: total > records.length, ...(restricted ? { restrictedCount: restricted } : {}) });
      }
      if (path === "/v1/job-runs") {
        const total = Number(operationDb.prepare("SELECT COUNT(*) AS total FROM job_runs").get()?.total ?? 0);
        const restricted = Number(operationDb.prepare(`SELECT COUNT(*) AS n FROM job_runs WHERE NOT (${publicRunPredicate})`).get()?.n ?? 0);
        const records = operationDb.prepare(`SELECT run_id FROM job_runs WHERE ${publicRunPredicate} ORDER BY observed_at DESC,run_id DESC LIMIT ?`).all(limit).map((row) => {
          const { items, ...summary } = jobs.getRun(String(row.run_id));
          return { ...summary, itemCount: items.length, itemsIncluded: false };
        });
        return respond(200, { records, total, partial: total > records.length, ...(restricted ? { restrictedCount: restricted } : {}) });
      }
      const job = /^\/v1\/jobs\/([^/]+)$/.exec(path);
      if (job) { const record = jobs.getJob(identifier(job[1]!)); return sourceOwned(record.definition.handler) ? sourceBoundary() : respond(200, record); }
      const run = /^\/v1\/job-runs\/([^/]+)(?:\/(history))?$/.exec(path);
      if (run) { const record = jobs.getRun(identifier(run[1]!)); return sourceOwned(record.definition.handler) ? sourceBoundary()
        : respond(200, run[2] ? jobs.history(identifier(run[1]!), limit) : record); }
      return false;
    }
    if (req.method !== "POST") return false;
    const connection = /^\/v1\/connections\/([a-f0-9]{64})\/(verify|revoke)$/.exec(path);
    const pause = /^\/v1\/jobs\/([^/]+)\/pause$/.exec(path);
    const control = /^\/v1\/job-runs\/([^/]+)\/control$/.exec(path);
    const recognized = ["/v1/connections/register", "/v1/jobs/register", "/v1/jobs/ingress"].includes(path) || connection || pause || control;
    if (!recognized) return false;
    if (role !== "reviewer") { reply(res, 403, { code: "REVIEWER_REQUIRED", executionCertainty: "notApplied" }); return true; }
    empty.parse(query(url));
    if (!req.headers["content-type"]?.startsWith("application/json")) { reply(res, 415, { code: "JSON_REQUIRED", executionCertainty: "notApplied" }); return true; }
    const body = await bodyOf(req);
    if (path === "/v1/connections/register") { const input = registerConnection.parse(body); return respond(200, connectionLedger.register(input.registration, input.expectedRevision)); }
    if (connection) {
      if (!connectionLedger.get(connection[1]!)) return notFound();
      if (connection[2] === "verify") { const input = verifyConnection.parse(body); return respond(200, await connectionLedger.verify(connection[1]!, input.receiptRef, input.expectedRevision)); }
      const input = revokeConnection.parse(body); return respond(200, connectionLedger.revoke(connection[1]!, input.reasonCode, input.expectedRevision));
    }
    if (path === "/v1/jobs/register") { const input = registerJob.parse(body);
      if (sourceOwned(input.definition.handler)) return sourceBoundary();
      try { if (sourceOwned(jobs.getJob(input.definition.jobId).definition.handler)) return sourceBoundary(); }
      catch (error) { if (!(error instanceof JobConflict) || error.message !== "JOB_NOT_FOUND") throw error; }
      return respond(200, jobs.register(input.definition, input.expectedVersion)); }
    if (path === "/v1/jobs/ingress") {
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key.trim() || key.length > 240) { reply(res, 400, { code: "IDEMPOTENCY_KEY_REQUIRED", executionCertainty: "notApplied" }); return true; }
      const input = jobEventSchema.parse(body);
      if (sourceOwned(jobs.getJob(input.jobId).definition.handler)) return sourceBoundary();
      return respond(200, jobs.ingest(input, key));
    }
    if (pause) { const input = pauseJob.parse(body), id = identifier(pause[1]!);
      return sourceOwned(jobs.getJob(id).definition.handler) ? sourceBoundary() : respond(200, jobs.setJobControl(id, input.version, "pause")); }
    if (control) { const input = controlRun.parse(body), id = identifier(control[1]!);
      return sourceOwned(jobs.getRun(id).definition.handler) ? sourceBoundary() : respond(200, jobs.controlRun(id, input.command)); }
    return false;
  }
  return { ledger: connectionLedger, jobs, handle, close };
}

export function operationsErrorStatus(error: unknown): number | null {
  if (!(error instanceof CapabilityConflict) && !(error instanceof JobConflict)) return null;
  if (/SCOPE_MISMATCH|^INVALID_/.test(error.message)) return 400;
  if (/NOT_FOUND$/.test(error.message)) return 404;
  return 409;
}
