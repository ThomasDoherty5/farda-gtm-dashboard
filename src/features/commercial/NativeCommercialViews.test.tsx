import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdapterError } from "@/adapter/errors";
import type { ReadRequest, ReadResponse } from "@/adapter/contract";
import { commercialEligibilityViewSchema, type CommercialEligibilityView } from "@/creator-agent/commercialPolicy/views";
import type { AgentAssessmentRecord, NativeRecruitmentView } from "@/creator-agent/readViews";
import { scorecardPreviewPath, parseScorecardSelection, type ScorecardPreview } from "@/creator-agent/scorecardPreview";
import { offerPolicyFixture } from "@/creator-agent/offers/policyFixture.testkit";
import { syntheticAgentEvidence, syntheticQualification } from "@/test/creatorQualification";
import { renderRoute, scriptedAdapter } from "@/test/renderWithAdapter";
import type { CommercialOfferRecord } from "@/features/scorecards/SavedOffer";

afterEach(cleanup);
const hash="b".repeat(64),creatorId="synthetic-creator",runId="synthetic-run",offerId="synthetic-offer";
const selected={creatorId,runId,offerId,offerVersion:"v1",phase:"invitation" as const};
const commercial=(patch:Partial<CommercialEligibilityView>={}):CommercialEligibilityView=>commercialEligibilityViewSchema.parse({kind:"commercial-eligibility",selected:{offerRef:`commercial-offer-${hash}`,version:"v1"},phase:"invitation",state:"held",reasonCodes:["CREATOR_FEE_REQUEST"],basisStatus:"current",policyVersion:`commercial-policy-${hash}`,modelVersion:`commercial-model-${hash}`,configVersion:`commercial-config-${hash}`,rewardBasis:"notApplicable",rewardVersion:null,basisHash:hash,confersApproval:false,sourceEffect:"none",validity:{observedAt:new Date(Date.now()).toISOString(),validUntil:new Date(Date.now()+60000).toISOString()},...patch});
function records() {
  const fixture=offerPolicyFixture();let offer:CommercialOfferRecord;
  try{offer={...fixture.save(),commercialEligibility:commercial()};}finally{fixture.store.close();}
  const qualification=syntheticQualification({creatorId});
  const assessment:AgentAssessmentRecord={kind:"creator-v3",creatorId,assessmentId:runId,runId,evidenceId:"synthetic-post-1",qualification,assessedQualification:qualification,agentEvidence:syntheticAgentEvidence({creatorId}),recordedAt:"2026-11-04T12:00:00Z",revision:1,stale:false,superseded:false,commercialEligibility:commercial()};
  const preview:ScorecardPreview={kind:"agent-scorecard-preview",selectedCount:1,dispatchAuthorized:false,items:[{creatorId,runId,status:"eligible",route:"website",modelId:qualification.modelId,configHash:null,policyVersion:qualification.policyVersion,evidenceRevision:"source-v1",termsRevision:"terms-v1",sourceRef:null,evidencePostId:null,score:88,stale:false,reasonCodes:[],commercialEligibility:commercial(),acceptedOffer:null,criteria:[]}]};
  const queue:NativeRecruitmentView={kind:"native-recruitment",filters:{networks:"both",route:"queue"},observedAt:new Date(Date.now()).toISOString(),validUntil:new Date(Date.now()+60000).toISOString(),sourceAlias:`recruitment-source-${hash}`,coverage:{returned:1,total:1,complete:true},dispatchAuthorized:false,rows:[{opportunityRef:`recruitment-opportunity-${hash}`,creatorId,runId,offerId,offerVersion:"v1",phase:"invitation",network:"instagram",route:"inbound",assessment:{state:qualification.state,score:88,stale:false},commercialEligibility:commercial()}]};
  return {offer,assessment,preview,queue};
}
function fixture() {
  const data=records(),requests:ReadRequest<unknown>[]=[];let denied=false,unavailable=false;
  const adapter=scriptedAdapter(async (request:ReadRequest<unknown>)=>{
    requests.push(request);
    if(denied||unavailable)throw new AdapterError({code:denied?"FORBIDDEN":"INTEGRATION_PENDING",message:"Source unavailable",requestId:request.requestId,correlationId:null,retryable:false,retryAfterMs:null});
    const value=request.viewKey==="assessmentRecord"?data.assessment:request.viewKey==="offerDraft"?data.offer:request.viewKey==="batchDetail"?data.preview:request.viewKey==="recruitmentQueue"?data.queue:null;
    const result:ReadResponse<unknown>={schemaVersion:request.schemaVersion,requestId:request.requestId,scope:{...request.requestedScope,authorizationScopeVersion:"synthetic-commercial-scope"},dataVersion:"synthetic-v1",dataState:"ready",data:value,sourceFreshness:[],coverage:{expectedCount:1,observedCount:1,missingCount:0,complete:true,reasonCodes:[]},capabilities:[{actionKind:"saveOfferDraft",state:"available",reasonCodes:[]}],page:{nextCursor:null,hasMore:false},refresh:{nextPollAfterMs:null}};
    return result;
  },"live");
  return {data,adapter:{...adapter,environment:"sandbox" as const},requests,deny:()=>{denied=true;},disconnect:()=>{unavailable=true;}};
}

