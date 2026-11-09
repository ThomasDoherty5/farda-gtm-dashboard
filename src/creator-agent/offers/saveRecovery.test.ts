// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { offerPolicyFixture } from "./policyFixture.testkit.ts";
import { digest } from "../config.ts";
const cleanups:(()=>void)[]=[];afterEach(()=>cleanups.splice(0).forEach(clean=>clean()));
function setup(){const w=offerPolicyFixture();cleanups.push(()=>w.store.database.close());const offer=w.save();return {...w,offer};}
describe("existing offer command readback",()=>{
  it("reads the exact recorded original after a later revision without claiming current acceptance",()=>{const w=setup(),key="synthetic-original",terms={...w.terms,commission:{...w.terms.commission,standardRateBps:1500}},hash=digest({id:w.offer.offerId,expected:w.offer.version,terms,job:null,operation:"offer-propose"});const saved=w.repo.saveFromAdapter(w.offer.offerId,w.offer.version,terms,key);w.repo.saveFromAdapter(saved.offerId,saved.version,{...terms,commission:{...terms.commission,standardRateBps:1600}},"synthetic-later");expect(w.repo.readSaveRequest(saved.offerId,w.offer.version,key,hash)).toMatchObject({state:"recorded",record:{version:saved.version,terms},confersRetry:false});});
  it("absence is not a terminal no-op",()=>{const w=setup();expect(w.repo.readSaveRequest(w.offer.offerId,w.offer.version,"synthetic-missing","a".repeat(64))).toMatchObject({state:"notFound",record:null,confersRetry:false});});
  it("rejects cross-offer, wrong payload and wrong expected-version recovery",()=>{const w=setup(),key="synthetic-original",terms=w.terms,hash=digest({id:w.offer.offerId,expected:w.offer.version,terms,job:null,operation:"offer-propose"});w.repo.saveFromAdapter(w.offer.offerId,w.offer.version,terms,key);for(const args of [["other-offer",w.offer.version,key,hash],[w.offer.offerId,"v999",key,hash],[w.offer.offerId,w.offer.version,key,"b".repeat(64)]] as const)expect(()=>w.repo.readSaveRequest(...args)).toThrow("OFFER_SAVE_RECOVERY_MISMATCH");});
});
