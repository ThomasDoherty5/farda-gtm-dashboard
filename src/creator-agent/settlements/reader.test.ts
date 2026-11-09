// @vitest-environment node
import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { afterEach, describe, expect, it } from "vitest";
import { createSettlementReader } from "./reader.ts";
import { settlementSourceFixture } from "./fixtures.testkit.ts";
import type { SettlementSnapshot, SettlementSource } from "./source.ts";

const scope={workspaceId:"fictional-workspace",accountId:"fictional-account",environment:"sandbox" as const};
const actor={principalRef:"fictional-finance",role:"reviewer" as const};
const databases:InstanceType<typeof DatabaseSync>[]=[];afterEach(()=>{for(const db of databases.splice(0))db.close();});
function setup(edit?:(snapshot:SettlementSnapshot)=>void){const db=new DatabaseSync(":memory:");databases.push(db);const fixture=settlementSourceFixture(scope);
  const source:SettlementSource={...fixture.source,async read(request){const s=await fixture.source.read(request) as SettlementSnapshot;edit?.(s);return s;}};
  const reader=createSettlementReader({db,scope,secret:"fictional-private-reference-key",bindings:{source},now:fixture.now});return{db,...fixture,source,reader};}
describe("native settlement source projection",()=>{
  it("keeps independent eligible-product rate scopes and aliases their evidence without inferring missing scope",async()=>{
    const w=setup(),standard=w.records[1]!.rates[0]!;
    standard.eligibleProducts={state:"known",value:"Fictional bottle variants A and B",evidenceRef:"private-product-scope-evidence",observedAt:new Date(w.now()).toISOString(),reasonCode:null};
    const result=await w.reader.read("commissionLedger",{provider:"tiktok"},actor);
    if(result.data.kind!=="native-commission-ledger")throw Error();
    expect(result.data.records[0]!.rates[0]!.eligibleProducts).toMatchObject({state:"known",value:"Fictional bottle variants A and B"});
    expect(result.data.records[0]!.rates[1]!.eligibleProducts).toBeNull();
    expect(JSON.stringify(result.data)).not.toContain("private-product-scope-evidence");
  });
  it("rejects future product-scope evidence rather than applying a rate to an unverified product set",async()=>{
    const w=setup();w.records[1]!.rates[0]!.eligibleProducts={state:"known",value:"Fictional future scope",evidenceRef:"future-scope-evidence",observedAt:new Date(w.now()+1).toISOString(),reasonCode:null};
    await expect(w.reader.read("commissionLedger",{provider:"tiktok"},actor)).rejects.toMatchObject({code:"SETTLEMENT_RATE_SCOPE_INVALID"});
  });
  it("withdraws a shorter permissioned source-link lease before publication even when the snapshot is still current",async()=>{
    const w=setup(snapshot=>{snapshot.synthetic=false;const record=snapshot.records[0]!;record.links=[{kind:"order",targetRef:record.orderRef,state:"verified",url:"https://commerce.example.test/orders/fictional",observedAt:snapshot.observedAt,validUntil:new Date(Date.parse(snapshot.observedAt)+1000).toISOString()}];});
    const reader=createSettlementReader({db:w.db,scope,secret:"fictional-private-reference-key",bindings:{source:w.source,permittedLinkOrigins:["https://commerce.example.test"]},now:w.now});
    const result=await reader.read("commissionLedger",{},actor);if(result.data.kind!=="native-commission-ledger")throw Error();
    expect(result.data.records[0]!.links[0]!.state).toBe("verified");expect(Date.parse(result.data.source.validUntil!)).toBe(w.now()+1000);
    w.state.now+=1001;expect(()=>result.assertCurrent()).toThrow("SETTLEMENT_SOURCE_LINK_EXPIRED");
  });
  it("preserves whole-snapshot state balances on a one-record page instead of aggregating its rows",async()=>{
    const w=setup(snapshot=>{const fact=(minorUnits:number)=>({state:"known" as const,value:{minorUnits,currency:"USD" as const},evidenceRef:"fictional-whole-snapshot-balance",observedAt:snapshot.observedAt,reasonCode:null});
      snapshot.stateTotals={held:fact(10000),disputed:fact(2000),awaitingProvider:fact(3000),paid:fact(7000)};});
    const result=await w.reader.read("commissionLedger",{},actor,{cursor:null,limit:1});
    if(result.data.kind!=="native-commission-ledger")throw Error();
    expect(result.data.records).toHaveLength(1);expect(result.data.stateTotals?.held.value?.minorUnits).toBe(10000);
    expect(result.data.stateTotals?.paid.value?.minorUnits).toBe(7000);expect(result.data.records[0]!.balances.creatorPaid.value?.minorUnits).toBe(9000);
    expect(JSON.stringify(result.data.stateTotals)).not.toContain("fictional-whole-snapshot-balance");
  });
  it.each(["partial","negative","future"] as const)("rejects %s whole-snapshot state balances",async invalid=>{
    const w=setup(snapshot=>{const fact={state:"known" as const,value:{minorUnits:invalid==="negative"?-1:100,currency:"USD" as const},evidenceRef:"fictional-balance",observedAt:invalid==="future"?new Date(Date.parse(snapshot.observedAt)+1).toISOString():snapshot.observedAt,reasonCode:null};
      snapshot.stateTotals={held:fact,disputed:fact,awaitingProvider:fact,paid:fact};if(invalid==="partial"){snapshot.complete=false;snapshot.state="partial";}});
    if(invalid==="partial")w.state.partial=true;
    await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_STATE_TOTALS_UNVERIFIED"});
  });
  it("retains a final publication fence after the read and refuses a changed principal",async()=>{
    const w=setup(),result=await w.reader.read("commissionLedger",{},actor);w.state.denied=true;expect(()=>result.assertCurrent()).toThrow();
    const other=setup(s=>{s.principalRef="another-principal";});await expect(other.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({status:403});
  });
  it("bounds a hung source and does not permit an expired publication lease",async()=>{
    const w=setup(),source={...w.source,read:async()=>new Promise<never>(()=>{})};
    const reader=createSettlementReader({db:w.db,scope,secret:"fictional-private-reference-key",bindings:{source},now:w.now,timeoutMs:5});
    await expect(reader.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_SOURCE_TIMEOUT",status:504});
    const result=await w.reader.read("commissionLedger",{},actor);w.state.now+=300001;expect(()=>result.assertCurrent()).toThrow();
  });
  it("does not turn partial or stale zero coverage into confirmed absence",async()=>{
    const w=setup();w.records.splice(0);w.state.partial=true;expect((await w.reader.read("commissionLedger",{},actor)).empty).toBe(false);
    w.state.partial=false;w.state.stale=true;w.state.now+=1000;w.state.version="expired-zero";expect((await w.reader.read("commissionLedger",{},actor)).empty).toBe(false);
  });
  it("rejects a source that ignores the requested provider filter",async()=>{
    const w=setup(),original=w.source.read;w.source.read=(request)=>original({...request,provider:"all"});
    await expect(w.reader.read("commissionLedger",{provider:"tiktok"},actor)).rejects.toMatchObject({code:"SETTLEMENT_REQUEST_MISMATCH"});
  });

  it("keeps all three source ownership lanes and unknown accounting separate without payment authority",async()=>{
    const w=setup(),res=await w.reader.read("commissionLedger",{},actor);
    expect(res.data.kind).toBe("native-commission-ledger");if(res.data.kind!=="native-commission-ledger")throw Error();
    expect(res.data.records.map(r=>r.provider)).toEqual(["collabs","tiktok","externalManual"]);
    expect(res.data.records[0]!.balances.creatorPaid.value).toEqual({minorUnits:9000,currency:"USD"});
    expect(res.data.records[0]!.accounting.state).toBe("unknown");expect(res.data.capabilities).toEqual({match:false,export:false,pay:false});
    expect(JSON.stringify(res)).not.toContain("fixture-creator");expect(JSON.stringify(res)).not.toContain("collabs-one-receipt");
    const detail=await w.reader.read("settlementDetail",{settlementId:res.data.records[0]!.ref},actor);expect(detail.data.kind).toBe("native-settlement");
    if(detail.data.kind!=="native-settlement")throw Error();expect(detail.data.record!.ref).toBe(res.data.records[0]!.ref);
    const payable=await w.reader.read("payableDetail",{payableId:res.data.records[2]!.ref},actor);expect(payable.data.kind).toBe("native-payable");
  });
  it("unconfigured is unknown coverage, not confirmed empty or a zero balance",async()=>{const w=setup();const reader=createSettlementReader({db:w.db,scope,secret:"fictional-private-reference-key",now:w.now});
    const r=await reader.read("commissionLedger",{},actor);expect(r.empty).toBe(false);expect(r.total).toBeNull();expect(r.partial).toBe(true);if(r.data.kind!=="native-commission-ledger")throw Error();expect(r.data.totals.accrued.state).toBe("unknown");});
  it("does not confuse one current authorized empty snapshot with unconfigured",async()=>{const w=setup();w.records.splice(0);const r=await w.reader.read("commissionLedger",{},actor);expect(r.empty).toBe(true);expect(r.total).toBe(0);});
  it("paginates an exact snapshot and binds cursor to actor/filter/scope",async()=>{const w=setup();const r=await w.reader.read("commissionLedger",{},actor,{cursor:null,limit:1});expect(r.nextCursor).toBeTruthy();
    const second=await w.reader.read("commissionLedger",{},actor,{cursor:r.nextCursor,limit:1});if(second.data.kind!=="native-commission-ledger")throw Error();expect(second.data.records[0]!.provider).toBe("tiktok");
    await expect(w.reader.read("commissionLedger",{}, {...actor,principalRef:"other"},{cursor:r.nextCursor,limit:1})).rejects.toMatchObject({code:"SETTLEMENT_CURSOR_INVALID"});
    w.state.version="fixture-ledger-v2";await expect(w.reader.read("commissionLedger",{},actor,{cursor:r.nextCursor,limit:1})).rejects.toMatchObject({code:"SETTLEMENT_SNAPSHOT_CHANGED"});});
  it("rejects foreign opaque detail refs without asking the source",async()=>{const w=setup();const other=createSettlementReader({db:w.db,scope:{...scope,accountId:"another"},secret:"fictional-private-reference-key",bindings:{source:w.source},now:w.now});
    await expect(other.read("settlementDetail",{settlementId:w.reader.reference("settlement","collabs-one")},actor)).rejects.toMatchObject({status:404});expect(w.state.reads).toBe(0);});
  it("rejects wrong detail record and cross-scope source answers",async()=>{const w=setup(s=>{s.records=s.records.map(r=>({...r,ref:"different"}));});await expect(w.reader.read("settlementDetail",{settlementId:w.reader.reference("settlement","collabs-one")},actor)).rejects.toMatchObject({code:"SETTLEMENT_RECORD_MISMATCH"});
    const bad=setup(s=>{s.scope={...scope,accountId:"other"};});await expect(bad.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({status:403});});
  it("retains source partial coverage and unknown totals without claiming a complete export",async()=>{const w=setup();w.state.partial=true;const r=await w.reader.read("commissionLedger",{},actor);expect(r.partial).toBe(true);expect(r.total).toBeNull();expect(r.data.capabilities.export).toBe(false);});
  it("retains stale observations and disables all effect intents",async()=>{const w=setup();w.state.stale=true;w.state.now+=1000;const r=await w.reader.read("commissionLedger",{},actor);expect(r.stale).toBe(true);expect(r.data.source.state).toBe("stale");expect(r.data.capabilities.match).toBe(false);});
  it("fences permission withdrawn during the awaited source read",async()=>{const w=setup(()=>{w.state.denied=true;});await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({status:403});});
  it.each(["resolve","reject","false"])("fails closed on a non-void final source fence: %s",async kind=>{const w=setup();w.source.assertCurrent=(()=>kind==="false"?false:kind==="resolve"?Promise.resolve():Promise.reject(Error("synthetic"))) as unknown as SettlementSource["assertCurrent"];
    await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({status:403});});
  it("holds changed immutable receipt evidence across a later source version",async()=>{const w=setup();await w.reader.read("commissionLedger",{},actor);w.state.version="fixture-ledger-v2";w.records[0]!.receipts[0]!.amount.minorUnits++;
    await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_IMMUTABLE_RECEIPT_CONFLICT"});});
  it("allows an appended source adjustment while leaving original receipt unchanged",async()=>{const w=setup();await w.reader.read("commissionLedger",{},actor);const before=structuredClone(w.records[0]!.receipts);w.state.version="fixture-ledger-v2";
    w.records[0]!.adjustments.push({ref:"adjustment-new",receiptRef:before[0]!.ref,amount:{minorUnits:-300,currency:"USD"},effectiveAt:before[0]!.settledAt,observedAt:before[0]!.observedAt,reason:"refund",evidenceRef:"adjustment-proof"});
    const r=await w.reader.read("commissionLedger",{},actor);if(r.data.kind!=="native-commission-ledger")throw Error();expect(r.data.records[0]!.adjustments).toHaveLength(1);
    const adjustment=structuredClone(w.records[0]!.adjustments[0]!);w.state.version="fixture-ledger-v3";
    w.records[0]!.adjustments.push({...adjustment,ref:"adjustment-appended",amount:{minorUnits:100,currency:"USD"},reason:"correction",evidenceRef:"appended-adjustment-proof"});
    const appended=await w.reader.read("commissionLedger",{},actor);if(appended.data.kind!=="native-commission-ledger")throw Error();
    expect(appended.data.records[0]!.adjustments).toHaveLength(2);expect(w.records[0]!.adjustments[0]).toEqual(adjustment);expect(w.records[0]!.receipts).toEqual(before);});
  it.each(["amount","reason","evidence","receipt"] as const)("holds an immutable adjustment's changed %s across source revisions and reader recreation",async field=>{
    const w=setup(),record=w.records[0]!,receipt=record.receipts[0]!;
    record.receipts.push({...structuredClone(receipt),ref:"another-fictional-receipt"});
    record.adjustments.push({ref:"adjustment-original",receiptRef:receipt.ref,amount:{minorUnits:-300,currency:"USD"},effectiveAt:receipt.settledAt,observedAt:receipt.observedAt,reason:"refund",evidenceRef:"original-adjustment-proof"});
    await w.reader.read("commissionLedger",{},actor);w.state.version="fixture-ledger-v2";
    const adjustment=record.adjustments[0]!;
    if(field==="amount")adjustment.amount.minorUnits--;
    else if(field==="reason")adjustment.reason="correction";
    else if(field==="evidence")adjustment.evidenceRef="changed-adjustment-proof";
    else adjustment.receiptRef="another-fictional-receipt";
    const restarted=createSettlementReader({db:w.db,scope,secret:"fictional-private-reference-key",bindings:{source:w.source},now:w.now});
    await expect(restarted.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_IMMUTABLE_ADJUSTMENT_CONFLICT",status:409});
  });
  it("rejects conflicting adjustment identities within one provider/account snapshot",async()=>{
    const w=setup(),record=w.records[0]!,receipt=record.receipts[0]!;
    record.adjustments.push({ref:"adjustment-shared",receiptRef:receipt.ref,amount:{minorUnits:-300,currency:"USD"},effectiveAt:receipt.settledAt,observedAt:receipt.observedAt,reason:"refund",evidenceRef:"adjustment-proof"});
    const other=structuredClone(record);other.ref="another-fictional-record";other.adjustments[0]!.amount.minorUnits--;
    w.records.push(other);
    await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_IMMUTABLE_ADJUSTMENT_CONFLICT",status:409});
  });
  it("holds conflicting facts under the same source version",async()=>{const w=setup();await w.reader.read("commissionLedger",{},actor);w.records[0]!.balances.billed=w.money(9000);await expect(w.reader.read("commissionLedger",{},actor)).rejects.toMatchObject({code:"SETTLEMENT_SOURCE_CONFLICT"});});
  it("rejects unsafe monetary precision, future evidence and a false complete count",async()=>{for(const edit of [(s:SettlementSnapshot)=>{s.records[0]!.receipts[0]!.amount.minorUnits=Number.MAX_SAFE_INTEGER+1;},(s:SettlementSnapshot)=>{s.records[0]!.facts[0]!.observedAt="2099-01-01T00:00:00Z";},(s:SettlementSnapshot)=>{s.total=4;}]){
    const w=setup(edit);await expect(w.reader.read("commissionLedger",{},actor)).rejects.toBeDefined();}});
  it("does not expose unapproved external links or source identifiers",async()=>{const w=setup();w.records[0]!.links=[{kind:"order",targetRef:null,state:"verified",url:"https://untrusted.example/path?token=synthetic",observedAt:new Date(w.state.now).toISOString(),validUntil:new Date(w.state.now+10000).toISOString()}];
    const r=await w.reader.read("commissionLedger",{},actor);expect(JSON.stringify(r)).not.toContain("untrusted.example");if(r.data.kind!=="native-commission-ledger")throw Error();expect(r.data.records[0]!.links[0]!.url).toBeNull();});
});
