import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { digest } from "../config.ts";
import { POLICY_VERSION } from "../assessmentSchema.ts";
import type { CapabilityReadiness, ExpectedBinding } from "../connections/schema.ts";
import { checkpointSchema, failureSchema, jobDefinitionSchema, jobEventSchema, jobItemViewSchema, jobRunViewSchema, localResultSchema, referenceInputSchema,
  type JobDefinition, type JobItemView, type JobRunView, type LocalResult } from "./schema.ts";

type Row = Record<string, unknown>;
type Scope = { workspaceId: string; accountId: string; environment: "sandbox" };
export class JobConflict extends Error {}
export type JobOptions = { scope: Scope; now?: () => number;
  resolveActivation?: (request: { jobId: string; version: number; definitionHash: string; decisionRef: string }) => { approved: boolean; decisionRef: string; definitionHash: string } | null;
  resolveCapability?: (binding: ExpectedBinding) => CapabilityReadiness };
export type JobClaim = { runId: string; item: JobItemView; definition: JobDefinition; leaseToken: string };
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const iso = (value: unknown) => new Date(Number(value)).toISOString();
const terminal = new Set(["completed", "cancelled", "failed", "reconcile"]);

/** Borrows the existing scoped SQLite handle; it never opens a second secret store or closes its caller's DB.
 * Mutations are synchronous transactions. Callers must not nest these methods inside another transaction.
 */
