import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { commercialInstant, commercialRef, commercialScopeSchema, type CommercialPolicySnapshot, type CommercialPolicySource, type CommercialScope } from "../commercialPolicy/contract.ts";
import { assertCommercialPolicyCurrent, assertRewardPolicyCurrent, commercialLease, commercialPolicyHash, readCommercialPolicy, sameCommercialScope } from "../commercialPolicy/authority.ts";
import { evaluateCommercialTerms } from "../commercialPolicy/evaluate.ts";
import type { AssessmentBasis, OfferRecord, OfferTerms, ProviderFacts } from "./contract.ts";

export const offerPhaseSchema = z.enum(["invitation", "activation", "shipment"]);
export type OfferPhase = z.infer<typeof offerPhaseSchema>;
export const suppressionProofSchema = z.object({ scope: commercialScopeSchema, creatorId: commercialRef, sourceRef: commercialRef, sourceVersion: commercialRef,
  state: z.enum(["clear", "suppressed", "unknown"]), observedAt: commercialInstant, validUntil: commercialInstant }).strict();
export type SuppressionProof = z.infer<typeof suppressionProofSchema>;
export const offerReplySchema = z.object({ scope: commercialScopeSchema, sourceRef: commercialRef, sourceVersion: commercialRef,
  eventRef: commercialRef, creatorId: commercialRef, provider: z.enum(["shopify-collabs", "tiktok-shop", "external-affiliate"]), programRef: commercialRef,
  providerAccountRef:commercialRef.optional(),
  offerId: commercialRef, offerVersion: commercialRef, manifestHash: z.string().regex(/^[a-f0-9]{64}$/), occurredAt: commercialInstant,
  observedAt: commercialInstant, validUntil: commercialInstant, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  classification: z.enum(["fee-request", "commission-only-accepted", "other", "unknown"]),
  reason: z.string().min(1).max(500), excerpt: z.string().max(280),
  resolvesSourceRefs: z.array(commercialRef).max(100), acceptanceRef: commercialRef.nullable(),
}).strict().superRefine((reply, ctx) => {
  if (reply.classification === "commission-only-accepted" ? !reply.acceptanceRef : reply.resolvesSourceRefs.length > 0 || reply.acceptanceRef !== null)
    ctx.addIssue({ code: "custom", message: "Only exact source acceptance can resolve an earlier fee request." });
});
export type OfferReply = z.infer<typeof offerReplySchema>;
export type OfferSourceFence = { scope: CommercialScope; offerId: string; offerVersion: string; manifestHash: string;
  provider: ProviderFacts | null; assessment: AssessmentBasis | null; decisionRefs: string[]; suppression: SuppressionProof | null; resolvedReplies:OfferReply[] };
const replyMaterial=(reply:OfferReply)=>{const {observedAt:_observed,validUntil:_until,...material}=reply;void _observed;void _until;return material;};
export function providerMaterial(provider: ProviderFacts | null) {
  if(!provider)return null;
  const {observedAt:_observed,validUntil:_until,recruitment,...material}=provider; void _observed; void _until;
  if(!recruitment)return {...material,recruitment:null};
  const {observedAt:_recruitmentObserved,validUntil:_recruitmentUntil,...recruitmentMaterial}=recruitment;void _recruitmentObserved;void _recruitmentUntil;
  return {...material,recruitment:recruitmentMaterial};
}
export interface OfferPolicyAuthority {
  commercialPolicy?: CommercialPolicySource;
  reply?: (sourceRef: string, scope: CommercialScope) => unknown;
  assertReplyCurrent?: (reply: OfferReply, now: number) => void;
  suppression?: (creatorId: string, scope: CommercialScope) => unknown;
  /** Inspect current backing source state, not only the supplied copy. Mandatory for positive execution eligibility. */
  assertCurrent?: (snapshot: OfferSourceFence, now: number) => void;
}
export type OfferPolicyProof = { scope: CommercialScope; offerId: string; offerVersion: string; manifestHash: string; phase: OfferPhase;
  providerAccountRef:string;
  policyVersion: string; policyHash: string; modelVersion: string; configHash: string; rewardVersion: string | null; replyRevision: number;
  sourceHash: string; observedAt: string; validUntil: string };
export type OfferEligibility = { state: "eligible" | "held"; reasonCodes: string[]; policyVersion: string | null; offerVersion: string;
  modelVersion: string | null; rewardVersion: string | null; replyRevision: number; proof: OfferPolicyProof | null; confersApproval: false };

