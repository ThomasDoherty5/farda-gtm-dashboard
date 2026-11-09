import { invitationFieldIssues } from "./invitationValidation";
const now = Date.parse("2026-11-09T07:00:00Z");
const visible = { state: "visible" as const, value: "Fictional source", reasonCode: null };
const terms = {creatorId:"fictional-creator",offerId:"fictional-offer",offerVersion:"v1",productRef:"fictional-product",programRef:"fictional-program",sourceVersion:"source-v1",templateRef:"template-v1",templateVersion:"template-v1",claimsVersion:"claims-v1",message:"An everyday routine invitation.",startsAt:"2026-11-09T07:01:00Z",expiresAt:"2026-11-09T07:02:00Z",timezone:"UTC",sampleRequested:false};
const source = {limits:{maxRateBps:1500,maxValiditySeconds:120,startsNotBefore:"2026-11-09T07:00:30Z",expiresNotAfter:"2026-11-09T07:03:00Z",timezone:"UTC"},offer:{expiresAt:"2026-11-09T07:03:00Z",standardRateBps:1200,shopAdsRateBps:null},products:[{ref:"fictional-product",programRef:"fictional-program",label:visible,market:visible,category:visible,eligible:true,reasonCodes:[]}],creators:[{creatorId:"fictional-creator",ref:"fictional-profile",label:visible,eligible:true,reasonCodes:[]}]};
it("accepts a source-bound future window and marks missing or reversed dates at fields",()=>{
  expect(invitationFieldIssues(terms,source,now)).toEqual({});
  expect(invitationFieldIssues({...terms,startsAt:""},source,now)).toHaveProperty("startsAt");
  expect(invitationFieldIssues({...terms,expiresAt:terms.startsAt},source,now)).toHaveProperty("expiresAt");
});
it("does not replace actual program deadlines with a proposed seven-day default",()=>{
  expect(invitationFieldIssues({...terms,expiresAt:"2026-11-16T07:02:00Z"},source,now)).toHaveProperty("expiresAt");
  expect(invitationFieldIssues(terms,{...source,limits:{...source.limits,maxValiditySeconds:null}},now)).toHaveProperty("expiresAt");
  expect(invitationFieldIssues(terms,source,Date.parse(terms.startsAt)+1)).toHaveProperty("startsAt");
});
it("rejects stale source identity, unavailable listing and unsupported commission at the relevant fields",()=>{
  expect(invitationFieldIssues({...terms,programRef:"foreign-program"},source,now)).toHaveProperty("productRef");
  expect(invitationFieldIssues(terms,{...source,creators:[]},now)).toHaveProperty("creatorId");
  expect(invitationFieldIssues(terms,{...source,offer:{...source.offer,standardRateBps:1600}},now)).toHaveProperty("commission");
});
