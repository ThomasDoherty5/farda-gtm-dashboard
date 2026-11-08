// @vitest-environment node
import { afterEach,expect,it } from "vitest";
import { fulfillmentFixture, type FictionalFulfillmentSnapshot } from "./fixtures.testkit.ts";
import { createFulfillmentDomain } from "./service.ts";
import { fulfillmentPlanSchema } from "./contract.ts";
import { actionTestSecret } from "../actions/fixtures.testkit.ts";
import type { FulfillmentSource } from "./source.ts";
const fixtures:ReturnType<typeof fulfillmentFixture>[]=[];
const setup=(kind:Parameters<typeof fulfillmentFixture>[0]="shippingDecision")=>{const w=fulfillmentFixture(kind);fixtures.push(w);return w;};
afterEach(()=>{for(const w of fixtures.splice(0))w.close();});

it.each(["shippingDecision","returnTask"] as const)("creates an exact %s canonical preview and pure original-key recovery with no business effect",async kind=>{
  const w=setup(kind),input=await w.input(),before=await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal);expect(before.data.recovery?.state).toBe("absent");
  const result=await w.domain.preview(input,w.principal);expect(result.response.approvalRef).toBeTruthy();expect(result.response.runRef).toBeNull();
  const count=w.state.ownerReads;w.state.version="source-v2";
  const recovered=await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal);expect(recovered.data.recovery).toMatchObject({state:"recorded",approvalRef:result.response.approvalRef});
  expect(w.state.ownerReads).toBe(count);expect(JSON.stringify(recovered.data)).not.toContain(input.payload.reason);expect(w.state.effects).toBe(0);
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);
});
it("rejects changed payloads under the original key and does not rebase a submitted intent",async()=>{
  const w=setup(),input=await w.input();await w.domain.preview(input,w.principal);
  await expect(w.domain.preview({...input,payload:{...input.payload,reason:"Changed reason"}},w.principal)).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  const again=await w.domain.preview(input,w.principal);expect(again.response.approvalRef).toBeTruthy();expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.state.effects).toBe(0);
});
it("does not mint a second approval for a claimed exact source plan under a fresh key or actor",async()=>{
  const w=setup(),input=await w.input();await w.domain.preview(input,w.principal);
  expect((await w.domain.read(w.filters,w.principal)).data.plans[0]?.capability).toMatchObject({state:"held",reasonCodes:["FULFILLMENT_PLAN_ALREADY_PROPOSED"]});
  await expect(w.domain.preview({...input,idempotencyKey:"second-key"},w.principal)).rejects.toMatchObject({code:"FULFILLMENT_PLAN_ALREADY_PROPOSED"});
  const other={principalRef:"synthetic:reviewer"},view=await w.domain.read(w.filters,other);
  await expect(w.domain.preview({...input,expectedVersion:view.data.version,idempotencyKey:"other-actor-key"},other)).rejects.toMatchObject({code:"FULFILLMENT_PLAN_ALREADY_PROPOSED"});
  // A renewed observation or unrelated source revision does not grant this exact plan another identity.
  w.state.version="source-v2";await expect(w.domain.preview(await w.input("same-plan-new-source"),w.principal)).rejects.toMatchObject({code:"FULFILLMENT_PLAN_ALREADY_PROPOSED"});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.state.effects).toBe(0);
  w.plan.version="plan-v2";const revised=await w.domain.preview(await w.input("source-authorized-new-plan"),w.principal);expect(revised.response.approvalRef).toBeTruthy();
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(2);
});
it("keeps an uncertain original proposal across restart and blocks a fresh-key bypass",async()=>{
  const w=setup(),input=await w.input(),resolve=w.owner.resolveDraft;w.owner.resolveDraft=async()=>{throw Error("Fictional unavailable source");};
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({executionCertainty:"uncertain"});w.restart();
  expect((await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal)).data.recovery?.state).toBe("pending");
  expect((await w.domain.read(w.filters,w.principal)).data.capability).toMatchObject({state:"held",reasonCodes:["FULFILLMENT_PRIOR_PROPOSAL_PENDING"]});
  await expect(w.domain.preview({...input,idempotencyKey:"fresh-key"},w.principal)).rejects.toMatchObject({code:"FULFILLMENT_PRIOR_PROPOSAL_PENDING"});
  w.owner.resolveDraft=resolve;const same=await w.domain.preview(input,w.principal);expect(same.response.approvalRef).toBeTruthy();
  expect((await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal)).data.recovery?.state).toBe("recorded");expect(w.state.effects).toBe(0);
});
it("requires explicit current historical access and exact actor/target binding for recovery",async()=>{
  const w=setup(),input=await w.input();await w.domain.preview(input,w.principal);w.state.historyDenied=true;
  await expect(w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal)).rejects.toMatchObject({status:403});w.state.historyDenied=false;
  await expect(w.domain.read({...w.filters,targetRef:"other-target",requestKey:input.idempotencyKey},w.principal)).rejects.toMatchObject({status:403});
  const other=await w.domain.read({...w.filters,requestKey:input.idempotencyKey},{principalRef:"synthetic:reviewer"});expect(other.data.recovery?.state).toBe("absent");
});
it("holds source-unknown previous actions and missing qualified owners",async()=>{
  const w=setup(),input=await w.input();w.state.unresolved="original-source-action";
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({code:"FULFILLMENT_ORIGINAL_ACTION_UNCERTAIN"});w.state.unresolved=null;
  w.bindings.owners.clear();const domain=w.restart();expect((await domain.read(w.filters,w.principal)).data.capability.state).toBe("held");
  await expect(domain.preview(await w.input(),w.principal)).rejects.toMatchObject({code:"FULFILLMENT_OWNER_UNCONFIGURED",status:503});
});
it.each(["EUR","JPY","KWD"])("rejects %s source money before projection or canonical proposal",async currency=>{
  const w=setup(),input=await w.input(),read=w.source.read;if(w.plan.remedy.kind!=="refund")throw Error();
  expect(fulfillmentPlanSchema.safeParse({...w.plan,remedy:{...w.plan.remedy,amount:{minorUnits:3499,currency},remainingRefundable:{minorUnits:3499,currency}}}).success).toBe(false);
  w.source.read=async request=>{const s=await read(request,{}) as FictionalFulfillmentSnapshot;return {...s,plans:[{...w.plan,remedy:{...w.plan.remedy,amount:{minorUnits:3499,currency},remainingRefundable:{minorUnits:3499,currency}}}]};};
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({code:"CURRENCY_NOT_SUPPORTED",status:503});
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({code:"CURRENCY_NOT_SUPPORTED",status:503});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM fulfillment_proposal_intents").get()?.n).toBe(0);
});
it("rejects over-refund, mixed remedies, missing inspection and excess/unsafe restock quantity",()=>{
  const w=setup("returnTask");if(w.plan.remedy.kind!=="refund")throw Error();
  expect(fulfillmentPlanSchema.safeParse({...w.plan,remedy:{...w.plan.remedy,amount:{minorUnits:3500,currency:"USD"}}}).success).toBe(false);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,remedy:{...w.plan.remedy,newShipmentRef:"invented-replacement"}}).success).toBe(false);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,inspection:null}).success).toBe(false);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,inspection:{...w.plan.inspection!,inspectedQuantity:2}}).success).toBe(false);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,inspection:{...w.plan.inspection!,condition:"quarantine"}}).success).toBe(false);
});
it("binds a replacement to its new keys, exact stock, home and spend without reserving or shipping",async()=>{
  const w=setup("returnTask");w.plan.remedy={kind:"replacement",skuRef:"fictional-sku",quantity:1,home:"H2",originalOrderRef:"fictional-order",originalShipmentRef:"fictional-original-shipment",
    newOrderRef:"fictional-replacement-order",newShipmentRef:"fictional-replacement-shipment",stockEvidenceRef:"fictional-stock",stockVersion:"stock-v1",availableQuantity:1,addressRef:"fictional-address-reference",costBound:{minorUnits:2500,currency:"USD"}};
  w.plan.items[0]!.units=1;w.plan.items[0]!.spendMinor=2500;
  const read=await w.domain.read(w.filters,w.principal);expect(read.data.plans[0]?.remedy).toMatchObject({kind:"replacement",quantity:1,home:"H2",costBound:{minorUnits:2500}});
  const result=await w.domain.preview(await w.input(),w.principal);expect(result.response.approvalRef).toBeTruthy();expect(w.state.effects).toBe(0);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,remedy:{...w.plan.remedy,newShipmentRef:w.plan.remedy.originalShipmentRef}}).success).toBe(false);
  expect(fulfillmentPlanSchema.safeParse({...w.plan,remedy:{...w.plan.remedy,availableQuantity:0}}).success).toBe(false);
});
it("rejects source scope/permission/version changes after awaits and retains a final read fence",async()=>{
  const w=setup(),read=w.source.read;w.source.read=async request=>{const s=await read(request,{}) as FictionalFulfillmentSnapshot;w.state.permissionVersion="permission-v2";return s;};
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({code:"FULFILLMENT_SOURCE_CHANGED"});w.source.read=read;
  const observed=await w.domain.read(w.filters,w.principal);w.state.denied=true;expect(()=>observed.assertCurrent()).toThrow();w.state.denied=false;
  w.source.read=async request=>{const s=await read(request,{}) as FictionalFulfillmentSnapshot;s.request.targetRef="foreign";return s;};
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({status:403});
});
it.each(["async","nonvoid"] as const)("rejects a %s final source fence before saving a proposal",async kind=>{
  const w=setup(),input=await w.input();w.source.assertCurrent=(()=>kind==="async"?Promise.resolve():false) as unknown as FulfillmentSource["assertCurrent"];
  await expect(w.domain.preview(input,w.principal)).rejects.toBeDefined();expect(w.a.db.prepare("SELECT COUNT(*) n FROM fulfillment_proposal_intents").get()?.n).toBe(0);
});
it("fences an awaited owner version change and rejects malicious unapproved draft bounds",async()=>{
  const w=setup(),input=await w.input(),resolve=w.owner.resolveDraft;w.owner.resolveDraft=async args=>{const draft=await resolve(args);w.state.version="changed-after-await";return draft;};
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({executionCertainty:"uncertain"});expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);
  const other=setup(),original=other.owner.resolveDraft;other.owner.resolveDraft=async args=>{const draft=await original(args) as {bounds:{maxSpendMinor:number}};draft.bounds.maxSpendMinor++;return draft;};
  await expect(other.domain.preview(await other.input(),other.principal)).rejects.toMatchObject({executionCertainty:"uncertain"});expect(other.state.effects).toBe(0);
});
it("requires the canonical payload reference to identify the immutable original intent",async()=>{
  const w=setup(),resolve=w.owner.resolveDraft;w.owner.resolveDraft=async args=>({...((await resolve(args)) as object),payloadRef:"unrelated-source-payload"});
  await expect(w.domain.preview(await w.input(),w.principal)).rejects.toMatchObject({code:"FULFILLMENT_DRAFT_BINDING_CHANGED"});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);expect(w.state.effects).toBe(0);
});
it("bounds hung sources, rejects overlong leases and refuses late publication after cancellation",async()=>{
  const w=setup(),read=w.source.read;w.source.read=async()=>new Promise(()=>{});
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({code:"SOURCE_READ_TIMEOUT",status:504});
  w.source.read=async request=>{const s=await read(request,{}) as FictionalFulfillmentSnapshot;s.validUntil=new Date(w.a.state.now+300001).toISOString();return s;};
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({code:"FULFILLMENT_SOURCE_STALE"});w.source.read=read;
  const abort=new AbortController(),result=await w.domain.read(w.filters,w.principal,abort.signal);abort.abort();expect(()=>result.assertCurrent()).toThrow("REQUEST_CANCELLED");
});
it("is unconfigured by default and does not accept a synthetic source as named authority",async()=>{
  const w=setup(),domain=createFulfillmentDomain({db:w.a.db,scope:w.scope,secret:actionTestSecret,actions:()=>w.foundation.service,approvals:()=>w.foundation.approvals});
  await expect(domain.read(w.filters,w.principal)).rejects.toMatchObject({status:503});
  w.a.sources.resolveActor=async()=>null;await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({status:403});
});
it("preserves a current 403 after the canonical owner await and never returns protected prior data",async()=>{
  const w=setup(),input=await w.input(),resolve=w.owner.resolveDraft;
  w.owner.resolveDraft=async args=>{const draft=await resolve(args);w.state.denied=true;return draft;};
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({status:403,executionCertainty:"uncertain"});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);expect(w.state.effects).toBe(0);
});
it("rejects actor revocation during a source await and at final publication",async()=>{
  const w=setup(),read=w.source.read,person=w.a.humans.get(w.principal.principalRef)!;
  w.source.read=async request=>{const result=await read(request,{});person.active=false;return result;};
  await expect(w.domain.read(w.filters,w.principal)).rejects.toMatchObject({status:403});
  person.active=true;w.source.read=read;const result=await w.domain.read(w.filters,w.principal);person.directoryVersion="directory-v2";
  expect(()=>result.assertCurrent()).toThrow("FULFILLMENT_ACTOR_DENIED");
});
it.each(["async","nonvoid"] as const)("rejects a %s owner fence without recording a canonical manifest",async kind=>{
  const w=setup(),input=await w.input();w.owner.assertCurrent=(()=>kind==="async"?Promise.resolve():false) as unknown as typeof w.owner.assertCurrent;
  await expect(w.domain.preview(input,w.principal)).rejects.toMatchObject({executionCertainty:"uncertain"});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(0);expect(w.state.effects).toBe(0);
});
it("fences absent-to-recorded recovery and subsequent canonical receipt revision changes",async()=>{
  const w=setup(),input=await w.input(),absent=await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal);
  const preview=await w.domain.preview(input,w.principal);expect(()=>absent.assertCurrent()).toThrow("FULFILLMENT_REQUEST_CHANGED");
  const recorded=await w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal);
  // A canonical repository revision is independent of source snapshot revision.
  w.a.db.prepare("UPDATE approval_heads SET revision=revision+1 WHERE ref=?").run(preview.response.approvalRef!);
  expect(()=>recorded.assertCurrent()).toThrow("FULFILLMENT_REQUEST_CHANGED");expect(()=>preview.assertCurrent()).toThrow("FULFILLMENT_INTENT_CHANGED");
});
it("retains the qualified handler without wrapping or rewriting its canonical execution proof",()=>{
  const w=setup();expect(w.domain.domain.handlers.get("fulfillment-fictional-owner.v1")).toBe(w.handler);
});
it.each([false,true])("fences a late original during an absent retry (conflicting reason: %s)",async conflicting=>{
  const w=setup(),input=await w.input(),read=w.source.read;let first=true,release!:()=>void,entered!:()=>void;
  const blocked=new Promise<void>(resolve=>{entered=resolve;}),resume=new Promise<void>(resolve=>{release=resolve;});
  w.source.read=async request=>{const snapshot=await read(request,{});if(first){first=false;entered();await resume;}return snapshot;};
  const retry=w.domain.preview(input,w.principal);await blocked;
  try{await w.domain.preview(conflicting?{...input,payload:{...input.payload,reason:"Other original reason"}}:input,w.principal);}finally{release();}
  await expect(retry).rejects.toMatchObject({code:conflicting?"IDEMPOTENCY_CONFLICT":"FULFILLMENT_REQUEST_CHANGED"});
  expect(w.a.db.prepare("SELECT COUNT(*) n FROM approval_manifests").get()?.n).toBe(1);expect(w.state.effects).toBe(0);
  w.state.historyDenied=true;await expect(w.domain.read({...w.filters,requestKey:input.idempotencyKey},w.principal)).rejects.toMatchObject({status:403});
});