export class OfferPolicyError extends Error {
  readonly code: string;
  readonly status:number;
  readonly reasonCodes:string[];
  readonly rowIndex:number|null;
  readonly executionCertainty:"notApplied"|"applied"|"uncertain";
  constructor(code: string, options:{status?:number;reasonCodes?:string[];rowIndex?:number;executionCertainty?:"notApplied"|"applied"|"uncertain"}={}) {
    super(code); this.code = code; this.name = "OfferPolicyError";
    this.status=options.status??(/UNVERIFIED|UNAVAILABLE|SOURCE_HELD/.test(code)?503:409);
    this.reasonCodes=options.reasonCodes??[code];this.rowIndex=options.rowIndex??null;this.executionCertainty=options.executionCertainty??"notApplied";
  }
}
export class OfferCommercialPolicy {
  readonly db: DatabaseSync;
  readonly scope: CommercialScope;
  readonly authority: OfferPolicyAuthority;
  readonly now: () => number;
  constructor(db: DatabaseSync, scope: CommercialScope, authority: OfferPolicyAuthority, now: () => number) {
    this.db = db; this.scope = commercialScopeSchema.parse(scope); this.authority = authority; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS offer_reply_observations (revision INTEGER PRIMARY KEY AUTOINCREMENT,source_key TEXT NOT NULL UNIQUE,body_hash TEXT NOT NULL,creator_id TEXT NOT NULL,provider TEXT NOT NULL,program_ref TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS offer_reply_group ON offer_reply_observations(creator_id,provider,program_ref);
      CREATE TABLE IF NOT EXISTS offer_reply_requests (request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,receipt TEXT NOT NULL);`);
  }
  policy(terms: OfferTerms, boundHash?: string | null) {
    const now = this.now(), result = readCommercialPolicy(this.authority.commercialPolicy, this.scope, now);
    const reasons = [...result.reasonCodes, ...evaluateCommercialTerms(terms, result.snapshot)];
    if (result.snapshot?.performanceReward) {
      try { assertRewardPolicyCurrent(this.authority.commercialPolicy, result.snapshot.performanceReward, this.scope, now);
        if (!result.snapshot.performanceReward.terms.effectiveAt || Date.parse(result.snapshot.performanceReward.terms.effectiveAt) > now) reasons.push("PERFORMANCE_REWARD_NOT_EFFECTIVE");
      } catch { reasons.push("PERFORMANCE_REWARD_SOURCE_HELD"); }
    }
    if (boundHash && result.snapshot && boundHash !== commercialPolicyHash(result.snapshot)) reasons.push("COMMERCIAL_POLICY_CHANGED","NEW_PREVIEW_REQUIRED");
    return { snapshot: result.snapshot, reasonCodes: [...new Set(reasons)] };
  }
  replies(terms: OfferTerms,providerAccountRef?:string) {
    const rows = this.db.prepare("SELECT revision,body FROM offer_reply_observations WHERE creator_id=? AND provider=? AND program_ref=? ORDER BY revision").all(terms.creatorId, terms.provider, terms.programRef ?? "");
    const held = new Map<string, OfferReply>();
    let revision=0;const events:OfferReply[]=[];
    for (const row of rows) {
      const reply = offerReplySchema.parse(JSON.parse(String(row.body)));
      if(providerAccountRef && reply.providerAccountRef && reply.providerAccountRef!==providerAccountRef)continue;
      revision=Math.max(revision,Number(row.revision));events.push(reply);
    }
    // Delivery order is not event order. Equal source instants never let an acceptance clear a fee.
    events.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||digest(replyMaterial(a)).localeCompare(digest(replyMaterial(b))));
    const resolutions:OfferReply[]=[];
    for(const reply of events) {
      if (reply.classification === "fee-request") held.set(reply.sourceRef, reply);
      if (reply.classification === "commission-only-accepted") {
        let verified:OfferReply|null=null;
        try {
          const parsed=offerReplySchema.safeParse(this.authority.reply?.(reply.sourceRef,this.scope)),now=this.now();
          if(parsed.success && !!parsed.data.providerAccountRef && parsed.data.providerAccountRef===providerAccountRef &&
            sameCommercialScope(parsed.data.scope,this.scope) && digest(replyMaterial(parsed.data))===digest(replyMaterial(reply)) &&
            commercialLease(parsed.data.observedAt,parsed.data.validUntil,now) && Date.parse(parsed.data.occurredAt)<=Date.parse(parsed.data.observedAt) &&
            this.authority.assertReplyCurrent) {
            this.authority.assertReplyCurrent(parsed.data,now);verified=parsed.data;
          }
        } catch { /* Historical acceptance is not current source authority. */ }
        if(!verified)continue;
        let used=false;
        for (const ref of reply.resolvesSourceRefs) {
          const old = held.get(ref);
          if (old && Date.parse(reply.occurredAt) > Date.parse(old.occurredAt)) {held.delete(ref);used=true;}
        }
        if(used)resolutions.push(verified);
      }
    }
    return { revision, held: [...held.values()], resolutions };
  }
  suppression(creatorId: string): SuppressionProof | null {
    try {
      const parsed = suppressionProofSchema.safeParse(this.authority.suppression?.(creatorId, this.scope));
      return parsed.success && sameCommercialScope(parsed.data.scope, this.scope) && parsed.data.creatorId === creatorId && commercialLease(parsed.data.observedAt, parsed.data.validUntil, this.now()) ? parsed.data : null;
    } catch { return null; }
  }
  evaluate(record: OfferRecord, phase: OfferPhase, policy: CommercialPolicySnapshot | null, acceptedUntil?:string|null): OfferEligibility {
    const now = this.now(), reply = this.replies(record.terms,record.provider?.providerAccountRef), suppression = this.suppression(record.terms.creatorId);
    const reasons = new Set(record.commercial?.reasonCodes ?? ["COMMERCIAL_POLICY_UNAVAILABLE"]);
    for(const reason of evaluateCommercialTerms(record.terms,policy,record.provider,now))reasons.add(reason);
    if(!policy || policy.state!=="effective" || !policy.effectiveAt || Date.parse(policy.effectiveAt)>now)reasons.add("COMMERCIAL_POLICY_NOT_EFFECTIVE");
    if(policy && record.commercial?.policyHash!==commercialPolicyHash(policy))reasons.add("COMMERCIAL_POLICY_CHANGED");
    if (record.blockers.length) reasons.add("OFFER_ECONOMICS_HELD");
    if (!record.assessmentCurrent || !record.assessment?.configHash || !["prospectiveInviteEligible", "activationReady"].includes(record.assessment.state ?? "")) reasons.add("CURRENT_INVITATION_SCORECARD_REQUIRED");
    if (reply.held.length) reasons.add("CREATOR_FEE_REQUEST");
    if (!suppression || suppression.state !== "clear") reasons.add(suppression?.state === "suppressed" ? "CREATOR_SUPPRESSED" : "SUPPRESSION_UNVERIFIED");
    if (phase !== "invitation" && (!record.acceptedRef || !acceptedUntil || Date.parse(acceptedUntil)<=now)) reasons.add("SOURCE_ACCEPTANCE_REQUIRED");
    const fence: OfferSourceFence = { scope: this.scope, offerId: record.offerId, offerVersion: record.version, manifestHash: record.manifestHash,
      provider: record.provider, assessment: record.assessment, decisionRefs: [record.ownerApprovalRef, record.acceptedRef].filter((ref): ref is string => ref !== null), suppression,resolvedReplies:reply.resolutions };
    try {
      if (!policy || !this.authority.assertCurrent) throw new Error("Missing current source fence");
      this.authority.assertCurrent(fence, now);
      for(const resolution of reply.resolutions) {
        if(!this.authority.assertReplyCurrent)throw new Error("Missing current reply fence");
        this.authority.assertReplyCurrent(resolution,now);
      }
      assertCommercialPolicyCurrent(this.authority.commercialPolicy, policy, this.scope, now);
    } catch { reasons.add("OFFER_SOURCE_FENCE_UNAVAILABLE"); }
    const until = policy && suppression && record.provider && record.terms.expiresAt ? Math.min(Date.parse(policy.validUntil), Date.parse(suppression.validUntil), Date.parse(record.provider.validUntil),
      Date.parse(record.terms.expiresAt), ...reply.resolutions.map(resolution=>Date.parse(resolution.validUntil)), ...(record.provider.recruitment?[Date.parse(record.provider.recruitment.validUntil)]:[]), ...(phase!=="invitation"&&acceptedUntil?[Date.parse(acceptedUntil)]:[]), ...(policy.performanceReward ? [Date.parse(policy.performanceReward.validUntil),Date.parse(policy.performanceReward.execution.validUntil)] : [])) : NaN;
    const validUntil = Number.isFinite(until) ? new Date(until).toISOString() : null;
    if (!validUntil || Date.parse(validUntil) <= now) reasons.add("OFFER_SOURCE_EXPIRED");
    const reasonCodes = [...reasons];
    const proof = !reasonCodes.length && policy && record.provider?.providerAccountRef && record.assessment?.configHash && validUntil ? { scope: this.scope, offerId: record.offerId, offerVersion: record.version, manifestHash: record.manifestHash,
      phase, providerAccountRef:record.provider.providerAccountRef, policyVersion: policy.version, policyHash: commercialPolicyHash(policy), modelVersion: record.assessment.configHash, configHash: record.assessment.configHash,
      rewardVersion: record.terms.rewardVersion, replyRevision: reply.revision,
      sourceHash: digest({...fence,resolvedReplies:fence.resolvedReplies.map(replyMaterial),provider:providerMaterial(fence.provider),suppression:suppression?{scope:suppression.scope,creatorId:suppression.creatorId,sourceRef:suppression.sourceRef,sourceVersion:suppression.sourceVersion,state:suppression.state}:null}), observedAt: new Date(now).toISOString(), validUntil } : null;
    return { state: proof ? "eligible" : "held", reasonCodes, policyVersion: policy?.version ?? null, offerVersion: record.version, modelVersion: record.assessment?.configHash ?? null,
      rewardVersion: record.terms.rewardVersion, replyRevision: reply.revision, proof, confersApproval: false };
  }
  observeReply(record: OfferRecord, sourceRef: string, key: string, actorRef: string) {
    [sourceRef, key, actorRef].forEach(value => commercialRef.parse(value));
    const requestHash = digest({ offerId: record.offerId, offerVersion: record.version, sourceRef, actorRef });
    const prior=this.lookupReply(record.offerId,record.version,sourceRef,key,actorRef);if(prior)return prior;
    let source:unknown;
    try {source=this.authority.reply?.(sourceRef,this.scope);} catch {throw new OfferPolicyError("CREATOR_REPLY_SOURCE_UNVERIFIED");}
    const parsed = offerReplySchema.safeParse(source);
    if (!parsed.success) throw new OfferPolicyError("CREATOR_REPLY_SOURCE_UNVERIFIED");
    const reply = parsed.data, now = this.now();
    if (!sameCommercialScope(reply.scope, this.scope) || reply.sourceRef !== sourceRef || reply.offerId !== record.offerId || reply.offerVersion !== record.version || reply.manifestHash !== record.manifestHash ||
      reply.creatorId !== record.terms.creatorId || reply.provider !== record.terms.provider || reply.programRef !== record.terms.programRef ||
      !reply.providerAccountRef || reply.providerAccountRef!==record.provider?.providerAccountRef ||
      !commercialLease(reply.observedAt, reply.validUntil, now) || Date.parse(reply.occurredAt) > Date.parse(reply.observedAt) || !this.authority.assertReplyCurrent) throw new OfferPolicyError("CREATOR_REPLY_SOURCE_UNVERIFIED");
    try {this.authority.assertReplyCurrent(reply, now);} catch {throw new OfferPolicyError("CREATOR_REPLY_SOURCE_UNVERIFIED");}
    const sourceKey = digest({ scope: this.scope, provider: reply.provider, providerAccountRef:reply.providerAccountRef, programRef: reply.programRef, eventRef: reply.eventRef, sourceVersion: reply.sourceVersion });
    const {observedAt:_observed,validUntil:_until,...material}=reply; void _observed; void _until;
    const bodyHash = digest(material), existing = this.db.prepare("SELECT revision,body_hash FROM offer_reply_observations WHERE source_key=?").get(sourceKey);
    if (existing && existing.body_hash !== bodyHash) throw new OfferPolicyError("CREATOR_REPLY_SOURCE_CHANGED");
    const revision = existing ? Number(existing.revision) : Number(this.db.prepare("INSERT INTO offer_reply_observations(source_key,body_hash,creator_id,provider,program_ref,body) VALUES(?,?,?,?,?,?)")
      .run(sourceKey, bodyHash, reply.creatorId, reply.provider, reply.programRef, JSON.stringify(reply)).lastInsertRowid);
    const receipt = { sourceRef, revision, classification: reply.classification, sourceEffects: "none" as const };
    this.db.prepare("INSERT INTO offer_reply_requests VALUES(?,?,?)").run(key, requestHash, JSON.stringify(receipt));
    return receipt;
  }
  lookupReply(offerId:string,offerVersion:string,sourceRef:string,key:string,actorRef:string) {
    const prior=this.db.prepare("SELECT request_hash,receipt FROM offer_reply_requests WHERE request_key=?").get(key);
    if(!prior)return null;
    if(prior.request_hash!==digest({offerId,offerVersion,sourceRef,actorRef}))throw new OfferPolicyError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(String(prior.receipt)) as {sourceRef:string;revision:number;classification:OfferReply["classification"];sourceEffects:"none"};
  }
}
