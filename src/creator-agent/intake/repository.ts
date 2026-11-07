import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import { IntakeHandoffs, type RevisionSnapshot } from "./handoff.ts";
import {
  JOB_ID, JOB_VERSION, HANDOFF_TARGETS, crosswalkSchema, intakeRequestSchema, intakeResultSchema, opaqueRef, routeStateSchema, type SinkBinding,
  suppressionListSchema, type Crosswalk, type EvidenceRef, type Handoff, type IntakeInput, type IntakeResult, type Network, type ProfileRef,
  type RecruitmentSource, type SourceRef, type SuppressionList,
} from "./contract.ts";

type Scope = { workspaceId: string; accountId: string };
type Target = (typeof HANDOFF_TARGETS)[number];
type ProfileRow = { network: Network; profileKey: string; creatorId: string; sourceId: string | null; url: string | null; handle: string | null;
  sourceUpdatedAt: string | null; provenanceRef: string; accountId: string };

/** The canonical identity record a sink receives. It carries references only: no provider payloads or personal data beyond public handles. */
export type CanonicalRecord = {
  creatorId:string;revision:number;profiles:ProfileRow[];
  relationships:{relationshipId:string;campaignKey:string;state:"active"|"closed";recruitmentSource:RecruitmentSource;campaignRef:SourceRef|null;briefRef:IntakeInput["briefRef"]}[];
  context:{sourceCandidate:SourceRef;campaignRef:SourceRef|null;briefRef:IntakeInput["briefRef"];identityMapVersion:string;suppressionVersion:string}|null;
  suppressed: boolean; watchlistEligibility: IntakeResult["watchlistEligibility"]; canonicalReceiptRef: string | null;
};
/** A Notion CRM or Sheets watchlist writer, injected by trusted server configuration. Both calls are keyed and must be idempotent at the sink. */
export interface IdentitySink {
  upsert(key:string,record:CanonicalRecord,binding:SinkBinding):unknown;
  read(key:string,binding:SinkBinding):unknown;
}
export interface IntakeAuthority {
  /** Permission preflight for the source route, such as the capability ledger's requireReady. Anything but Ready holds intake. */
  route?(source: RecruitmentSource, sourceAccountId: string): unknown;
  /** Return the current authorized source snapshot; an obsolete requested version must never impersonate current evidence. */
  crosswalk?(version:string,scope:Scope):unknown;
  suppression?(version:string,scope:Scope):unknown;
  sinks?: Partial<Record<Target, IdentitySink>>;
}
export class IntakeSourceUnavailable extends Error {}
export class IntakeReconciliationRequired extends IntakeSourceUnavailable {}

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
const scopedKey = (account:string,key:string) => JSON.stringify([account,key]);
const creatorIdFor = (network:Network,account:string,key:string) => `creator-${digest([network,account,key]).slice(0,32)}`;
const campaignKeyOf = (ref:SourceRef) => ref.canonicalId ?? (ref.sourceId ? `campaign-${digest([ref.source,ref.accountId,ref.sourceId]).slice(0,32)}` : null);
const profileSubject = (network:Network,account:string,key:string) => "profile:"+network+":"+scopedKey(account,key);

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
  private readonly delivery:IntakeHandoffs;
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
        state TEXT NOT NULL, receipt_ref TEXT, attempts INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intake_relationship_context(relationship_id TEXT PRIMARY KEY,campaign TEXT NOT NULL,brief TEXT);
      CREATE TABLE IF NOT EXISTS intake_profile_addresses(network TEXT NOT NULL,account_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        native_id TEXT NOT NULL,creator_id TEXT NOT NULL,PRIMARY KEY(network,account_id,fingerprint,native_id,creator_id));
      CREATE TABLE IF NOT EXISTS intake_event_inputs(source TEXT NOT NULL,event_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(source,event_id));`);
    this.delivery=new IntakeHandoffs(db,scope,now,()=>this.authority.sinks ?? {},snapshot=>this.sourceGate(snapshot));
    // Preserve old identity rows and their creator IDs; their historical sink receipts remain unqualified.
    this.tx(()=>{
      const legacy=db.prepare("SELECT network,profile_key,body FROM intake_profiles WHERE substr(profile_key,1,1)!='['").all();
      for (const old of legacy) {
        const p=JSON.parse(String(old.body)) as ProfileRow;
        if (typeof old.network!=="string" || typeof old.profile_key!=="string" || old.network!==p.network ||
          old.profile_key!==p.profileKey || !opaqueRef.safeParse(p.accountId).success) throw new AgentConflict("LEGACY_PROFILE_SCOPE_UNVERIFIED");
        const fp=fingerprintKeyOf({source:p.network,url:p.url});
        if (fp && p.sourceId) db.prepare("INSERT OR IGNORE INTO intake_profile_addresses VALUES(?,?,?,?,?)").run(p.network,p.accountId,fp,p.sourceId,p.creatorId);
        db.prepare("UPDATE intake_profiles SET profile_key=? WHERE network=? AND profile_key=?")
          .run(scopedKey(p.accountId,p.profileKey),old.network,old.profile_key);
      }
    });
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

    const eventHash = digest({input});
    const account=input.sourceCandidate.accountId, source=scopedKey(input.recruitmentSource,account);
    const sources=this.sources(input);
    const known=this.db.prepare("SELECT hash FROM intake_events WHERE source=? AND event_id=?").get(source,input.eventId);
    // Earlier stores did not include the source account in their event key. Match only an identical historical input.
    const legacy=!known && this.db.prepare("SELECT hash,result FROM intake_events WHERE source=? AND event_id=?").get(input.recruitmentSource,input.eventId);
    if (legacy && legacy.hash!==eventHash) throw new AgentConflict("LEGACY_EVENT_SCOPE_UNVERIFIED");
    this.tx(()=>{
      const command=this.db.prepare("SELECT hash FROM intake_commands WHERE key=?").get(idempotencyKey);
      if (command && command.hash!==eventHash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const prior=this.db.prepare("SELECT hash FROM intake_events WHERE source=? AND event_id=?").get(source,input.eventId);
      if (prior && prior.hash!==eventHash) throw new AgentConflict("EVENT_ID_REUSED");
      if (prior || legacy) {
        if (!prior && legacy) this.db.prepare("INSERT INTO intake_events VALUES(?,?,?,?)").run(source,input.eventId,eventHash,String(legacy.result));
      } else {
        if (envelope.mode==="reconcile") throw new AgentConflict("NOTHING_TO_RECONCILE");
        if (sources.route!=="Ready") return;
        const result=this.resolve(input,sources.suppression,sources.crosswalk);
        this.db.prepare("INSERT INTO intake_events VALUES(?,?,?,?)").run(source,input.eventId,eventHash,JSON.stringify(result));
      }
      this.db.prepare("INSERT OR IGNORE INTO intake_event_inputs VALUES(?,?,?)").run(source,input.eventId,JSON.stringify(input));
      this.db.prepare("INSERT OR IGNORE INTO intake_commands VALUES(?,?,?)").run(idempotencyKey,eventHash,JSON.stringify([source,input.eventId]));
      this.rememberSuppression(sources.suppression);
    });
    if (sources.route!=="Ready") {
      this.tx(()=>this.db.prepare(`INSERT INTO intake_cursors VALUES(?,?,NULL,NULL,?,?) ON CONFLICT(source,source_account)
        DO UPDATE SET paused_reason=excluded.paused_reason,updated_at=excluded.updated_at`).run(input.recruitmentSource,account,"SOURCE_"+sources.route.toUpperCase(),this.now().toISOString()));
      const previous=this.db.prepare("SELECT result FROM intake_events WHERE source=? AND event_id=?").get(source,input.eventId);
      const keys=previous ? (JSON.parse(String(previous.result)) as IntakeResult).checkpoint.handoffKeys : [];
      if (keys.some(key=>this.handoff(key).state==="uncertain")) throw new IntakeReconciliationRequired("SOURCE_"+sources.route.toUpperCase());
      throw new IntakeSourceUnavailable("SOURCE_"+sources.route.toUpperCase());
    }
    const saved=this.event(input.recruitmentSource,input.eventId,account)!;
    const creatorId=saved.creatorRef?.canonicalId;
    if (creatorId) {
      this.queueExclusion(creatorId);
      await this.delivery.drive(creatorId,envelope.deadline);
      if (this.queueExclusion(creatorId)) await this.delivery.drive(creatorId,envelope.deadline);
    }
    return this.event(input.recruitmentSource,input.eventId,account)!;
  }

  private sources(input:IntakeInput) {
    let route: z.infer<typeof routeStateSchema> = "Unverified";
    try { route=parse(routeStateSchema,this.authority.route?.(input.recruitmentSource,input.sourceCandidate.accountId)) ?? "Unverified"; } catch { /* Fail closed on source loss. */ }
    if (route!=="Ready") return {route,crosswalk:null,suppression:null};
    let c:Crosswalk|null=null,s:SuppressionList|null=null;
    try {c=parse(crosswalkSchema,this.authority.crosswalk?.(input.identityMapVersion,this.scope));} catch { /* Identity stays pending. */ }
    try {s=parse(suppressionListSchema,this.authority.suppression?.(input.suppressionVersion,this.scope));} catch { /* No active enrollment without suppression evidence. */ }
    return {route,crosswalk:c?.version===input.identityMapVersion?c:null,suppression:s?.version===input.suppressionVersion?s:null};
  }

  private queueExclusion(creatorId:string) {
    return this.tx(()=>{
      const latest=this.delivery.snapshot(creatorId,this.revision(creatorId));
      if (!latest || latest.record.watchlistEligibility==="excluded") return false;
      const current=this.sourceGate(latest);
      if (!current.canRead || !current.excluded) return false;
      this.rememberSuppression(this.sources(latest.input).suppression);
      this.db.prepare("UPDATE intake_creators SET revision=revision+1 WHERE creator_id=?").run(creatorId);
      const revision=this.revision(creatorId),meta={watchlistEligibility:"excluded" as const,suppressed:this.suppressionReasons(creatorId).length>0};
      const record={...this.canonical(creatorId,revision,null,meta),context:latest.record.context};
      this.delivery.freeze({input:latest.input,record});
      for (const target of HANDOFF_TARGETS) this.db.prepare("INSERT INTO intake_handoffs VALUES(?,?,?,?,'pending',NULL,0,?)")
        .run(target+":"+creatorId+":r"+revision,creatorId,target,revision,JSON.stringify(meta));
      return true;
    });
  }

  private rememberSuppression(list:SuppressionList|null) {
    if (!list) return;
    for (const entry of list.entries) {
      if (Date.parse(entry.effectiveAt)>this.now().getTime()) continue;
      const subject=entry.subject.kind==="creator" ? "creator:"+entry.subject.creatorId :
        profileSubject(entry.subject.network,entry.subject.accountId,entry.subject.profileKey);
      this.db.prepare("INSERT OR IGNORE INTO intake_suppressions VALUES(?,?,?,?,?)").run(subject,entry.sourceRef,entry.reason,list.version,entry.effectiveAt);
    }
  }

  private sourceGate(snapshot:RevisionSnapshot) {
    const {input,record}=snapshot, current=this.sources(input);
    const identities=[...record.profiles,...input.profileRefs.map(p=>({...p,network:p.source,profileKey:profileKeyOf(p)}))];
    const matches=(network:Network,account:string,key:string)=>identities.some(p=>p.network===network && p.accountId===account &&
      (p.profileKey===key || fingerprintKeyOf({source:network,url:p.url})===key));
    const key=input.campaignRef && campaignKeyOf(input.campaignRef);
    const closed=key ? !!this.db.prepare("SELECT 1 FROM intake_relationships WHERE creator_id=? AND campaign_key=? AND state='closed'").get(record.creatorId,key) :
      record.relationships.length>0 && record.relationships.every(r=>r.state==="closed");
    const excluded=this.suppressionReasons(record.creatorId).length>0 || closed ||
      !!current.suppression?.entries.some(e=>Date.parse(e.effectiveAt)<=this.now().getTime() && (e.subject.kind==="creator"
        ? e.subject.creatorId===record.creatorId : matches(e.subject.network,e.subject.accountId,e.subject.profileKey)));
    const currentMap=current.crosswalk && !current.crosswalk.entries.some(e=>matches(e.network,e.accountId,e.profileKey) && e.creatorId!==record.creatorId);
    const canRead=current.route==="Ready" && !!current.suppression && !!currentMap;
    const canWrite=canRead && (excluded ? record.watchlistEligibility==="excluded" : record.watchlistEligibility==="active");
    return {canRead,canWrite,excluded};
  }

  private resolve(input: IntakeInput, suppression: SuppressionList | null, crosswalk: Crosswalk | null): IntakeResult {
    const syncedAt = this.now().toISOString();
    const reasons = new Set<string>();
    if (!suppression) reasons.add("SUPPRESSION_LIST_UNAVAILABLE");
    this.rememberSuppression(suppression);
    if (!crosswalk) reasons.add("IDENTITY_MAP_UNAVAILABLE");

    // 1. Resolve each profile by stored native ID, then by a stored fingerprint of its address, then by a reviewed crosswalk entry for either
    //    key. A profile that gains a native ID still finds the person its fingerprint was attached to. Names never match people.
    const profiles = input.profileRefs.map((profile) => {
      const key = profileKeyOf(profile);
      const fingerprint = fingerprintKeyOf(profile);
      const keys = [...new Set([key, fingerprint].filter((k): k is string => k !== null))];
      const own=key ? this.profile(profile.source,profile.accountId,key) : null;
      const byFingerprint=fingerprint ? this.profile(profile.source,profile.accountId,fingerprint) : null;
      const stored=own ?? byFingerprint;
      const reviewed=crosswalk?.entries.filter(e=>e.network===profile.source && e.accountId===profile.accountId && keys.includes(e.profileKey)) ?? [];
      const owners=new Set([own?.creatorId,byFingerprint?.creatorId,...reviewed.map(e=>e.creatorId)].filter((id):id is string=>!!id));
      const addresses=fingerprint ? this.db.prepare("SELECT native_id,creator_id FROM intake_profile_addresses WHERE network=? AND account_id=? AND fingerprint=?")
        .all(profile.source,profile.accountId,fingerprint) : [];
      for (const address of addresses) owners.add(String(address.creator_id));
      const recycled=!!profile.sourceId && addresses.some(a=>a.native_id!==profile.sourceId);
      return {profile,key,keys,own,stored,creatorId:owners.size===1?[...owners][0]!:null, split:owners.size>1 || recycled};
    });
    if (!input.profileRefs.length) reasons.add("NO_PROFILE");
    if (profiles.some((p) => p.key === null)) reasons.add("PROFILE_ID_MISSING");
    const fingerprints=new Map<string,string>();
    for (const p of profiles) {
      const fp=fingerprintKeyOf(p.profile);
      if (!fp || !p.profile.sourceId) continue;
      const address=JSON.stringify([p.profile.source,p.profile.accountId,fp]);
      if (fingerprints.has(address) && fingerprints.get(address)!==p.profile.sourceId) reasons.add("IDENTITY_CONFLICT");
      fingerprints.set(address,p.profile.sourceId);
    }
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
      if (native) creatorId = creatorIdFor(native.profile.source,native.profile.accountId,native.key!);
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
        const context=this.db.prepare("SELECT campaign,brief FROM intake_relationship_context WHERE relationship_id=?").get(relationshipId);
        const campaign=JSON.stringify(input.campaignRef), brief=input.briefRef ? JSON.stringify(input.briefRef) : context?.brief ?? null;
        if (!context || context.campaign!==campaign || context.brief!==brief) {
          this.db.prepare("INSERT INTO intake_relationship_context VALUES(?,?,?) ON CONFLICT(relationship_id) DO UPDATE SET campaign=excluded.campaign,brief=excluded.brief")
            .run(relationshipId,campaign,brief);
          changed=true;
        }
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
      : !resolved || !suppression || !crosswalk ? "identityPending" : "active";

    // 5. Checkpointed handoffs for a changed canonical record: Notion CRM first, then the Sheets watchlist that references it.
    //    A new eligibility or suppression state is a change too, so it reaches the sinks under a new revision's keys.
    const handoffKeys: string[] = [];
    if (creatorId) {
      const body = { watchlistEligibility, suppressed: suppressionReasons.length > 0 };
      const sent = this.db.prepare("SELECT body FROM intake_handoffs WHERE creator_id=? AND revision=? ORDER BY key LIMIT 1").get(creatorId, this.revision(creatorId));
      const prior = sent ? JSON.parse(String(sent.body)) as typeof body : null;
      if (prior && (prior.watchlistEligibility !== body.watchlistEligibility || prior.suppressed !== body.suppressed)) changed = true;
      const previous=this.delivery.snapshot(creatorId,this.revision(creatorId));
      const context={sourceCandidate:input.sourceCandidate,campaignRef:input.campaignRef,briefRef:input.briefRef,
        identityMapVersion:input.identityMapVersion,suppressionVersion:input.suppressionVersion};
      // No authoritative snapshot can be reconstructed for legacy handoffs. Start a new version from current evidence.
      if (!previous || digest(previous.record.context)!==digest(context)) changed=true;
      if (changed) this.db.prepare("UPDATE intake_creators SET revision=revision+1 WHERE creator_id=?").run(creatorId);
      const revision = this.revision(creatorId);
      if (changed) this.delivery.freeze({input,record:{...this.canonical(creatorId,revision,null,body),context}});
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
      evidenceId:`evidence-${digest([input.recruitmentSource,input.sourceCandidate.accountId,input.eventId]).slice(0,32)}`,sourceRef:input.sourceCandidate.provenanceRef,
      occurredAt: input.occurredAt, observedAt: input.observedAt, syncedAt,
      sourceUpdatedAt:input.profileRefs.map(p=>p.sourceUpdatedAt).filter((t):t is string=>t!==null).sort((a,b)=>Date.parse(b)-Date.parse(a))[0] ?? null,
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
    const storageKey=scopedKey(profile.accountId,key);
    const address=fingerprintKeyOf(profile);
    if (address && profile.sourceId) this.db.prepare("INSERT OR IGNORE INTO intake_profile_addresses VALUES(?,?,?,?,?)")
      .run(profile.source,profile.accountId,address,profile.sourceId,creatorId);
    if (profile.handle) {
      const reuse = this.db.prepare("SELECT creator_id FROM intake_aliases WHERE network=? AND handle=? AND creator_id<>?").get(profile.source, profile.handle.toLowerCase(), creatorId);
      if (reuse) reasons.add("HANDLE_PREVIOUSLY_USED_BY_ANOTHER_CREATOR");
      this.db.prepare("INSERT OR IGNORE INTO intake_aliases VALUES(?,?,?,?)").run(profile.source, profile.handle.toLowerCase(), creatorId, observedAt);
    }
    if (!stored) {
      this.db.prepare("INSERT INTO intake_profiles VALUES(?,?,?,?)").run(profile.source,storageKey,creatorId,JSON.stringify(row));
      return true;
    }
    // A late record adds evidence but never overwrites a newer confirmed profile. Undated records never overwrite.
    if (!newer(profile.sourceUpdatedAt, stored.sourceUpdatedAt)) {
      if (profile.handle !== stored.handle || profile.url !== stored.url) reasons.add("LATE_SOURCE_RECORD");
      return false;
    }
    this.db.prepare("UPDATE intake_profiles SET body=? WHERE network=? AND profile_key=?").run(JSON.stringify(row),profile.source,storageKey);
    return true;
  }

  private ref(profile: ProfileRef, creatorId: string | null): SourceRef {
    return { source: profile.source, accountId: profile.accountId, sourceId: profile.sourceId, url: profile.url, canonicalId: creatorId,
      identityState: creatorId ? "resolved" : "unresolved", provenanceRef: profile.provenanceRef };
  }
  private profile(network:Network,account:string,key:string):ProfileRow|null {
    const row=this.db.prepare("SELECT body FROM intake_profiles WHERE network=? AND profile_key=?").get(network,scopedKey(account,key));
    return row ? JSON.parse(String(row.body)) as ProfileRow : null;
  }
  private creatorExists(creatorId: string) { return !!this.db.prepare("SELECT 1 FROM intake_creators WHERE creator_id=?").get(creatorId); }
  private revision(creatorId: string) { return Number(this.db.prepare("SELECT revision FROM intake_creators WHERE creator_id=?").get(creatorId)!.revision); }
  private suppressionReasons(creatorId: string): string[] {
    const keys=this.db.prepare("SELECT body FROM intake_profiles WHERE creator_id=?").all(creatorId).flatMap(r=>{
      const p=JSON.parse(String(r.body)) as ProfileRow, fp=fingerprintKeyOf({source:p.network,url:p.url});
      return [...new Set([p.profileKey,fp].filter((k):k is string=>!!k))].flatMap(k=>[profileSubject(p.network,p.accountId,k),"profile:"+p.network+":"+k]);
    });
    const subjects = [`creator:${creatorId}`, ...keys];
    const rows = this.db.prepare(`SELECT DISTINCT reason FROM intake_suppressions WHERE subject IN (${subjects.map(() => "?").join(",")}) ORDER BY reason`).all(...subjects);
    return rows.map((r) => String(r.reason));
  }
  private profileSuppressions(profiles: { profile: ProfileRef; keys: string[] }[]): string[] {
    const subjects=profiles.flatMap(p=>p.keys.flatMap(key=>[profileSubject(p.profile.source,p.profile.accountId,key),"profile:"+p.profile.source+":"+key]));
    if (!subjects.length) return [];
    return this.db.prepare(`SELECT DISTINCT reason FROM intake_suppressions WHERE subject IN (${subjects.map(() => "?").join(",")}) ORDER BY reason`)
      .all(...subjects).map((r) => String(r.reason));
  }

  private canonical(creatorId: string, revision: number, notionReceipt: string | null, meta: { watchlistEligibility: IntakeResult["watchlistEligibility"]; suppressed: boolean }): CanonicalRecord {
    return {
      creatorId,revision,canonicalReceiptRef:notionReceipt,context:null,...meta,
      profiles: this.db.prepare("SELECT body FROM intake_profiles WHERE creator_id=? ORDER BY network,profile_key").all(creatorId).map((r) => JSON.parse(String(r.body)) as ProfileRow),
      relationships:this.db.prepare(`SELECT r.relationship_id,r.campaign_key,r.state,r.recruitment_source,c.campaign,c.brief FROM intake_relationships r
        LEFT JOIN intake_relationship_context c ON c.relationship_id=r.relationship_id WHERE r.creator_id=? ORDER BY r.relationship_id`).all(creatorId)
        .map(r=>({relationshipId:String(r.relationship_id),campaignKey:String(r.campaign_key),state:r.state as "active"|"closed",recruitmentSource:r.recruitment_source as RecruitmentSource,
          campaignRef:r.campaign ? JSON.parse(String(r.campaign)) as SourceRef : null,briefRef:r.brief ? JSON.parse(String(r.brief)) as IntakeInput["briefRef"] : null})),
    };
  }
  private handoff(key: string): Handoff & { creatorId: string; revision: number; body: string; attempts: number } {
    const row = this.db.prepare("SELECT * FROM intake_handoffs WHERE key=?").get(key)!;
    return { key, target: row.target as Target, state: row.state as Handoff["state"], receiptRef: row.receipt_ref === null ? null : String(row.receipt_ref),
      creatorId: String(row.creator_id), revision: Number(row.revision), body: String(row.body), attempts: Number(row.attempts) };
  }
  private enrollment(creatorId:string,revision:number) {
    const snapshot=this.delivery.snapshot(creatorId,revision);
    const rows=this.db.prepare("SELECT key,target,state,receipt_ref,revision FROM intake_handoffs WHERE creator_id=? AND revision=? ORDER BY target").all(creatorId,revision);
    const handoffs=rows.map(r=>{
      const proof=this.delivery.receipt(String(r.key));
      return {key:String(r.key),target:r.target as Target,state:r.state as Handoff["state"],revision,receiptRef:proof?.receiptRef ?? null,
        recordHash:proof?.recordHash ?? null,canonicalReceiptRef:proof?.canonicalReceiptRef ?? null};
    });
    const gate=snapshot ? this.sourceGate(snapshot) : null;
    const notion=handoffs.find(h=>h.target==="notion-creator-crm"),sheets=handoffs.find(h=>h.target==="sheets-watchlist");
    const fresh=handoffs.every(h=>{
      const proof=this.delivery.receipt(h.key);
      return proof?.state==="applied" && Date.parse(proof.validUntil)>this.now().getTime();
    });
    const verified=!!(snapshot && fresh && this.revision(creatorId)===revision && gate?.canWrite && notion?.receiptRef && sheets?.receiptRef &&
      notion.state==="confirmed" && sheets.state==="confirmed" && sheets.canonicalReceiptRef===notion.receiptRef &&
      notion.recordHash===digest({...snapshot.record,canonicalReceiptRef:null}) && sheets.recordHash===digest({...snapshot.record,canonicalReceiptRef:notion.receiptRef}));
    const excluded=gate?.excluded || this.suppressionReasons(creatorId).length>0;
    return {handoffs,verified,excluded:!!excluded,canRead:gate?.canRead ?? false};
  }

  /** Without an account, only an unambiguous legacy-compatible read is supported. */
  event(source:RecruitmentSource,eventId:string,accountId?:string):IntakeResult|null {
    const rows=accountId ? this.db.prepare("SELECT result,hash FROM intake_events WHERE source=? AND event_id=?").all(scopedKey(source,accountId),eventId) :
      this.db.prepare(`SELECT result,hash FROM intake_events WHERE event_id=? AND
        (source=? OR json_extract(CASE WHEN json_valid(source) THEN source ELSE '[]' END,'$[0]')=?) LIMIT 3`).all(eventId,source,source);
    if (new Set(rows.map(r=>String(r.hash))).size>1) throw new AgentConflict("AMBIGUOUS_SOURCE_ACCOUNT");
    if (!rows[0]) return null;
    const result=JSON.parse(String(rows[0].result)) as IntakeResult;
    const handoffs=result.checkpoint.handoffKeys.map(key=>{
      const h=this.handoff(key),proof=this.delivery.receipt(key);
      return {key,target:h.target,state:h.state==="confirmed" && !proof ? "unavailable" as const : h.state,receiptRef:proof?.receiptRef ?? null};
    });
    const first=result.checkpoint.handoffKeys[0];
    const membership=first && result.creatorRef?.canonicalId ? this.enrollment(result.creatorRef.canonicalId,this.handoff(first).revision) : null;
    const eligibility: IntakeResult["watchlistEligibility"] = result.watchlistEligibility==="excluded" || membership?.excluded ? "excluded" :
      result.watchlistEligibility==="active" && membership?.verified ? "active" : "identityPending";
    const reason=eligibility==="identityPending" && result.watchlistEligibility==="active" ? ["CANONICAL_HANDOFF_UNVERIFIED"] : [];
    return {...result,handoffs,watchlistEligibility:eligibility,nextWork:eligibility==="active"?result.nextWork:null,
      reviewReasons:[...new Set([...result.reviewReasons,...reason])]};
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

  /** A bounded local identity projection. A legacy receipt alone never proves source enrollment. */
  monitorMembership(limit = 2000) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new AgentConflict("INVALID_MEMBERSHIP_LIMIT");
    const total = Number(this.db.prepare("SELECT COUNT(*) AS n FROM intake_creators").get()!.n);
    const records = this.db.prepare("SELECT creator_id,revision FROM intake_creators ORDER BY creator_id LIMIT ?").all(limit).map(row => {
      const creatorId = String(row.creator_id), revision = Number(row.revision);
      const creator = this.creator(creatorId)!;
      const membership=this.enrollment(creatorId,revision);
      const closed=creator.relationships.length>0 && creator.relationships.every(r=>r.state==="closed");
      const excluded=membership.excluded || closed;
      const watchlistEligibility:IntakeResult["watchlistEligibility"]=excluded?"excluded":membership.verified?"active":"identityPending";
      return {creatorId,revision,identityState:"resolved" as "resolved"|"needsReview",watchlistEligibility,
        suppressed:membership.excluded,profiles:creator.profiles.map(p=>({network:p.network,accountId:p.accountId,sourceId:p.sourceId,
          url:p.url,handle:p.handle,sourceUpdatedAt:p.sourceUpdatedAt,provenanceRef:p.provenanceRef})),
        relationships:creator.relationships,handoffs:membership.handoffs,
        sourceStatus:(membership.verified?"verified":membership.canRead?"pending":"unavailable") as "verified"|"pending"|"unavailable"};
    });
    return { records, total, complete: records.length === total };
  }
  /** Records an authoritative closure. Intake never reopens it. */
  closeRelationship(relationshipId: string, closedRef: string) {
    return this.tx(() => {
      const row = this.db.prepare("SELECT creator_id,state,closed_ref FROM intake_relationships WHERE relationship_id=?").get(opaqueRef.parse(relationshipId));
      if (!row) throw new AgentConflict("RELATIONSHIP_UNKNOWN");
      if (row.state === "closed") { if (row.closed_ref !== closedRef) throw new AgentConflict("RELATIONSHIP_ALREADY_CLOSED"); return { relationshipId, state: "closed" as const }; }
      const creatorId=String(row.creator_id),previous=this.delivery.snapshot(creatorId,this.revision(creatorId));
      this.db.prepare("UPDATE intake_relationships SET state='closed', closed_ref=? WHERE relationship_id=?").run(opaqueRef.parse(closedRef), relationshipId);
      this.db.prepare("UPDATE intake_creators SET revision=revision+1 WHERE creator_id=?").run(creatorId);
      // Closure is a new immutable fact, not a reconstruction or mutation of an older source request.
      // Legacy revisions without frozen provenance remain held until a fresh canonical event arrives.
      if (previous) {
        const revision=this.revision(creatorId),record={...this.canonical(creatorId,revision,null,{
          watchlistEligibility:previous.record.watchlistEligibility,suppressed:this.suppressionReasons(creatorId).length>0}),context:previous.record.context};
        const snapshot={input:previous.input,record};
        const excluded=this.sourceGate(snapshot).excluded;
        if (excluded) record.watchlistEligibility="excluded";
        this.delivery.freeze(snapshot);
        // Do not replay an active enrollment merely because an unrelated relationship closed.
        // The normal driver checks current authority and resolves earlier uncertain effects first.
        if (excluded) for (const target of HANDOFF_TARGETS) this.db.prepare("INSERT INTO intake_handoffs VALUES(?,?,?,?,'pending',NULL,0,?)")
          .run(target+":"+creatorId+":r"+revision,creatorId,target,revision,JSON.stringify({watchlistEligibility:"excluded",suppressed:record.suppressed}));
      }
      return { relationshipId, state: "closed" as const };
    });
  }
}
