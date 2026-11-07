import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { draftRecordSchema, flowResourceSchema, lifecycleFilters, mandatoryPolicies, nativeActivationSchema, nativeConsentSchema,
  nativeEmailFlowSchema, nativeLifecycleSchema, requestedSaveSchema, saveDraftSchema, saveReceiptSchema,
  type DraftRecord, type FlowCatalog, type FlowDraft, type FlowKey, type LifecycleViewKey, type NativeLifecycleData, type SaveDraftInput, type SaveReceipt } from "./contract.ts";
import { LifecycleError, lifecycleObservationCurrent, lifecycleObservationDeadline, lifecycleSnapshotSchema, type LifecycleSnapshot, type LifecycleSourceReader } from "./source.ts";

export { LifecycleError } from "./source.ts";
type Options = { db: DatabaseSync; scope: OperationsScope; secret: string; source?: LifecycleSourceReader; now?: () => number };
type SourceRead = { snapshot: LifecycleSnapshot | null; reason: string | null; state: "unconfigured" | "unavailable" | "current" | "expired" | "partial"; factsHash: string | null };
type RequestRow = { actor: string; resource: string; hash: string; original: string; state: "recorded" | "rejected"; receipt: string | null; reason: string | null; current_version: string | null };
export type LifecycleReadResult = { data: NativeLifecycleData; version: string; observedAt: string; partial: boolean; stale: boolean; empty: boolean;
  capabilities: { actionKind: string; state: "available" | "held" | "denied"; reasonCodes: string[] }[] };
const fail = (code: string, status: number, currentVersion?: string): never => { throw new LifecycleError(code, status, { currentVersion }); };
const unknown = (missingReason: string) => ({ value: null, missingReason });
const isEditable = (flow: FlowKey): flow is Exclude<FlowKey, "setup"> => flow !== "setup";