describe("CP08 native exact-selection presentation",()=>{
  it.each(["assessment","offer","preview","recruitment"] as const)("shows the same current fee hold on %s without changing saved qualification",async page=>{
    const f=fixture(),snapshot=structuredClone(f.data.assessment.qualification);
    const route=page==="assessment"?`/creators/${creatorId}/assessments/${runId}?offerId=${offerId}&offerVersion=v1&phase=invitation`:page==="offer"?`/offers/${offerId}`:page==="preview"?scorecardPreviewPath([selected]):"/creators/social-cat/recruitment";
    renderRoute(route,f.adapter);expect(await screen.findByText("CREATOR_FEE_REQUEST")).toBeInTheDocument();
    expect(screen.getByText("Commercial invitation held")).toBeInTheDocument();
    expect(f.data.assessment.qualification).toEqual(snapshot);
    if(page==="preview")expect(screen.getByText("1 selected · 1 content-qualified · 0 commercially eligible")).toBeInTheDocument();
    if(page==="assessment")expect(f.requests.find(r=>r.viewKey==="assessmentRecord")?.filters).toEqual({creatorId,assessmentId:runId,offerId,offerVersion:"v1",phase:"invitation"});
  });
  it("creates a finite source selection with the original exact offer context and no demo queue facts",async()=>{
    const f=fixture(),user=userEvent.setup();renderRoute("/creators/social-cat/recruitment",f.adapter);await screen.findByText("CREATOR_FEE_REQUEST");
    expect(screen.queryByText(/routine.with.ella|299 \/ month|Draft 15%/)).not.toBeInTheDocument();
    expect(screen.getByRole("link",{name:"Review saved assessment"})).toHaveAttribute("href",`/creators/${creatorId}/assessments/${runId}?offerId=${offerId}&offerVersion=v1&phase=invitation`);
    await user.click(screen.getByLabelText("Select source row 1"));
    const href=screen.getByRole("link",{name:"Review selected invitation set"}).getAttribute("href")!;
    expect(parseScorecardSelection(new URL(href,"http://synthetic.local").searchParams)).toEqual([selected]);
  });
  it("keeps later-phase source selections distinct from invitation readiness",async()=>{
    const f=fixture(),user=userEvent.setup();f.data.queue.rows[0]!.phase="activation";f.data.queue.rows[0]!.commercialEligibility.phase="activation";
    renderRoute("/creators/social-cat/recruitment",f.adapter);await screen.findByText("Commercial activation held");await user.click(screen.getByLabelText("Select source row 1"));
    const href=screen.getByRole("link",{name:"Review selected commercial set"}).getAttribute("href")!;expect(parseScorecardSelection(new URL(href,"http://synthetic.local").searchParams)?.[0]?.phase).toBe("activation");
  });
  it("does not count a legacy untimed commercial pass as current finite eligibility",async()=>{
    const f=fixture();f.data.preview.items[0]!.commercialEligibility=commercial({state:"eligible",reasonCodes:[],validity:undefined});renderRoute(scorecardPreviewPath([selected]),f.adapter);
    await screen.findByText("1 selected · 1 content-qualified · Unknown commercially eligible");expect(screen.queryByText("Commercially eligible for invitation")).not.toBeInTheDocument();
  });
  it("source disconnect displays no synthetic recipient, plan or proposed message",async()=>{
    const f=fixture();f.disconnect();renderRoute("/creators/social-cat/recruitment",f.adapter);
    await screen.findByText(/Source unavailable/);
    expect(screen.queryByText(creatorId)).not.toBeInTheDocument();expect(screen.queryByText(/routine.with.ella|299 \/ month|Draft 15%/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Instagram")).not.toBeInTheDocument();
  });
  it("clears protected source rows and commercial results after a denied refresh",async()=>{
    const f=fixture(),user=userEvent.setup();renderRoute("/creators/social-cat/recruitment",f.adapter);await screen.findByText("CREATOR_FEE_REQUEST");f.deny();await user.click(screen.getByRole("button",{name:"Refresh recruitment evidence"}));
    await waitFor(()=>expect(screen.queryByText("CREATOR_FEE_REQUEST")).not.toBeInTheDocument());expect(screen.queryByText(creatorId)).not.toBeInTheDocument();
  });
  it("does not certify unsaved offer edits with the saved commercial pass",async()=>{
    const f=fixture(),user=userEvent.setup();f.data.offer.commercialEligibility=commercial({state:"eligible",reasonCodes:[]});renderRoute(`/offers/${offerId}`,f.adapter);
    await screen.findByText("Commercially eligible for invitation");await user.clear(screen.getByLabelText("Creator commission (%)"));await user.type(screen.getByLabelText("Creator commission (%)"),"19");
    expect(screen.queryByText("Commercially eligible for invitation")).not.toBeInTheDocument();expect(screen.getByText(/Unsaved edits are outside/)).toBeInTheDocument();
    await user.click(screen.getByRole("button",{name:"Review commitment"}));
    const dialog=screen.getAllByRole("dialog",{hidden:true}).find(node=>within(node).queryByRole("heading",{name:"Review commitment",hidden:true}))!;expect(within(dialog).getByText("Current commercial eligibility unavailable")).toBeInTheDocument();expect(within(dialog).queryByText(/0 unresolved/)).not.toBeInTheDocument();
  });
});
