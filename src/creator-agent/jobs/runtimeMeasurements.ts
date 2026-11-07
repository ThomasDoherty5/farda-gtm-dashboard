import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { RuntimeError, runtimeInstant, runtimeRef } from "./runtimeSchema.ts";

export const runtimeUsageReceiptSchema=z.object({receiptRef:runtimeRef,issuerRef:runtimeRef,providerAccountRef:runtimeRef,billingEventRef:runtimeRef,runRef:runtimeRef,
  channel:z.enum(["ordinaryZapTasks","mcpTasks","modelTokens","runtime"]),count:z.number().int().nonnegative().safe(),observedAt:runtimeInstant,
  cost:z.discriminatedUnion("state",[z.object({state:z.literal("unknown"),reasonCode:z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/)}).strict(),z.object({state:z.literal("known"),amountMinor:z.number().int().nonnegative().safe(),currency:z.string().regex(/^[A-Z]{3}$/),sourceRef:runtimeRef}).strict()]),
}).strict();
export type RuntimeUsageReceipt=z.infer<typeof runtimeUsageReceiptSchema>;
export type RuntimeUsageRead={schemaVersion:"farda.runtime-usage.v1";runRef:string;invocations:{directApi:number;mcp:number;model:number;browser:number};
  pendingInvocations:number;measuredRuntimeMs:number;ordinaryZapTasks:number|null;mcpTasks:number|null;modelTokens:number|null;
  observedCostMinor:number|null;currency:string|null;costCoverage:"unknown"|"partial";runtimeCost:"unknown";receiptRefs:string[];coverage:"instrumented-invocations-only"};
/** Counts observations; it does not allocate quota, maintain balances or infer a paid bill from an HTTP request. */
export class RuntimeMeasurements{
  private db:DatabaseSync;private now:()=>number;
  constructor(db:DatabaseSync,now:()=>number=Date.now){this.db=db;this.now=now;db.exec(`CREATE TABLE IF NOT EXISTS job_runtime_usage_calls(call_ref TEXT PRIMARY KEY,run_ref TEXT NOT NULL,item_ref TEXT NOT NULL,attempt INTEGER NOT NULL,channel TEXT NOT NULL,binding_hash TEXT NOT NULL,started_at INTEGER NOT NULL,elapsed_ms REAL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_runtime_usage_receipts(identity TEXT PRIMARY KEY,body_hash TEXT NOT NULL,run_ref TEXT NOT NULL,body TEXT NOT NULL);`);}
  begin(runRef:string,itemRef:string,attempt:number,channel:"directApi"|"mcp"|"model"|"browser",bindingHash:string){
    if(!this.db.prepare("SELECT 1 FROM job_run_items WHERE run_id=? AND item_id=?").get(runRef,itemRef))throw new RuntimeError("RUNTIME_USAGE_SCOPE_INVALID");
    const callRef=`runtime-call:${randomUUID()}`;this.db.prepare("INSERT INTO job_runtime_usage_calls VALUES(?,?,?,?,?,?,?,NULL,'pending')").run(callRef,runRef,itemRef,attempt,channel,bindingHash,this.now());return callRef;
  }
  finish(callRef:string,elapsedMs:number,state:"returned"|"failed"){if(!Number.isFinite(elapsedMs)||elapsedMs<0)throw new RuntimeError("RUNTIME_USAGE_INVALID");this.db.prepare("UPDATE job_runtime_usage_calls SET elapsed_ms=?,state=? WHERE call_ref=? AND state='pending'").run(elapsedMs,state,callRef);}
  recordVerified(input:unknown,assertCurrent:(receipt:RuntimeUsageReceipt)=>void){const receipt=runtimeUsageReceiptSchema.parse(input);if(Date.parse(receipt.observedAt)>this.now()||!this.db.prepare("SELECT 1 FROM job_runs WHERE run_id=?").get(receipt.runRef))throw new RuntimeError("RUNTIME_USAGE_SCOPE_INVALID");
    // Source fence is synchronous and must be read-only. Recheck it inside the serialized receipt transaction.
    assertCurrent(receipt);this.db.exec("BEGIN IMMEDIATE");try{const key=digest({issuer:receipt.issuerRef,account:receipt.providerAccountRef,event:receipt.billingEventRef});const prior=this.db.prepare("SELECT body_hash FROM job_runtime_usage_receipts WHERE identity=?").get(key);if(prior&&prior.body_hash!==digest(receipt))throw new RuntimeError("RUNTIME_USAGE_RECEIPT_CONFLICT");if(!prior&&Number(this.db.prepare("SELECT COUNT(*) AS n FROM job_runtime_usage_receipts WHERE run_ref=?").get(receipt.runRef)?.n)>=1000)throw new RuntimeError("RUNTIME_USAGE_RECEIPT_LIMIT");assertCurrent(receipt);this.db.prepare("INSERT OR IGNORE INTO job_runtime_usage_receipts VALUES(?,?,?,?)").run(key,digest(receipt),receipt.runRef,JSON.stringify(receipt));const stored=this.db.prepare("SELECT body_hash FROM job_runtime_usage_receipts WHERE identity=?").get(key);if(stored?.body_hash!==digest(receipt))throw new RuntimeError("RUNTIME_USAGE_RECEIPT_CONFLICT");this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}}
  read(runRef:string):RuntimeUsageRead{if(!this.db.prepare("SELECT 1 FROM job_runs WHERE run_id=?").get(runRef))throw new RuntimeError("RUNTIME_RUN_NOT_FOUND",404);
    const rows=this.db.prepare("SELECT channel,COUNT(*) AS n,SUM(COALESCE(elapsed_ms,0)) AS ms,SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending FROM job_runtime_usage_calls WHERE run_ref=? GROUP BY channel").all(runRef);
    const invocations={directApi:0,mcp:0,model:0,browser:0};let measuredRuntimeMs=0,pendingInvocations=0;for(const row of rows){const channel=row.channel as keyof typeof invocations;if(Object.hasOwn(invocations,channel))invocations[channel]=Number(row.n);measuredRuntimeMs+=Number(row.ms);pendingInvocations+=Number(row.pending);}
    const receipts=this.db.prepare("SELECT body FROM job_runtime_usage_receipts WHERE run_ref=? ORDER BY identity").all(runRef).map(r=>runtimeUsageReceiptSchema.parse(JSON.parse(String(r.body))));
    const sum=(channel:RuntimeUsageReceipt["channel"])=>{const found=receipts.filter(r=>r.channel===channel);if(!found.length)return null;const total=found.reduce((n,r)=>n+r.count,0);if(!Number.isSafeInteger(total))throw new RuntimeError("RUNTIME_USAGE_OVERFLOW");return total;};
    const costs=receipts.flatMap(r=>r.cost.state==="known"?[r.cost]:[]),currencies=new Set(costs.map(c=>c.currency));const amount=costs.reduce((n,c)=>n+c.amountMinor,0);if(!Number.isSafeInteger(amount))throw new RuntimeError("RUNTIME_USAGE_OVERFLOW");
    return{schemaVersion:"farda.runtime-usage.v1",runRef,invocations,pendingInvocations,measuredRuntimeMs,ordinaryZapTasks:sum("ordinaryZapTasks"),mcpTasks:sum("mcpTasks"),modelTokens:sum("modelTokens"),observedCostMinor:costs.length&&currencies.size===1?amount:null,currency:currencies.size===1?[...currencies][0]!:null,costCoverage:costs.length?"partial":"unknown",runtimeCost:"unknown",receiptRefs:receipts.map(r=>r.receiptRef),coverage:"instrumented-invocations-only"};
  }
}
