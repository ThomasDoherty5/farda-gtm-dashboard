import { createHash, createHmac, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { JobRepository, type JobClaim } from "../jobs/repository.ts";
import { nativeReadinessViewSchema, readinessRecoveryIntentSchema, readinessPublicReceiptSchema, readinessRequestRecoverySchema, type ReadinessRequestRecovery } from "./views.ts";
import { ActionServiceError, exportPayloadSchema, exportReceiptSchema, ledgerPageSchema, ledgerSnapshotSchema,
  principalGrantSchema, readinessIntentSchema, readinessLookupSchema, readinessPayloadSchema, readinessReceiptSchema, readinessSnapshotSchema, reference,
  type ActionPrincipal, type ActionPrincipalAuthority, type ActionAuthorityFence, type ActionScope, type ExportPayload, type ExportReceipt, type LedgerSnapshot, type LedgerSource,
  type PrincipalGrant, type ReadinessIntent, type ReadinessPayload, type ReadinessReceipt, type ReadinessSnapshot, type ReadinessSource } from "./contract.ts";

type Options = { db: DatabaseSync; scope: ActionScope; secret: string; authorize?: ActionPrincipalAuthority;
  assertAuthority?: ActionAuthorityFence;
  ledger?: LedgerSource; readiness?: ReadinessSource; jobs?: JobRepository; now?: () => number };
type Request = { hash: string; state: string; intent: string; receipt: string | null; createdAt: number };
function fail(code: string, status = 409, certainty: "notApplied" | "applied" | "uncertain" = "notApplied"): never { throw new ActionServiceError(code, status, certainty); }
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const csvCell = (value: string | number | null) => {
  const raw = value === null ? "" : String(value);
  let start = 0; while (start < raw.length && (raw.charCodeAt(start) <= 31 || /\s/.test(raw[start]!))) start++;
  const safe = typeof value === "string" && "=+@-".includes(raw[start] ?? " ") ? "'" + raw : raw;
  return /[",\r\n]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
};

/** Source-owned reporting effects only. Neither an export nor a readiness record can release business execution. */
export function createActionDomainServices(options: Options) {
  const { db, scope, secret, ledger, readiness } = options, now = options.now ?? Date.now;
  const jobs = options.jobs ?? new JobRepository(db, { scope, now });
  const bound = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if (!bound || bound.workspace_id !== scope.workspaceId || bound.account_id !== scope.accountId || scope.environment !== "sandbox" || secret.length < 32)
    throw new ActionServiceError("ACTION_SCOPE_DENIED", 403);
  db.exec(`CREATE TABLE IF NOT EXISTS action_domain_requests(key TEXT PRIMARY KEY,actor TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL,
      hash TEXT NOT NULL,state TEXT NOT NULL,intent TEXT NOT NULL,receipt TEXT,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS action_export_artifacts(ref TEXT PRIMARY KEY,request_key TEXT NOT NULL,snapshot TEXT NOT NULL,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS action_domain_source_versions(kind TEXT NOT NULL,target TEXT NOT NULL,version TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(kind,target,version));
    CREATE TABLE IF NOT EXISTS action_domain_source_heads(kind TEXT NOT NULL,target TEXT NOT NULL,version TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(kind,target));`);
  db.exec("CREATE TABLE IF NOT EXISTS action_readiness_view_refs(ref TEXT PRIMARY KEY,actor TEXT NOT NULL,target_ref TEXT NOT NULL,snapshot TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS action_readiness_terminal_receipts(request_key TEXT PRIMARY KEY,proof TEXT NOT NULL)");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify([scope, kind, value])).digest("hex").slice(0, 40);
  const keyOf = (kind: string, actor: ActionPrincipal, key: string) => alias("request", JSON.stringify([kind, actor.principalRef, reference.parse(key)]));
  const time = () => { const t = now(); if (!Number.isFinite(t)) fail("INVALID_CLOCK", 500); return t; };
  const iso = () => new Date(time()).toISOString();
  function tx<T>(fn: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const value = fn(); db.exec("COMMIT"); return value; } catch (e) { db.exec("ROLLBACK"); throw e; } }
  function request(key: string): Request | null {
    const r = db.prepare("SELECT hash,state,intent,receipt,created_at FROM action_domain_requests WHERE key=?").get(key);
    return r ? { hash: String(r.hash), state: String(r.state), intent: String(r.intent), receipt: r.receipt === null ? null : String(r.receipt), createdAt: Number(r.created_at) } : null;
  }
  function currentGrant(g: PrincipalGrant, actor: ActionPrincipal, role: "export" | "readiness") {
    if (!same(g.scope, scope) || g.principalRef !== actor.principalRef || !g.active || Date.parse(g.observedAt) > time() || Date.parse(g.validUntil) <= time() || Date.parse(g.observedAt) >= Date.parse(g.validUntil)) fail("AUTHORITY_REQUIRED", 403);
    if (!(role === "readiness" ? g.roles.includes("founder") : g.roles.includes("founder") || g.roles.includes("finance"))) fail("AUTHORITY_REQUIRED", 403);
    if (!options.assertAuthority) fail("ACTOR_AUTHORITY_FENCE_UNCONFIGURED", 403);
    try { options.assertAuthority({ scope, actor: g, slack: null, linearRecords: [] }, time()); }
    catch { fail("AUTHORITY_REQUIRED", 403); }
  }
  async function authorize(actor: ActionPrincipal, role: "export" | "readiness") {
    reference.parse(actor.principalRef);
    if (!options.authorize) fail("NAMED_ACTOR_UNCONFIGURED", 403);
    const grant = principalGrantSchema.safeParse(await options.authorize(actor.principalRef, scope));
    if (!grant.success) fail("ACTOR_PROOF_INVALID", 403);
    currentGrant(grant.data, actor, role); return grant.data;
  }
  function rethrow(e: unknown, key: string): never {
    const r = request(key), certainty = r?.state === "applied" || r?.state === "acknowledged" ? "applied" : r?.state === "pending" ? "uncertain" : "notApplied";
    if (e instanceof ActionServiceError) throw new ActionServiceError(e.code, e.status, certainty, e.currentVersion);
    throw new ActionServiceError(certainty === "uncertain" ? "OUTCOME_UNCERTAIN" : "SOURCE_UNAVAILABLE", 502, certainty);
  }
  function observe(kind: string, target: string, version: string, observedAt: string, facts: unknown) {
    const at = Date.parse(observedAt); if (!Number.isFinite(at) || at > time()) fail("SOURCE_INVALID", 502);
    tx(() => {
      const hash = digest(facts), prior = db.prepare("SELECT hash FROM action_domain_source_versions WHERE kind=? AND target=? AND version=?").get(kind, target, version);
      if (prior && prior.hash !== hash) fail("SOURCE_VERSION_CONFLICT");
      const head = db.prepare("SELECT version,observed_at FROM action_domain_source_heads WHERE kind=? AND target=?").get(kind, target);
      if (head && (Number(head.observed_at) > at || Number(head.observed_at) === at && head.version !== version)) fail("SOURCE_REGRESSED");
      db.prepare("INSERT OR IGNORE INTO action_domain_source_versions VALUES(?,?,?,?)").run(kind, target, version, hash);
      db.prepare("INSERT INTO action_domain_source_heads VALUES(?,?,?,?) ON CONFLICT(kind,target) DO UPDATE SET version=excluded.version,observed_at=excluded.observed_at").run(kind, target, version, at);
    });
  }
  function headCurrent(kind: string, target: string, version: string) {
    if (db.prepare("SELECT version FROM action_domain_source_heads WHERE kind=? AND target=?").get(kind, target)?.version !== version) fail("SOURCE_CHANGED");
  }
  function snapshot(raw: unknown, payload: ExportPayload): LedgerSnapshot {
    const parsed = ledgerSnapshotSchema.safeParse(raw); if (!parsed.success) fail("EXPORT_SOURCE_INVALID", 502);
    const s = parsed.data;
    if (!same(s.scope, scope) || !same(s.filters, payload.filters)) fail("SOURCE_SCOPE_DENIED", 403);
    if (Date.parse(s.asOf) > time() || Date.parse(s.validUntil) <= time() || Date.parse(s.asOf) >= Date.parse(s.validUntil)) fail("SOURCE_STALE");
    return s;
  }
  async function exportLedger(raw: unknown, expectedVersion: string, actor: ActionPrincipal, idempotencyKey: string): Promise<ExportReceipt> {
    const payload = exportPayloadSchema.parse(raw), key = keyOf("ledger-export", actor, idempotencyKey), hash = digest([scope, actor, payload, expectedVersion]);
    let claimed = false, jobClaim: JobClaim | null = null;
    try {
      const initialGrant = await authorize(actor, "export");
      if (!ledger || typeof ledger.assertCurrent !== "function") fail("EXPORT_SOURCE_UNCONFIGURED", 409);
      const old = request(key);
      if (old && old.hash !== hash) fail("MANIFEST_CHANGED");
      if (old?.state === "applied" && old.receipt) {
        const receipt = exportReceiptSchema.parse(JSON.parse(old.receipt)); await downloadExport(receipt.artifactRef, actor); return receipt;
      }
      if (old && old.state !== "rejected") fail("EXPORT_RECONCILIATION_REQUIRED", 409);
      const s = snapshot(await ledger.open(scope, actor, payload.filters), payload);
      if (expectedVersion !== s.version) fail("STALE_VERSION");
      tx(() => {
        const prior = request(key); if (prior && (prior.hash !== hash || prior.state !== "rejected")) fail(prior.hash === hash ? "EXPORT_IN_PROGRESS" : "MANIFEST_CHANGED", 409);
        if (prior) db.prepare("UPDATE action_domain_requests SET state='pending',target=?,created_at=? WHERE key=?").run(s.snapshotRef, time(), key);
        else db.prepare("INSERT INTO action_domain_requests VALUES(?,?,?,?,?,'pending',?,NULL,?)").run(key, actor.principalRef, "ledger-export", s.snapshotRef, hash, JSON.stringify(payload), time());
      });
      claimed = true;
      const jobId = alias("export-job", key), sourceGrantRef = alias("export-grant", JSON.stringify([s.permissionVersion, initialGrant.directoryVersion]));
      const fence = () => { currentGrant(initialGrant, actor, "export"); if (Date.parse(s.validUntil) <= time()) fail("SOURCE_STALE"); ledger.assertCurrent(s, actor, time()); };
      jobs.register({ jobId, version: 1, ownerRef: alias("principal", actor.principalRef), mode: "observe", handler: "export-ledger-snapshot.v1",
        eventType: "authorized-ledger-snapshot", inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-local-result.v1",
        policyVersion: alias("permission", s.permissionVersion), modelVersion: null, offerVersion: null, capabilityBinding: null,
        budgets: { maxItems: 1, maxSteps: 1000, maxAttempts: 5, maxRunMs: 300000, leaseMs: 300000, maxConcurrency: 1, retryBaseMs: 0 } }, 0);
      const run = jobs.ingest({ schemaVersion: "job-reference-batch.v1", jobId, jobVersion: 1, eventId: key, eventType: "authorized-ledger-snapshot", eventAt: null,
        items: [{ itemKey: key, subjectRef: alias("snapshot", s.snapshotRef), evidenceRef: alias("ledger", s.version) }] }, key);
      jobs.activateLocalArtifact(jobId, 1, sourceGrantRef, fence);
      jobClaim = jobs.claimLocalArtifact(run.runId, "action-export-worker", fence); if (!jobClaim) fail("EXPORT_JOB_HELD");
      let checkpointVersion = jobClaim.item.checkpointVersion;
      const lines: string[] = ["entitlement_ref,creator_ref,source_ref,order_ref,currency,eligible_minor,commission_minor,commission_rate_pct,state,event_at,observed_at,policy_version,ledger_revision"];
      const seen = new Set<string>(), cursors = new Set<string>(); let cursor: string | null = null, offset = 0, bytes = 0;
      do {
        const parsed = ledgerPageSchema.safeParse(await ledger.page(s, cursor)); if (!parsed.success) fail("EXPORT_PAGE_INVALID", 502);
        const page = parsed.data;
        if (page.snapshotRef !== s.snapshotRef || page.version !== s.version || page.offset !== offset || page.total !== s.total || page.rows.length === 0 && page.nextCursor !== null) fail("EXPORT_SNAPSHOT_CHANGED");
        for (const row of page.rows) {
          if (seen.has(row.entitlementRef) || row.currency !== payload.filters.currency || Date.parse(row.eventAt) < Date.parse(payload.filters.startAt) || Date.parse(row.eventAt) >= Date.parse(payload.filters.endAt) || Date.parse(row.observedAt) > Date.parse(s.asOf) || row.ledgerRevision !== s.version || payload.filters.state !== "all" && row.state !== payload.filters.state) fail("EXPORT_ROW_INVALID", 502);
          seen.add(row.entitlementRef);
          const line = [alias("entitlement", row.entitlementRef), alias("creator", row.creatorRef), alias("source", row.sourceRef), alias("order", row.orderRef), row.currency,
            row.eligibleMinor, row.commissionMinor, row.commissionRatePct, row.state, row.eventAt, row.observedAt, alias("policy", row.policyVersion), alias("ledger", row.ledgerRevision)].map(csvCell).join(",");
          bytes += Buffer.byteLength(line, "utf8"); if (bytes > 16_000_000) fail("EXPORT_TOO_LARGE", 413); lines.push(line);
        }
        offset += page.rows.length; if (offset > s.total) fail("EXPORT_COUNT_INVALID", 502);
        cursor = page.nextCursor; if (cursor && cursors.has(cursor)) fail("EXPORT_CURSOR_LOOP", 502); if (cursor) cursors.add(cursor);
        const checkpoint = jobs.checkpoint(jobClaim.item.itemId, jobClaim.leaseToken, checkpointVersion, { cursor: cursor ? alias("cursor", cursor) : null, processedRefs: ["rows-" + offset] });
        checkpointVersion = checkpoint.checkpointVersion;
      } while (cursor);
      if (offset !== s.total) fail("EXPORT_INCOMPLETE");
      const current = snapshot(await ledger.current(s, actor), payload);
      if (!same(current, s)) fail("EXPORT_SNAPSHOT_CHANGED");
      const grant = await authorize(actor, "export");
      if (Date.parse(s.validUntil) <= time()) fail("SOURCE_STALE"); currentGrant(grant, actor, "export");
      const body = lines.join("\r\n") + "\r\n", artifactRef = "export-" + randomUUID();
      const receipt = exportReceiptSchema.parse({ kind: "ledger-export", artifactRef, runRef: run.runId, requestKey: idempotencyKey, principalRef: actor.principalRef, payloadDigest: digest(payload), sourceVersion: alias("ledger", s.version),
        rowCount: offset, byteLength: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"), createdAt: iso(), expiresAt: new Date(Math.min(time() + 3_600_000, Date.parse(s.validUntil))).toISOString(), asOf: s.asOf, contentType: "text/csv;charset=utf-8", confersRelease: false });
      jobs.completeLocalArtifact(jobClaim.item.itemId, jobClaim.leaseToken, { schemaVersion: "job-local-result.v1", kind: "reference-recorded", artifactRef, sourceEffect: "none" }, () => {
        currentGrant(grant, actor, "export"); if (Date.parse(s.validUntil) <= time()) fail("SOURCE_STALE");
        ledger.assertCurrent(s, actor, time());
        if (request(key)?.state !== "pending") fail("EXPORT_REQUEST_CHANGED");
        db.prepare("INSERT INTO action_export_artifacts VALUES(?,?,?,?)").run(artifactRef, key, JSON.stringify(s), body);
        db.prepare("UPDATE action_domain_requests SET state='applied',receipt=? WHERE key=? AND state='pending'").run(JSON.stringify(receipt), key);
      });
      return receipt;
    } catch (e) {
      // Export generation has no remote write; a failed unfinished generation is safe to reconcile as not generated.
      if (jobClaim && request(key)?.state === "pending") { try { jobs.fail(jobClaim.item.itemId, jobClaim.leaseToken, { reasonCode: "EXPORT_GENERATION_FAILED", certainty: "safe-read", retryable: true }); } catch { /* The existing job lease fences late workers. */ } }
      if (claimed && request(key)?.state === "pending") db.prepare("UPDATE action_domain_requests SET state='rejected' WHERE key=? AND state='pending'").run(key);
      rethrow(e, key);
    }
  }
  async function downloadExport(artifactRef: string, actor: ActionPrincipal) {
    reference.parse(artifactRef); await authorize(actor, "export");
    const row = db.prepare("SELECT a.*,r.actor,r.receipt FROM action_export_artifacts a INNER JOIN action_domain_requests r ON r.key=a.request_key WHERE a.ref=? AND r.state='applied'").get(artifactRef);
    if (!row || row.actor !== actor.principalRef) fail("EXPORT_ACCESS_DENIED", 403);
    const receipt = exportReceiptSchema.parse(JSON.parse(String(row.receipt))), s = ledgerSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
    if (Date.parse(receipt.expiresAt) <= time()) fail("EXPORT_EXPIRED", 410);
    if (!ledger) fail("EXPORT_SOURCE_UNCONFIGURED");
    const current = snapshot(await ledger.current(s, actor), { filters: s.filters, format: "csv" });
    if (!same(current, s)) fail("EXPORT_SNAPSHOT_CHANGED");
    const grant = await authorize(actor, "export"); currentGrant(grant, actor, "export"); ledger.assertCurrent(s, actor, time());
    if (Date.parse(receipt.expiresAt) <= time()) fail("EXPORT_EXPIRED", 410);
    return { receipt, body: String(row.body) };
  }
  const facts = (s: ReadinessSnapshot) => { const { observedAt, validUntil, ...rest } = s; void observedAt; void validUntil; return rest; };
  async function readSource(targetRef: string, actor: ActionPrincipal) {
    if (!readiness || readiness.idempotency !== "source-enforced" || typeof readiness.assertCurrent !== "function") fail("READINESS_SOURCE_UNCONFIGURED");
    const parsed = readinessSnapshotSchema.safeParse(await readiness.read(scope, actor, targetRef)); if (!parsed.success) fail("READINESS_SOURCE_INVALID", 502);
    const s = parsed.data;
    if (!same(s.scope, scope) || s.targetRef !== targetRef) fail("SOURCE_SCOPE_DENIED", 403);
    if (Date.parse(s.validUntil) <= time() || Date.parse(s.observedAt) >= Date.parse(s.validUntil)) fail("SOURCE_STALE");
    observe("readiness", targetRef, s.version, s.observedAt, facts(s)); return s;
  }
  const publicReceipt = (r: ReadinessReceipt): ReadinessReceipt => ({ ...r, receiptRef: alias("notion-receipt", r.receiptRef), recordedVersion: alias("notion-version", r.recordedVersion) });
  async function readReadiness(targetRef: string, actor: ActionPrincipal) {
    reference.parse(targetRef); await authorize(actor, "readiness"); const s = await readSource(targetRef, actor), grant = await authorize(actor, "readiness");
    currentGrant(grant, actor, "readiness"); readiness!.assertCurrent(s, actor, time());
    const version = alias("readiness-view", JSON.stringify([actor.principalRef, facts(s)])), publicTarget = alias("launch", s.targetRef);
    // A frozen public-reference mapping only: it is not a decision and never substitutes for fresh source authority.
    db.prepare("INSERT OR IGNORE INTO action_readiness_view_refs VALUES(?,?,?,?)").run(version, actor.principalRef, publicTarget, JSON.stringify(s));
    return nativeReadinessViewSchema.parse({ kind: "native-launch-readiness", targetRef: publicTarget, version, actorRef: alias("principal", actor.principalRef), requestRecovery: null, observedAt: s.observedAt, validUntil: s.validUntil,
      launchDate: s.launchDate, launchDateApproved: s.launchDateApproved, phase: s.phase, phaseAllowed: s.phaseAllowed, policyVersion: alias("readiness-policy", s.policyVersion),
      gates: s.gates.map(g => ({ ...g, id: alias("gate", g.id), evidenceRef: g.evidenceRef ? alias("evidence", g.evidenceRef) : null })),
      evidenceRefs: s.evidenceRefs.map(ref => alias("evidence", ref)), confersRelease: false });
  }
  async function recordReadinessFromView(targetRef: string, raw: unknown, expectedVersion: string, actor: ActionPrincipal, idempotencyKey: string) {
    reference.parse(targetRef); reference.parse(expectedVersion); const payload = readinessPayloadSchema.parse(raw);
    const row = db.prepare("SELECT actor,target_ref,snapshot FROM action_readiness_view_refs WHERE ref=?").get(expectedVersion);
    if (!row || row.actor !== actor.principalRef || row.target_ref !== targetRef) fail("SOURCE_SCOPE_DENIED", 403);
    const source = readinessSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
    const evidenceRefs = payload.evidenceRefs.map(ref => { const sourceRef = source.evidenceRefs.find(candidate => alias("evidence", candidate) === ref);
      if (!sourceRef) fail("READINESS_BASIS_INVALID"); return sourceRef; });
    const receipt = await recordReadiness(source.targetRef, { ...payload, evidenceRefs }, source.version, actor, idempotencyKey);
    return { kind: receipt.kind, receiptRef: receipt.receiptRef, recordedVersion: receipt.recordedVersion, recordedAt: receipt.recordedAt,
      provider: receipt.provider, targetRef, requestKey: idempotencyKey, actorRef: alias("principal", actor.principalRef), expectedVersion, payload, payloadDigest: digest(payload), confersRelease: false as const };
  }
  function validateReadiness(payload: ReadinessPayload, s: ReadinessSnapshot) {
    if (payload.launchDate !== s.launchDate || !s.phaseAllowed || payload.evidenceRefs.some(ref => !s.evidenceRefs.includes(ref))) fail("READINESS_BASIS_INVALID");
    if (payload.verdict === "go" && (!s.launchDate || !s.launchDateApproved || s.gates.some(g => g.required && (g.state !== "pass" || !g.evidenceRef)))) fail("LAUNCH_GO_HELD");
  }
  function sameIntent(receipt: ReadinessReceipt, intent: ReadinessIntent) { const { kind, receiptRef, recordedVersion, recordedAt, provider, ...actual } = receipt; void kind; void receiptRef; void recordedVersion; void provider;
    return same(actual, intent) && Date.parse(recordedAt) <= time(); }
  async function reconcileReadiness(intent: ReadinessIntent, key: string, actor: ActionPrincipal): Promise<ReadinessReceipt> {
    if (!readiness) fail("READINESS_SOURCE_UNCONFIGURED");
    const lookup = readinessLookupSchema.safeParse(await readiness.lookup(intent));
    if (!lookup.success || lookup.data.state === "unknown") fail("OUTCOME_UNCERTAIN", 502, "uncertain");
    if (lookup.data.state === "notApplied") {
      if (!same(lookup.data.intent, intent) || Date.parse(lookup.data.observedAt) > time() || Date.parse(lookup.data.observedAt) < (request(key)?.createdAt ?? Infinity) || request(key)?.state === "acknowledged") fail("READINESS_RECEIPT_CONFLICT", 502, "uncertain");
      tx(() => {
        const prior = request(key), proof = db.prepare("SELECT proof FROM action_readiness_terminal_receipts WHERE request_key=?").get(key);
        if (!prior || !["pending", "rejected"].includes(prior.state) || proof && !same(JSON.parse(String(proof.proof)), lookup.data)) fail("READINESS_RECEIPT_CONFLICT", 502, "uncertain");
        db.prepare("INSERT OR IGNORE INTO action_readiness_terminal_receipts VALUES(?,?)").run(key, JSON.stringify(lookup.data));
        db.prepare("UPDATE action_domain_requests SET state='rejected' WHERE key=? AND state='pending'").run(key);
      });
      fail("READINESS_NOT_APPLIED", 409);
    }
    const receipt = lookup.data.receipt;
    if (!sameIntent(receipt, intent) || Date.parse(receipt.recordedAt) < (request(key)?.createdAt ?? Infinity)) fail("READINESS_RECEIPT_CONFLICT", 502, "uncertain");
    const old = request(key); if (old?.state === "rejected" || old?.receipt && !same(JSON.parse(old.receipt), receipt)) fail("READINESS_RECEIPT_CONFLICT", 502, "applied");
    db.prepare("UPDATE action_domain_requests SET state='applied',receipt=? WHERE key=?").run(JSON.stringify(receipt), key);
    const grant = await authorize(actor, "readiness"), current = await readSource(intent.targetRef, actor);
    currentGrant(grant, actor, "readiness"); readiness.assertCurrent(current, actor, time());
    return publicReceipt(receipt);
  }
  async function recordReadiness(targetRef: string, raw: unknown, expectedVersion: string, actor: ActionPrincipal, idempotencyKey: string): Promise<ReadinessReceipt> {
    reference.parse(targetRef); reference.parse(expectedVersion); const payload = readinessPayloadSchema.parse(raw);
    const key = keyOf("readiness", actor, idempotencyKey), hash = digest([scope, actor, targetRef, expectedVersion, payload]);
    try {
      const currentActor = await authorize(actor, "readiness");
      const old = request(key);
      if (old && old.hash !== hash) fail("MANIFEST_CHANGED");
      if (old) {
        if (old.state === "rejected") fail("READINESS_NOT_APPLIED");
        // Current source permission must remain valid, but a later source version does not erase the historical receipt.
        const source = await readSource(targetRef, actor);
        currentGrant(currentActor, actor, "readiness"); readiness!.assertCurrent(source, actor, time());
        if (old.state === "applied" && old.receipt) return publicReceipt(readinessReceiptSchema.parse(JSON.parse(old.receipt)));
        return await reconcileReadiness(readinessIntentSchema.parse(JSON.parse(old.intent)), key, actor);
      }
      const s = await readSource(targetRef, actor);
      if (s.version !== expectedVersion) fail("STALE_VERSION"); validateReadiness(payload, s);
      const grant = await authorize(actor, "readiness"), current = await readSource(targetRef, actor);
      if (!same(facts(current), facts(s))) fail("READINESS_BASIS_CHANGED"); validateReadiness(payload, current); currentGrant(grant, actor, "readiness");
      const intent = readinessIntentSchema.parse({ scope, requestKey: idempotencyKey, principalRef: actor.principalRef, targetRef,
        expectedVersion, sourceBasis: digest(facts(s)), payloadDigest: digest(payload), payload, confersRelease: false });
      tx(() => {
        headCurrent("readiness", targetRef, expectedVersion);
        readiness!.assertCurrent(current, actor, time()); currentGrant(grant, actor, "readiness");
        const prior = request(key); if (prior) fail(prior.hash === hash ? "OUTCOME_UNCERTAIN" : "MANIFEST_CHANGED", 409);
        if (db.prepare("SELECT key FROM action_domain_requests WHERE kind='readiness' AND target=? AND state IN ('pending','acknowledged')").get(targetRef)) fail("READINESS_PRIOR_OUTCOME_UNCERTAIN", 409);
        db.prepare("INSERT INTO action_domain_requests VALUES(?,?,?,?,?,'pending',?,NULL,?)").run(key, actor.principalRef, "readiness", targetRef, hash, JSON.stringify(intent), time());
      });
      if (!readiness) fail("READINESS_SOURCE_UNCONFIGURED");
      const acknowledgment = readinessReceiptSchema.safeParse(await readiness.write(intent));
      if (acknowledgment.success && sameIntent(acknowledgment.data, intent) && Date.parse(acknowledgment.data.recordedAt) >= (request(key)?.createdAt ?? Infinity)) {
        db.prepare("UPDATE action_domain_requests SET state='acknowledged',receipt=? WHERE key=? AND state='pending'").run(JSON.stringify(acknowledgment.data), key);
      }
      return await reconcileReadiness(intent, key, actor);
    } catch (e) { rethrow(e, key); }
  }
  /** Reads the immutable original intent. Source lookup can settle an old request; it never invokes write. */
  async function recoverReadinessRequest(requestKey: string, actor: ActionPrincipal): Promise<ReadinessRequestRecovery> {
    const key = keyOf("readiness", actor, requestKey);
    try {
      const grant = await authorize(actor, "readiness");
      const stored = request(key);
      const base = { requestKey, intent: null, receipt: null, terminalProof: null };
      if (!stored) {
        currentGrant(grant, actor, "readiness");
        return readinessRequestRecoverySchema.parse({ ...base, state: "notFound", reasonCodes: ["REQUEST_NOT_OBSERVED_ORIGINAL_KEY_ONLY"] });
      }
      const original = readinessIntentSchema.parse(JSON.parse(stored.intent));
      if (!same(original.scope, scope) || original.principalRef !== actor.principalRef || original.requestKey !== requestKey || original.payloadDigest !== digest(original.payload) || stored.hash !== digest([scope, actor, original.targetRef, original.expectedVersion, original.payload])) fail("READINESS_RECEIPT_CONFLICT", 502);
      const current = await readSource(original.targetRef, actor);
      currentGrant(grant, actor, "readiness"); readiness!.assertCurrent(current, actor, time());
      // Reconstruct only from the exact frozen public view that authorized this input, never today's source version.
      const viewRef = alias("readiness-view", JSON.stringify([actor.principalRef, factsFromOriginal()]));
      function factsFromOriginal() {
        const candidates = db.prepare("SELECT ref,snapshot FROM action_readiness_view_refs WHERE actor=? AND target_ref=?").all(actor.principalRef, alias("launch", original.targetRef));
        for (const candidate of candidates) {
          const parsed = readinessSnapshotSchema.safeParse(JSON.parse(String(candidate.snapshot)));
          if (parsed.success && same(parsed.data.scope, scope) && parsed.data.targetRef === original.targetRef && parsed.data.version === original.expectedVersion && digest(facts(parsed.data)) === original.sourceBasis) return facts(parsed.data);
        }
        return null;
      }
      const mapping = db.prepare("SELECT snapshot FROM action_readiness_view_refs WHERE ref=? AND actor=?").get(viewRef, actor.principalRef);
      if (!mapping) return readinessRequestRecoverySchema.parse({ ...base, state: "unverified", reasonCodes: ["ORIGINAL_PUBLIC_INTENT_UNAVAILABLE"] });
      const frozen = readinessSnapshotSchema.parse(JSON.parse(String(mapping.snapshot)));
      if (original.payload.evidenceRefs.some(ref => !frozen.evidenceRefs.includes(ref))) fail("READINESS_RECEIPT_CONFLICT", 502);
      const payload = { ...original.payload, evidenceRefs: original.payload.evidenceRefs.map(ref => alias("evidence", ref)) }, targetRef = alias("launch", original.targetRef);
      const intent = readinessRecoveryIntentSchema.parse({ operation: "recordSourceDecision", actionKind: "recordLaunchReadiness", requestKey,
        actorRef: alias("principal", actor.principalRef), targetRef, expectedVersion: viewRef,
        entityRefs: [{ source: "launch-readiness", accountId: scope.accountId, sourceId: null, canonicalId: targetRef, url: null, identityState: "resolved", provenanceRef: viewRef }],
        payload, payloadDigest: digest(payload) });
      let reasonCodes: string[] = [];
      if (["pending", "acknowledged"].includes(stored.state)) {
        try { await reconcileReadiness(original, key, actor); }
        catch (e) {
          if (!(e instanceof ActionServiceError) || !["OUTCOME_UNCERTAIN", "READINESS_NOT_APPLIED", "READINESS_RECEIPT_CONFLICT"].includes(e.code)) throw e;
          reasonCodes = [e.code];
        }
      }
      // Every awaited reconciliation is followed by fresh source and actor authorization before returning rationale or receipts.
      const latestGrant = await authorize(actor, "readiness"), source = await readSource(original.targetRef, actor);
      currentGrant(latestGrant, actor, "readiness"); readiness!.assertCurrent(source, actor, time());
      const latest = request(key)!;
      if (latest.state === "applied" && latest.receipt) {
        const rawReceipt = readinessReceiptSchema.parse(JSON.parse(latest.receipt));
        if (!sameIntent(rawReceipt, original)) fail("READINESS_RECEIPT_CONFLICT", 502);
        const receipt = readinessPublicReceiptSchema.parse({ kind: rawReceipt.kind, receiptRef: alias("notion-receipt", rawReceipt.receiptRef), recordedVersion: alias("notion-version", rawReceipt.recordedVersion),
          recordedAt: rawReceipt.recordedAt, provider: rawReceipt.provider, requestKey, actorRef: intent.actorRef, targetRef, expectedVersion: viewRef, payloadDigest: intent.payloadDigest, confersRelease: false });
        return readinessRequestRecoverySchema.parse({ requestKey, state: "recorded", intent, receipt, terminalProof: null, reasonCodes: ["HISTORICAL_RECORD_ONLY_RELEASE_NOT_GRANTED"] });
      }
      if (latest.state === "rejected") {
        const row = db.prepare("SELECT proof FROM action_readiness_terminal_receipts WHERE request_key=?").get(key), proof = row && readinessLookupSchema.safeParse(JSON.parse(String(row.proof)));
        if (proof?.success && proof.data.state === "notApplied" && same(proof.data.intent, original)) return readinessRequestRecoverySchema.parse({ requestKey, state: "notApplied", intent, receipt: null,
          terminalProof: { receiptRef: alias("notion-terminal", proof.data.receiptRef), observedAt: proof.data.observedAt }, reasonCodes: ["ORIGINAL_ATTEMPT_TERMINALLY_NOT_APPLIED"] });
        return readinessRequestRecoverySchema.parse({ ...base, state: "unverified", reasonCodes: ["TERMINAL_SOURCE_PROOF_UNAVAILABLE"] });
      }
      return readinessRequestRecoverySchema.parse({ requestKey, state: "pending", intent, receipt: null, terminalProof: null, reasonCodes: reasonCodes.length ? reasonCodes : ["OUTCOME_UNCERTAIN"] });
    } catch (e) { rethrow(e, key); }
  }
  return { exportLedger, downloadExport, readReadiness, recordReadiness, recordReadinessFromView, recoverReadinessRequest };
}
