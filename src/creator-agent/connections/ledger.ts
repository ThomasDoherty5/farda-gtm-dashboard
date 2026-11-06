import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseType } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  CAPABILITY_SCHEMA_VERSION, MAX_VERIFICATION_AGE_MS, capabilityRecordSchema, capabilityScopeSchema,
  capabilityViewSchema, expectedBindingSchema, receiptRefSchema, registrationSchema,
  unknownBusinessEligibility, unknownSourceFreshness, verificationReceiptSchema,
  type CapabilityReadiness, type CapabilityRecord, type CapabilityRegistration, type CapabilityScope,
  type CapabilityView, type ExpectedBinding, type ReceiptResolver, type VerificationReceipt,
} from "./schema.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = (input: ExpectedBinding) => { const binding = expectedBindingSchema.parse(input); return { ...binding, requiredScopes: [...binding.requiredScopes].sort() }; };
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const sameScope = (a: CapabilityScope, b: CapabilityScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId && a.environment === b.environment;
const reasons = (...codes: string[][]) => [...new Set(codes.flat())].slice(0, 30);
export class CapabilityConflict extends Error {}

/** Stable slot: changing the source account or permission context invalidates this slot's verification. */
export function capabilityIdForBinding(input: ExpectedBinding) {
  const b = normalized(input);
  return digest({ workspaceId: b.workspaceId, accountId: b.accountId, environment: b.environment, provider: b.provider, action: b.action, mode: b.mode, route: b.route, routeRef: b.routeRef });
}

/** Local durable facts only. This module never resolves credentials, calls providers or dispatches work. */
export class CapabilityLedger {
  private db: DatabaseType;
  private ownsDatabase: boolean;
  private closed = false;
  private scope: CapabilityScope;
  private now: () => number;
  private resolveReceipt?: ReceiptResolver;
  private healthHold?: (binding: ExpectedBinding) => string | null;

  constructor(database: string | DatabaseType, scope: CapabilityScope, options: { now?: () => number; resolveReceipt?: ReceiptResolver } = {}) {
    this.scope = capabilityScopeSchema.parse(scope);
    this.now = options.now ?? Date.now;
    this.resolveReceipt = options.resolveReceipt;
    this.ownsDatabase = typeof database === "string";
    this.db = typeof database === "string" ? new DatabaseSync(database) : database;
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
      // Sharing the agent file cannot cross its existing internal workspace/account boundary.
      if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_scope'").get()) {
        const existing = this.db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
        if (existing && (existing.workspace_id !== scope.workspaceId || existing.account_id !== scope.accountId)) throw new CapabilityConflict("CAPABILITY_SCOPE_MISMATCH");
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS capability_meta (id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO capability_meta VALUES(1,1);
        CREATE TABLE IF NOT EXISTS capability_scope (id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,environment TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS capability_events (event_id TEXT NOT NULL UNIQUE,capability_id TEXT NOT NULL,revision INTEGER NOT NULL,recorded_at TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(capability_id,revision));`);
      this.db.prepare("INSERT OR IGNORE INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId, scope.accountId, scope.environment);
      const persisted = this.db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
      if (persisted?.workspace_id !== scope.workspaceId || persisted.account_id !== scope.accountId || persisted.environment !== scope.environment) throw new CapabilityConflict("CAPABILITY_SCOPE_MISMATCH");
      if (this.db.prepare("SELECT version FROM capability_meta WHERE id=1").get()?.version !== 1) throw new CapabilityConflict("UNSUPPORTED_CAPABILITY_STORAGE_SCHEMA");
    } catch (error) { if (this.ownsDatabase) this.db.close(); throw error; }
  }

  private timestamp() { const value = this.now(); if (!Number.isSafeInteger(value) || value < 0) throw new Error("INVALID_CAPABILITY_CLOCK"); return new Date(value).toISOString(); }
  private latest(id: string): CapabilityRecord | null {
    const row = this.db.prepare("SELECT body FROM capability_events WHERE capability_id=? ORDER BY revision DESC LIMIT 1").get(id);
    return row ? capabilityRecordSchema.parse(JSON.parse(String(row.body))) : null;
  }
  private expected(id: string, revision: number) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new CapabilityConflict("INVALID_CAPABILITY_REVISION");
    const current = this.latest(id);
    if ((current?.revision ?? 0) !== revision) throw new CapabilityConflict("CAPABILITY_VERSION_CONFLICT");
    return current;
  }
  private append(id: string, expectedRevision: number, build: (current: CapabilityRecord | null, at: string) => CapabilityRecord): CapabilityRecord {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.expected(id, expectedRevision);
      const record = capabilityRecordSchema.parse(build(current, this.timestamp()));
      if (record.capabilityId !== id || record.revision !== expectedRevision + 1) throw new Error("INVALID_CAPABILITY_EVENT");
      this.db.prepare("INSERT INTO capability_events VALUES(?,?,?,?,?)").run(randomUUID(), id, record.revision, record.recordedAt, JSON.stringify(record));
      this.db.exec("COMMIT");
      return record;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  register(input: CapabilityRegistration, expectedRevision: number): CapabilityView {
    const registration = registrationSchema.parse(input);
    registration.binding = normalized(registration.binding);
    if (!sameScope(registration.binding, this.scope)) throw new CapabilityConflict("CAPABILITY_SCOPE_MISMATCH");
    const id = capabilityIdForBinding(registration.binding);
    return this.view(this.append(id, expectedRevision, (current, at) => ({
      schemaVersion: CAPABILITY_SCHEMA_VERSION, capabilityId: id, revision: expectedRevision + 1,
      registration, observedState: current?.revokedAt ? "Denied" : "Unverified",
      checkedAt: null, expiresAt: null, receiptRef: null, recordedAt: at, revokedAt: current?.revokedAt ?? null,
      verifiedScopes: [], connectionHealth: "Unknown", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(),
      reasonCodes: reasons(current?.revokedAt ? ["REVOKED"] : [], [current ? "BINDING_CHANGED" : "NOT_VERIFIED"]),
    })));
  }

  async verify(id: string, requestedReceipt: string, expectedRevision: number): Promise<CapabilityView> {
    const receiptRef = receiptRefSchema.parse(requestedReceipt);
    if (!this.expected(id, expectedRevision)) throw new CapabilityConflict("CAPABILITY_NOT_FOUND");
    let proof: VerificationReceipt | null = null;
    let unavailable = this.resolveReceipt ? "RECEIPT_NOT_FOUND" : "VERIFIER_NOT_CONFIGURED";
    if (this.resolveReceipt) {
      try {
        const resolved = await this.resolveReceipt(receiptRef);
        if (resolved !== null) {
          const parsed = verificationReceiptSchema.safeParse(resolved);
          if (parsed.success) proof = parsed.data;
          else unavailable = "INVALID_VERIFICATION_RECEIPT";
        }
      } catch { unavailable = "VERIFIER_UNAVAILABLE"; }
    }
    // Recheck inside the write transaction: a concurrent revoke/rebind cannot be overwritten after await.
    return this.view(this.append(id, expectedRevision, (current, at) => {
      if (!current) throw new CapabilityConflict("CAPABILITY_NOT_FOUND");
      const base = { ...current, revision: expectedRevision + 1, recordedAt: at };
      const failed = (code: string, state: CapabilityRecord["observedState"] = "Unverified"): CapabilityRecord => ({
        ...base, observedState: current.revokedAt ? "Denied" : state, checkedAt: null, expiresAt: null, receiptRef: null,
        verifiedScopes: [], connectionHealth: "Unknown", sourceFreshness: unknownSourceFreshness(), businessEligibility: unknownBusinessEligibility(),
        reasonCodes: reasons(current.revokedAt ? ["REVOKED"] : [], [code]),
      });
      if (!proof) return failed(unavailable);
      if (proof.receiptRef !== receiptRef) return failed("VERIFICATION_REFERENCE_MISMATCH");
      const binding = normalized(proof.binding);
      const expected = current.registration.binding;
      if (!sameScope(binding, this.scope) || binding.providerAccountId !== expected.providerAccountId || capabilityIdForBinding(binding) !== id) return failed("VERIFICATION_IDENTITY_MISMATCH", "Denied");
      if (!same(binding, expected)) return failed("VERIFICATION_BINDING_STALE");
      const checked = Date.parse(proof.checkedAt);
      const now = Date.parse(at);
      if (checked > now) return failed("VERIFICATION_TIME_IN_FUTURE");
      if (now - checked >= MAX_VERIFICATION_AGE_MS) return failed("VERIFICATION_STALE");
      if (current.revokedAt && checked <= Date.parse(current.revokedAt)) return failed("REVERIFICATION_REQUIRED", "Denied");
      if (proof.expiresAt !== null && (Date.parse(proof.expiresAt) <= checked || Date.parse(proof.expiresAt) > checked + MAX_VERIFICATION_AGE_MS)) return failed("INVALID_VERIFICATION_EXPIRY");
      if (proof.expiresAt !== null && Date.parse(proof.expiresAt) <= now) return failed("VERIFICATION_EXPIRED");
      if (proof.outcome === "Ready") {
        if (!proof.expiresAt) return failed("VERIFICATION_EXPIRY_REQUIRED");
        if (proof.connectionHealth !== "Authenticated") return failed("AUTHENTICATION_UNVERIFIED");
        if (expected.requiredScopes.some((scope) => !proof!.verifiedScopes.includes(scope))) return failed("REQUIRED_SCOPE_MISSING", "Denied");
      }
      return { ...base, observedState: proof.outcome, checkedAt: proof.checkedAt, expiresAt: proof.expiresAt, receiptRef,
        revokedAt: proof.outcome === "Ready" ? null : current.revokedAt,
        verifiedScopes: proof.verifiedScopes, connectionHealth: proof.connectionHealth, sourceFreshness: proof.sourceFreshness, businessEligibility: proof.businessEligibility,
        reasonCodes: reasons(current.revokedAt && proof.outcome !== "Ready" ? ["REVOKED"] : [], proof.reasonCodes, [proof.outcome === "Ready" ? "ACTION_VERIFIED" : "ACTION_NOT_READY"]),
      };
    }));
  }

  revoke(id: string, reasonCode: string, expectedRevision: number): CapabilityView {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) throw new Error("INVALID_CAPABILITY_REASON");
    return this.view(this.append(id, expectedRevision, (current, at) => {
      if (!current) throw new CapabilityConflict("CAPABILITY_NOT_FOUND");
      return { ...current, revision: expectedRevision + 1, recordedAt: at, observedState: "Denied", revokedAt: at,
        connectionHealth: "Denied", reasonCodes: reasons(["REVOKED", reasonCode], current.reasonCodes) };
    }));
  }

  private view(record: CapabilityRecord): CapabilityView {
    const now = Date.parse(this.timestamp());
    const fresh = record.checkedAt !== null && Date.parse(record.checkedAt) <= now && now - Date.parse(record.checkedAt) < MAX_VERIFICATION_AGE_MS && (record.expiresAt === null || Date.parse(record.expiresAt) > now);
    const complete = record.receiptRef !== null && record.checkedAt !== null && record.expiresAt !== null;
    const state = record.revokedAt ? "Denied" : record.observedState === "Ready" && (!fresh || !complete) ? "Unverified" : record.observedState;
    const { secretRef, connectionRef, ...binding } = record.registration.binding;
    return capabilityViewSchema.parse({ ...record, registration: { ...record.registration, binding,
      hasCredentialReference: secretRef !== null, hasConnectionReference: connectionRef !== null },
      state, fresh,
      recovery: state === "Ready" ? "none" : record.revokedAt || state === "Denied" ? "reviewPermission" : record.checkedAt ? "reverify" : "configureRoute",
      reasonCodes: reasons(state !== record.observedState ? ["VERIFICATION_EXPIRED"] : [], record.reasonCodes),
    });
  }
  get(id: string): CapabilityView | null { const record = this.latest(id); return record ? this.view(record) : null; }
  matchesBinding(input: ExpectedBinding): boolean {
    const binding = normalized(input);
    const record = this.latest(capabilityIdForBinding(binding));
    return !!record && sameScope(binding, this.scope) && same(record.registration.binding, binding);
  }
  hasDeniedActionRoute(binding: CapabilityScope & Pick<ExpectedBinding,"provider"|"providerAccountId"|"action">): boolean {
    if (!sameScope(binding,this.scope)) return true;
    // A revocation on this native account/action cannot be bypassed by swapping transports.
    return Boolean(this.db.prepare(`SELECT 1 FROM capability_events e WHERE e.revision=(
      SELECT MAX(other.revision) FROM capability_events other WHERE other.capability_id=e.capability_id)
      AND json_extract(e.body,'$.registration.binding.provider')=? AND json_extract(e.body,'$.registration.binding.providerAccountId')=?
      AND json_extract(e.body,'$.registration.binding.action')=? AND (json_extract(e.body,'$.revokedAt') IS NOT NULL
      OR json_extract(e.body,'$.observedState')='Denied') LIMIT 1`).get(binding.provider,binding.providerAccountId,binding.action));
  }
  list(limit = 100): { records: CapabilityView[]; total: number; partial: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_CAPABILITY_LIMIT");
    const total = Number(this.db.prepare("SELECT COUNT(DISTINCT capability_id) AS total FROM capability_events").get()?.total ?? 0);
    const rows = this.db.prepare(`SELECT e.body FROM capability_events e INNER JOIN
      (SELECT capability_id,MAX(revision) AS revision FROM capability_events GROUP BY capability_id) current
      ON e.capability_id=current.capability_id AND e.revision=current.revision ORDER BY e.capability_id LIMIT ?`).all(limit);
    return { records: rows.map((row) => this.view(capabilityRecordSchema.parse(JSON.parse(String(row.body))))), total, partial: total > rows.length };
  }
  history(id: string, limit = 100): CapabilityView[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_CAPABILITY_LIMIT");
    return this.db.prepare("SELECT body FROM capability_events WHERE capability_id=? ORDER BY revision LIMIT ?").all(id, limit).map((row) => this.view(capabilityRecordSchema.parse(JSON.parse(String(row.body)))));
  }
  historyPage(id: string, limit = 100): { records: CapabilityView[]; total: number; partial: boolean } {
    const records = this.history(id, limit);
    const total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM capability_events WHERE capability_id=?").get(id)?.count ?? 0);
    return { records, total, partial: total > records.length };
  }

  /** Permission preflight only: source data freshness, business approval, budget and source execution remain separate. */
  setHealthHold(check: (binding: ExpectedBinding) => string | null) { this.healthHold = check; }
  requireReady(input: ExpectedBinding): CapabilityReadiness {
    const unavailable = (state: CapabilityReadiness["state"], reason: string, capabilityId: string | null = null): CapabilityReadiness => ({ allowed: false, state, reasonCodes: [reason], capabilityId, revision: null, checkedAt: null, expiresAt: null, receiptRef: null, ownerRef: null, recovery: "configureRoute" });
    const parsed = expectedBindingSchema.safeParse(input);
    if (!parsed.success) return unavailable("Unverified", "INVALID_CAPABILITY_BINDING");
    const expected = normalized(parsed.data);
    if (!sameScope(expected, this.scope)) return unavailable("Denied", "CAPABILITY_SCOPE_MISMATCH");
    const id = capabilityIdForBinding(expected);
    const record = this.latest(id);
    if (!record) return unavailable("Unverified", "CAPABILITY_NOT_REGISTERED", id);
    if (record.registration.binding.providerAccountId !== expected.providerAccountId) return { ...unavailable("Denied", "CAPABILITY_ACCOUNT_MISMATCH", id), revision: record.revision, ownerRef: record.registration.ownerRef, recovery: "reviewPermission" };
    if (!same(record.registration.binding, expected)) return { ...unavailable("Unverified", "CAPABILITY_BINDING_STALE", id), revision: record.revision, ownerRef: record.registration.ownerRef, recovery: "reverify" };
    const view = this.view(record);
    const hold = this.healthHold?.(expected);
    if (hold && view.state === "Ready") return { ...unavailable("Unverified", hold, id), revision: record.revision, ownerRef: record.registration.ownerRef, recovery: "reverify" };
    return { allowed: view.state === "Ready" && view.fresh, state: view.state, reasonCodes: view.reasonCodes,
      capabilityId: id, revision: record.revision, checkedAt: record.checkedAt, expiresAt: record.expiresAt,
      receiptRef: record.receiptRef, ownerRef: record.registration.ownerRef, recovery: view.recovery };
  }
  close() { if (this.closed) return; this.closed = true; if (this.ownsDatabase) this.db.close(); }
}
