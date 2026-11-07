import { cleanup, render, screen } from "@testing-library/react";
import { runItemExecutionSchema, type RunItemRecovery } from "@/creator-agent/actions/reviewViews";
import { NativeRunRecovery } from "./NativeRunRecovery";

const expected: [RunItemRecovery["kind"],RunItemRecovery["nextAction"],string][] = [
  ["login","signInAtSource","Source owner must sign in"],
  ["mfa","completeMfaAtSource","Source owner must complete MFA"],
  ["denied","ownerPermissionReview","another route cannot bypass it"],
  ["throttled","waitForSourceReset","source-confirmed reset"],
  ["failed","inspectFailure","Inspect the recorded failure"],
  ["uncertain","reconcileOriginal","Do not resend or generate a new key"],
];
afterEach(cleanup);
it.each(expected)("shows actual source recovery %s with its owner and precise next action",(kind,nextAction,note)=>{
  const now=Date.now(),at=new Date(now-1000).toISOString(),until=new Date(now+60_000).toISOString();
  const execution=runItemExecutionSchema.parse({state:"held",attempts:1,dueAt:at,updatedAt:at,checkpointVersion:2,reasonCode:"SOURCE_HOLD",attemptOutcome:{state:"open",attemptNumber:1,receiptRef:null,observedAt:at},
    recovery:{kind,owner:{state:"visible",value:"Synthetic source owner",reasonCode:null},nextAction,deadline:until,resetAt:kind==="throttled"?until:null,reasonCodes:["SOURCE_HOLD"],observedAt:at,validUntil:until}});
  render(<NativeRunRecovery current data={{items:[{itemRef:"item-opaque",receiptRef:null,sourceEffect:null,observedAt:null,execution}]}}/>);
  expect(screen.getByText("Synthetic source owner")).toBeInTheDocument();
  expect(screen.getByText((text)=>text.includes(note))).toBeInTheDocument();
  expect(screen.getByText("Original attempt remains open")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});
it("retains local history but withholds expired source owner and never turns unknown into a reset time",()=>{
  const old=new Date(Date.now()-1000).toISOString();
  const execution=runItemExecutionSchema.parse({state:"failed",attempts:2,dueAt:old,updatedAt:old,checkpointVersion:3,reasonCode:"SOURCE_TIMEOUT",attemptOutcome:{state:"unknown",attemptNumber:null,receiptRef:null,observedAt:null},
    recovery:{kind:"throttled",owner:{state:"visible",value:"Expired owner label",reasonCode:null},nextAction:"waitForSourceReset",deadline:null,resetAt:null,reasonCodes:[],observedAt:old,validUntil:old}});
  render(<NativeRunRecovery current data={{items:[{itemRef:"item-opaque",receiptRef:null,sourceEffect:null,observedAt:null,execution}]}}/>);
  expect(screen.getByText("failed")).toBeInTheDocument();expect(screen.getByText("Attempt outcome unknown")).toBeInTheDocument();
  expect(screen.queryByText("Expired owner label")).not.toBeInTheDocument();expect(screen.getByText("Unknown · no current source reset")).toBeInTheDocument();
});
