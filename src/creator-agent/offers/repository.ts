import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "../config.ts";
import { AgentConflict } from "../store.ts";
import { assessmentBasisSchema, costKeys, offerRecordSchema, offerTermsSchema, providerFactsSchema, routeId, scopeSchema,
  type AssessmentBasis, type OfferRecord, type OfferScope, type OfferTerms, type ProviderFacts } from "./contract.ts";
import { offerScenario, proposalBlockers } from "./economics.ts";
import { projectRewards, rewardSourceSchema, type RewardSource } from "./rewards.ts";

const id=z.string().trim().min(1).max(180), time=z.string().datetime({offset:true});
const proofSchema=z.object({scope:scopeSchema,creatorId:id,provider:providerFactsSchema.shape.provider,programRef:id,sourceRef:id,validUntil:time}).strict();
const capabilityPacket=proofSchema.extend({facts:providerFactsSchema}).strict();
const costPacket=proofSchema.extend({costKey:z.enum(costKeys),minor:z.number().int().nonnegative(),currency:z.literal("USD"),productRef:id,productRevision:id}).strict();
const decisionPacket=proofSchema.extend({offerId:routeId,manifestHash:z.string().length(64),version:id,decision:z.enum(["owner-approved","creator-accepted"]),occurredAt:time}).strict();
type Change="owner-approved"|"creator-accepted";
type Snapshot={offerId:string;version:string;revision:number;recordedAt:string;manifestHash:string;terms:OfferTerms;assessment:AssessmentBasis|null;provider:ProviderFacts|null;verifiedCosts:string[]};
export interface OfferAuthority {
  assessment?(creatorId:string):AssessmentBasis|null;
  provider?(terms:OfferTerms,scope:OfferScope):unknown;
  cost?(sourceRef:string,scope:OfferScope):unknown;
  decision?(sourceRef:string,scope:OfferScope):unknown;
  reward?(sourceRef:string,scope:OfferScope):unknown;
}
export class OfferSourceUnavailable extends Error {}
const parse=<T>(schema:z.ZodType<T>,input:unknown)=>{const r=schema.safeParse(input);return r.success?r.data:null;};
const sameScope=(a:OfferScope,b:OfferScope)=>a.workspaceId===b.workspaceId&&a.accountId===b.accountId;
export class OfferRepository {
  private readonly db: DatabaseSync;
  private readonly scope: OfferScope;
  private readonly authority: OfferAuthority;
  constructor(db:DatabaseSync, scope:OfferScope, authority:OfferAuthority={}) {
    this.db=db; this.scope=scope; this.authority=authority;
    scopeSchema.parse(scope);
    const actual=db.prepare("SELECT workspace_id,account_id FROM agent_scope WHERE id=1").get();
    if(actual?.workspace_id!==scope.workspaceId || actual.account_id!==scope.accountId) throw new Error("DATABASE_SCOPE_MISMATCH");
    db.exec(`CREATE TABLE IF NOT EXISTS offer_versions (offer_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(offer_id,revision));
      CREATE TABLE IF NOT EXISTS offer_commands (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offer_decisions (offer_id TEXT NOT NULL, revision INTEGER NOT NULL, kind TEXT NOT NULL, source_ref TEXT NOT NULL UNIQUE, body TEXT NOT NULL, PRIMARY KEY(offer_id,revision,kind));
      CREATE TABLE IF NOT EXISTS offer_rewards (creator_id TEXT NOT NULL, source_ref TEXT NOT NULL UNIQUE, observed_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(creator_id,observed_at));
      CREATE TABLE IF NOT EXISTS offer_reward_awards (creator_id TEXT NOT NULL,tier TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(creator_id,tier));`);
  }
  private apply<T>(key:string,command:unknown,fn:()=>T):T {
    if(!key?.trim() || key.length>240) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const hash=digest(command);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior=this.db.prepare("SELECT hash,body FROM offer_commands WHERE key=?").get(key);
      if(prior && prior.hash!==hash) throw new AgentConflict("IDEMPOTENCY_KEY_REUSED");
      const result=prior?JSON.parse(String(prior.body)) as T:fn();
      if(!prior)this.db.prepare("INSERT INTO offer_commands VALUES(?,?,?)").run(key,hash,JSON.stringify(result));
      this.db.exec("COMMIT");return result;
    } catch(error){this.db.exec("ROLLBACK");throw error;}
  }
  private snapshot(offerId:string,revision?:number):Snapshot|null {
    const row=revision===undefined?this.db.prepare("SELECT body FROM offer_versions WHERE offer_id=? ORDER BY revision DESC LIMIT 1").get(offerId):
      this.db.prepare("SELECT body FROM offer_versions WHERE offer_id=? AND revision=?").get(offerId,revision);
    return row?JSON.parse(String(row.body)) as Snapshot:null;
  }
  private model(terms:OfferTerms) {
    const b=parse(assessmentBasisSchema,this.authority.assessment?.(terms.creatorId));
    return b && b.creatorId===terms.creatorId && b.route===terms.checkoutRoute && b.modelId===(terms.checkoutRoute==="website"?"WEBSITE-AFFILIATE-v3":"TIKTOK-SHOP-AFFILIATE-v3")?b:null;
  }
  private provider(terms:OfferTerms,now:string) {
    const p=parse(capabilityPacket,this.authority.provider?.(terms,this.scope));
    if(!p || !sameScope(p.scope,this.scope) || p.creatorId!==terms.creatorId || p.provider!==terms.provider || p.programRef!==terms.programRef ||
      p.facts.provider!==p.provider || p.facts.programRef!==p.programRef || p.facts.sourceRef!==p.sourceRef ||
      [p.validUntil,p.facts.validUntil].some(t=>Date.parse(t)<=Date.parse(now)) || Date.parse(p.facts.observedAt)>Date.parse(now))return null;
    return p.facts;
  }
  private costs(terms:OfferTerms,now:string) {
    return costKeys.filter(key=>{
      const cost=terms.costs[key]; if(cost.minor===null || !cost.sourceRef) return false;
      const proof=parse(costPacket,this.authority.cost?.(cost.sourceRef,this.scope));
      return !!proof && sameScope(proof.scope,this.scope) && proof.sourceRef===cost.sourceRef && proof.creatorId===terms.creatorId &&
        proof.provider===terms.provider && proof.programRef===terms.programRef && proof.costKey===key && proof.minor===cost.minor &&
        proof.productRef===terms.manifest.productRef && proof.productRevision===terms.manifest.productRevision && Date.parse(proof.validUntil)>Date.parse(now);
    });
  }
  private project(s:Snapshot):OfferRecord {
    const now=new Date().toISOString(),current=this.model(s.terms), provider=this.provider(s.terms,now);
    const providerCurrent=provider && digest(provider)===digest(s.provider)?provider:null;
    const currentCosts=this.costs(s.terms,now).filter(key=>s.verifiedCosts.includes(key));
    const decisions=this.db.prepare("SELECT kind,source_ref FROM offer_decisions WHERE offer_id=? AND revision=?").all(s.offerId,s.revision);
    const approved=decisions.find(d=>d.kind==="owner-approved"), accepted=decisions.find(d=>d.kind==="creator-accepted");
    const history=this.db.prepare("SELECT body FROM offer_versions WHERE offer_id=? AND revision<=? ORDER BY revision DESC LIMIT 100").all(s.offerId,s.revision)
      .map(row=>{const snap=JSON.parse(String(row.body)) as Snapshot;return {version:snap.version,hash:snap.manifestHash,at:snap.recordedAt};});
    return offerRecordSchema.parse({kind:"agent-offer",offerId:s.offerId,version:s.version,revision:s.revision,recordedAt:s.recordedAt,manifestHash:s.manifestHash,
      terms:s.terms,assessment:s.assessment,assessmentCurrent:!!current && !current.stale && !!current.configHash && !!s.assessment && digest(current)===digest(s.assessment) && current.termsRevision===s.manifestHash,
      scenarios:[offerScenario(s.terms,"base"),offerScenario(s.terms,"downside")],provider:providerCurrent,
      blockers:proposalBlockers(s.terms,providerCurrent,new Set(currentCosts),now),state:accepted?"accepted":approved?"approved":"proposed",
      ownerApprovalRef:approved?String(approved.source_ref):null,acceptedRef:accepted?String(accepted.source_ref):null,history,historyTotal:s.revision});
  }
  matchesOfferVersion(id:string,version:string,manifestHash:string):boolean {
    const latest=this.snapshot(id);
    return !!latest && latest.version===version && latest.manifestHash===manifestHash;
  }
  readOffer(id:string,revision?:number) {const s=this.snapshot(routeId.parse(id),revision);return s?this.project(s):null;}
  saveFromAdapter(id:string,expected:string|null,input:unknown,key:string) {
    const terms=offerTermsSchema.parse(input);routeId.parse(id);
    return this.apply(key,{id,expected,terms,operation:"offer-propose"},()=>{
      const prior=this.snapshot(id);
      if((prior?.version??null)!==expected)throw new AgentConflict("VERSION_CONFLICT");
      if(prior && prior.terms.creatorId!==terms.creatorId)throw new AgentConflict("CREATOR_IDENTITY_CHANGED");
      const recordedAt=new Date().toISOString(),assessment=this.model(terms),provider=this.provider(terms,recordedAt),verifiedCosts=this.costs(terms,recordedAt);
      // Receipt/term basis is independent of score so a new score can bind the immutable manifest hash without creating a cycle.
      const manifestHash=digest({scope:this.scope,offerId:id,terms,provider,verifiedCosts});
      if(prior && prior.manifestHash===manifestHash && digest(prior.assessment)===digest(assessment))return this.project(prior);
      const revision=(prior?.revision??0)+1;
      const snapshot:Snapshot={offerId:id,revision,version:`v${revision}`,recordedAt,manifestHash,terms,provider,verifiedCosts,assessment};
      this.db.prepare("INSERT INTO offer_versions VALUES(?,?,?)").run(id,revision,JSON.stringify(snapshot));
      return this.project(snapshot);
    });
  }
  decision(id:string,input:{version:string;sourceRef:string;kind:Change},key:string) {
    return this.apply(key,{id,...input,operation:"offer-decision"},()=>{
      const s=this.snapshot(routeId.parse(id));
      if(!s || s.version!==input.version)throw new AgentConflict("VERSION_CONFLICT");
      const p=parse(decisionPacket,this.authority.decision?.(input.sourceRef,this.scope)),now=Date.now();
      if(!p || !sameScope(p.scope,this.scope) || p.sourceRef!==input.sourceRef || p.offerId!==id || p.version!==s.version || p.manifestHash!==s.manifestHash ||
        p.creatorId!==s.terms.creatorId || p.provider!==s.terms.provider || p.programRef!==s.terms.programRef || p.decision!==input.kind ||
        Date.parse(p.validUntil)<=now || Date.parse(p.occurredAt)>now || Date.parse(p.occurredAt)<Date.parse(s.recordedAt))
        throw new OfferSourceUnavailable("EXACT_VERSION_DECISION_UNVERIFIED");
      const record=this.project(s);
      if(record.blockers.length)throw new AgentConflict("OFFER_ECONOMICS_HELD");
      if(input.kind==="creator-accepted" && !record.ownerApprovalRef)throw new AgentConflict("OWNER_APPROVAL_REQUIRED");
      const old=this.db.prepare("SELECT source_ref FROM offer_decisions WHERE offer_id=? AND revision=? AND kind=?").get(id,s.revision,input.kind);
      if(old && old.source_ref!==input.sourceRef)throw new AgentConflict("DECISION_ALREADY_RECORDED");
      if(!old)this.db.prepare("INSERT INTO offer_decisions VALUES(?,?,?,?,?)").run(id,s.revision,input.kind,input.sourceRef,JSON.stringify(p));
      return this.project(s);
    });
  }
  acceptedTerms(id:string) {
    const record=this.readOffer(id);
    if(!record?.acceptedRef || !record.provider || record.blockers.length)return null;
    const decisions=this.db.prepare("SELECT body FROM offer_decisions WHERE offer_id=? AND revision=?").all(id,record.revision);
    if(decisions.some(row=>Date.parse(decisionPacket.parse(JSON.parse(String(row.body))).validUntil)<=Date.now()))return null;
    return {offerId:id,version:record.version,manifestHash:record.manifestHash,creatorId:record.terms.creatorId,route:record.terms.checkoutRoute,
      currency:record.terms.commission.currency,commission:record.terms.commission,provider:record.provider,acceptedRef:record.acceptedRef};
  }
  onboarding(id:string) {
    const accepted=this.acceptedTerms(id),s=this.snapshot(id);
    if(!accepted || !s)return null;
    return {accepted,brief:s.terms.manifest,postingObligations:s.terms.manifest.deliverables,
      handoffs:s.terms.sample.requested?["J07","J15"]:[],reserved:false,dispatched:false};
  }
  private rewards(creator:string) {
    const row=this.db.prepare("SELECT body FROM offer_rewards WHERE creator_id=? ORDER BY observed_at DESC LIMIT 1").get(creator);
    return row?rewardSourceSchema.parse(JSON.parse(String(row.body))):null;
  }
  private awards(creator:string):RewardSource["awards"] {
    return this.db.prepare("SELECT body FROM offer_reward_awards WHERE creator_id=?").all(creator).map(r=>JSON.parse(String(r.body)));
  }
  readRewards(id:string) {
    const s=this.snapshot(routeId.parse(id));return s?projectRewards(id,s.terms.creatorId,s.version,this.rewards(s.terms.creatorId),this.awards(s.terms.creatorId)):null;
  }
  recordReward(id:string,ref:string,key:string) {
    return this.apply(key,{id,ref,operation:"reward-observation"},()=>{
      const s=this.snapshot(id),raw=parse(rewardSourceSchema,this.authority.reward?.(ref,this.scope));
      if(!s || !raw || raw.sourceRef!==ref || !sameScope(raw.scope,this.scope) || raw.creatorId!==s.terms.creatorId || Date.parse(raw.observedAt)>Date.now())
        throw new OfferSourceUnavailable("REWARD_SOURCE_UNVERIFIED");
      const prior=this.rewards(raw.creatorId);
      if(prior && Date.parse(prior.observedAt)>=Date.parse(raw.observedAt)) {
        if(digest(prior)===digest(raw))return this.readRewards(id);
        throw new AgentConflict("STALE_REWARD_SNAPSHOT");
      }
      const result=projectRewards(id,raw.creatorId,s.version,raw,this.awards(raw.creatorId));
      this.db.prepare("INSERT INTO offer_rewards VALUES(?,?,?,?)").run(raw.creatorId,ref,new Date(raw.observedAt).toISOString(),JSON.stringify(raw));
      for(const a of raw.awards)this.db.prepare("INSERT INTO offer_reward_awards VALUES(?,?,?) ON CONFLICT(creator_id,tier) DO UPDATE SET body=excluded.body").run(raw.creatorId,a.tier,JSON.stringify(a));
      return result;
    });
  }
}
