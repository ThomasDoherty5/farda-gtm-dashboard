import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { digest } from "./config.ts";
import { POLICY_VERSION } from "./assessmentSchema.ts";
import { CapabilityLedger, capabilityIdForBinding } from "./connections/ledger.ts";
import type { CapabilityScope } from "./connections/schema.ts";
import { JobConflict, JobRepository } from "./jobs/repository.ts";
import type { JobDefinition } from "./jobs/schema.ts";
import {
  actionGroup, healthBindingDigest, healthPolicyDigest, healthObservationSchema, noObservation, sourceHealthPolicySchema, summarize,
  type HealthObservation, type HealthTarget, type HealthOptions, type HealthSummary, type HealthActionBinding,
} from "./providerHealthSchema.ts";
export { createNotionRegistryHealthTargets, notionHealthTargetConfigSchema, healthBindingDigest } from "./providerHealthSchema.ts";
export type { NotionHealthTargetConfig, HealthTarget, HealthOptions, HealthSummary, HealthObservation } from "./providerHealthSchema.ts";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const eventRef = z.string().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const checkRequest = z.object({ capabilityId: hash, eventId: eventRef }).strict();
const limitSchema = z.number().int().min(1).max(100);
type ProbeEvent = { observationId: string; runId: string; revision: number; policyDigest:string; observation: HealthObservation; summary: HealthSummary };
type Exception = { exceptionId:string; reasonCode:string; ownerRef:string; state:"open"|"resolved"; openedAt:string; updatedAt:string; nextAction:string; deadline:string|null };

function jobDefinition(capabilityId: string, target: HealthTarget, version:number): JobDefinition {
  return { jobId:"j14-"+capabilityId, version, ownerRef:target.ownerRef, healthPolicyVersion:healthPolicyDigest(target), mode:"observe", handler:"probe-provider-health.v1",
    eventType:"provider-health-check", inputSchemaVersion:"job-reference-batch.v1", outputSchemaVersion:"job-local-result.v1", policyVersion:POLICY_VERSION,
    capabilityBinding:null, modelVersion:null, offerVersion:null,
    budgets:{ maxItems:1,maxSteps:6,maxAttempts:2,maxRunMs:60_000,leaseMs:20_000,maxConcurrency:1,retryBaseMs:0 } };
}

async function boundedProbe(target: HealthTarget, now: () => number): Promise<HealthObservation> {
  if (!target.probe) return noObservation(target.binding,now(),"missing_access");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_,reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("PROBE_TIMEOUT")); },8_000); });
    const result = healthObservationSchema.safeParse(await Promise.race([target.probe(controller.signal),expired]));
    if (!result.success || Date.parse(result.data.checkedAt)>now()) return noObservation(target.binding,now(),"failed");
    if (result.data.bindingDigest!==healthBindingDigest(target.binding)) return noObservation(target.binding,now(),"account_mismatch");
    return result.data;
  } catch { return noObservation(target.binding,now(),"failed"); }
  finally { if (timer) clearTimeout(timer); }
}

/** A manual health check produces local evidence using the same durable run/lease as every job.
 * Only the server-configured probe may inspect a provider. A health observation never grants a capability. */