export class JobRepository {
  private db: DatabaseSync;
  private options: JobOptions;
  private now: () => number;
  constructor(db: DatabaseSync, options: JobOptions) {
    this.db = db;
    this.options = options;
    this.now = options.now ?? Date.now;
    const scope = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (!scope || scope.workspace_id !== options.scope.workspaceId || scope.account_id !== options.scope.accountId || options.scope.environment !== "sandbox") throw new JobConflict("JOB_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS job_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO job_schema VALUES(1,1);
      CREATE TABLE IF NOT EXISTS job_definitions(job_id TEXT NOT NULL,version INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(job_id,version));
      CREATE TABLE IF NOT EXISTS job_heads(job_id TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,activation_ref TEXT,activation_hash TEXT);
      CREATE TABLE IF NOT EXISTS job_runs(run_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,job_version INTEGER NOT NULL,event_id TEXT NOT NULL,event_at TEXT,observed_at INTEGER NOT NULL,request_hash TEXT NOT NULL,definition_hash TEXT NOT NULL,definition TEXT NOT NULL,control TEXT NOT NULL DEFAULT 'active',started_at INTEGER,activation_ref TEXT,UNIQUE(job_id,event_id));
      CREATE TABLE IF NOT EXISTS job_items(item_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,item_key TEXT NOT NULL,input_hash TEXT NOT NULL,job_version INTEGER NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,steps INTEGER NOT NULL DEFAULT 0,due_at INTEGER NOT NULL,lease_token TEXT,lease_owner TEXT,lease_until INTEGER,lease_run_id TEXT,checkpoint_version INTEGER NOT NULL DEFAULT 0,checkpoint TEXT NOT NULL,result TEXT,reason_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,last_token_hash TEXT,last_outcome_hash TEXT,UNIQUE(job_id,item_key));
      CREATE TABLE IF NOT EXISTS job_run_items(run_id TEXT NOT NULL,item_id TEXT NOT NULL,reused INTEGER NOT NULL,PRIMARY KEY(run_id,item_id));
      CREATE TABLE IF NOT EXISTS job_ingress_requests(key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS job_resource_leases(resource_key TEXT PRIMARY KEY,item_id TEXT NOT NULL,lease_token TEXT NOT NULL,lease_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_transitions(transition_id TEXT PRIMARY KEY,run_id TEXT,item_id TEXT,kind TEXT NOT NULL,at INTEGER NOT NULL,detail TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_item_due ON job_items(state,due_at,created_at);
      CREATE INDEX IF NOT EXISTS job_transition_run ON job_transitions(run_id,at);`);
    if (db.prepare("SELECT version FROM job_schema WHERE id=1").get()?.version !== 1) throw new JobConflict("UNSUPPORTED_JOB_SCHEMA");
  }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (error) { this.db.exec("ROLLBACK"); throw error; } }
  private log(runId: string | null, itemId: string | null, kind: string, detail: object = {}) { this.db.prepare("INSERT INTO job_transitions VALUES(?,?,?,?,?,?)").run(randomUUID(), runId, itemId, kind, this.now(), JSON.stringify(detail)); }
  private head(jobId: string) { const row = this.db.prepare("SELECT * FROM job_heads WHERE job_id=?").get(jobId); if (!row) throw new JobConflict("JOB_NOT_FOUND"); return row; }
  private definition(jobId: string, version: number): { definition: JobDefinition; hash: string } {
    const row = this.db.prepare("SELECT body,hash FROM job_definitions WHERE job_id=? AND version=?").get(jobId, version);
    if (!row) throw new JobConflict("JOB_DEFINITION_NOT_FOUND");
    return { definition: jobDefinitionSchema.parse(parse(row.body)), hash: String(row.hash) };
  }
  register(input: unknown, expectedVersion: number) {
    const definition = jobDefinitionSchema.parse(input);
    const binding = definition.capabilityBinding;
    if (binding && (binding.workspaceId !== this.options.scope.workspaceId || binding.accountId !== this.options.scope.accountId || binding.environment !== this.options.scope.environment)) throw new JobConflict("JOB_SCOPE_MISMATCH");
    const hash = digest(definition);
    return this.tx(() => {
      const prior = this.db.prepare("SELECT hash FROM job_definitions WHERE job_id=? AND version=?").get(definition.jobId, definition.version);
      if (prior) { if (prior.hash !== hash) throw new JobConflict("JOB_VERSION_REUSED"); return this.getJob(definition.jobId); }
      const head = this.db.prepare("SELECT version FROM job_heads WHERE job_id=?").get(definition.jobId);
      if ((head?.version ?? 0) !== expectedVersion || definition.version !== expectedVersion + 1) throw new JobConflict("JOB_VERSION_CONFLICT");
      this.db.prepare("INSERT INTO job_definitions VALUES(?,?,?,?)").run(definition.jobId, definition.version, hash, JSON.stringify(definition));
      this.db.prepare("INSERT INTO job_heads(job_id,version) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET version=excluded.version,enabled=0,paused=0,activation_ref=NULL,activation_hash=NULL").run(definition.jobId, definition.version);
      this.log(null, null, "registered", { jobId: definition.jobId, version: definition.version, hash, enabled: false });
      return this.getJob(definition.jobId);
    });
  }
  getJob(jobId: string) { const head = this.head(jobId); const data = this.definition(jobId, Number(head.version)); return { ...data, enabled: Boolean(head.enabled), paused: Boolean(head.paused), activationRef: head.activation_ref === null ? null : String(head.activation_ref) }; }
  private wakeHeld(jobId: string, version: number, reason: string) {
    const rows = this.db.prepare("SELECT item_id FROM job_items WHERE job_id=? AND job_version=? AND state='held' AND reason_code=?").all(jobId, version, reason);
    for (const row of rows) { const itemId = String(row.item_id); this.db.prepare("UPDATE job_items SET state='queued',reason_code=NULL,updated_at=? WHERE item_id=?").run(this.now(), itemId);
      this.log(this.uncancelledRun(itemId)?.run_id?.toString() ?? null, itemId, "hold-resolved", { reason }); }
  }
  activate(jobId: string, version: number, decisionRef: string) {
    referenceInputSchema.shape.subjectRef.parse(decisionRef);
    return this.tx(() => {
      const head = this.head(jobId); const { hash } = this.definition(jobId, version);
      if (head.version !== version) throw new JobConflict("JOB_VERSION_CONFLICT");
      const proof = this.options.resolveActivation?.({ jobId, version, definitionHash: hash, decisionRef });
      if (!proof?.approved || proof.decisionRef !== decisionRef || proof.definitionHash !== hash) throw new JobConflict("JOB_ACTIVATION_UNVERIFIED");
      this.db.prepare("UPDATE job_heads SET enabled=1,activation_ref=?,activation_hash=? WHERE job_id=?").run(decisionRef, hash, jobId);
      this.wakeHeld(jobId, version, "JOB_DISABLED");
      this.log(null, null, "activated", { jobId, version, decisionRef, definitionHash: hash }); return this.getJob(jobId);
    });
  }
  setJobControl(jobId: string, version: number, control: "pause" | "resume" | "disable") {
    if (!["pause", "resume", "disable"].includes(control)) throw new JobConflict("INVALID_JOB_CONTROL");
    return this.tx(() => { const head = this.head(jobId); if (head.version !== version) throw new JobConflict("JOB_VERSION_CONFLICT");
      if (control === "disable") this.db.prepare("UPDATE job_heads SET enabled=0,activation_ref=NULL,activation_hash=NULL WHERE job_id=?").run(jobId);
      else this.db.prepare("UPDATE job_heads SET paused=? WHERE job_id=?").run(control === "pause" ? 1 : 0, jobId);
      if (control === "resume") this.wakeHeld(jobId, version, "JOB_PAUSED");
      this.log(null, null, control, { jobId, version }); return this.getJob(jobId); });
  }
  ingest(input: unknown, idempotencyKey: string): JobRunView {
    const event = jobEventSchema.parse(input); referenceInputSchema.shape.itemKey.parse(idempotencyKey); const hash = digest(event);
    return this.tx(() => {
      const priorRequest = this.db.prepare("SELECT * FROM job_ingress_requests WHERE key=?").get(idempotencyKey);
      if (priorRequest) { if (priorRequest.request_hash !== hash) throw new JobConflict("JOB_IDEMPOTENCY_KEY_REUSED"); return this.getRun(String(priorRequest.run_id)); }
      const priorEvent = this.db.prepare("SELECT * FROM job_runs WHERE job_id=? AND event_id=?").get(event.jobId, event.eventId);
      if (priorEvent) { if (priorEvent.request_hash !== hash) throw new JobConflict("JOB_EVENT_REUSED");
        const priorRunId = priorEvent.run_id;
        if (typeof priorRunId !== "string" || !priorRunId) throw new JobConflict("JOB_EVENT_RECEIPT_INVALID");
        this.db.prepare("INSERT INTO job_ingress_requests VALUES(?,?,?)").run(idempotencyKey, hash, priorRunId); return this.getRun(priorRunId); }
      const head = this.head(event.jobId); const { definition, hash: definitionHash } = this.definition(event.jobId, event.jobVersion);
      if (head.version !== event.jobVersion) throw new JobConflict("JOB_DEFINITION_STALE");
      if (event.eventType !== definition.eventType || event.items.length > definition.budgets.maxItems) throw new JobConflict("JOB_EVENT_BUDGET_OR_TYPE_MISMATCH");
      const runId = randomUUID(); const now = this.now();
      this.db.prepare("INSERT INTO job_runs(run_id,job_id,job_version,event_id,event_at,observed_at,request_hash,definition_hash,definition) VALUES(?,?,?,?,?,?,?,?,?)").run(runId, event.jobId, event.jobVersion, event.eventId, event.eventAt, now, hash, definitionHash, JSON.stringify(definition));
      for (const item of event.items) {
        const inputHash = digest(item); let row = this.db.prepare("SELECT * FROM job_items WHERE job_id=? AND item_key=?").get(event.jobId, item.itemKey); const reused = Boolean(row);
        // Completion belongs to the registration that produced it. A new policy/handler version needs a new work identity.
        if (row && row.job_version !== event.jobVersion) throw new JobConflict("JOB_ITEM_DEFINITION_MISMATCH");
        if (row && row.input_hash !== inputHash) throw new JobConflict("JOB_ITEM_KEY_REUSED");
        if (!row) { const itemId = randomUUID(); this.db.prepare("INSERT INTO job_items(item_id,job_id,item_key,input_hash,job_version,input,state,due_at,checkpoint,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?)").run(itemId, event.jobId, item.itemKey, inputHash, event.jobVersion, JSON.stringify(item), now, JSON.stringify({ cursor: null, processedRefs: [] }), now, now); row = this.db.prepare("SELECT * FROM job_items WHERE item_id=?").get(itemId)!; }
        this.db.prepare("INSERT INTO job_run_items VALUES(?,?,?)").run(runId, String(row.item_id), reused ? 1 : 0); this.log(runId, String(row.item_id), reused ? "item-reused" : "item-queued");
      }
      this.db.prepare("INSERT INTO job_ingress_requests VALUES(?,?,?)").run(idempotencyKey, hash, runId); this.log(runId, null, "event-ingested", { eventId: event.eventId, count: event.items.length }); return this.getRun(runId);
    });
  }
  private itemRow(itemId: string): Row { const row = this.db.prepare("SELECT * FROM job_items WHERE item_id=?").get(itemId); if (!row) throw new JobConflict("JOB_ITEM_NOT_FOUND"); return row; }
  private viewItem(row: Row): JobItemView { return jobItemViewSchema.parse({ itemId: row.item_id, jobId: row.job_id, itemKey: row.item_key, definitionVersion: row.job_version, input: parse(row.input), state: row.state,
    attempts: row.attempts, steps: row.steps, dueAt: iso(row.due_at), lease: row.lease_token ? { ownerRef: row.lease_owner, expiresAt: iso(row.lease_until) } : null,
    checkpointVersion: row.checkpoint_version, checkpoint: parse(row.checkpoint), result: row.result ? parse(row.result) : null, reasonCode: row.reason_code, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }); }
  private currentReason(row: Row, allowPaused = false): string | null { const head = this.head(String(row.job_id)); const { definition, hash } = this.definition(String(row.job_id), Number(row.job_version));
    if (head.version !== row.job_version) return "JOB_DEFINITION_STALE"; if (!head.enabled || head.activation_hash !== hash) return "JOB_DISABLED"; if (head.paused && !allowPaused) return "JOB_PAUSED"; if (definition.policyVersion !== POLICY_VERSION) return "JOB_POLICY_STALE"; return null; }
  private capabilityReason(definition: JobDefinition): string | null {
    if (!definition.capabilityBinding) return null; // N/A: both registered handlers are purely local, without a source dispatcher.
    try { const result = this.options.resolveCapability?.(definition.capabilityBinding);
      return result?.allowed && result.state === "Ready" && result.receiptRef && result.expiresAt && Date.parse(result.expiresAt) > this.now() ? null : "JOB_CAPABILITY_UNVERIFIED";
    } catch { return "JOB_CAPABILITY_UNVERIFIED"; }
  }
  private steps(runId: string) { return Number(this.db.prepare("SELECT COUNT(*) AS count FROM job_transitions WHERE run_id=? AND kind IN ('leased','checkpoint')").get(runId)?.count ?? 0); }
  private release(row: Row) { if (row.lease_token) this.db.prepare("DELETE FROM job_resource_leases WHERE item_id=? AND lease_token=?").run(String(row.item_id), String(row.lease_token)); }
  private activeRun(itemId: string) { return this.db.prepare("SELECT r.* FROM job_runs r INNER JOIN job_run_items j ON j.run_id=r.run_id WHERE j.item_id=? AND r.control='active' ORDER BY r.observed_at,r.run_id LIMIT 1").get(itemId); }
  private uncancelledRun(itemId: string) { return this.db.prepare("SELECT r.* FROM job_runs r INNER JOIN job_run_items j ON j.run_id=r.run_id WHERE j.item_id=? AND r.control!='cancelled' ORDER BY r.observed_at,r.run_id LIMIT 1").get(itemId); }
  recoverExpired(limit = 100) { if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobConflict("INVALID_RECOVERY_LIMIT");
    return this.tx(() => { const rows = this.db.prepare("SELECT * FROM job_items WHERE state='leased' AND lease_until<=? ORDER BY lease_until,item_id LIMIT ?").all(this.now(), limit);
      for (const row of rows) { const { definition } = this.definition(String(row.job_id), Number(row.job_version)); const currentReason = this.currentReason(row); const active = this.uncancelledRun(String(row.item_id));
        const state = !active ? "cancelled" : currentReason ? "held" : Number(row.attempts) >= definition.budgets.maxAttempts ? "failed" : "retryWait";
        const reason = !active ? "NO_ACTIVE_RUN" : currentReason ?? (state === "failed" ? "ATTEMPT_LIMIT" : "WORKER_LEASE_EXPIRED"); this.release(row);
        this.db.prepare("UPDATE job_items SET state=?,reason_code=?,due_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,lease_run_id=NULL,updated_at=? WHERE item_id=?").run(state, reason, this.now() + definition.budgets.retryBaseMs, this.now(), row.item_id!);
        this.log(String(row.lease_run_id), String(row.item_id), "lease-recovered", { state, reason }); }
      return { recovered: rows.length, remainingExpired: Number(this.db.prepare("SELECT COUNT(*) AS count FROM job_items WHERE state='leased' AND lease_until<=?").get(this.now())?.count ?? 0) }; });
  }
  claim(workerId: string, jobId?: string, healthRunId?: string): JobClaim | null { referenceInputSchema.shape.subjectRef.parse(workerId); this.recoverExpired();
    return this.tx(() => { const query = `SELECT i.* FROM job_items i WHERE i.state IN ('queued','retryWait') AND i.due_at<=?
      AND EXISTS(SELECT 1 FROM job_run_items dispatch_item INNER JOIN job_runs dispatch_run ON dispatch_run.run_id=dispatch_item.run_id WHERE dispatch_item.item_id=i.item_id AND dispatch_run.control='active')
      AND EXISTS(SELECT 1 FROM job_definitions def WHERE def.job_id=i.job_id AND def.version=i.job_version
        AND (json_extract(def.body,'$.handler')='probe-provider-health.v1')=?)
      ${jobId ? "AND i.job_id=?" : ""} ${healthRunId ? "AND EXISTS(SELECT 1 FROM job_run_items jr WHERE jr.item_id=i.item_id AND jr.run_id=?)" : ""} ORDER BY i.created_at,i.item_id LIMIT 100`;
      const candidates = this.db.prepare(query).all(this.now(), healthRunId ? 1 : 0, ...(jobId ? [jobId] : []), ...(healthRunId ? [healthRunId] : []));
      for (const row of candidates) { const run = this.activeRun(String(row.item_id)); if (!run) continue; const runId = String(run.run_id); const { definition } = this.definition(String(row.job_id), Number(row.job_version));
        const reason = this.currentReason(row) ?? this.capabilityReason(definition);
        if (reason) { this.db.prepare("UPDATE job_items SET state='held',reason_code=?,updated_at=? WHERE item_id=?").run(reason, this.now(), row.item_id!); this.log(runId, String(row.item_id), "held", { reason }); continue; }
        const startedAt = run.started_at === null ? this.now() : Number(run.started_at);
        const budgetReason = this.now() - startedAt >= definition.budgets.maxRunMs ? "RUN_TIME_BUDGET" : this.steps(runId) >= definition.budgets.maxSteps ? "RUN_STEP_BUDGET" : Number(row.attempts) >= definition.budgets.maxAttempts ? "ATTEMPT_LIMIT" : null;
        if (budgetReason) { this.db.prepare("UPDATE job_items SET state='failed',reason_code=?,updated_at=? WHERE item_id=?").run(budgetReason, this.now(), row.item_id!); this.log(runId, String(row.item_id), "failed", { reason: budgetReason }); continue; }
        if (Number(this.db.prepare("SELECT COUNT(*) AS count FROM job_items WHERE job_id=? AND state='leased' AND lease_until>?").get(row.job_id!, this.now())?.count) >= definition.budgets.maxConcurrency) continue;
        const binding = definition.capabilityBinding; const resource = binding ? digest({ provider: binding.provider, account: binding.providerAccountId, action: binding.action }) : null;
        if (resource) { this.db.prepare("DELETE FROM job_resource_leases WHERE resource_key=? AND lease_until<=?").run(resource, this.now()); if (this.db.prepare("SELECT 1 FROM job_resource_leases WHERE resource_key=?").get(resource)) continue; }
        const token = randomUUID(); const expiresAt = Math.min(this.now() + definition.budgets.leaseMs, startedAt + definition.budgets.maxRunMs);
        this.db.prepare("UPDATE job_runs SET started_at=COALESCE(started_at,?),activation_ref=COALESCE(activation_ref,?) WHERE run_id=?").run(startedAt, this.head(String(row.job_id)).activation_ref!, runId);
        this.db.prepare("UPDATE job_items SET state='leased',attempts=attempts+1,steps=steps+1,lease_token=?,lease_owner=?,lease_until=?,lease_run_id=?,reason_code=NULL,last_token_hash=NULL,last_outcome_hash=NULL,updated_at=? WHERE item_id=?").run(token, workerId, expiresAt, runId, this.now(), row.item_id!);
        if (resource) this.db.prepare("INSERT INTO job_resource_leases VALUES(?,?,?,?)").run(resource, row.item_id!, token, expiresAt);
        this.log(runId, String(row.item_id), "leased", { ownerRef: workerId, expiresAt: iso(expiresAt), attempt: Number(row.attempts) + 1 });
        return { runId, item: this.viewItem(this.itemRow(String(row.item_id))), definition, leaseToken: token };
      } return null; });
  }
  private leased(itemId: string, token: string): Row { const row = this.itemRow(itemId); if (row.state !== "leased" || row.lease_token !== token || Number(row.lease_until) <= this.now()) throw new JobConflict("JOB_LEASE_FENCED"); return row; }
  checkpoint(itemId: string, token: string, expectedVersion: number, input: unknown) { const data = checkpointSchema.parse(input);
    return this.tx(() => { const row = this.leased(itemId, token); if (Number(row.checkpoint_version) === expectedVersion + 1 && digest(parse(row.checkpoint)) === digest(data)) return this.viewItem(row);
      if (row.checkpoint_version !== expectedVersion) throw new JobConflict("CHECKPOINT_VERSION_CONFLICT"); const { definition } = this.definition(String(row.job_id), Number(row.job_version));
      if (this.steps(String(row.lease_run_id)) >= definition.budgets.maxSteps) throw new JobConflict("RUN_STEP_BUDGET");
      this.db.prepare("UPDATE job_items SET checkpoint=?,checkpoint_version=checkpoint_version+1,steps=steps+1,updated_at=? WHERE item_id=?").run(JSON.stringify(data), this.now(), itemId);
      this.log(String(row.lease_run_id), itemId, "checkpoint", { version: expectedVersion + 1 }); return this.viewItem(this.itemRow(itemId)); });
  }
  complete(itemId: string, token: string, input: unknown, persistHealthObservation?: () => void) { const result = localResultSchema.parse(input); const outcomeHash = digest({ operation: "complete", result });
    return this.tx(() => { const current = this.itemRow(itemId); if (current.last_token_hash === digest(token) && current.last_outcome_hash === outcomeHash) return this.viewItem(current);
      const row = this.leased(itemId, token); const { definition } = this.definition(String(row.job_id), Number(row.job_version));
      if (this.currentReason(row, true) || this.capabilityReason(definition)) throw new JobConflict("JOB_PREFLIGHT_HELD");
      if ((definition.mode === "observe") !== (result.kind === "reference-recorded") || (definition.handler === "probe-provider-health.v1") !== Boolean(persistHealthObservation)) throw new JobConflict("JOB_HANDLER_RESULT_MISMATCH");
      if (persistHealthObservation) {
        if (this.db.prepare("SELECT control FROM job_runs WHERE run_id=?").get(String(row.lease_run_id))?.control !== "active" || this.currentReason(row)) throw new JobConflict("JOB_PREFLIGHT_HELD");
        persistHealthObservation();
      }
      this.release(row);
      this.db.prepare("UPDATE job_items SET state='completed',result=?,reason_code=NULL,lease_token=NULL,lease_owner=NULL,lease_until=NULL,lease_run_id=NULL,last_token_hash=?,last_outcome_hash=?,updated_at=? WHERE item_id=?").run(JSON.stringify(result), digest(token), outcomeHash, this.now(), itemId);
      this.log(String(row.lease_run_id), itemId, "completed", { result }); return this.viewItem(this.itemRow(itemId)); });
  }
  fail(itemId: string, token: string, input: unknown) { const failure = failureSchema.parse(input); const outcomeHash = digest({ operation: "fail", failure });
    return this.tx(() => { const current = this.itemRow(itemId); if (current.last_token_hash === digest(token) && current.last_outcome_hash === outcomeHash) return this.viewItem(current);
      const row = this.leased(itemId, token); const { definition } = this.definition(String(row.job_id), Number(row.job_version));
      const state = failure.certainty === "uncertain" ? "reconcile" : failure.retryable && Number(row.attempts) < definition.budgets.maxAttempts ? "retryWait" : "failed";
      const delay = Math.max(failure.retryAfterMs, definition.budgets.retryBaseMs * 2 ** Math.max(0, Number(row.attempts) - 1)); this.release(row);
      this.db.prepare("UPDATE job_items SET state=?,reason_code=?,due_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL,lease_run_id=NULL,last_token_hash=?,last_outcome_hash=?,updated_at=? WHERE item_id=?").run(state, failure.reasonCode, this.now() + delay, digest(token), outcomeHash, this.now(), itemId);
      this.log(String(row.lease_run_id), itemId, "failed-attempt", { state, ...failure }); return this.viewItem(this.itemRow(itemId)); });
  }
  controlRun(runId: string, command: "pause" | "resume" | "cancel") { if (!["pause", "resume", "cancel"].includes(command)) throw new JobConflict("INVALID_RUN_CONTROL");
    return this.tx(() => { const run = this.db.prepare("SELECT * FROM job_runs WHERE run_id=?").get(runId); if (!run) throw new JobConflict("JOB_RUN_NOT_FOUND"); if (run.control === "cancelled" && command !== "cancel") throw new JobConflict("RUN_CANCELLED");
      this.db.prepare("UPDATE job_runs SET control=? WHERE run_id=?").run(command === "pause" ? "paused" : command === "cancel" ? "cancelled" : "active", runId);
      const rows = this.db.prepare("SELECT i.* FROM job_items i INNER JOIN job_run_items j ON j.item_id=i.item_id WHERE j.run_id=?").all(runId);
      for (const row of rows) { if (command === "resume" && row.state === "held") this.db.prepare("UPDATE job_items SET state='queued',reason_code=NULL,updated_at=? WHERE item_id=?").run(this.now(), row.item_id!);
        if (command === "cancel" && !terminal.has(String(row.state)) && row.state !== "leased" && !this.uncancelledRun(String(row.item_id))) { this.db.prepare("UPDATE job_items SET state='cancelled',reason_code='RUN_CANCELLED',updated_at=? WHERE item_id=?").run(this.now(), row.item_id!); this.log(runId, String(row.item_id), "cancelled"); } }
      this.log(runId, null, command); return this.getRun(runId); });
  }
  processOne(workerId: string, jobId?: string) { const claim = this.claim(workerId, jobId); if (!claim) return null;
    const result: LocalResult = { schemaVersion: "job-local-result.v1", kind: claim.definition.mode === "observe" ? "reference-recorded" : "proposal-recorded", artifactRef: `job-artifact:${claim.item.itemId}`, sourceEffect: "none" };
    const item = this.complete(claim.item.itemId, claim.leaseToken, result); return { runId: claim.runId, item }; }
  getRun(runId: string): JobRunView { const run = this.db.prepare("SELECT * FROM job_runs WHERE run_id=?").get(runId); if (!run) throw new JobConflict("JOB_RUN_NOT_FOUND");
    const definition = jobDefinitionSchema.parse(parse(run.definition)); const head = this.head(String(run.job_id)); const rows = this.db.prepare("SELECT i.*,j.reused FROM job_items i INNER JOIN job_run_items j ON j.item_id=i.item_id WHERE j.run_id=? ORDER BY i.created_at,i.item_id").all(runId);
    const count = (state: string) => rows.filter((row) => row.state === state).length; const due = rows.filter((row) => ["queued", "retryWait"].includes(String(row.state)) && Number(row.due_at) <= this.now()).length;
    const counts = { total: rows.length, due, deferred: rows.filter((row) => row.state === "retryWait" && Number(row.due_at) > this.now()).length, leased: count("leased"), held: count("held"), completed: count("completed"), cancelled: count("cancelled"), failed: count("failed"), reconcile: count("reconcile"), reused: rows.filter((row) => row.reused).length };
    const enabled = Boolean(head.enabled) && head.version === run.job_version && head.activation_hash === run.definition_hash;
    const blockerCodes = [...new Set([...(enabled ? [] : ["JOB_DISABLED_OR_STALE"]), ...rows.flatMap((row) => row.reason_code ? [String(row.reason_code)] : [])])];
    const control = String(run.control); const state = counts.reconcile ? "reconcile" : control === "cancelled" ? counts.leased ? "cancelling" : "cancelled" : counts.completed === rows.length ? rows.length ? "completed" : "empty" : control === "paused" || head.paused ? "paused" : counts.leased ? "running" : counts.failed === rows.length ? "failed" : counts.failed + counts.cancelled > 0 ? "partial" : !enabled || counts.held ? "held" : counts.deferred && !due ? "deferred" : "queued";
    return jobRunViewSchema.parse({ schemaVersion: "farda.jobs.v1", environment: this.options.scope.environment, runId, jobId: run.job_id, eventId: run.event_id, eventAt: run.event_at, observedAt: iso(run.observed_at), definition, definitionHash: run.definition_hash, enabled,
      activationRef: run.activation_ref === null ? null : String(run.activation_ref), control, state, counts, blockerCodes, nextAction: state === "reconcile" ? "Reconcile uncertainty; do not retry automatically." : state === "held" ? "Resolve the registration, policy or capability hold." : state === "deferred" ? "Wait for the due time before the next bounded claim." : "Read the per-item state; no source executor is registered.",
      items: rows.map((row) => this.viewItem(row)), usage: { workSteps: this.steps(runId), externalCalls: definition.handler === "probe-provider-health.v1" && rows.some((row) => Number(row.attempts) > 0) ? null : 0, modelCalls: 0, sourceQuota: definition.handler === "probe-provider-health.v1" ? "unknown" : "notApplicable", zapierTasks: "unknown", runtimeCost: "unknown" } });
  }
  history(runId: string, limit = 100) { this.getRun(runId); if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new JobConflict("INVALID_HISTORY_LIMIT"); const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM job_transitions WHERE run_id=?").get(runId)?.count ?? 0);
    return { total, partial: total > limit, transitions: this.db.prepare("SELECT * FROM job_transitions WHERE run_id=? ORDER BY at,transition_id LIMIT ?").all(runId, limit).map((row) => ({ transitionId: row.transition_id, itemId: row.item_id, kind: row.kind, at: iso(row.at), detail: parse(row.detail) })) }; }
}
