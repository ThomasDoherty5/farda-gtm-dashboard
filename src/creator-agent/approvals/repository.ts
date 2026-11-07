import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { ApprovalError, approvalScopeSchema, approvalDraftSchema, proposeCommandSchema, approvalCommandSchema, principalSchema, slackDecisionLocatorSchema, dispatchApprovalBindingSchema,
  type ApprovalScope, type ApprovalSources, type ApprovalRegistry, type ApprovalPrincipal, type ProposeCommand, type ApprovalCommand, type ApprovalManifest, type ApprovalDraft,
  type ApprovalRead, type LinearRecordIntent, type RecordedLinearRecord, type VerifiedSlackDecision, type SlackDecisionLocator, type TrustedApprovalIngress,
  type DecisionReceipt, type DispatchApprovalBinding, type VerifiedApprovalProof, type CurrentApprovalResult, type TrustedHuman, type VerifiedExistingJobOutcome, type ApprovalPolicy, type ApprovalAuthoritySnapshot } from "./contract.ts";
import { currentPolicy, fresh, readLinear, readSlack, resolveHuman, sameApprovalScope, stableSlack } from "./authority.ts";
import { actorCanPropose, decisionAuthorityReasons, draftPolicyReasons } from "./policy.ts";

export type ApprovalRepositoryOptions = { scope: ApprovalScope; sources?: ApprovalSources; registry?: ApprovalRegistry; currentPolicy?: () => unknown; now?: () => number;
  verifyOutcome?: (input: VerifiedExistingJobOutcome) => boolean };
type Head = { version: number; revision: number; hold: string | null };
type Outbox = { intent: LinearRecordIntent; state: "pending" | "attempted" | "recorded" | "uncertain"; attempts: number; record: RecordedLinearRecord | null };
type Verification = { proof: VerifiedApprovalProof; draft: ApprovalDraft; actor: TrustedHuman; authority: ApprovalAuthoritySnapshot; policyHash: string };
type WriteFence = { manifest: ApprovalManifest; draft: ApprovalDraft; authority: ApprovalAuthoritySnapshot; revision: number; policyHash: string; validUntil: string };
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const error = (reason: string): never => { throw new ApprovalError(reason); };
const minTime = (...values: string[]) => new Date(Math.min(...values.map(value => Date.parse(value)))).toISOString();
const policyHash = (policy: ApprovalPolicy) => digest(Object.fromEntries(Object.entries(policy).filter(([key]) => key !== "observedAt" && key !== "validUntil")));
/** Source leases may renew without changing the exact approved action. Material source revisions may not. */
export function stableApprovalDraft(draft: ApprovalDraft) {
  const value = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "sourceValidUntil" && key !== "gates" && key !== "historicalLiability"));
  return { ...value, gates: Object.fromEntries(Object.entries(draft.gates).map(([key, gate]) => {
    if (gate.state !== "satisfied") return [key, gate];
    return [key, { state: gate.state, sourceRef: gate.sourceRef, sourceVersion: gate.sourceVersion }];
  })), historicalLiability: draft.historicalLiability ? { sourceRef: draft.historicalLiability.sourceRef, sourceVersion: draft.historicalLiability.sourceVersion, acceptedMinor: draft.historicalLiability.acceptedMinor, currency: draft.historicalLiability.currency } : null };
}
export function approvalDispatchBinding(manifest: ApprovalManifest, itemRef: string): DispatchApprovalBinding {
  const item = manifest.items.find(value => value.itemRef === itemRef); if (!item) return error("APPROVAL_ITEM_NOT_FOUND");
  return { scope: manifest.scope, approvalRef: manifest.approvalRef, manifestVersion: manifest.manifestVersion, manifestHash: manifest.manifestHash,
    itemRef, itemVersion: item.itemVersion, itemHash: item.itemHash, actionKind: manifest.draft.actionKind, providerAccountRef: manifest.draft.providerAccountRef,
    payloadHash: item.payloadHash, policyVersion: manifest.draft.policyVersion, termsVersion: manifest.draft.termsVersion, rightsVersion: manifest.draft.rightsVersion, phase: manifest.draft.phase };
}