export function createProviderHealth(db: DatabaseSync, scope: CapabilityScope, ledger: CapabilityLedger, jobs: JobRepository, options: HealthOptions = {}) {
  const now = options.now ?? Date.now;
  const registeredScope = db.prepare("SELECT workspace_id,account_id,environment FROM capability_scope WHERE id=1").get();
  if (!registeredScope || registeredScope.workspace_id!==scope.workspaceId || registeredScope.account_id!==scope.accountId || registeredScope.environment!==scope.environment) throw new JobConflict("HEALTH_SCOPE_MISMATCH");
  const targets = new Map<string,HealthTarget>();
  for (const raw of options.catalog ?? []) {
    const { probe, ...policy } = raw;
    const target = { ...sourceHealthPolicySchema.parse(policy), probe };
    const b = target.binding;
    const id = capabilityIdForBinding(b);
    if (b.workspaceId!==scope.workspaceId || b.accountId!==scope.accountId || b.environment!==scope.environment || targets.has(id)
        || Date.parse(target.documentationCheckedAt)>now()) throw new JobConflict("INVALID_HEALTH_CONFIGURATION");
    targets.set(id,target);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS health_observations(sequence INTEGER PRIMARY KEY AUTOINCREMENT, capability_id TEXT NOT NULL, group_id TEXT NOT NULL,
    observation_id TEXT UNIQUE NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(capability_id,event_id));
    CREATE INDEX IF NOT EXISTS health_latest ON health_observations(capability_id,sequence);
    CREATE TABLE IF NOT EXISTS health_exception_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT, exception_id TEXT NOT NULL, group_id TEXT NOT NULL, body TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS health_exception_latest ON health_exception_history(exception_id,sequence);
    CREATE TABLE IF NOT EXISTS health_exception_members(exception_id TEXT NOT NULL, capability_id TEXT NOT NULL, reason_code TEXT NOT NULL, group_id TEXT NOT NULL,
      binding_digest TEXT NOT NULL, PRIMARY KEY(exception_id,capability_id,binding_digest));`);
  const latest = (id: string): ProbeEvent|null => {
    const row = db.prepare("SELECT body FROM health_observations WHERE capability_id=? ORDER BY sequence DESC LIMIT 1").get(id);
    return row ? JSON.parse(String(row.body)) : null;
  };
  const denied = (b: HealthActionBinding) => ledger.hasDeniedActionRoute(b) || Boolean(db.prepare("SELECT 1 FROM health_exception_members WHERE group_id=? AND reason_code IN ('PERMISSION_DENIED','ACCOUNT_RESTRICTED','ACCOUNT_MISMATCH') LIMIT 1").get(actionGroup(b)));
  function get(id: string): HealthSummary|null {
    const binding = ledger.get(hash.parse(id));
    if (!binding) return null;
    const target = targets.get(id);
    const event = latest(id);
    const exact=!!target && !!event && event.revision===binding.revision && event.policyDigest===healthPolicyDigest(target)
      && event.observation.bindingDigest===healthBindingDigest(target.binding) && ledger.matchesBinding(target.binding);
    return summarize({id,target,ownerRef:binding.registration.ownerRef,capabilityState:binding.state,observation:exact?event.observation:undefined,
      capabilityRevision:binding.revision,observationId:exact?event.observationId:undefined,previousEvidence:!!event,
      revisionCurrent:exact,now:now(),activeDenial:denied(binding.registration.binding)});
  }
  ledger.setHealthHold(b => {
    if (denied(b)) return "PROVIDER_PERMISSION_HELD";
    const id = capabilityIdForBinding(b);
    if (!targets.has(id)) return latest(id) ? "PROVIDER_HEALTH_TARGET_UNAVAILABLE" : null;
    const health = get(id);
    return health?.state === "ready" ? null : "PROVIDER_HEALTH_RECHECK_REQUIRED";
  });
  function history(id: string, limit = 25) {
    hash.parse(id); limitSchema.parse(limit);
    const total = Number(db.prepare("SELECT COUNT(*) n FROM health_observations WHERE capability_id=?").get(id)!.n);
    const saved=ledger.get(id),target=targets.get(id);
    const records = db.prepare("SELECT group_id,body FROM health_observations WHERE capability_id=? ORDER BY sequence DESC LIMIT ?").all(id,limit)
      .map(r => {
        const e:ProbeEvent=JSON.parse(String(r.body));
        const sameAccount=!!saved && r.group_id===actionGroup(saved.registration.binding);
        const currentBinding=sameAccount && !!target && ledger.matchesBinding(target.binding) && e.observation.bindingDigest===healthBindingDigest(target.binding) && e.policyDigest===healthPolicyDigest(target);
        return { observationId:e.observationId,runId:e.runId,bindingVersion:e.observation.bindingDigest,policyVersion:e.policyDigest,currentBinding,sameAccount,summary:sameAccount?e.summary:null };
      });
    return { records,total,partial:total>records.length };
  }
  function list(limit = 25) {
    limitSchema.parse(limit);
    const saved = ledger.list(limit);
    return { configured:targets.size>0, records:saved.records.map(r => get(r.capabilityId)!), total:saved.total,partial:saved.partial };
  }
  function exceptions(id: string, limit = 25) {
    hash.parse(id); limitSchema.parse(limit);
    const saved=ledger.get(id);
    if (!saved) return { records:[] as Exception[],total:0,partial:false };
    const group=actionGroup(saved.registration.binding);
    const total=Number(db.prepare("SELECT COUNT(DISTINCT exception_id) n FROM health_exception_history WHERE group_id=?").get(group)!.n);
    const records=db.prepare(`SELECT e.body FROM health_exception_history e JOIN (SELECT exception_id,MAX(sequence) seq FROM health_exception_history
      WHERE group_id=? GROUP BY exception_id) x ON x.seq=e.sequence ORDER BY e.sequence DESC LIMIT ?`).all(group,limit).map(r=>JSON.parse(String(r.body)) as Exception);
    return { records,total,partial:total>records.length };
  }
  function exceptionUpdate(target:HealthTarget, summary:HealthSummary, at:string) {
    const group=actionGroup(target.binding);
    const bindingVersion=healthBindingDigest(target.binding);
    const id=summary.capabilityId;
    const head = (exceptionId:string):Exception|null => {
      const r=db.prepare("SELECT body FROM health_exception_history WHERE exception_id=? ORDER BY sequence DESC LIMIT 1").get(exceptionId);
      return r ? JSON.parse(String(r.body)) : null;
    };
    const append = (e:Exception) => db.prepare("INSERT INTO health_exception_history(exception_id,group_id,body) VALUES(?,?,?)").run(e.exceptionId,group,JSON.stringify(e));
    for (const reasonCode of summary.reasonCodes) {
      const exceptionId=digest({ group,reasonCode });
      const prior=head(exceptionId);
      db.prepare("INSERT OR IGNORE INTO health_exception_members VALUES(?,?,?,?,?)").run(exceptionId,id,reasonCode,group,bindingVersion);
      append({ exceptionId,reasonCode,ownerRef:target.ownerRef,state:"open",openedAt:prior?.state==="open" ? prior.openedAt : at,updatedAt:at,nextAction:summary.nextAction,deadline:summary.deadline });
    }
    // A single healthy route cannot clear another route's denial. Its own exceptions require
    // an independently permitted current source check, never a dismissal, retry or mirror write.
    if (summary.state!=="ready") return;
    for (const r of db.prepare("SELECT exception_id FROM health_exception_members WHERE capability_id=? AND group_id=? AND binding_digest=?").all(id,group,bindingVersion)) {
      const exceptionId=String(r.exception_id);
      db.prepare("DELETE FROM health_exception_members WHERE exception_id=? AND capability_id=? AND group_id=? AND binding_digest=?").run(exceptionId,id,group,bindingVersion);
      if (!db.prepare("SELECT 1 FROM health_exception_members WHERE exception_id=? LIMIT 1").get(exceptionId)) {
        const prior=head(exceptionId);
        if (prior) append({ ...prior,state:"resolved",updatedAt:at,nextAction:"none" });
      }
    }
  }
  async function check(raw:unknown,key:string) {
    const input=checkRequest.parse(raw);
    eventRef.parse(key);
    const binding=ledger.get(input.capabilityId);
    if (!binding) throw new JobConflict("CAPABILITY_NOT_FOUND");
    const target=targets.get(input.capabilityId);
    if (!target) return { state:"unconfigured" as const,runId:null,observationId:null,health:get(input.capabilityId) };
    if (!ledger.matchesBinding(target.binding)) throw new JobConflict("HEALTH_BINDING_CHANGED");
    const currentHead=db.prepare("SELECT version FROM job_heads WHERE job_id=?").get("j14-"+input.capabilityId);
    const previousVersion=Number(currentHead?.version ?? 0);
    let def=jobDefinition(input.capabilityId,target,previousVersion || 1);
    let registered;
    if (currentHead && jobs.getJob(def.jobId).hash===digest(def)) registered=jobs.getJob(def.jobId);
    else {
      def=jobDefinition(input.capabilityId,target,previousVersion+1);
      registered=jobs.register(def,previousVersion);
    }
    const disabledByOwner = db.prepare("SELECT 1 FROM job_transitions WHERE kind='disable' AND json_extract(detail,'$.jobId')=? AND json_extract(detail,'$.version')=? LIMIT 1").get(def.jobId,def.version);
    if (!registered.enabled && !registered.paused && !disabledByOwner && options.activationRef) {
      try { registered=jobs.activate(def.jobId,def.version,options.activationRef); }
      catch (error) { if (!(error instanceof JobConflict) || error.message!=="JOB_ACTIVATION_UNVERIFIED") throw error; }
    }
    const eventId = digest({ capabilityId:input.capabilityId,event:input.eventId,policy:healthPolicyDigest(target) });
    const run=jobs.ingest({ schemaVersion:"job-reference-batch.v1",jobId:def.jobId,jobVersion:def.version,eventId,eventType:def.eventType,eventAt:null,
      items:[{ itemKey:eventId,subjectRef:input.capabilityId,evidenceRef:null }] },key);
    const existing=db.prepare("SELECT body FROM health_observations WHERE capability_id=? AND event_id=?").get(input.capabilityId,eventId);
    if (existing) {
      const e:ProbeEvent=JSON.parse(String(existing.body));
      return { state:"observed" as const,runId:e.runId,observationId:e.observationId,health:get(input.capabilityId) };
    }
    const held = () => ({ state:"held" as const,runId:run.runId,observationId:null,health:get(input.capabilityId),blockers:jobs.getRun(run.runId).blockerCodes });
    if (!registered.enabled || registered.paused) return held();
    const claim=jobs.claim("j14-health-reader",def.jobId,run.runId);
    if (!claim || claim.runId!==run.runId) return held();
    const checkpoint={ cursor:"native-preflight",processedRefs:[input.capabilityId] };
    jobs.checkpoint(claim.item.itemId,claim.leaseToken,claim.item.checkpointVersion,checkpoint);
    const observation=await boundedProbe(target,now);
    const observationId=digest({ id:input.capabilityId,eventId });
    let recorded:HealthSummary|null=null;
    jobs.complete(claim.item.itemId,claim.leaseToken,{ schemaVersion:"job-local-result.v1",kind:"reference-recorded",artifactRef:"health:"+observationId,sourceEffect:"none" },() => {
      const current=ledger.get(input.capabilityId);
      if (!current || current.revision!==binding.revision || !ledger.matchesBinding(target.binding)) throw new JobConflict("HEALTH_BINDING_CHANGED");
      const previous=latest(input.capabilityId);
      const prior=previous?.policyDigest===healthPolicyDigest(target) && previous.observation.bindingDigest===healthBindingDigest(target.binding) ? previous.observation : null;
      if (prior && Date.parse(observation.checkedAt)<Date.parse(prior.checkedAt)) throw new JobConflict("STALE_HEALTH_OBSERVATION");
      // A failed read or a new mirror write can never replace the last native success time.
      if (observation.status!=="observed") {
        observation.sourceLastSuccess=prior?.sourceLastSuccess ?? null; observation.sourceUpdatedAt=prior?.sourceUpdatedAt ?? null;
      }
      const version={ capabilityRevision:current.revision,observationId };
      const summary=summarize({ id:input.capabilityId,target,ownerRef:target.ownerRef,capabilityState:current.state,observation,...version,revisionCurrent:true,now:now(),activeDenial:false });
      exceptionUpdate(target,summary,observation.checkedAt);
      const final=summarize({ id:input.capabilityId,target,ownerRef:target.ownerRef,capabilityState:current.state,observation,...version,revisionCurrent:true,now:now(),activeDenial:denied(target.binding) });
      const event:ProbeEvent={ observationId,runId:run.runId,revision:current.revision,policyDigest:healthPolicyDigest(target),observation,summary:final };
      db.prepare("INSERT INTO health_observations(capability_id,group_id,observation_id,event_id,body) VALUES(?,?,?,?,?)")
        .run(input.capabilityId,actionGroup(target.binding),observationId,eventId,JSON.stringify(event));
      recorded=final;
    });
    return { state:"observed" as const,runId:run.runId,observationId,health:recorded as HealthSummary|null };
  }
  return { check,get,list,history,exceptions };
}
