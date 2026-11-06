import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import {
  JOB_ID, JOB_VERSION, HANDOFF_TARGETS, crosswalkSchema, intakeRequestSchema, intakeResultSchema, opaqueRef, routeStateSchema, sinkReceiptSchema,
  suppressionListSchema, type Crosswalk, type EvidenceRef, type Handoff, type IntakeInput, type IntakeResult, type Network, type ProfileRef,
  type RecruitmentSource, type SourceRef, type SuppressionList,
} from "./contract.ts";

type Scope = { workspaceId: string; accountId: string };
type Target = (typeof HANDOFF_TARGETS)[number];
type ProfileRow = { network: Network; profileKey: string; creatorId: string; sourceId: string | null; url: string | null; handle: string | null;
  sourceUpdatedAt: string | null; provenanceRef: string; accountId: string };

/** The canonical identity record a sink receives. It carries references only: no provider payloads or personal data beyond public handles. */
export type CanonicalRecord = {
  creatorId: string; revision: number; profiles: ProfileRow[]; relationships: { relationshipId: string; campaignKey: string; state: "active" | "closed"; recruitmentSource: RecruitmentSource }[];
  suppressed: boolean; watchlistEligibility: IntakeResult["watchlistEligibility"]; canonicalReceiptRef: string | null;
};
/** A Notion CRM or Sheets watchlist writer, injected by trusted server configuration. Both calls are keyed and must be idempotent at the sink. */
export interface IdentitySink {
  upsert(key: string, record: CanonicalRecord): unknown;
  read(key: string): unknown;
}
export interface IntakeAuthority {
  /** Permission preflight for the source route, such as the capability ledger's requireReady. Anything but Ready holds intake. */
  route?(source: RecruitmentSource, sourceAccountId: string): unknown;
  crosswalk?(version: string): unknown;
  suppression?(version: string): unknown;
  sinks?: Partial<Record<Target, IdentitySink>>;
}
export class IntakeSourceUnavailable extends Error {}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T | null => { const r = schema.safeParse(value); return r.success ? r.data : null; };
const newer = (a: string | null, b: string | null) => a !== null && (b === null || Date.parse(a) > Date.parse(b));

/** A controlled fingerprint of the profile address, whether or not the source also gives a native ID. */
export function fingerprintKeyOf(profile: Pick<ProfileRef, "source" | "url">): string | null {
  if (!profile.url) return null;
  const path = new URL(profile.url).pathname.toLowerCase().replace(/\/+$/, "");
  return `fp:${digest({ network: profile.source, path })}`;
}
/** A native ID when the source gives one, otherwise a controlled fingerprint of the profile address. Never a display name. */
export function profileKeyOf(profile: Pick<ProfileRef, "source" | "sourceId" | "url">): string | null {
  return profile.sourceId ? `id:${profile.sourceId}` : fingerprintKeyOf(profile);
}
const creatorIdFor = (network: Network, key: string) => `creator-${digest({ network, key }).slice(0, 32)}`;
const campaignKeyOf = (ref: SourceRef) => ref.canonicalId ?? (ref.sourceId ? `${ref.source}:${ref.sourceId}` : null);

/**
 * J01 intake. Identity, relationships and suppression live in the scoped agent SQLite file; Notion and Sheets receive checkpointed
 * handoffs through injected sinks. Local resolution commits before any sink is called, so a crash between writes resumes from the
 * recorded handoff state and never creates a second person.
 */
