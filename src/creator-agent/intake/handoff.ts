import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { digest } from "../config.ts";
import { sinkReceiptSchema, type Handoff, type IntakeInput, type SinkBinding, type SinkReceipt } from "./contract.ts";
import type { CanonicalRecord, IdentitySink } from "./repository.ts";

type Scope={workspaceId:string;accountId:string};
type Target=Handoff["target"];
type SourceGate={canRead:boolean;canWrite:boolean;excluded:boolean};
export interface RevisionSnapshot { input:IntakeInput; record:CanonicalRecord }
type Work={key:string;target:Target;state:Handoff["state"];revision:number;attempts:number};
type Attempt={binding:SinkBinding;startedAt:string};
const LEASE_MS=5*60_000;

/** One durable claim per creator. A later revision cannot pass an earlier unresolved external effect. */
export class IntakeHandoffs {
  private readonly db:DatabaseSync;
  private readonly scope:Scope;
  private readonly now:()=>Date;
  private readonly sinks:()=>Partial<Record<Target,IdentitySink>>;
  private readonly gate:(snapshot:RevisionSnapshot)=>SourceGate;
  constructor(db:DatabaseSync,scope:Scope,now:()=>Date,sinks:()=>Partial<Record<Target,IdentitySink>>,gate:(snapshot:RevisionSnapshot)=>SourceGate) {
    this.db=db;this.scope=scope;this.now=now;this.sinks=sinks;this.gate=gate;
    db.exec(`CREATE TABLE IF NOT EXISTS intake_revision_snapshots(creator_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY(creator_id,revision));
      CREATE TABLE IF NOT EXISTS intake_handoff_attempts(key TEXT PRIMARY KEY,body TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS intake_handoff_audit(attempt_id TEXT PRIMARY KEY,key TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS intake_creator_claims(creator_id TEXT PRIMARY KEY,token TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  }
  snapshot(creatorId:string, revision:number):RevisionSnapshot|null {
    const row=this.db.prepare("SELECT body FROM intake_revision_snapshots WHERE creator_id=? AND revision=?").get(creatorId,revision);
    return row ? JSON.parse(String(row.body)) as RevisionSnapshot : null;
  }
  freeze(snapshot:RevisionSnapshot) {
    this.db.prepare("INSERT INTO intake_revision_snapshots VALUES(?,?,?)").run(snapshot.record.creatorId,snapshot.record.revision,JSON.stringify(snapshot));
  }
  private tx<T>(fn:()=>T):T {
    this.db.exec("BEGIN IMMEDIATE");
    try {const value=fn();this.db.exec("COMMIT");return value;} catch(e){this.db.exec("ROLLBACK");throw e;}
  }
  private owns(creatorId:string, token:string) {
    return !!this.db.prepare("SELECT 1 FROM intake_creator_claims WHERE creator_id=? AND token=? AND expires_at>?").get(creatorId,token,this.now().getTime());
  }
  private current(creatorId:string) {
    return Number(this.db.prepare("SELECT revision FROM intake_creators WHERE creator_id=?").get(creatorId)?.revision);
  }
  receipt(key:string):SinkReceipt|null {
    const row=this.db.prepare("SELECT receipt FROM intake_handoff_attempts WHERE key=?").get(key);
    if (!row?.receipt) return null;
    const result=sinkReceiptSchema.safeParse(JSON.parse(String(row.receipt)));
    return result.success && result.data.state==="applied" ? result.data : null;
  }
  private proof(raw:unknown, attempt:Attempt) {
    const r=sinkReceiptSchema.safeParse(raw);
    if (!r.success) return null;
    const proof=r.data;
    const {state,receiptRef,observedAt,...context}=proof;
    const binding={...context} as Record<string,unknown>;
    delete binding.terminal;
    delete binding.validUntil;
    if (digest(binding)!==digest(attempt.binding) || Date.parse(observedAt)<Date.parse(attempt.startedAt) ||
      Date.parse(observedAt)>this.now().getTime() || !state || !receiptRef) return null;
    if (proof.state==="applied" && (Date.parse(proof.validUntil)<=this.now().getTime() || Date.parse(proof.validUntil)<=Date.parse(proof.observedAt))) return null;
    return proof;
  }
  private stop(key:string,state:Handoff["state"]) {
    this.db.prepare("UPDATE intake_handoffs SET state=? WHERE key=?").run(state,key);
  }
  private succeed(key:string, proof:SinkReceipt) {
    this.db.prepare("UPDATE intake_handoffs SET state='confirmed',receipt_ref=? WHERE key=?").run(proof.receiptRef,key);
    this.db.prepare("UPDATE intake_handoff_attempts SET receipt=? WHERE key=?").run(JSON.stringify(proof),key);
    this.db.prepare("UPDATE intake_handoff_audit SET receipt=COALESCE(receipt,?) WHERE attempt_id=?").run(JSON.stringify(proof),proof.attemptId);
  }
  async drive(creatorId:string,deadline:string|null) {
    const withinDeadline=()=>deadline===null || this.now().getTime()<Date.parse(deadline);
    const token=randomUUID(), timestamp=this.now().getTime();
    const claim=this.db.prepare(`INSERT INTO intake_creator_claims VALUES(?,?,?) ON CONFLICT(creator_id)
      DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE expires_at<=?`).run(creatorId,token,timestamp+LEASE_MS,timestamp);
    if (!claim.changes) return;
    try {
      while (withinDeadline() && this.owns(creatorId,token)) {
      const pending=this.db.prepare(`SELECT key,target,state,revision,attempts FROM intake_handoffs WHERE creator_id=?
        AND (state NOT IN ('confirmed','superseded') OR (state='confirmed' AND revision=?))
        ORDER BY revision,CASE target WHEN 'notion-creator-crm' THEN 0 ELSE 1 END LIMIT 100`).all(creatorId,this.current(creatorId)) as unknown as Work[];
      const rows=pending.filter(row=>{
        if (row.state!=="confirmed") return true;
        const proof=this.receipt(row.key);
        return !proof || proof.state!=="applied" || Date.parse(proof.validUntil)<=this.now().getTime();
      });
      if (rows.length===0) return;
      for (const row of rows) {
        if (!withinDeadline() || !this.owns(creatorId,token)) return;
        const snapshot=this.snapshot(creatorId,row.revision);
        const current=this.current(creatorId);
        if (!snapshot) {
          // An old uncertain handoff has no provable frozen bytes to reconcile. Preserve it for its owner.
          if (row.attempts || row.state==="uncertain" || row.state==="confirmed") return;
          if (row.revision<current) { this.stop(row.key,"superseded"); continue; }
          this.stop(row.key,"unavailable");return;
        }
        if (row.revision<current && row.state!=="uncertain" && row.attempts===0) {this.stop(row.key,"superseded");continue;}
        const source=this.gate(snapshot);
        const sink=this.sinks()[row.target];
        if (!sink || !source.canRead) {
          if (row.state!=="uncertain") this.stop(row.key,"unavailable");
          return;
        }
        const prior=this.db.prepare("SELECT body FROM intake_handoff_attempts WHERE key=?").get(row.key);
        if (row.state==="uncertain" || (row.attempts && prior)) {
          if (!prior) return;
          const previous=JSON.parse(String(prior.body)) as Attempt;
          let raw:unknown;
          try {raw=await sink.read(row.key,structuredClone(previous.binding));} catch {return;}
          if (!this.owns(creatorId,token)) return;
          const receipt=this.proof(raw,previous);
          if (!receipt) return;
          if (receipt.state==="applied") {this.tx(()=>{if(this.owns(creatorId,token)) this.succeed(row.key,receipt);});continue;}
          if (this.receipt(row.key)) return; // A prior confirmed write cannot be undone by a contradictory absence.
          // A terminal notApplied receipt fences the previous attempt at the sink. Only now can this key be retried or retired.
          this.tx(()=>{if(this.owns(creatorId,token)) {
            this.stop(row.key,"pending");
            this.db.prepare("UPDATE intake_handoff_audit SET receipt=COALESCE(receipt,?) WHERE attempt_id=?").run(JSON.stringify(receipt),receipt.attemptId);
            this.db.prepare("DELETE FROM intake_handoff_attempts WHERE key=?").run(row.key);
          }});
        }
        if (row.revision!==this.current(creatorId)) {this.stop(row.key,"superseded");continue;}
        if (!this.gate(snapshot).canWrite) {this.stop(row.key,"unavailable");return;}
        let canonicalReceiptRef:string|null=null;
        if (row.target==="sheets-watchlist") {
          const notion=this.receipt("notion-creator-crm:"+creatorId+":r"+row.revision);
          if (!notion) return;
          canonicalReceiptRef=notion.receiptRef;
        }
        const record={...snapshot.record,canonicalReceiptRef};
        const binding:SinkBinding={scope:this.scope,key:row.key,target:row.target,creatorId,revision:row.revision,
          recordHash:digest(record),canonicalReceiptRef,attemptId:randomUUID()};
        const attempt:Attempt={binding,startedAt:this.now().toISOString()};
        const authorized=this.tx(()=>{
          if (!withinDeadline() || !this.owns(creatorId,token) || this.current(creatorId)!==row.revision || !this.gate(snapshot).canWrite) return false;
          this.db.prepare("INSERT INTO intake_handoff_attempts VALUES(?,?,NULL) ON CONFLICT(key) DO UPDATE SET body=excluded.body,receipt=NULL")
            .run(row.key,JSON.stringify(attempt));
          this.db.prepare("INSERT INTO intake_handoff_audit VALUES(?,?,?,NULL)").run(binding.attemptId,row.key,JSON.stringify(attempt));
          this.db.prepare("UPDATE intake_handoffs SET state='uncertain',attempts=attempts+1 WHERE key=?").run(row.key);
          return true;
        });
        if (!authorized) return;
        let raw:unknown;
        try {raw=await sink.upsert(row.key,structuredClone(record),structuredClone(binding));} catch {return;}
        if (!this.owns(creatorId,token)) return;
        const receipt=this.proof(raw,attempt);
        if (!receipt || receipt.state!=="applied") return;
        this.tx(()=>{if(this.owns(creatorId,token)) this.succeed(row.key,receipt);});
      }
      }
    } finally {this.db.prepare("DELETE FROM intake_creator_claims WHERE creator_id=? AND token=?").run(creatorId,token);}
  }
}
