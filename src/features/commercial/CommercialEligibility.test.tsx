import { act, cleanup, render, screen } from "@testing-library/react";
import { commercialEligibilityReasonCodes, commercialEligibilityViewSchema, type CommercialEligibilityView } from "@/creator-agent/commercialPolicy/views";
import { CommercialEligibility, CommercialItemEligibility, commercialReasonLabel } from "./CommercialEligibility";
import { commercialAssessmentPath, commercialSelectionFromSearch } from "./selection";

afterEach(()=>{cleanup();vi.useRealTimers();});
const hash="a".repeat(64);
export const commercialFixture=(patch:Partial<CommercialEligibilityView>={}):CommercialEligibilityView=>commercialEligibilityViewSchema.parse({
  kind:"commercial-eligibility",selected:{offerRef:`commercial-offer-${hash}`,version:"v1"},phase:"invitation",state:"held",reasonCodes:["CREATOR_FEE_REQUEST"],basisStatus:"current",
  policyVersion:`commercial-policy-${hash}`,modelVersion:`commercial-model-${hash}`,configVersion:`commercial-config-${hash}`,rewardBasis:"notApplicable",rewardVersion:null,basisHash:hash,confersApproval:false,sourceEffect:"none",validity:{observedAt:new Date(Date.now()).toISOString(),validUntil:new Date(Date.now()+60000).toISOString()},...patch,
});

describe("one commercial projection presenter",()=>{
  it("keeps exact normalized reasons, phase and provenance separate from qualification and approval",()=>{
    render(<CommercialEligibility data={commercialFixture()}/>);
    expect(screen.getByText("Commercial invitation held")).toBeInTheDocument();
    expect(screen.getByText("CREATOR_FEE_REQUEST")).toBeInTheDocument();
    expect(screen.getByText(/grants no approval/)).toBeInTheDocument();
    expect(screen.getByText(`commercial-policy-${hash}`)).toBeInTheDocument();
    expect(commercialEligibilityReasonCodes.every(code=>commercialReasonLabel(code).length>10)).toBe(true);
  });
  it("does not turn missing, unbound or retained stale read data into an eligible result",()=>{
    const view=render(<CommercialEligibility/>);expect(screen.getByText("Commercial eligibility unknown")).toBeInTheDocument();
    view.rerender(<CommercialEligibility data={commercialFixture({selected:null,state:"unbound",reasonCodes:["OFFER_SELECTION_REQUIRED"],basisStatus:"notSelected"})}/>);
    expect(screen.getByText("No exact offer selected")).toBeInTheDocument();
    view.rerender(<CommercialEligibility current={false} data={commercialFixture({state:"eligible",reasonCodes:[]})}/>);
    expect(screen.queryByText("Commercially eligible for invitation")).not.toBeInTheDocument();
    expect(screen.getByText("Current commercial eligibility unavailable")).toBeInTheDocument();
  });
  it("stops presenting an idle expired or legacy untimed pass as current",()=>{
    vi.useFakeTimers();const now=Date.parse("2026-11-07T12:00:00Z");vi.setSystemTime(now);
    const data=commercialFixture({state:"eligible",reasonCodes:[],validity:{observedAt:new Date(now).toISOString(),validUntil:new Date(now+1000).toISOString()}});
    const view=render(<CommercialEligibility data={data}/>);expect(screen.getByText("Commercially eligible for invitation")).toBeInTheDocument();act(()=>vi.advanceTimersByTime(1001));
    expect(screen.queryByText("Commercially eligible for invitation")).not.toBeInTheDocument();expect(screen.getByText("Current commercial eligibility unavailable")).toBeInTheDocument();
    view.rerender(<CommercialEligibility data={{...data,validity:undefined}}/>);expect(screen.getByText(/Current source timing is unavailable/)).toBeInTheDocument();expect(screen.queryByText("Commercially eligible for invitation")).not.toBeInTheDocument();
  });
  it("uses explicit source applicability rather than guessing from a local or completed receipt",()=>{
    const view=render(<CommercialItemEligibility applicability="required"/>);expect(screen.getByText("Commercial eligibility unknown")).toBeInTheDocument();
    view.rerender(<CommercialItemEligibility applicability="notApplicable"/>);expect(screen.getByText(/not applicable to this recorded item/)).toBeInTheDocument();
    view.rerender(<CommercialItemEligibility/>);expect(screen.getByText(/Commercial applicability unknown/)).toBeInTheDocument();
  });
  it("preserves exact URL identity and never converts missing, duplicate or malformed selection to a different offer",()=>{
    expect(commercialSelectionFromSearch(new URLSearchParams())).toEqual({});
    expect(commercialSelectionFromSearch(new URLSearchParams("offerId=offer-one"))).toEqual({offerId:"offer-one"});
    expect(commercialSelectionFromSearch(new URLSearchParams("offerId=one&offerId=two"))).toBeNull();
    expect(commercialSelectionFromSearch(new URLSearchParams("offerVersion=v0"))).toBeNull();
    expect(commercialSelectionFromSearch(new URLSearchParams("phase=publish"))).toBeNull();
    expect(commercialAssessmentPath("creator one","run one",{offerId:"exact-offer",offerVersion:"v7",phase:"activation"})).toBe("/creators/creator%20one/assessments/run%20one?offerId=exact-offer&offerVersion=v7&phase=activation");
    expect(commercialAssessmentPath("c","r",{offerId:"o",phase:undefined})).toBe("/creators/c/assessments/r?offerId=o");
  });
});