export class IntakeRepository {
  private readonly db: DatabaseSync;
  private readonly scope: Scope;
  private readonly authority: IntakeAuthority;
  private readonly now: () => Date;
  constructor(db: DatabaseSync, scope: Scope, authority: IntakeAuthority = {}, now: () => Date = () => new Date()) {
    this.db = db; this.scope = scope; this.authority = authority; this.now = now;
    const actual = db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if (actual?.workspace_id !== scope.workspaceId || actual.account_id !== scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS intake_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, event TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_events (source TEXT NOT NULL, event_id TEXT NOT NULL, hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(source,event_id));
      CREATE TABLE IF NOT EXISTS intake_creators (creator_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_profiles (network TEXT NOT NULL, profile_key TEXT NOT NULL, creator_id TEXT NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY(network,profile_key));
      CREATE TABLE IF NOT EXISTS intake_aliases (network TEXT NOT NULL, handle TEXT NOT NULL, creator_id TEXT NOT NULL, first_seen TEXT NOT NULL,
        PRIMARY KEY(network,handle,creator_id));
      CREATE TABLE IF NOT EXISTS intake_relationships (relationship_id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, campaign_key TEXT NOT NULL,
        recruitment_source TEXT NOT NULL, state TEXT NOT NULL, closed_ref TEXT, UNIQUE(creator_id,campaign_key));
      CREATE TABLE IF NOT EXISTS intake_suppressions (subject TEXT NOT NULL, source_ref TEXT NOT NULL, reason TEXT NOT NULL, version TEXT NOT NULL,
        effective_at TEXT NOT NULL, PRIMARY KEY(subject,source_ref));
      CREATE TABLE IF NOT EXISTS intake_cursors (source TEXT NOT NULL, source_account TEXT NOT NULL, cursor TEXT, event_id TEXT, paused_reason TEXT,
        updated_at TEXT NOT NULL, PRIMARY KEY(source,source_account));
      CREATE TABLE IF NOT EXISTS intake_handoffs (key TEXT PRIMARY KEY, creator_id TEXT NOT NULL, target TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL, receipt_ref TEXT, attempts INTEGER NOT NULL, body TEXT NOT NULL);`);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** Validates, resolves and records one intake event, then drives its handoffs. A replay of the same event resumes; it never redoes resolution. */
  async ingest(body: unknown, idempotencyKey: string): Promise<IntakeResult> {
    if (!idempotencyKey?.trim() || idempotencyKey.length > 240) throw new AgentConflict("IDEMPOTENCY_KEY_REQUIRED");
    const { envelope, input } = intakeRequestSchema.parse(body);
    if (envelope.accountRef.workspaceId !== this.scope.workspaceId || envelope.accountRef.accountId !== this.scope.accountId) throw new AgentConflict("JOB_SCOPE_MISMATCH");
    if (envelope.idempotencyKey !== idempotencyKey || envelope.inputHash !== digest(input)) throw new AgentConflict("JOB_INPUT_MISMATCH");
    if (envelope.mode === "propose" || envelope.mode === "executeApproved") throw new AgentConflict("MODE_NOT_SUPPORTED_BY_J01");
    if (input.recruitmentSource === "reviewed-correction" && envelope.actor.role !== "reviewer") throw new AgentConflict("REVIEWER_REQUIRED_FOR_CORRECTION");
    const now = this.now().getTime();
    if (Date.parse(envelope.requestedAt) > now || Date.parse(input.observedAt) > now) throw new AgentConflict("FUTURE_TIMESTAMP");
    if (envelope.deadline !== null && Date.parse(envelope.deadline) <= now) throw new AgentConflict("JOB_OUTSIDE_EXECUTION_WINDOW");

    const eventHash = digest({ input });
    const prior = this.db.prepare("SELECT hash FROM intake_events WHERE source=? AND event_id=?").get(input.recruitmentSource, input.eventId);
    const command = this.db.prepare("SELECT hash FROM intake_commands WHERE key=?").get(idempotencyKey);
    if (command && command.hash !== eventHash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
    if (prior) {
      if (prior.hash !== eventHash) throw new AgentConflict("EVENT_ID_REUSED");
      return this.resume(input.recruitmentSource, input.eventId);
    }
    if (envelope.mode === "reconcile") throw new AgentConflict("NOTHING_TO_RECONCILE");

    const route = parse(routeStateSchema, this.authority.route?.(input.recruitmentSource, input.sourceCandidate.accountId)) ?? "Unverified";
    if (route !== "Ready") {
      // Nothing is applied. The source pauses and keeps its last cursor, so a later import resumes where it stopped.
      this.tx(() => this.db.prepare(`INSERT INTO intake_cursors VALUES(?,?,NULL,NULL,?,?) ON CONFLICT(source,source_account)
        DO UPDATE SET paused_reason=excluded.paused_reason, updated_at=excluded.updated_at`)
        .run(input.recruitmentSource, input.sourceCandidate.accountId, `SOURCE_${route.toUpperCase()}`, this.now().toISOString()));
      throw new IntakeSourceUnavailable(`SOURCE_${route.toUpperCase()}`);
    }
    const suppression = parse(suppressionListSchema, this.authority.suppression?.(input.suppressionVersion));
    const crosswalk = parse(crosswalkSchema, this.authority.crosswalk?.(input.identityMapVersion));
    this.tx(() => {
      // A racing replay may have committed between the read above and this transaction.
      if (this.db.prepare("SELECT 1 FROM intake_events WHERE source=? AND event_id=?").get(input.recruitmentSource, input.eventId)) return;
      const result = this.resolve(input, suppression?.version === input.suppressionVersion ? suppression : null,
        crosswalk?.version === input.identityMapVersion ? crosswalk : null);
      this.db.prepare("INSERT INTO intake_events VALUES(?,?,?,?)").run(input.recruitmentSource, input.eventId, eventHash, JSON.stringify(result));
      this.db.prepare("INSERT OR IGNORE INTO intake_commands VALUES(?,?,?)").run(idempotencyKey, eventHash, `${input.recruitmentSource}/${input.eventId}`);
    });
    return this.resume(input.recruitmentSource, input.eventId);
  }

  private resolve(input: IntakeInput, suppression: SuppressionList | null, crosswalk: Crosswalk | null): IntakeResult {
    const syncedAt = this.now().toISOString();
    const reasons = new Set<string>();
    if (!suppression) reasons.add("SUPPRESSION_LIST_UNAVAILABLE");
    else for (const entry of suppression.entries) {
      const subject = entry.subject.kind === "creator" ? `creator:${entry.subject.creatorId}` : `profile:${entry.subject.network}:${entry.subject.profileKey}`;
      this.db.prepare("INSERT OR IGNORE INTO intake_suppressions VALUES(?,?,?,?,?)").run(subject, entry.sourceRef, entry.reason, suppression.version, entry.effectiveAt);
    }

    // 1. Resolve each profile by stored native ID, then by a stored fingerprint of its address, then by a reviewed crosswalk entry for either
    //    key. A profile that gains a native ID still finds the person its fingerprint was attached to. Names never match people.
    const profiles = input.profileRefs.map((profile) => {
      const key = profileKeyOf(profile);
      const fingerprint = fingerprintKeyOf(profile);
      const keys = [...new Set([key, fingerprint].filter((k): k is string => k !== null))];
      const own = key ? this.profile(profile.source, key) : null;
      const byFingerprint = fingerprint && fingerprint !== key ? this.profile(profile.source, fingerprint) : null;
      const stored = own ?? byFingerprint;
      const reviewed = stored ? null
        : keys.map((k) => crosswalk?.entries.find((e) => e.network === profile.source && e.profileKey === k)).find((e) => e !== undefined) ?? null;
      return { profile, key, keys, own, creatorId: stored?.creatorId ?? reviewed?.creatorId ?? null, stored,
        split: own !== null && byFingerprint !== null && own.creatorId !== byFingerprint.creatorId };
    });
    if (!input.profileRefs.length) reasons.add("NO_PROFILE");
    if (profiles.some((p) => p.key === null)) reasons.add("PROFILE_ID_MISSING");
    if (profiles.some((p) => p.split)) reasons.add("IDENTITY_CONFLICT");
    if (crosswalk === null && profiles.some((p) => p.key?.startsWith("fp:") && !p.stored)) reasons.add("IDENTITY_MAP_UNAVAILABLE");
    const correctionTarget = input.trigger === "correction" ? input.sourceCandidate.canonicalId : null;
    if (input.trigger === "correction" && !correctionTarget) reasons.add("CORRECTION_TARGET_MISSING");
    if (correctionTarget && !this.creatorExists(correctionTarget)) reasons.add("CORRECTION_TARGET_UNKNOWN");
    for (const p of profiles) if (p.creatorId && !p.stored && !this.creatorExists(p.creatorId)) { reasons.add("CROSSWALK_TARGET_UNKNOWN"); p.creatorId = null; }

    const matched = new Set(profiles.flatMap((p) => (p.creatorId ? [p.creatorId] : [])));
    if (correctionTarget && this.creatorExists(correctionTarget)) matched.add(correctionTarget);
    let creatorId: string | null = null;
    if (matched.size > 1) reasons.add("IDENTITY_CONFLICT");
    else if (matched.size === 1) creatorId = [...matched][0]!;
    else if (input.trigger !== "correction") {
      const native = profiles.find((p) => p.key?.startsWith("id:"));
      if (native) creatorId = creatorIdFor(native.profile.source, native.key!);
      else if (input.profileRefs.length) reasons.add("IDENTITY_UNRESOLVED");
    }
    if (reasons.has("IDENTITY_CONFLICT") || reasons.has("CORRECTION_TARGET_UNKNOWN") || reasons.has("CORRECTION_TARGET_MISSING")) creatorId = null;

    // 2. Attach profiles. A source signup or a reviewed correction may attach a fingerprint-only profile; a discovery hit may not.
    //    A profile found by its fingerprint that now carries a native ID gains a native-key row on the same creator; the fingerprint row stays.
    let changed = false;
    const profileRefs: SourceRef[] = [];
    if (creatorId) {
      if (!this.creatorExists(creatorId)) { this.db.prepare("INSERT INTO intake_creators VALUES(?,0,?)").run(creatorId, syncedAt); changed = true; }
      for (const p of profiles) {
        const attachable = p.key !== null && (p.key.startsWith("id:") || p.creatorId === creatorId || input.trigger === "signup" || input.trigger === "correction");
        if (!attachable) { reasons.add("PROFILE_FINGERPRINT_UNREVIEWED"); profileRefs.push(this.ref(p.profile, null)); continue; }
        changed = this.upsertProfile(p.profile, p.key!, creatorId, p.own, input.observedAt, reasons) || changed;
        profileRefs.push(this.ref(p.profile, creatorId));
      }
    } else for (const p of profiles) profileRefs.push(this.ref(p.profile, null));

    // 3. Relationships keep campaign history per creator; closed relationships stay closed.
    const relationshipRefs: SourceRef[] = [];
    let closed = false;
    if (creatorId && input.campaignRef) {
      const campaignKey = campaignKeyOf(input.campaignRef);
      if (!campaignKey) reasons.add("CAMPAIGN_UNRESOLVED");
      else {
        const existing = this.db.prepare("SELECT relationship_id,state FROM intake_relationships WHERE creator_id=? AND campaign_key=?").get(creatorId, campaignKey);
        const relationshipId = existing ? String(existing.relationship_id) : `relationship-${digest({ creatorId, campaignKey }).slice(0, 32)}`;
        if (!existing) {
          this.db.prepare("INSERT INTO intake_relationships VALUES(?,?,?,?,'active',NULL)").run(relationshipId, creatorId, campaignKey, input.recruitmentSource);
          changed = true;
        } else if (existing.state === "closed") { closed = true; reasons.add("RELATIONSHIP_CLOSED"); }
        relationshipRefs.push({ source: "farda-relationship", accountId: this.scope.accountId, sourceId: relationshipId, url: null, canonicalId: creatorId,
          identityState: "resolved", provenanceRef: input.campaignRef.provenanceRef });
      }
    }

    // 4. Suppression and eligibility. Suppression on the creator, on any attached profile, or on any profile key in this event
    //    (native or fingerprint, attached or not) suppresses the person.
    const suppressionReasons = [...new Set([...(creatorId ? this.suppressionReasons(creatorId) : []), ...this.profileSuppressions(profiles)])].sort();
    for (const reason of suppressionReasons) reasons.add(`SUPPRESSED_${reason.toUpperCase().replace(/-/g, "_")}`);
    const resolved = creatorId !== null && !reasons.has("IDENTITY_CONFLICT");
    const watchlistEligibility: IntakeResult["watchlistEligibility"] = suppressionReasons.length || closed ? "excluded"
      : !resolved || !suppression ? "identityPending" : "active";

    // 5. Checkpointed handoffs for a changed canonical record: Notion CRM first, then the Sheets watchlist that references it.
    //    A new eligibility or suppression state is a change too, so it reaches the sinks under a new revision's keys.
    const handoffKeys: string[] = [];
    if (creatorId) {
      const body = { watchlistEligibility, suppressed: suppressionReasons.length > 0 };
      const sent = this.db.prepare("SELECT body FROM intake_handoffs WHERE creator_id=? AND revision=? ORDER BY key LIMIT 1").get(creatorId, this.revision(creatorId));
      const prior = sent ? JSON.parse(String(sent.body)) as typeof body : null;
      if (prior && (prior.watchlistEligibility !== body.watchlistEligibility || prior.suppressed !== body.suppressed)) changed = true;
      if (changed) this.db.prepare("UPDATE intake_creators SET revision=revision+1 WHERE creator_id=?").run(creatorId);
      const revision = this.revision(creatorId);
      for (const target of HANDOFF_TARGETS) {
        const key = `${target}:${creatorId}:r${revision}`;
        handoffKeys.push(key);
        this.db.prepare("INSERT OR IGNORE INTO intake_handoffs VALUES(?,?,?,?,'pending',NULL,0,?)").run(key, creatorId, target, revision, JSON.stringify(body));
      }
    }
    if (input.cursor) {
      this.db.prepare(`INSERT INTO intake_cursors VALUES(?,?,?,?,NULL,?) ON CONFLICT(source,source_account)
        DO UPDATE SET cursor=excluded.cursor, event_id=excluded.event_id, paused_reason=NULL, updated_at=excluded.updated_at`)
        .run(input.recruitmentSource, input.sourceCandidate.accountId, JSON.stringify(input.cursor), input.eventId, syncedAt);
    }

    const evidence: EvidenceRef = {
      evidenceId: `evidence-${digest({ source: input.recruitmentSource, eventId: input.eventId }).slice(0, 32)}`, sourceRef: input.sourceCandidate.provenanceRef,
      occurredAt: input.occurredAt, observedAt: input.observedAt, syncedAt,
      sourceUpdatedAt: input.profileRefs.map((p) => p.sourceUpdatedAt).filter((t): t is string => t !== null).sort().at(-1) ?? null,
      method: ({ signup: "source-signup", discovery: "source-discovery", correction: "reviewed-correction", profileChange: "profile-change" } as const)[input.trigger],
    };
    return intakeResultSchema.parse({
      kind: "creator-intake", jobId: JOB_ID, jobVersion: JOB_VERSION, eventId: input.eventId, recruitmentSource: input.recruitmentSource,
      creatorRef: creatorId ? { source: "farda-creator", accountId: this.scope.accountId, sourceId: creatorId, url: null, canonicalId: creatorId,
        identityState: resolved ? "resolved" : "unresolved", provenanceRef: input.sourceCandidate.provenanceRef } : null,
      profileRefs, relationshipRefs, campaignRef: input.campaignRef, briefRef: input.briefRef,
      identityState: resolved ? "resolved" : "needsReview", watchlistEligibility, evidenceRefs: [evidence], reviewReasons: [...reasons].sort(),
      nextWork: watchlistEligibility !== "active" ? null : input.trigger === "discovery" ? "J20" : input.trigger === "signup" ? "J02" : null,
      handoffs: [], checkpoint: { cursor: input.cursor, handoffKeys }, identityMapVersion: input.identityMapVersion, suppressionVersion: input.suppressionVersion,
      outbound: { scored: false, invited: false, messaged: false, sampleReserved: false, paid: false },
    });
  }

  private upsertProfile(profile: ProfileRef, key: string, creatorId: string, stored: ProfileRow | null, observedAt: string, reasons: Set<string>) {
    const row: ProfileRow = { network: profile.source, profileKey: key, creatorId, sourceId: profile.sourceId, url: profile.url, handle: profile.handle,
      sourceUpdatedAt: profile.sourceUpdatedAt, provenanceRef: profile.provenanceRef, accountId: profile.accountId };
    if (profile.handle) {
      const reuse = this.db.prepare("SELECT creator_id FROM intake_aliases WHERE network=? AND handle=? AND creator_id<>?").get(profile.source, profile.handle.toLowerCase(), creatorId);
      if (reuse) reasons.add("HANDLE_PREVIOUSLY_USED_BY_ANOTHER_CREATOR");
      this.db.prepare("INSERT OR IGNORE INTO intake_aliases VALUES(?,?,?,?)").run(profile.source, profile.handle.toLowerCase(), creatorId, observedAt);
    }
    if (!stored) {
      this.db.prepare("INSERT INTO intake_profiles VALUES(?,?,?,?)").run(profile.source, key, creatorId, JSON.stringify(row));
      return true;
    }
    // A late record adds evidence but never overwrites a newer confirmed profile. Undated records never overwrite.
    if (!newer(profile.sourceUpdatedAt, stored.sourceUpdatedAt)) {
      if (profile.handle !== stored.handle || profile.url !== stored.url) reasons.add("LATE_SOURCE_RECORD");
      return false;
    }
    if (profile.handle === stored.handle && profile.url === stored.url) return false;
    this.db.prepare("UPDATE intake_profiles SET body=? WHERE network=? AND profile_key=?").run(JSON.stringify(row), profile.source, key);
    return true;
  }

  private ref(profile: ProfileRef, creatorId: string | null): SourceRef {
    return { source: profile.source, accountId: profile.accountId, sourceId: profile.sourceId, url: profile.url, canonicalId: creatorId,
      identityState: creatorId ? "resolved" : "unresolved", provenanceRef: profile.provenanceRef };
  }
  private profile(network: Network, key: string): ProfileRow | null {
    const row = this.db.prepare("SELECT body FROM intake_profiles WHERE network=? AND profile_key=?").get(network, key);
    return row ? JSON.parse(String(row.body)) as ProfileRow : null;
  }
  private creatorExists(creatorId: string) { return !!this.db.prepare("SELECT 1 FROM intake_creators WHERE creator_id=?").get(creatorId); }
  private revision(creatorId: string) { return Number(this.db.prepare("SELECT revision FROM intake_creators WHERE creator_id=?").get(creatorId)!.revision); }
  private suppressionReasons(creatorId: string): string[] {
    const keys = this.db.prepare("SELECT network,profile_key FROM intake_profiles WHERE creator_id=?").all(creatorId).map((r) => `profile:${r.network}:${r.profile_key}`);
    const subjects = [`creator:${creatorId}`, ...keys];
    const rows = this.db.prepare(`SELECT DISTINCT reason FROM intake_suppressions WHERE subject IN (${subjects.map(() => "?").join(",")}) ORDER BY reason`).all(...subjects);
    return rows.map((r) => String(r.reason));
  }
  private profileSuppressions(profiles: { profile: ProfileRef; keys: string[] }[]): string[] {
    const subjects = profiles.flatMap((p) => p.keys.map((key) => `profile:${p.profile.source}:${key}`));
    if (!subjects.length) return [];
    return this.db.prepare(`SELECT DISTINCT reason FROM intake_suppressions WHERE subject IN (${subjects.map(() => "?").join(",")}) ORDER BY reason`)
      .all(...subjects).map((r) => String(r.reason));
  }

  private canonical(creatorId: string, revision: number, notionReceipt: string | null, meta: { watchlistEligibility: IntakeResult["watchlistEligibility"]; suppressed: boolean }): CanonicalRecord {
    return {
      creatorId, revision, canonicalReceiptRef: notionReceipt, ...meta,
      profiles: this.db.prepare("SELECT body FROM intake_profiles WHERE creator_id=? ORDER BY network,profile_key").all(creatorId).map((r) => JSON.parse(String(r.body)) as ProfileRow),
      relationships: this.db.prepare("SELECT relationship_id,campaign_key,state,recruitment_source FROM intake_relationships WHERE creator_id=? ORDER BY relationship_id").all(creatorId)
        .map((r) => ({ relationshipId: String(r.relationship_id), campaignKey: String(r.campaign_key), state: r.state as "active" | "closed", recruitmentSource: r.recruitment_source as RecruitmentSource })),
    };
  }
  private handoff(key: string): Handoff & { creatorId: string; revision: number; body: string; attempts: number } {
    const row = this.db.prepare("SELECT * FROM intake_handoffs WHERE key=?").get(key)!;
    return { key, target: row.target as Target, state: row.state as Handoff["state"], receiptRef: row.receipt_ref === null ? null : String(row.receipt_ref),
      creatorId: String(row.creator_id), revision: Number(row.revision), body: String(row.body), attempts: Number(row.attempts) };
  }
  private setHandoff(key: string, state: Handoff["state"], receiptRef: string | null, attempted: boolean) {
    this.tx(() => this.db.prepare("UPDATE intake_handoffs SET state=?, receipt_ref=?, attempts=attempts+? WHERE key=?").run(state, receiptRef, attempted ? 1 : 0, key));
  }

  /**
   * Drives pending and uncertain handoffs in order. An uncertain write is read back by its key before any retry. A handoff for an older
   * revision than the creator's current one is superseded and never written, so a replayed event cannot overwrite newer data at a sink.
   */
  private async resume(source: RecruitmentSource, eventId: string): Promise<IntakeResult> {
    const result = this.event(source, eventId)!;
    let notionReceipt: string | null = null;
    for (const key of result.checkpoint.handoffKeys) {
      const h = this.handoff(key);
      if (h.state === "confirmed") { if (h.target === "notion-creator-crm") notionReceipt = h.receiptRef; continue; }
      if (h.state === "superseded") continue;
      if (h.revision < this.revision(h.creatorId)) { this.setHandoff(key, "superseded", null, false); continue; }
      const sink = this.authority.sinks?.[h.target];
      if (!sink) { this.setHandoff(key, "unavailable", null, false); break; }
      if (h.target === "sheets-watchlist" && !notionReceipt) break;
      try {
        if (h.state === "uncertain") {
          const found = parse(sinkReceiptSchema, await sink.read(key));
          if (found) { this.setHandoff(key, "confirmed", found.receiptRef, false); if (h.target === "notion-creator-crm") notionReceipt = found.receiptRef; continue; }
        }
        const receipt = parse(sinkReceiptSchema, await sink.upsert(key, this.canonical(h.creatorId, h.revision, notionReceipt, JSON.parse(h.body))));
        if (!receipt) { this.setHandoff(key, "uncertain", null, true); break; }
        this.setHandoff(key, "confirmed", receipt.receiptRef, true);
        if (h.target === "notion-creator-crm") notionReceipt = receipt.receiptRef;
      } catch {
        // The outcome is unknown. The next resume reads by key before writing again.
        this.setHandoff(key, "uncertain", null, true);
        break;
      }
    }
    return this.event(source, eventId)!;
  }

  /** The stored result of an event with its handoffs' current state. */
  event(source: RecruitmentSource, eventId: string): IntakeResult | null {
    const row = this.db.prepare("SELECT result FROM intake_events WHERE source=? AND event_id=?").get(source, eventId);
    if (!row) return null;
    const result = JSON.parse(String(row.result)) as IntakeResult;
    return { ...result, handoffs: result.checkpoint.handoffKeys.map((key) => { const { target, state, receiptRef } = this.handoff(key); return { target, key, state, receiptRef }; }) };
  }
  creator(creatorId: string) {
    const row = this.db.prepare("SELECT revision FROM intake_creators WHERE creator_id=?").get(opaqueRef.parse(creatorId));
    if (!row) return null;
    const record = this.canonical(creatorId, Number(row.revision), null, { watchlistEligibility: "identityPending", suppressed: false });
    const suppressions = this.suppressionReasons(creatorId);
    return { creatorId, revision: record.revision, profiles: record.profiles, relationships: record.relationships, suppressions,
      aliases: this.db.prepare("SELECT network,handle,first_seen FROM intake_aliases WHERE creator_id=? ORDER BY network,handle").all(creatorId)
        .map((r) => ({ network: String(r.network), handle: String(r.handle), firstSeen: String(r.first_seen) })) };
  }
  sourceStatus(source: RecruitmentSource, sourceAccountId: string) {
    const row = this.db.prepare("SELECT * FROM intake_cursors WHERE source=? AND source_account=?").get(source, sourceAccountId);
    if (!row) return null;
    return { source, sourceAccountId, cursor: row.cursor === null ? null : JSON.parse(String(row.cursor)), lastEventId: row.event_id === null ? null : String(row.event_id),
      paused: row.paused_reason !== null, pausedReason: row.paused_reason === null ? null : String(row.paused_reason), updatedAt: String(row.updated_at) };
  }
  /** Records an authoritative closure. Intake never reopens it. */
  closeRelationship(relationshipId: string, closedRef: string) {
    return this.tx(() => {
      const row = this.db.prepare("SELECT creator_id,state,closed_ref FROM intake_relationships WHERE relationship_id=?").get(opaqueRef.parse(relationshipId));
      if (!row) throw new AgentConflict("RELATIONSHIP_UNKNOWN");
      if (row.state === "closed") { if (row.closed_ref !== closedRef) throw new AgentConflict("RELATIONSHIP_ALREADY_CLOSED"); return { relationshipId, state: "closed" as const }; }
      this.db.prepare("UPDATE intake_relationships SET state='closed', closed_ref=? WHERE relationship_id=?").run(opaqueRef.parse(closedRef), relationshipId);
      this.db.prepare("UPDATE intake_creators SET revision=revision+1 WHERE creator_id=?").run(String(row.creator_id));
      return { relationshipId, state: "closed" as const };
    });
  }
}