/** Linear + verified Slack origin own authority. SQLite stores immutable intent, readback, fencing and audit evidence. */
export class ApprovalRepository {
  private readonly db: DatabaseSync;
  private readonly options: ApprovalRepositoryOptions;
  private readonly scope: ApprovalScope;
  private readonly sources: ApprovalSources;
  private readonly now: () => number;
  constructor(db: DatabaseSync, options: ApprovalRepositoryOptions) {
    this.db = db; this.options = options; this.scope = approvalScopeSchema.parse(options.scope); this.sources = options.sources ?? {}; this.now = options.now ?? Date.now;
    const actual = db.prepare("SELECT workspace_id, account_id FROM agent_scope WHERE id=1").get();
    if (!actual || actual.workspace_id !== this.scope.workspaceId || actual.account_id !== this.scope.accountId) error("DATABASE_SCOPE_MISMATCH");
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='capability_scope'").get()) {
      const environment = db.prepare("SELECT environment FROM capability_scope WHERE id=1").get();
      if (environment && environment.environment !== this.scope.environment) error("DATABASE_SCOPE_MISMATCH");
    }
    db.exec(`CREATE TABLE IF NOT EXISTS approval_scope(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_manifests(ref TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(ref,version));
      CREATE TABLE IF NOT EXISTS approval_heads(ref TEXT PRIMARY KEY, version INTEGER NOT NULL, revision INTEGER NOT NULL, hold TEXT);
      CREATE TABLE IF NOT EXISTS approval_commands(key TEXT PRIMARY KEY, hash TEXT NOT NULL, ref TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_outbox(ref TEXT PRIMARY KEY, approval_ref TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_events(event_key TEXT PRIMARY KEY, hash TEXT NOT NULL, intent_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_decision_slots(ref TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, intent_ref TEXT NOT NULL, PRIMARY KEY(ref,version,kind));
      CREATE TABLE IF NOT EXISTS approval_decisions(ref TEXT PRIMARY KEY, approval_ref TEXT NOT NULL, version INTEGER NOT NULL, intent_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_verifications(ref TEXT PRIMARY KEY, approval_ref TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_current(ref TEXT PRIMARY KEY, version INTEGER NOT NULL, reasons TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_source_observations(ref TEXT PRIMARY KEY, source TEXT NOT NULL, source_key TEXT NOT NULL, body TEXT NOT NULL, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_outcomes(ref TEXT PRIMARY KEY, approval_ref TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approval_audit(ref TEXT PRIMARY KEY, approval_ref TEXT, event_hash TEXT, reason TEXT NOT NULL, observed_at TEXT NOT NULL);`);
    db.prepare("INSERT OR IGNORE INTO approval_scope VALUES(1,?)").run(JSON.stringify(this.scope));
    if (!sameApprovalScope(parse<ApprovalScope>(db.prepare("SELECT body FROM approval_scope WHERE id=1").get()!.body), this.scope)) error("DATABASE_SCOPE_MISMATCH");
  }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const result = fn(); this.db.exec("COMMIT"); return result; } catch (cause) { this.db.exec("ROLLBACK"); throw cause; } }
  private audit(ref: string | null, reason: string, event?: unknown) { this.db.prepare("INSERT INTO approval_audit VALUES(?,?,?,?,?)").run(randomUUID(), ref, event === undefined ? null : digest(event), reason, new Date(this.now()).toISOString()); }
  private sourceObservation(source: "linear" | "slack", sourceKey: string, observation: unknown): void {
    this.db.prepare("INSERT INTO approval_source_observations VALUES(?,?,?,?,?)").run(randomUUID(), source, sourceKey, JSON.stringify(observation), new Date(this.now()).toISOString());
  }
  private assertSources(manifest: ApprovalManifest, draft: ApprovalDraft, authority: ApprovalAuthoritySnapshot, now: number): void {
    if (!this.sources.assertCurrent || !this.options.registry?.assertCurrentDraft) return error("APPROVAL_CURRENT_AUTHORITY_UNAVAILABLE");
    if (!sameApprovalScope(authority.scope, this.scope) || !fresh(authority.actor.observedAt, authority.actor.validUntil, now)) return error("AUTHORITY_REQUIRED");
    if (authority.slack && !fresh(authority.slack.observedAt, authority.slack.validUntil, now) || authority.linearRecords.some(record => !fresh(record.observedAt, record.validUntil, now))) return error("APPROVAL_PROOF_EXPIRED");
    try { this.sources.assertCurrent(authority, now); this.options.registry.assertCurrentDraft(manifest, draft, now); }
    catch (cause) { if (cause instanceof ApprovalError) throw cause; return error("APPROVAL_CURRENT_SOURCE_UNVERIFIED"); }
  }
  /** Caller owns the transaction. Only an existing, scoped source intent/event may reach this path. */
  private fenceObservation(ref: string, version: number, reason: string): void {
    if (this.head(ref)?.version !== version) return;
    this.db.prepare("INSERT INTO approval_current VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET version=excluded.version,reasons=excluded.reasons").run(ref, version, JSON.stringify([reason]));
    this.db.prepare("UPDATE approval_heads SET revision=revision+1 WHERE ref=?").run(ref);
    this.audit(ref, reason);
  }
  private fenceKnownEvent(locator: SlackDecisionLocator, reason: string): void {
    const row = this.db.prepare("SELECT intent_ref FROM approval_events WHERE event_key=?").get(digest({ scope: this.scope, locator }));
    const box = row ? this.outbox(String(row.intent_ref)) : null;
    if (box) this.tx(() => this.fenceObservation(box.intent.approvalRef, box.intent.manifestVersion, reason));
  }
  private policy() { try { return currentPolicy(this.options.currentPolicy?.(), this.scope, this.now()); } catch { return null; } }
  private head(ref: string): Head | null { const row = this.db.prepare("SELECT version,revision,hold FROM approval_heads WHERE ref=?").get(ref); return row ? { version: Number(row.version), revision: Number(row.revision), hold: row.hold === null ? null : String(row.hold) } : null; }
  private manifest(ref: string, version?: number): ApprovalManifest | null { const v = version ?? this.head(ref)?.version; if (!v) return null; const row = this.db.prepare("SELECT body FROM approval_manifests WHERE ref=? AND version=?").get(ref, v); return row ? parse<ApprovalManifest>(row.body) : null; }
  private outbox(ref: string): Outbox | null { const row = this.db.prepare("SELECT body FROM approval_outbox WHERE ref=?").get(ref); return row ? parse<Outbox>(row.body) : null; }
  private boxes(ref: string, version: number): Outbox[] { return this.db.prepare("SELECT body FROM approval_outbox WHERE approval_ref=? AND version=? ORDER BY ref").all(ref, version).map(row => parse<Outbox>(row.body)); }
  private saveBox(box: Outbox) { this.db.prepare("INSERT INTO approval_outbox VALUES(?,?,?,?) ON CONFLICT(ref) DO UPDATE SET body=excluded.body").run(box.intent.intentRef, box.intent.approvalRef, box.intent.manifestVersion, JSON.stringify(box)); }
  private receipts(ref: string, version: number): DecisionReceipt[] { return this.db.prepare("SELECT body FROM approval_decisions WHERE approval_ref=? AND version=? ORDER BY rowid").all(ref, version).map(row => parse<DecisionReceipt>(row.body)); }
  private commandKey(operation: string, principal: ApprovalPrincipal, key: string) { if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$/.test(key)) error("INVALID_IDEMPOTENCY_KEY"); return digest({ scope: this.scope, operation, principal, key }); }
  private command(key: string, input: unknown) { const row = this.db.prepare("SELECT hash,ref,version FROM approval_commands WHERE key=?").get(key); if (row && row.hash !== digest(input)) error("IDEMPOTENCY_KEY_REUSED"); return row ? { ref: String(row.ref), version: Number(row.version) } : null; }
  private saveCommand(key: string, input: unknown, ref: string, version: number) { this.db.prepare("INSERT INTO approval_commands VALUES(?,?,?,?)").run(key, digest(input), ref, version); }
  private checkHead(manifest: ApprovalManifest, revision?: number): Head { const head = this.head(manifest.approvalRef); if (!head || head.version !== manifest.manifestVersion || revision !== undefined && head.revision !== revision) return error("APPROVAL_VERSION_CHANGED"); return head; }
  private async human(principal: ApprovalPrincipal) { const human = await resolveHuman(this.sources, principal.principalRef, this.scope, this.now); if (!human || !actorCanPropose(human, this.now())) return error("AUTHORITY_REQUIRED"); return human; }
  private makeIntent(manifest: ApprovalManifest, kind: LinearRecordIntent["kind"], decision: VerifiedSlackDecision | null = null, outcomeRef: string | null = null): LinearRecordIntent {
    const intentRef = `j04:intent:${digest({ scope: this.scope, ref: manifest.approvalRef, version: manifest.manifestVersion, kind, event: decision?.locator ?? null, outcomeRef })}`;
    const preview = { manifestRef: `j04:manifest:${manifest.approvalRef}:${manifest.manifestVersion}`, actionKind: manifest.draft.actionKind, providerAccountRef: manifest.draft.providerAccountRef,
      recipientRefs: manifest.items.map(item => item.targetRef), payloadHash: manifest.draft.payloadHash, termsVersion: manifest.draft.termsVersion, rightsVersion: manifest.draft.rightsVersion,
      policyVersion: manifest.draft.policyVersion, bounds: manifest.draft.bounds, expiresAt: manifest.draft.expiresAt };
    return { scope: this.scope, intentRef, kind, issueRef: manifest.draft.linearIssueRef, approvalRef: manifest.approvalRef, manifestVersion: manifest.manifestVersion, manifestHash: manifest.manifestHash,
      contentHash: digest({ preview, manifestHash: manifest.manifestHash, kind, decision: decision ? stableSlack(decision) : null, outcomeRef }), preview, decision, outcomeRef };
  }
  private ensureBox(intent: LinearRecordIntent) { const prior = this.outbox(intent.intentRef); if (prior) { if (prior.intent.contentHash !== intent.contentHash) error("SOURCE_EVENT_CHANGED"); return prior; } const box: Outbox = { intent, state: "pending", attempts: 0, record: null }; this.saveBox(box); return box; }
  private async writeFence(intent: LinearRecordIntent): Promise<WriteFence | null> {
    const manifest = this.manifest(intent.approvalRef, intent.manifestVersion), head = this.head(intent.approvalRef);
    if (!manifest || !head || head.version !== intent.manifestVersion || head.hold || !this.options.registry) return null;
    let draft: ApprovalDraft;
    try { draft = approvalDraftSchema.parse(await this.options.registry.currentDraft(manifest)); } catch { return null; }
    if (digest(stableApprovalDraft(draft)) !== digest(stableApprovalDraft(manifest.draft))) return null;
    const actor = await resolveHuman(this.sources, intent.decision?.principalRef ?? manifest.proposer.principalRef, this.scope, this.now);
    const slack = intent.decision ? await readSlack(this.sources, intent.decision.locator, this.scope, this.now) : null;
    const policy = this.policy();
    if (!actor || !actorCanPropose(actor, this.now()) || !policy || policyHash(policy) !== manifest.policyHash || draftPolicyReasons(draft, policy, this.now()).length) return null;
    if (intent.decision && (!slack || slack.state !== "current" || digest(stableSlack(slack)) !== digest(stableSlack(intent.decision)) || actor.personRef !== slack.personRef || decisionAuthorityReasons(manifest, actor, policy, this.now()).length)) return null;
    const validUntil = minTime(actor.validUntil, policy.validUntil, draft.sourceValidUntil, draft.expiresAt, ...(slack ? [slack.validUntil] : []),
      ...Object.values(draft.gates).flatMap(gate => gate.state === "satisfied" ? [gate.validUntil] : []), ...(draft.historicalLiability ? [draft.historicalLiability.validUntil] : []));
    return { manifest, draft, authority: { scope: this.scope, actor, slack, linearRecords: [], linearWriteIntent: intent }, revision: head.revision, policyHash: policyHash(policy), validUntil };
  }

  async preparePreview(raw: ProposeCommand, actor: ApprovalPrincipal, idempotencyKey: string): Promise<ApprovalRead> {
    const command = proposeCommandSchema.parse(raw), principal = principalSchema.parse(actor), key = this.commandKey("propose", principal, idempotencyKey);
    const human = await this.human(principal), prior = this.command(key, command); if (prior) return this.readVersion(prior.ref, prior.version)!;
    if (!this.options.registry) return error("APPROVAL_SOURCE_UNAVAILABLE");
    const draft = approvalDraftSchema.parse(await this.options.registry.resolvePreview(command, principal, this.scope));
    if (draft.actionKind !== command.actionKind || digest([...draft.items.map(item => item.itemRef)].sort()) !== digest([...command.selectionRefs].sort())) error("PREVIEW_SELECTION_MISMATCH");
    const policy = this.policy(); if (!policy) return error("APPROVAL_POLICY_UNAVAILABLE");
    const reasons = draftPolicyReasons(draft, policy, this.now()); if (reasons.length) return error(reasons[0]!);
    if (!actorCanPropose(human, this.now())) return error("AUTHORITY_REQUIRED");
    const ref = command.approvalRef ?? `j04:approval:${randomUUID()}`;
    return this.tx(() => {
      const repeated = this.command(key, command); if (repeated) return this.readVersion(repeated.ref, repeated.version)!;
      const head = this.head(ref); if ((head?.version ?? 0) !== command.expectedVersion) return error("APPROVAL_VERSION_CHANGED");
      const policyNow = this.policy(); if (!policyNow || policyHash(policyNow) !== policyHash(policy)) return error("APPROVAL_POLICY_CHANGED");
      const manifestVersion = command.expectedVersion + 1, proposer = { principalRef: human.principalRef, personRef: human.personRef, directoryVersion: human.directoryVersion };
      const items = draft.items.map(item => ({ ...item, itemHash: digest(item) }));
      const manifest: ApprovalManifest = { scope: this.scope, approvalRef: ref, manifestVersion, policyHash: policyHash(policy), proposer, createdAt: new Date(this.now()).toISOString(), draft, items,
        manifestHash: digest({ scope: this.scope, ref, manifestVersion, proposer, draft: stableApprovalDraft(draft), policyHash: policyHash(policy) }) };
      this.assertSources(manifest, draft, { scope: this.scope, actor: human, slack: null, linearRecords: [] }, this.now());
      this.db.prepare("INSERT INTO approval_manifests VALUES(?,?,?)").run(ref, manifestVersion, JSON.stringify(manifest));
      this.db.prepare("INSERT INTO approval_heads VALUES(?,?,1,NULL) ON CONFLICT(ref) DO UPDATE SET version=excluded.version,revision=approval_heads.revision+1,hold=NULL").run(ref, manifestVersion);
      this.saveCommand(key, command, ref, manifestVersion); this.audit(ref, "PREVIEW_RECORDED"); return this.readVersion(ref, manifestVersion)!;
    });
  }

  private async observeBox(intentRef: string, allowWrite: boolean): Promise<Outbox> {
    let box = this.outbox(intentRef); if (!box) return error("APPROVAL_INTENT_NOT_FOUND");
    let read = await readLinear(this.sources, box.intent, this.now);
    if (read.state === "absent" && allowWrite && this.sources.writeLinearRecord) {
      const outcomeRow = box.intent.kind === "outcome" && box.intent.outcomeRef ? this.db.prepare("SELECT body FROM approval_outcomes WHERE ref=?").get(box.intent.outcomeRef) : null;
      const outcome = outcomeRow ? parse<VerifiedExistingJobOutcome>(outcomeRow.body) : null;
      const fence = outcome ? null : await this.writeFence(box.intent);
      const mayWrite = this.tx(() => {
        const current = this.outbox(intentRef)!; if (current.attempts !== 0) return false;
        // Linking a confirmed historical source fact is not a new action authorization, even after cancellation/expiry.
        if (outcome) {
          if (!this.options.verifyOutcome?.(outcome)) return false;
          current.attempts = 1; current.state = "attempted"; this.saveBox(current); return true;
        }
        if (!fence) return false;
        const head = this.head(fence.manifest.approvalRef), policy = this.policy();
        if (!head || head.version !== fence.manifest.manifestVersion || head.revision !== fence.revision || head.hold || !policy || policyHash(policy) !== fence.policyHash || Date.parse(fence.validUntil) <= this.now()) return false;
        this.assertSources(fence.manifest, fence.draft, fence.authority, this.now());
        current.attempts = 1; current.state = "attempted"; this.saveBox(current); return true;
      });
      if (mayWrite) {
        // Mark before the network await. A lost response remains uncertain and never gets a fresh write slot.
        try { await this.sources.writeLinearRecord(box.intent); } catch { /* Readback is the only authority. */ }
        read = await readLinear(this.sources, box.intent, this.now);
      }
    }
    box = this.tx(() => {
      const current = this.outbox(intentRef)!;
      this.sourceObservation("linear", intentRef, read.state === "recorded" ? read : { state: read.state, reasonCode: read.state === "denied" ? "LINEAR_SOURCE_DENIED" : "LINEAR_READBACK_UNVERIFIED" });
      if (read.state === "recorded") { current.record = read; current.state = "recorded"; }
      else { current.state = current.attempts > 0 || current.record ? "uncertain" : "pending"; current.record = null;
        if (current.intent.kind !== "outcome") this.fenceObservation(current.intent.approvalRef, current.intent.manifestVersion, current.intent.kind === "request" ? "APPROVAL_REQUEST_UNVERIFIED" : "DECISION_READBACK_UNVERIFIED"); }
      this.saveBox(current); return current;
    });
    return box;
  }
  async requestDecision(raw: ApprovalCommand, actor: ApprovalPrincipal, idempotencyKey: string): Promise<ApprovalRead> {
    const command = approvalCommandSchema.parse(raw), principal = principalSchema.parse(actor), key = this.commandKey("request", principal, idempotencyKey);
    await this.human(principal); const prior = this.command(key, command);
    const manifest = this.manifest(command.approvalRef, command.expectedVersion); if (!manifest) return error("APPROVAL_NOT_FOUND");
    const intent = this.makeIntent(manifest, "request");
    this.tx(() => { if (!prior) { this.checkHead(manifest); this.ensureBox(intent); this.saveCommand(key, command, manifest.approvalRef, manifest.manifestVersion); } });
    await this.observeBox(intent.intentRef, !prior || this.outbox(intent.intentRef)?.attempts === 0); return this.readVersion(manifest.approvalRef, manifest.manifestVersion)!;
  }

  async observeDecision(raw: SlackDecisionLocator, ingress: TrustedApprovalIngress): Promise<ApprovalRead> {
    try { return await this.ingestDecision(raw, ingress); }
    catch (cause) { this.audit(null, cause instanceof ApprovalError ? cause.code : "DECISION_INPUT_INVALID", raw); throw cause; }
  }
  private async ingestDecision(raw: SlackDecisionLocator, ingress: TrustedApprovalIngress): Promise<ApprovalRead> {
    const locator = slackDecisionLocatorSchema.parse(raw);
    if (!ingress?.ingressRef) return error("APPROVAL_INGRESS_UNVERIFIED");
    const event = await readSlack(this.sources, locator, this.scope, this.now, ingress);
    this.sourceObservation("slack", digest({ scope: this.scope, locator }), event ?? { state: "unavailable", locator });
    if (!event || event.state !== "current") { this.fenceKnownEvent(locator, "SLACK_DECISION_UNVERIFIED"); this.audit(event?.approvalRef ?? null, "SLACK_DECISION_UNVERIFIED", locator); return error("SLACK_DECISION_UNVERIFIED"); }
    const knownEvent = this.db.prepare("SELECT hash FROM approval_events WHERE event_key=?").get(digest({ scope: this.scope, locator }));
    if (knownEvent && knownEvent.hash !== digest(stableSlack(event))) { this.fenceKnownEvent(locator, "SOURCE_EVENT_CHANGED"); return error("SOURCE_EVENT_CHANGED"); }
    const manifest = this.manifest(event.approvalRef, event.manifestVersion); if (!manifest || manifest.manifestHash !== event.manifestHash) return error("APPROVAL_VERSION_CHANGED");
    if (Date.parse(event.decidedAt) < Date.parse(manifest.createdAt) || Date.parse(event.decidedAt) >= Date.parse(manifest.draft.expiresAt)) return error("DECISION_TIME_INVALID");
    if ((event.decision === "editRequired") !== (event.proposedEditRef !== null)) return error("DECISION_EDIT_INVALID");
    const head = this.checkHead(manifest);
    let human: TrustedHuman;
    try { human = await this.human({ principalRef: event.principalRef }); }
    catch (cause) { if (knownEvent) this.fenceKnownEvent(locator, "AUTHORITY_REQUIRED"); throw cause; }
    if (head.hold) return error(head.hold);
    let observedDraft: ApprovalDraft;
    try { observedDraft = approvalDraftSchema.parse(await this.options.registry?.currentDraft(manifest)); } catch { return error("APPROVAL_SOURCE_UNAVAILABLE"); }
    if (digest(stableApprovalDraft(observedDraft)) !== digest(stableApprovalDraft(manifest.draft))) return error("APPROVAL_SOURCE_CHANGED");
    const policy = this.policy(); if (!policy || policyHash(policy) !== manifest.policyHash) return error("APPROVAL_POLICY_CHANGED");
    if (human.personRef !== event.personRef) return error("SLACK_ACTOR_MISMATCH");
    const reasons = [...draftPolicyReasons(observedDraft, policy, this.now()), ...decisionAuthorityReasons(manifest, human, policy, this.now())];
    if (reasons.length) { this.audit(manifest.approvalRef, reasons[0]!, locator); return error(reasons[0]!); }
    const request = this.boxes(manifest.approvalRef, manifest.manifestVersion).find(value => value.intent.kind === "request");
    if (!request?.record || request.record.recordRef !== event.requestRecordRef) return error("APPROVAL_REQUEST_UNVERIFIED");
    const intent = this.makeIntent(manifest, "decision", event), eventKey = digest({ scope: this.scope, locator }), eventHash = digest(stableSlack(event));
    const allowWrite = this.tx(() => {
      this.checkHead(manifest, head.revision);
      const prior = this.db.prepare("SELECT hash,intent_ref FROM approval_events WHERE event_key=?").get(eventKey);
      if (prior) { if (prior.hash !== eventHash) return error("SOURCE_EVENT_CHANGED"); return this.outbox(String(prior.intent_ref))?.attempts === 0; }
      const kind = event.decision === "canceled" ? "cancel" : "decision";
      if (this.db.prepare("SELECT intent_ref FROM approval_decision_slots WHERE ref=? AND version=? AND kind=?").get(manifest.approvalRef, manifest.manifestVersion, kind)) return error("APPROVAL_ALREADY_DECIDED");
      this.db.prepare("INSERT INTO approval_decision_slots VALUES(?,?,?,?)").run(manifest.approvalRef, manifest.manifestVersion, kind, intent.intentRef);
      this.db.prepare("INSERT INTO approval_events VALUES(?,?,?)").run(eventKey, eventHash, intent.intentRef); this.ensureBox(intent); return true;
    });
    await this.observeBox(intent.intentRef, allowWrite);
    await this.finalizeDecision(intent.intentRef); return this.readVersion(manifest.approvalRef, manifest.manifestVersion)!;
  }

  private async finalizeDecision(intentRef: string): Promise<void> {
    const box = this.outbox(intentRef); if (!box?.record || !box.intent.decision) return;
    const manifest = this.manifest(box.intent.approvalRef, box.intent.manifestVersion); if (!manifest) return;
    const head = this.head(manifest.approvalRef); if (!head || head.version !== manifest.manifestVersion || head.hold) return;
    const request = this.boxes(manifest.approvalRef, manifest.manifestVersion).find(value => value.intent.kind === "request"); if (!request) return;
    const requestRead = await readLinear(this.sources, request.intent, this.now);
    const human = await resolveHuman(this.sources, box.intent.decision.principalRef, this.scope, this.now);
    const decisionRead = await readLinear(this.sources, box.intent, this.now);
    let observedDraft: ApprovalDraft;
    try { observedDraft = approvalDraftSchema.parse(await this.options.registry?.currentDraft(manifest)); } catch { return; }
    if (digest(stableApprovalDraft(observedDraft)) !== digest(stableApprovalDraft(manifest.draft))) return;
    const slack = await readSlack(this.sources, box.intent.decision.locator, this.scope, this.now);
    const policy = this.policy();
    if (!human || !slack || slack.state !== "current" || digest(stableSlack(slack)) !== digest(stableSlack(box.intent.decision)) || human.personRef !== slack.personRef ||
      requestRead.state !== "recorded" || requestRead.recordRef !== slack.requestRecordRef || decisionRead.state !== "recorded" || !policy || policyHash(policy) !== manifest.policyHash ||
      !fresh(human.observedAt, human.validUntil, this.now()) || !fresh(requestRead.observedAt, requestRead.validUntil, this.now()) || !fresh(decisionRead.observedAt, decisionRead.validUntil, this.now()) ||
      decisionAuthorityReasons(manifest, human, policy, this.now()).length || draftPolicyReasons(observedDraft, policy, this.now()).length) {
      this.audit(manifest.approvalRef, "DECISION_READBACK_UNVERIFIED"); return;
    }
    this.tx(() => {
      this.checkHead(manifest, head.revision);
      this.assertSources(manifest, observedDraft, { scope: this.scope, actor: human, slack, linearRecords: [requestRead, decisionRead] }, this.now());
      if (this.db.prepare("SELECT ref FROM approval_decisions WHERE intent_ref=?").get(intentRef)) return;
      const receipt: DecisionReceipt = { receiptRef: `j04:decision:${randomUUID()}`, scope: this.scope, approvalRef: manifest.approvalRef, manifestVersion: manifest.manifestVersion, manifestHash: manifest.manifestHash,
        decision: slack.decision, decidedAt: slack.decidedAt, principalRef: human.principalRef, personRef: human.personRef, directoryVersion: human.directoryVersion, proposedEditRef: slack.proposedEditRef, policyVersion: policy.version,
        linearRecordRef: decisionRead.recordRef, linearSourceVersion: decisionRead.sourceVersion, linearContentHash: decisionRead.contentHash, slack: slack.locator, slackSourceVersion: slack.sourceVersion,
        expiresAt: manifest.draft.expiresAt, bounds: manifest.draft.bounds };
      this.db.prepare("INSERT INTO approval_decisions VALUES(?,?,?,?,?)").run(receipt.receiptRef, manifest.approvalRef, manifest.manifestVersion, intentRef, JSON.stringify(receipt));
      this.db.prepare("UPDATE approval_heads SET revision=revision+1,hold=? WHERE ref=?").run(slack.decision === "canceled" ? "APPROVAL_CANCELED" : null, manifest.approvalRef);
      this.audit(manifest.approvalRef, "DECISION_CONFIRMED");
    });
  }

  async reconcileDecision(raw: ApprovalCommand, actor: ApprovalPrincipal, idempotencyKey: string): Promise<ApprovalRead> {
    const command = approvalCommandSchema.parse(raw), principal = principalSchema.parse(actor), key = this.commandKey("reconcile", principal, idempotencyKey);
    await this.human(principal); this.command(key, command);
    const manifest = this.manifest(command.approvalRef, command.expectedVersion); if (!manifest) return error("APPROVAL_NOT_FOUND");
    this.tx(() => { if (!this.command(key, command)) this.saveCommand(key, command, manifest.approvalRef, manifest.manifestVersion); });
    for (const box of this.boxes(manifest.approvalRef, manifest.manifestVersion)) {
      await this.observeBox(box.intent.intentRef, false);
      if (box.intent.kind === "decision") await this.finalizeDecision(box.intent.intentRef);
    }
    if (this.receipts(manifest.approvalRef, manifest.manifestVersion).at(-1)?.decision === "approved") await this.resolveCurrentProof(approvalDispatchBinding(manifest, manifest.items[0]!.itemRef));
    return this.readVersion(manifest.approvalRef, manifest.manifestVersion)!;
  }

  readApproval(ref: string, manifestVersion?: number): ApprovalRead | null { return this.readVersion(ref, manifestVersion); }
  /** Internal certainty lookup only. Callers must not expose protected payloads after an authorization failure. */
  readCommand(kind: "propose" | "request" | "reconcile", raw: ProposeCommand | ApprovalCommand, actor: ApprovalPrincipal, idempotencyKey: string): ApprovalRead | null {
    if (!["propose", "request", "reconcile"].includes(kind)) return error("INVALID_APPROVAL_OPERATION");
    const command = kind === "propose" ? proposeCommandSchema.parse(raw) : approvalCommandSchema.parse(raw), principal = principalSchema.parse(actor);
    const prior = this.command(this.commandKey(kind, principal, idempotencyKey), command); return prior ? this.readVersion(prior.ref, prior.version) : null;
  }
  private readVersion(ref: string, version?: number): ApprovalRead | null {
    const manifest = this.manifest(ref, version), head = this.head(ref); if (!manifest || !head) return null;
    const boxes = this.boxes(ref, manifest.manifestVersion), request = boxes.find(box => box.intent.kind === "request"), receipts = this.receipts(ref, manifest.manifestVersion), receipt = receipts.at(-1) ?? null;
    const latest = this.db.prepare("SELECT body FROM approval_verifications WHERE approval_ref=? ORDER BY rowid DESC LIMIT 1").get(ref);
    const verified = latest ? parse<Verification>(latest.body) : null;
    const effectiveDraft = verified && verified.proof.binding.manifestVersion === manifest.manifestVersion && verified.proof.approvalRevision === head.revision && fresh(verified.proof.observedAt, verified.proof.validUntil, this.now()) ? verified.draft : manifest.draft;
    const policy = this.policy(), reasons = draftPolicyReasons(effectiveDraft, policy, this.now());
    if (head.version !== manifest.manifestVersion) reasons.push("APPROVAL_VERSION_CHANGED"); if (head.hold) reasons.push(head.hold);
    const observed = this.db.prepare("SELECT reasons FROM approval_current WHERE ref=? AND version=?").get(ref, manifest.manifestVersion); if (observed) reasons.push(...parse<string[]>(observed.reasons));
    if (policy && policyHash(policy) !== manifest.policyHash) reasons.push("APPROVAL_POLICY_CHANGED");
    if (!request?.record || !fresh(request.record.observedAt, request.record.validUntil, this.now())) reasons.push("APPROVAL_REQUEST_UNVERIFIED");
    if (!receipt) reasons.push("DECISION_READBACK_UNVERIFIED");
    const decisionBox = receipt ? boxes.find(box => box.record?.recordRef === receipt.linearRecordRef) : null;
    if (receipt && (!decisionBox?.record || !fresh(decisionBox.record.observedAt, decisionBox.record.validUntil, this.now()))) reasons.push("DECISION_READBACK_UNVERIFIED");
    return { schemaVersion: "farda.approval.v1", manifest, revision: head.revision,
      request: { state: request?.record ? "recorded" : request?.attempts ? "uncertain" : "local", record: request?.record ?? null },
      decisionReceipt: receipt, decisionHistory: receipts,
      current: { state: reasons.length ? "held" : receipt?.decision ?? "pending", reasonCodes: [...new Set(reasons)] },
      outbox: boxes.map(box => ({ intentRef: box.intent.intentRef, kind: box.intent.kind, state: box.state, attempts: box.attempts })),
      outcomeRefs: this.db.prepare("SELECT ref FROM approval_outcomes WHERE approval_ref=? AND version=?").all(ref, manifest.manifestVersion).map(row => String(row.ref)), sourceEffect: "none" };
  }

  async resolveCurrentProof(raw: DispatchApprovalBinding): Promise<CurrentApprovalResult> {
    const binding = dispatchApprovalBindingSchema.parse(raw), manifest = this.manifest(binding.approvalRef, binding.manifestVersion);
    const receipt = manifest ? this.receipts(manifest.approvalRef, manifest.manifestVersion).at(-1) ?? null : null;
    let validBinding = false;
    const held = (...reasonCodes: string[]): CurrentApprovalResult => {
      if (manifest && validBinding) this.tx(() => {
        const current = this.head(manifest.approvalRef); if (current?.version !== manifest.manifestVersion) return;
        this.db.prepare("INSERT INTO approval_current VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET version=excluded.version,reasons=excluded.reasons").run(manifest.approvalRef, manifest.manifestVersion, JSON.stringify(reasonCodes));
        this.db.prepare("UPDATE approval_heads SET revision=revision+1 WHERE ref=?").run(manifest.approvalRef);
      });
      return { state: "held", reasonCodes, historicalReceipt: receipt };
    };
    if (!sameApprovalScope(binding.scope, this.scope) || !manifest) return held("APPROVAL_SCOPE_MISMATCH");
    if (!manifest.items.some(item => item.itemRef === binding.itemRef) || digest(binding) !== digest(approvalDispatchBinding(manifest, binding.itemRef))) return held("APPROVAL_BINDING_MISMATCH");
    validBinding = true;
    const head = this.head(manifest.approvalRef)!;
    if (head.version !== manifest.manifestVersion || head.hold || !receipt || receipt.decision !== "approved") return held(head.hold ?? "APPROVAL_NOT_CURRENT");
    if (!this.options.registry) return held("APPROVAL_SOURCE_UNAVAILABLE");
    let draft: ApprovalDraft;
    try { draft = approvalDraftSchema.parse(await this.options.registry.currentDraft(manifest)); } catch { return held("APPROVAL_SOURCE_UNAVAILABLE"); }
    if (digest(stableApprovalDraft(draft)) !== digest(stableApprovalDraft(manifest.draft))) return held("APPROVAL_SOURCE_CHANGED");
    const boxes = this.boxes(manifest.approvalRef, manifest.manifestVersion), request = boxes.find(box => box.intent.kind === "request"), decision = boxes.find(box => box.record?.recordRef === receipt.linearRecordRef);
    if (!request || !decision) return held("DECISION_READBACK_UNVERIFIED");
    const requestRead = await readLinear(this.sources, request.intent, this.now);
    const decisionRead = await readLinear(this.sources, decision.intent, this.now);
    const human = await resolveHuman(this.sources, receipt.principalRef, this.scope, this.now);
    const slack = await readSlack(this.sources, receipt.slack, this.scope, this.now);
    const policy = this.policy();
    if (!human || human.personRef !== receipt.personRef || human.directoryVersion !== receipt.directoryVersion) return held("AUTHORITY_REQUIRED");
    if (!slack || slack.state !== "current" || !decision.intent.decision || digest(stableSlack(slack)) !== digest(stableSlack(decision.intent.decision))) return held("SLACK_DECISION_UNVERIFIED");
    if (requestRead.state !== "recorded" || requestRead.recordRef !== slack.requestRecordRef || decisionRead.state !== "recorded" || decisionRead.recordRef !== receipt.linearRecordRef || decisionRead.sourceVersion !== receipt.linearSourceVersion) return held("DECISION_READBACK_UNVERIFIED");
    if (!policy || policyHash(policy) !== manifest.policyHash) return held("APPROVAL_POLICY_CHANGED");
    const reasons = [...draftPolicyReasons(draft, policy, this.now()), ...decisionAuthorityReasons(manifest, human, policy, this.now())];
    if (reasons.length) return held(...reasons);
    const leases = [draft.sourceValidUntil, draft.expiresAt, policy.validUntil, human.validUntil, slack.validUntil, requestRead.validUntil, decisionRead.validUntil,
      ...Object.values(draft.gates).flatMap(gate => gate.state === "satisfied" ? [gate.validUntil] : []), ...(draft.historicalLiability ? [draft.historicalLiability.validUntil] : [])];
    const validUntil = minTime(...leases), now = this.now();
    if (!fresh(human.observedAt, human.validUntil, now) || !fresh(requestRead.observedAt, requestRead.validUntil, now) || !fresh(decisionRead.observedAt, decisionRead.validUntil, now) || Date.parse(validUntil) <= now) return held("APPROVAL_PROOF_EXPIRED");
    const proof: VerifiedApprovalProof = { verificationRef: `j04:verification:${randomUUID()}`, binding, approvalRevision: head.revision, decisionReceipt: receipt,
      item: manifest.items.find(item => item.itemRef === binding.itemRef)!, observedAt: new Date(now).toISOString(), validUntil, policyEvidenceVersion: policyHash(policy), actorDirectoryVersion: human.directoryVersion };
    const authority: ApprovalAuthoritySnapshot = { scope: this.scope, actor: human, slack, linearRecords: [requestRead, decisionRead] };
    try { this.tx(() => { this.checkHead(manifest, head.revision);
      this.assertSources(manifest, draft, authority, this.now());
      this.saveBox({ ...request, record: requestRead, state: "recorded" }); this.saveBox({ ...decision, record: decisionRead, state: "recorded" });
      this.db.prepare("INSERT INTO approval_current VALUES(?,?,?) ON CONFLICT(ref) DO UPDATE SET version=excluded.version,reasons=excluded.reasons").run(manifest.approvalRef, manifest.manifestVersion, "[]"); this.db.prepare("INSERT INTO approval_verifications VALUES(?,?,?)").run(proof.verificationRef, manifest.approvalRef, JSON.stringify({ proof, draft, actor: human, authority, policyHash: policyHash(policy) } satisfies Verification)); }); }
    catch (cause) { return held(cause instanceof ApprovalError ? cause.code : "APPROVAL_CURRENT_SOURCE_UNVERIFIED"); }
    return { state: "verified", proof };
  }

  /** Synchronous: the dispatch owner calls this inside its existing atomic final fence. */
  assertCurrentProof(proof: VerifiedApprovalProof, now: number): void {
    const clock = this.now(); if (!Number.isFinite(now) || !Number.isFinite(clock)) return error("APPROVAL_PROOF_EXPIRED");
    now = Math.max(now, clock);
    const row = this.db.prepare("SELECT body FROM approval_verifications WHERE ref=?").get(proof.verificationRef);
    if (!row) return error("APPROVAL_PROOF_UNVERIFIED");
    const verified = parse<Verification>(row.body);
    if (digest(verified.proof) !== digest(proof) || !sameApprovalScope(proof.binding.scope, this.scope)) return error("APPROVAL_PROOF_UNVERIFIED");
    const manifest = this.manifest(proof.binding.approvalRef, proof.binding.manifestVersion); if (!manifest) return error("APPROVAL_NOT_FOUND");
    const head = this.checkHead(manifest, proof.approvalRevision); if (head.hold) return error(head.hold);
    if (!fresh(proof.observedAt, proof.validUntil, now)) return error("APPROVAL_PROOF_EXPIRED");
    const policy = this.policy(); if (!policy || policyHash(policy) !== verified.policyHash || verified.policyHash !== manifest.policyHash) return error("APPROVAL_POLICY_CHANGED");
    const reasons = [...draftPolicyReasons(verified.draft, policy, now), ...decisionAuthorityReasons(manifest, verified.actor, policy, now)]; if (reasons.length) return error(reasons[0]!);
    if (!verified.authority) return error("APPROVAL_CURRENT_AUTHORITY_UNAVAILABLE");
    this.assertSources(manifest, verified.draft, verified.authority, now);
    const receipt = this.receipts(manifest.approvalRef, manifest.manifestVersion).at(-1); if (!receipt || receipt.receiptRef !== proof.decisionReceipt.receiptRef || receipt.decision !== "approved") return error("APPROVAL_NOT_CURRENT");
  }

  recordOutcomeLink(input: VerifiedExistingJobOutcome): void {
    if (!this.options.verifyOutcome?.(input)) return error("OUTCOME_SOURCE_UNVERIFIED");
    const manifest = this.manifest(input.approvalRef, input.manifestVersion); if (!manifest || manifest.manifestHash !== input.manifestHash || !manifest.items.some(item => item.itemRef === input.itemRef)) return error("APPROVAL_BINDING_MISMATCH");
    // This seam accepts a verified existing job receipt from the dispatch owner, never a client 'sent' report.
    this.tx(() => { const prior = this.db.prepare("SELECT body FROM approval_outcomes WHERE ref=?").get(input.outcomeRef); if (prior) { if (digest(parse(prior.body)) !== digest(input)) error("OUTCOME_REFERENCE_REUSED"); return; }
      this.db.prepare("INSERT INTO approval_outcomes VALUES(?,?,?,?)").run(input.outcomeRef, input.approvalRef, input.manifestVersion, JSON.stringify(input)); this.ensureBox(this.makeIntent(manifest, "outcome", null, input.outcomeRef)); });
  }
  /** Called by the trusted dispatch owner after its native receipt is durably recorded. */
  async syncOutcomeLink(input: VerifiedExistingJobOutcome): Promise<ApprovalRead> {
    this.recordOutcomeLink(input);
    const manifest = this.manifest(input.approvalRef, input.manifestVersion)!;
    await this.observeBox(this.makeIntent(manifest, "outcome", null, input.outcomeRef).intentRef, true);
    return this.readVersion(input.approvalRef, input.manifestVersion)!;
  }
}
