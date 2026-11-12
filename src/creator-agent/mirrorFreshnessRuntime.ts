import { z } from "zod";
import { mirrorCompletionSchema, mirrorBindingSchema, type MirrorCompletion, type MirrorRunSource, type MirrorBinding, type MirrorSchedule } from "./mirrorFreshnessContract.ts";
export type { MirrorRunSource, MirrorCompletion } from "./mirrorFreshnessContract.ts";
import { digest } from "./config.ts";
import { assertSynchronousVoid } from "./sourceFence.ts";
import { MIRROR_IDS, mirrorRefSchema, mirrorIncidentPayloadSchema } from "./mirrorFreshness.ts";
import { MirrorFreshnessError, MirrorFreshnessRepository } from "./mirrorFreshnessRepository.ts";

/** Local health evaluation only. It never polls a provider, sends Slack, activates a Zap or repairs mirrored data. */
export class MirrorFreshnessRuntime {
  readonly bindings: readonly MirrorBinding[];
  readonly repository: MirrorFreshnessRepository;
  readonly scope: MirrorCompletion["scope"];
  readonly source: MirrorRunSource | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private schedule: MirrorSchedule = {state:"unconfigured",everyMinutes:15,timezone:"America/Los_Angeles",deploymentRef:null,lastSweepAt:null,nextSweepAt:null};
  constructor(repository: MirrorFreshnessRepository, scope: MirrorCompletion["scope"],
    source: MirrorRunSource | undefined, bindings: readonly MirrorBinding[] = []) {
    this.repository=repository;this.source=source;
    this.bindings = Object.freeze(z.array(mirrorBindingSchema).max(MIRROR_IDS.length).parse(bindings).map(b=>Object.freeze(b)));
    this.scope = Object.freeze({...scope});
    if (new Set(this.bindings.map(b=>b.mirrorId)).size !== this.bindings.length || new Set(this.bindings.map(b=>b.bindingRef)).size !== this.bindings.length)
      throw new MirrorFreshnessError("MIRROR_BINDING_AMBIGUOUS",422);
    repository.db.exec("CREATE TABLE IF NOT EXISTS mirror_freshness_completions(receipt_ref TEXT PRIMARY KEY,run_id TEXT UNIQUE NOT NULL,body_hash TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mirror_freshness_bindings(mirror_id TEXT PRIMARY KEY,body_hash TEXT NOT NULL)");
    // A changed source identity cannot inherit the preceding source's watermark or recovery proof.
    repository.db.exec("BEGIN IMMEDIATE");
    try {
      for(const binding of this.bindings){
        const prior=repository.db.prepare("SELECT body_hash FROM mirror_freshness_bindings WHERE mirror_id=?").get(binding.mirrorId);
        if(prior && prior.body_hash!==digest(binding))throw new MirrorFreshnessError("MIRROR_BINDING_CHANGE_REQUIRES_RECONCILIATION",409);
        repository.db.prepare("INSERT OR IGNORE INTO mirror_freshness_bindings VALUES(?,?)").run(binding.mirrorId,digest(binding));
      }
      repository.db.exec("COMMIT");
    }catch(error){repository.db.exec("ROLLBACK");throw error;}
  }
  async ingest(receiptRef: string) {
    mirrorRefSchema.parse(receiptRef);
    if (!this.source) throw new MirrorFreshnessError("MIRROR_COMPLETION_SOURCE_UNBOUND",503);
    if (!this.repository.approval) throw new MirrorFreshnessError("MIRROR_POLICY_UNAPPROVED",409);
    const completion = mirrorCompletionSchema.parse(await this.source.readCompletion(receiptRef));
    const binding = this.bindings.find(b=>b.mirrorId===completion.run.mirrorId);
    if (completion.receiptRef!==receiptRef || digest(completion.scope)!==digest(this.scope) || !binding ||
      binding.bindingRef!==completion.bindingRef || binding.version!==completion.bindingVersion)
      throw new MirrorFreshnessError("MIRROR_COMPLETION_BINDING_MISMATCH",403);
    return this.repository.recordRun(completion.run,()=>{
      assertSynchronousVoid(()=>this.source!.assertCurrent(completion));
      const prior=this.repository.db.prepare("SELECT body_hash FROM mirror_freshness_completions WHERE receipt_ref=? OR run_id=?").all(receiptRef,completion.run.runId);
      if(prior.some(r=>r.body_hash!==digest(completion)))throw new MirrorFreshnessError("MIRROR_COMPLETION_RECEIPT_REUSED",409);
      this.repository.db.prepare("INSERT OR IGNORE INTO mirror_freshness_completions VALUES(?,?,?,?)").run(receiptRef,completion.run.runId,digest(completion),JSON.stringify(completion));
    });
  }
  sweep() {
    if(!this.repository.approval)throw new MirrorFreshnessError("MIRROR_POLICY_UNAPPROVED",409);
    const result=this.repository.sweep();
    this.schedule.lastSweepAt=result.checkedAt;
    if(this.schedule.state==="running")this.schedule.nextSweepAt=new Date(Date.parse(result.checkedAt)+900_000).toISOString();
    return result;
  }
  start(deploymentRef: string) {
    mirrorRefSchema.parse(deploymentRef);
    if(this.timer)return;
    if(!this.repository.approval)throw new MirrorFreshnessError("MIRROR_POLICY_UNAPPROVED",409);
    this.schedule={...this.schedule,state:"running",deploymentRef};
    const tick=()=>{try{this.sweep();}catch{this.stop();this.schedule.state="failed";}};
    tick();
    if(this.schedule.state==="running"){this.timer=setInterval(tick,900_000);this.timer.unref();}
  }
  stop(){if(this.timer)clearInterval(this.timer);this.timer=null;if(this.schedule.state==="running")this.schedule.state="stopped";this.schedule.nextSweepAt=null;}
  scheduleEvidence():MirrorSchedule{return structuredClone(this.schedule);}
  events(after=0,limit=100){
    z.number().int().nonnegative().safe().parse(after);z.number().int().min(1).max(100).parse(limit);
    return this.repository.db.prepare("SELECT rowid,event_ref,body FROM mirror_freshness_events WHERE rowid>? ORDER BY rowid LIMIT ?").all(after,limit)
      .map(r=>({sequence:Number(r.rowid),eventRef:String(r.event_ref),incident:mirrorIncidentPayloadSchema.parse(JSON.parse(String(r.body)))}));
  }
  completion(runId: string):MirrorCompletion|null{
    mirrorRefSchema.parse(runId);
    const row=this.repository.db.prepare("SELECT body FROM mirror_freshness_completions WHERE run_id=?").get(runId);
    return row?mirrorCompletionSchema.parse(JSON.parse(String(row.body))):null;
  }
  event(eventRef: string){
    mirrorRefSchema.parse(eventRef);
    const row=this.repository.db.prepare("SELECT rowid,event_ref,body FROM mirror_freshness_events WHERE event_ref=?").get(eventRef);
    return row?{sequence:Number(row.rowid),eventRef:String(row.event_ref),incident:mirrorIncidentPayloadSchema.parse(JSON.parse(String(row.body)))}:null;
  }
}

/** Trusted job adapters call ingest with an exact completed receipt. Browser readers cannot submit run bodies. */
export type MirrorRuntimeConfig = { source?:MirrorRunSource; bindings?:readonly MirrorBinding[]; deploymentRef?:string };