/** Only local immutable configuration drafts are written here. J17 owns enrollments, consent and sends. */
export function createLifecycleService(options: Options) {
  const { db, scope, secret, source } = options, now = options.now ?? Date.now;
  const binding = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
  if (!binding || binding.workspace_id !== scope.workspaceId || binding.account_id !== scope.accountId || scope.environment !== "sandbox") fail("DATABASE_SCOPE_MISMATCH", 403);
  if (secret.length < 32) throw new Error("Lifecycle reference key must be private and at least 32 characters.");
  const alias = (kind: string, value: string) => kind + "-" + createHmac("sha256", secret).update(JSON.stringify(["lifecycle.v1", scope, kind, value])).digest("hex").slice(0, 32);
  db.exec(`CREATE TABLE IF NOT EXISTS lifecycle_source_versions(version TEXT PRIMARY KEY,facts_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lifecycle_source_head(id INTEGER PRIMARY KEY CHECK(id=1),version TEXT NOT NULL,facts_hash TEXT NOT NULL,observed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS lifecycle_draft_revisions(flow TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(flow,revision));
    CREATE TABLE IF NOT EXISTS lifecycle_draft_requests(request_key TEXT PRIMARY KEY,actor TEXT NOT NULL,resource TEXT NOT NULL,hash TEXT NOT NULL,
      original TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,reason TEXT,current_version TEXT);`);
  function tx<T>(fn: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
  function latest(flow: FlowKey): DraftRecord | null {
    const row = db.prepare("SELECT body FROM lifecycle_draft_revisions WHERE flow=? ORDER BY revision DESC LIMIT 1").get(flow);
    return row ? draftRecordSchema.parse(JSON.parse(String(row.body))) : null;
  }
  function history(flow: FlowKey) {
    const total = Number(db.prepare("SELECT count(*) n FROM lifecycle_draft_revisions WHERE flow=?").get(flow)?.n ?? 0);
    const rows = db.prepare("SELECT body FROM lifecycle_draft_revisions WHERE flow=? ORDER BY revision DESC LIMIT 20").all(flow).map(r => draftRecordSchema.parse(JSON.parse(String(r.body))));
    return { total, truncated: total > rows.length, rows };
  }
  const sourceVersion = (s: LifecycleSnapshot) => alias("source", s.version);
  const catalogFacts = (f: FlowCatalog) => ({ ...f, evidence: f.evidence.map(e => ({ ...e, observedAt: null, validUntil: null })) });
  function sourceFacts(s: LifecycleSnapshot) {
    const { observedAt, validUntil, ...rest } = s; void observedAt; void validUntil;
    // A trusted lease can renew. Changed substantive evidence under a reused source version cannot.
    return { ...rest, flows: rest.flows.map(catalogFacts) };
  }
  async function observe(): Promise<SourceRead> {
    if (!source) return { snapshot: null, reason: "LIFECYCLE_SOURCE_UNCONFIGURED", state: "unconfigured", factsHash: null };
    let raw: unknown;
    try { raw = await source({ ...scope }); }
    catch (error) {
      if (error instanceof LifecycleError && (error.status === 401 || error.status === 403 || error.status < 500)) throw error;
      return { snapshot: null, reason: "LIFECYCLE_SOURCE_UNAVAILABLE", state: "unavailable", factsHash: null };
    }
    if (raw === null) return { snapshot: null, reason: "LIFECYCLE_SOURCE_UNAVAILABLE", state: "unavailable", factsHash: null };
    const parsed = lifecycleSnapshotSchema.safeParse(raw);
    if (!parsed.success) throw new LifecycleError("LIFECYCLE_SOURCE_INVALID", 502);
    const s = parsed.data;
    if (digest(s.scope) !== digest(scope)) fail("SOURCE_SCOPE_DENIED", 403);
    const currentTime = now();
    if (!Number.isFinite(currentTime) || Date.parse(s.observedAt) > currentTime) fail("LIFECYCLE_SOURCE_INVALID", 502);
    const factsHash = digest(sourceFacts(s));
    tx(() => {
      const previous = db.prepare("SELECT facts_hash FROM lifecycle_source_versions WHERE version=?").get(s.version);
      if (previous && previous.facts_hash !== factsHash) fail("LIFECYCLE_SOURCE_CONFLICT", 409);
      const head = db.prepare("SELECT version,observed_at FROM lifecycle_source_head WHERE id=1").get();
      if (head && Date.parse(String(head.observed_at)) > Date.parse(s.observedAt)) fail("LIFECYCLE_SOURCE_REGRESSED", 409);
      if (head && head.version !== s.version && Date.parse(String(head.observed_at)) === Date.parse(s.observedAt)) fail("LIFECYCLE_SOURCE_CONFLICT", 409);
      db.prepare("INSERT OR IGNORE INTO lifecycle_source_versions VALUES(?,?)").run(s.version, factsHash);
      db.prepare("INSERT INTO lifecycle_source_head VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,facts_hash=excluded.facts_hash,observed_at=excluded.observed_at")
        .run(s.version, factsHash, s.observedAt);
    });
    const expired = !lifecycleObservationCurrent(s.observedAt, s.validUntil, now());
    return { snapshot: s, factsHash, state: expired ? "expired" : s.coverage === "partial" ? "partial" : "current",
      reason: expired ? "SOURCE_STALE" : s.coverage === "partial" ? "SOURCE_COVERAGE_PARTIAL" : null };
  }
  const publicCohort = (c: NonNullable<LifecycleSnapshot["consent"]>["cohort"]) =>
    ({ ...c, ref: alias("cohort", c.ref), receipt: alias("receipt", c.receipt) });
  function publicCatalog(c: FlowCatalog, selected?: FlowDraft | null, sourceCurrent = true, sourceValidUntil?: string): FlowCatalog {
    const publicFlow: FlowCatalog = {
      ...c, flowRef: alias("flow", c.flowRef), catalogVersion: alias("catalog", c.catalogVersion), policyVersion: alias("policy", c.policyVersion),
      recoveryOwner: c.recoveryOwner ? alias("owner", c.recoveryOwner) : null,
      entryEvents: c.entryEvents.map(e => ({ ...e, ref: alias("entry", e.ref), version: alias("entry-version", e.version) })),
      timingRules: c.timingRules.map(t => ({ ...t, ref: alias("timing", t.ref), version: alias("timing-version", t.version), entryEventRef: alias("entry", t.entryEventRef), approvalRef: t.approvalRef ? alias("approval", t.approvalRef) : null })),
      templates: c.templates.map(t => ({ ...t, ref: alias("template", t.ref), version: alias("template-version", t.version), claimPolicyVersion: alias("claim-policy", t.claimPolicyVersion), approvalRef: t.approvalRef ? alias("approval", t.approvalRef) : null })),
      outcomes: c.outcomes ? { cohort: publicCohort(c.outcomes.cohort), rows: c.outcomes.rows.map(r => ({ ...r, receipt: r.receipt ? alias("receipt", r.receipt) : null })) } : null,
      evidence: c.evidence.map(e => {
        const b = e.basis;
        const basis = b ? { catalogVersion: alias("catalog", b.catalogVersion), policyVersion: alias("policy", b.policyVersion), entryEventRef: alias("entry", b.entryEventRef),
          timingRuleRef: alias("timing", b.timingRuleRef), templateRef: alias("template", b.templateRef), templateVersion: alias("template-version", b.templateVersion) } : null;
        const exact = b && b.catalogVersion === c.catalogVersion && b.policyVersion === c.policyVersion &&
          c.entryEvents.some(x => x.ref === b.entryEventRef) && c.timingRules.some(x => x.ref === b.timingRuleRef && x.entryEventRef === b.entryEventRef) &&
          c.templates.some(x => x.ref === b.templateRef && x.version === b.templateVersion);
        const matches = !selected || !!basis && basis.entryEventRef === selected.entryEventRef && basis.timingRuleRef === selected.timingRuleRef && basis.templateRef === selected.templateRef && basis.templateVersion === selected.templateVersion;
        const deadline = e.observedAt && e.validUntil ? lifecycleObservationDeadline(e.observedAt, e.validUntil) : null;
        const validUntil = deadline && sourceValidUntil ? new Date(Math.min(Date.parse(deadline), Date.parse(sourceValidUntil))).toISOString() : deadline;
        const current = sourceCurrent && exact && matches && e.observedAt && validUntil && lifecycleObservationCurrent(e.observedAt, validUntil, now());
        return { ...e, validUntil, basis, receipt: e.receipt ? alias("receipt", e.receipt) : null,
          state: current ? e.state : "unknown", missingReason: current ? e.missingReason : "Evidence does not prove this current flow, timing, template and policy basis." };
      }),
    };
    return publicFlow;
  }
  function version(flow: FlowKey, sourceRead: SourceRead, record: DraftRecord | null) {
    const c = sourceRead.snapshot?.flows.find(f => f.flow === flow);
    return "lf1-" + digest([scope, flow, record?.revision ?? 0, sourceRead.snapshot?.version ?? null, c ? catalogFacts(c) : null, mandatoryPolicies]);
  }
  function reasons(flow: FlowKey, s: SourceRead, actor: string) {
    const result: string[] = [];
    if (actor !== "agent-reviewer") result.push("REVIEWER_REQUIRED");
    if (!isEditable(flow)) result.push("SETUP_FLOW_READ_ONLY");
    if (s.state !== "current") result.push(s.reason ?? "SOURCE_UNVERIFIED");
    const config = s.snapshot?.flows.find(f => f.flow === flow);
    if (!config) result.push("FLOW_CATALOG_UNAVAILABLE");
    else if (!config.draftAllowed) result.push("FLOW_DRAFT_DENIED");
    return result;
  }
  function requestRow(key: string): RequestRow | null {
    const row = db.prepare("SELECT actor,resource,hash,original,state,receipt,reason,current_version FROM lifecycle_draft_requests WHERE request_key=?").get(key);
    return row ? row as unknown as RequestRow : null;
  }
  function requestedSave(key: string, flow: FlowKey, actor: string) {
    if (actor !== "agent-reviewer") fail("SOURCE_SCOPE_DENIED", 403);
    const resourceRef = flowResourceSchema.safeParse("flow-" + flow);
    if (!resourceRef.success) fail("SETUP_FLOW_READ_ONLY", 403);
    const row = requestRow(key);
    if (row && (row.actor !== actor || row.resource !== resourceRef.data)) fail("SOURCE_SCOPE_DENIED", 403);
    const original = row ? saveDraftSchema.parse(JSON.parse(row.original)) : null;
    return requestedSaveSchema.parse({ requestKey: key, resourceRef: resourceRef.data, actorRef: actor,
      state: row?.state === "recorded" ? "applied" : row?.state === "rejected" ? "notApplied" : "unknown",
      disposition: row?.state ?? "absent", expectedVersion: original?.expectedVersion ?? null, payloadDigest: original ? digest(original.payload) : null,
      original: original ? { payload: original.payload, expectedVersion: original.expectedVersion } : null,
      receipt: row?.receipt ? saveReceiptSchema.parse(JSON.parse(row.receipt)) : null,
      reasonCode: row?.reason ?? (row ? null : "ABSENCE_IS_NOT_A_TERMINAL_FENCE") });
  }
  async function read(view: LifecycleViewKey, rawFilters: unknown, actorRef: string): Promise<LifecycleReadResult> {
    if (actorRef !== "agent-reader" && actorRef !== "agent-reviewer") fail("SOURCE_SCOPE_DENIED", 403);
    if (!Object.hasOwn(lifecycleFilters, view)) fail("INVALID_REQUEST", 400);
    const filters = lifecycleFilters[view].safeParse(rawFilters);
    if (!filters.success) fail("INVALID_REQUEST", 400);
    const f = view === "emailFlow" ? lifecycleFilters.emailFlow.parse(filters.data) : null;
    if (f?.draftRequestKey && actorRef !== "agent-reviewer") fail("SOURCE_SCOPE_DENIED", 403);
    const observed = await observe(), readTime = now();
    const s: SourceRead = observed.snapshot && !lifecycleObservationCurrent(observed.snapshot.observedAt, observed.snapshot.validUntil, readTime)
      ? { ...observed, state: "expired", reason: "SOURCE_STALE" } : observed;
    const observedAt = new Date(readTime).toISOString();
    const head = { observedAt, actorRef, sourceAsOf: s.snapshot?.observedAt ?? null, sourceVersion: s.snapshot ? sourceVersion(s.snapshot) : null,
      validUntil: s.snapshot ? lifecycleObservationDeadline(s.snapshot.observedAt, s.snapshot.validUntil) : null, freshness: s.state === "expired" ? "stale" as const : s.snapshot ? "current" as const : "unknown" as const,
      coverage: s.snapshot?.coverage ?? "unknown" as const, sourceState: s.state, missingReason: s.reason, sourceLink: null };
    const rawConsent = s.snapshot?.consent, rawActivation = s.snapshot?.activation;
    const consent = rawConsent ? { ...rawConsent, cohort: publicCohort(rawConsent.cohort), categoryDefinitionVersion: alias("consent-definition", rawConsent.categoryDefinitionVersion) } : null;
    const activation = rawActivation ? { ...rawActivation, cohort: publicCohort(rawActivation.cohort), privacyApproval: { ...rawActivation.privacyApproval,
      receipt: rawActivation.privacyApproval.receipt ? alias("receipt", rawActivation.privacyApproval.receipt) : null },
      ...(rawActivation.privacyApproval.state === "approved" ? {} : { delivered: unknown("Anonymous export approval is unverified."), paired: unknown("Anonymous export approval is unverified."),
        weekOne: unknown("Anonymous export approval is unverified."), pairingFailureEvents: unknown("Anonymous export approval is unverified.") }) } : null;
    let data: NativeLifecycleData, v: string, capabilities: LifecycleReadResult["capabilities"] = [];
    if (f) {
      const draft = latest(f.flow), config = s.snapshot?.flows.find(c => c.flow === f.flow);
      const saveHoldReasons = reasons(f.flow, s, actorRef);
      const publicConfig = config ? publicCatalog(config, draft?.payload, s.state !== "expired", head.validUntil ?? undefined) : null;
      v = version(f.flow, s, draft);
      data = nativeEmailFlowSchema.parse({ ...head, kind: "source-email-flow", flow: f.flow, sourceConfig: publicConfig, lockedPolicies: mandatoryPolicies,
        draft, draftVersion: v, currentSourceMatch: s.state === "current" && !!draft && !!publicConfig && draft.sourceVersion === head.sourceVersion && draft.catalogVersion === publicConfig.catalogVersion && draft.policyVersion === publicConfig.policyVersion,
        history: history(f.flow), requestedSave: f.draftRequestKey ? requestedSave(f.draftRequestKey, f.flow, actorRef) : null, saveHoldReasons });
      capabilities = [{ actionKind: "saveFlowDraft", state: actorRef !== "agent-reviewer" ? "denied" : saveHoldReasons.length ? "held" : "available", reasonCodes: saveHoldReasons },
        { actionKind: "enableFlow", state: "held", reasonCodes: ["J17_PROVIDER_EXECUTION_NOT_CONNECTED"] }];
    } else {
      if (view === "lifecycleOverview") data = nativeLifecycleSchema.parse({ ...head, kind: "source-lifecycle", flows: (s.snapshot?.flows ?? []).map(c => publicCatalog(c, null, s.state !== "expired", head.validUntil ?? undefined)),
        consent, activation, returnsAwaitingInspection: s.snapshot?.returnsAwaitingInspection ?? unknown("No source inspection aggregate.") });
      else if (view === "consentEligibility") data = nativeConsentSchema.parse({ ...head, kind: "source-consent", consent });
      else data = nativeActivationSchema.parse({ ...head, kind: "source-activation", activation });
      v = "lc1-" + digest(data);
    }
    const sectionMissing = data.kind === "source-email-flow" ? !data.sourceConfig : data.kind === "source-consent" ? !data.consent : data.kind === "source-activation" ? !data.activation : !data.consent || !data.activation || data.flows.length !== 4;
    return { data, version: v, observedAt, partial: s.state !== "current" || sectionMissing, stale: s.state === "expired", empty: false, capabilities };
  }
  function choice(config: FlowCatalog, payload: FlowDraft) {
    const e = config.entryEvents.find(x => x.ref === payload.entryEventRef);
    const t = config.timingRules.find(x => x.ref === payload.timingRuleRef);
    const template = config.templates.find(x => x.ref === payload.templateRef && x.version === payload.templateVersion);
    return !!e && !!t && !!template && t.entryEventRef === e.ref && t.timezone === payload.timezone;
  }
  async function saveDraft(raw: unknown, actorRef: string): Promise<SaveReceipt> {
    if (actorRef !== "agent-reviewer") fail("SOURCE_SCOPE_DENIED", 403);
    const parsed = saveDraftSchema.safeParse(raw);
    if (!parsed.success) throw new LifecycleError("VALIDATION_FAILED", 422, { fieldErrors: Object.fromEntries(parsed.error.issues.map(i => [i.path.join(".") || "draft", i.message])) });
    const request: SaveDraftInput = parsed.data, flow = request.resourceRef.slice(5) as Exclude<FlowKey, "setup">;
    const hash = digest([scope, actorRef, request]);
    const previous = requestRow(request.idempotencyKey);
    if (previous && (previous.hash !== hash || previous.actor !== actorRef || previous.resource !== request.resourceRef)) fail("IDEMPOTENCY_KEY_REUSED", 409);
    const s = await observe();
    let failure: LifecycleError | null = null;
    const result = tx(() => {
      const prior = requestRow(request.idempotencyKey);
      if (prior) {
        if (prior.hash !== hash || prior.actor !== actorRef || prior.resource !== request.resourceRef) fail("IDEMPOTENCY_KEY_REUSED", 409);
        if (prior.state === "recorded" && prior.receipt) return saveReceiptSchema.parse(JSON.parse(prior.receipt));
        throw new LifecycleError(prior.reason ?? "STALE_VERSION", 409, { currentVersion: prior.current_version ?? undefined });
      }
      const stored = latest(flow), current = version(flow, s, stored);
      const reject = (code: string, status = 409) => {
        db.prepare("INSERT INTO lifecycle_draft_requests VALUES(?,?,?,?,?,'rejected',NULL,?,?)")
          .run(request.idempotencyKey, actorRef, request.resourceRef, hash, JSON.stringify(request), code, current);
        failure = new LifecycleError(code, status, { currentVersion: current }); return null;
      };
      const hold = reasons(flow, s, actorRef)[0];
      if (hold) return reject(hold, hold === "FLOW_DRAFT_DENIED" ? 403 : 409);
      const snapshot = s.snapshot!;
      const head = db.prepare("SELECT version,facts_hash FROM lifecycle_source_head WHERE id=1").get();
      if (head?.version !== snapshot.version || head.facts_hash !== s.factsHash) return reject("SOURCE_VERSION_CHANGED");
      if (!lifecycleObservationCurrent(snapshot.observedAt, snapshot.validUntil, now())) return reject("SOURCE_STALE");
      if (request.expectedVersion !== current) return reject("STALE_VERSION");
      const config = publicCatalog(snapshot.flows.find(c => c.flow === flow)!);
      if (!choice(config, request.payload)) return reject("FLOW_CATALOG_SELECTION_INVALID", 422);
      const noChange = stored && digest(stored.payload) === digest(request.payload) && stored.sourceVersion === sourceVersion(snapshot) &&
        stored.catalogVersion === config.catalogVersion && stored.policyVersion === config.policyVersion;
      const record = noChange ? stored : draftRecordSchema.parse({ kind: "local-flow-draft", flow, revision: (stored?.revision ?? 0) + 1,
        payload: request.payload, sourceVersion: sourceVersion(snapshot), catalogVersion: config.catalogVersion, policyVersion: config.policyVersion,
        templateVersion: request.payload.templateVersion, lockedPolicies: mandatoryPolicies, savedAt: new Date(now()).toISOString(), savedBy: actorRef });
      if (!noChange) db.prepare("INSERT INTO lifecycle_draft_revisions VALUES(?,?,?)").run(flow, record.revision, JSON.stringify(record));
      const receipt = saveReceiptSchema.parse({ scope, resourceRef: request.resourceRef, resourceVersion: version(flow, s, record), persistedAt: record.savedAt,
        persistedByRef: record.savedBy, record, reasonCodes: noChange ? ["NO_CHANGE", "LOCAL_DRAFT_ONLY"] : ["LOCAL_DRAFT_ONLY"],
        requestKey: request.idempotencyKey, expectedVersion: request.expectedVersion, payloadDigest: digest(request.payload) });
      db.prepare("INSERT INTO lifecycle_draft_requests VALUES(?,?,?,?,?,'recorded',?,NULL,NULL)")
        .run(request.idempotencyKey, actorRef, request.resourceRef, hash, JSON.stringify(request), JSON.stringify(receipt));
      return receipt;
    });
    if (failure) throw failure;
    if (!result) throw new LifecycleError("PERSISTENCE_UNCERTAIN", 500, { executionCertainty: "uncertain" });
    return result;
  }
  return { read, saveDraft };
}
