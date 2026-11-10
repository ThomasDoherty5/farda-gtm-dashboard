import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { approvalReviewSchema, type ApprovalReview } from "@/creator-agent/actions/reviewViews";
import { NativeReview } from "./NativeReview";

const visible=(value:string)=>({state:"visible",value,reasonCode:null});
function review():ApprovalReview {
  return approvalReviewSchema.parse({state:"complete",sourceVersionAlias:"review-source-opaque",observedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+1000).toISOString(),reasonCodes:[],
    context:{provider:visible("Synthetic provider"),account:visible("Permitted account label"),requestedBy:visible("Permitted operator"),reviewer:visible("Permitted reviewer"),historicalRole:visible("Reviewer at decision")},
    items:[{itemRef:"item-opaque",recipient:visible("Permitted recipient label"),product:visible("Source product"),terms:visible("Source terms"),payload:visible("Permitted exact synthetic payload")}],
    links:Object.fromEntries(["approval","source","session","settlement"].map(kind=>[kind,{state:"available",url:`https://review.example.test/${kind}`,label:`Open ${kind}`}])),
    settlement:{lane:"collabsAutoSettlement",detail:visible("Platform source settles commission")},confersAuthority:false});
}
afterEach(()=>{cleanup();vi.useRealTimers();});
it.each(["manualHistoricalPayable","collabsAutoSettlement","tiktokAutoSettlement"] as const)("keeps %s reconciliation read-only and distinct",lane=>{
  const original=HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open","");};
  try {
    const value=review();value.settlement.lane=lane;
    render(<NativeReview review={value} current/>);fireEvent.click(screen.getByRole("button",{name:"Inspect settlement reconciliation"}));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(/Reconciliation/);
    expect(screen.getByText(/Financial receipt: Unknown/)).toBeInTheDocument();
    expect(screen.getByRole("link",{name:"Open permitted settlement record"})).toHaveAttribute("href","https://review.example.test/settlement");
    expect(screen.queryByRole("button",{name:/^Pay|Send payment|Approve/})).not.toBeInTheDocument();
    const note=lane==="manualHistoricalPayable"?/already accepted historical obligation/:lane==="collabsAutoSettlement"?/Shopify Collabs owns/:/TikTok Shop owns/;
    expect(screen.getByText(note)).toBeInTheDocument();
  } finally {HTMLDialogElement.prototype.showModal=original;}
});
it("renders only source-granted plain text, preserves settlement lane and never adds release actions",()=>{
  const value=review();value.items[0]!.payload=visible("<script>synthetic untrusted text</script>") as ApprovalReview["items"][number]["payload"];
  render(<NativeReview review={value} current/>);
  expect(screen.getByText("<script>synthetic untrusted text</script>")).toBeInTheDocument();
  expect(document.querySelector("script")).toBeNull();
  expect(screen.getByText("Shopify Collabs automatic settlement")).toBeInTheDocument();
  expect(screen.getByRole("link",{name:"Open approval"})).toHaveAttribute("href","https://review.example.test/approval");
  expect(screen.queryByRole("button",{name:/Approve|Pay|Send/})).not.toBeInTheDocument();
});
it("removes protected values and source URLs when their exact display lease expires",async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
  render(<NativeReview review={review()} current/>);
  expect(screen.getByText("Permitted exact synthetic payload")).toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(1002);});
  expect(screen.queryByText("Permitted exact synthetic payload")).not.toBeInTheDocument();
  expect(screen.queryByText("Permitted account label")).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
it("does not present stale, redacted or absent fields as an exact complete preview",()=>{
  const value=review();value.state="partial";value.items[0]!.payload={state:"redacted",value:"Approved redaction",reasonCode:"SOURCE_REDACTED"};
  const {rerender}=render(<NativeReview review={value} current/>);
  expect(screen.getByText(/partial source review/)).toBeInTheDocument();
  expect(screen.getByText("Source redacted · Approved redaction")).toBeInTheDocument();
  rerender(<NativeReview review={value} current={false}/>);
  expect(screen.queryByText(/Approved redaction/)).not.toBeInTheDocument();expect(screen.queryByRole("link")).not.toBeInTheDocument();
  rerender(<NativeReview current/>);expect(screen.getByText(/Exact payload, recipient and product context were not returned/)).toBeInTheDocument();
});
