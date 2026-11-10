import {screen} from "@testing-library/react";
import {createDemoAdapter} from "@/adapter/demoAdapter";
import {renderWithAdapter} from "@/test/renderWithAdapter";
import type {OperationsServiceEvidence} from "@/creator-agent/operationsControlsSchema";
import {NativeControlServiceEvidence} from "./NativeControlServiceEvidence";

const repair:OperationsServiceEvidence={kind:"repairReceipt",targetRef:"synthetic-target",receiptRef:"synthetic-receipt",sourceVersion:"synthetic-version",state:"applied",observedAt:"2026-11-07T12:00:00Z",sourceReadbackVersion:null,mirrorReadbackVersion:null,ownerRef:"synthetic-owner"};
it("distinguishes a repair write receipt from matching comparison and incident resolution",()=>{
 renderWithAdapter(<NativeControlServiceEvidence evidence={[repair]} section="reconciliation"/>,createDemoAdapter());
 expect(screen.getByText("applied")).toBeInTheDocument();expect(screen.getAllByText("Not verified")).toHaveLength(2);
 expect(screen.getByText(/A request or write acknowledgment does not resolve the conflict/)).toBeInTheDocument();
 expect(screen.queryByText(/The source reports a resolved incident/)).not.toBeInTheDocument();
});
it("shows the source-confirmed resolved stage with both exact readback versions",()=>{
 renderWithAdapter(<NativeControlServiceEvidence evidence={[{...repair,state:"resolved",sourceReadbackVersion:"synthetic-source-readback",mirrorReadbackVersion:"synthetic-mirror-readback"}]} section="reconciliation"/>,createDemoAdapter());
 expect(screen.getByText("synthetic-source-readback")).toBeInTheDocument();expect(screen.getByText("synthetic-mirror-readback")).toBeInTheDocument();
 expect(screen.getByText(/The source reports a resolved incident/)).toBeInTheDocument();
});
it("does not turn missing reporting sources into active recurrence or zero delivery",()=>{
 renderWithAdapter(<NativeControlServiceEvidence evidence={[]} section="reports"/>,createDemoAdapter());
 expect(screen.getByText(/Runtime activation, report programme and delivery are unknown/)).toBeInTheDocument();
 expect(screen.getByText(/A saved draft or setup post does not establish recurrence/)).toBeInTheDocument();
});
it("renders an uncertain report without a delivery receipt or completion claim",()=>{
 renderWithAdapter(<NativeControlServiceEvidence section="reports" evidence={[{kind:"report",targetRef:"synthetic-target",data:{schemaVersion:"farda.report.v1",reportRef:"synthetic-report",runRef:"synthetic-run",state:"reconcile",executionCertainty:"uncertain",sourceEffect:"unknown",observedAt:"2026-11-07T12:00:00Z",current:{sendEligible:false,reasonCodes:["OUTCOME_UNKNOWN"]},receipt:null,usage:{zapierTasks:"unknown",cost:"unknown"},grantsBusinessAuthority:false}}]}/>,createDemoAdapter());
 expect(screen.getByText("uncertain")).toBeInTheDocument();expect(screen.getByText("No confirmed delivery receipt")).toBeInTheDocument();expect(screen.getByText("OUTCOME_UNKNOWN")).toBeInTheDocument();
});
