// @vitest-environment node
import { describe, expect, it } from "vitest";
import { AgentStore } from "../store.ts";
import { createActionDomainServices } from "./domainServices.ts";
import { readinessSnapshotSchema } from "./contract.ts";
import { readinessSourceUrlSchema } from "./readinessPresentation.ts";
import { actionDomainFixture, actionTestScope, actionTestSecret, founderFixture } from "./fixtures.testkit.ts";

function fixture() {
  const f = actionDomainFixture();
  f.source.presentation = { evidenceStage: "synthetic", recordRef: f.source.targetRef, recordVersion: f.source.version,
    recordUrl: "https://www.notion.so/fictional-launch-record", dateProposalUrl: "https://www.notion.so/fictional-date-workflow",
    sampleAcceptance: {state:"verified", evidenceRef:"product-evidence", version:"synthetic-sample-v1", observedAt:f.source.observedAt} };
  f.source.gates[0]!.presentation = {label:"Product qualification", owner:"Fictional product owner", taskUrl:"https://linear.app/fictional-team/issue/TEST-1",
    evidenceUrl:"https://www.notion.so/fictional-product-evidence", dueRelative:"L − 7"};
  return f;
}
describe("permission-bound readiness presentation", () => {
  it.each(["https://evil.test/record", "https://notion.so.evil.test/record", "javascript:alert(1)", "http://notion.so/record", "https://user@notion.so/record", "https://notion.so/record?token=private", "https://notion.so/record#private"])("rejects an unsafe or token-bearing source link %s", url => {
    expect(readinessSourceUrlSchema.safeParse(url).success).toBe(false);
  });
  it.each(["record", "version", "acceptance", "time"])("rejects %s metadata outside the exact source record", kind => {
    const f=fixture(), p=f.source.presentation!;
    if(kind==="record")p.recordRef="different-launch";
    if(kind==="version")p.recordVersion="different-version";
    if(kind==="acceptance")p.sampleAcceptance!.evidenceRef="unverified-evidence";
    if(kind==="time")p.sampleAcceptance!.observedAt=f.source.validUntil;
    expect(readinessSnapshotSchema.safeParse(f.source).success).toBe(false);
  });
  it("aliases exact source identities, preserves unset L and refuses revoked access without writing", async () => {
    const f=fixture(), store=new AgentStore(":memory:",actionTestScope);
    try {
      f.source.launchDate=null;f.source.launchDateApproved=false;
      const service=createActionDomainServices({db:store.database,scope:actionTestScope,secret:actionTestSecret,...f});
      const d=await service.readReadiness(f.source.targetRef,founderFixture);
      expect(d.launchDate).toBeNull();expect(d.confersRelease).toBe(false);
      expect(d.presentation).toMatchObject({recordRef:d.targetRef,recordVersion:d.version,evidenceStage:"synthetic"});
      expect(d.presentation!.sampleAcceptance!.evidenceRef).toBe(d.evidenceRefs[0]);
      expect(d.presentation!.sampleAcceptance!.version).not.toBe("synthetic-sample-v1");
      expect(d.gates[0]!.presentation?.owner).toBe("Fictional product owner");
      f.state.denySource=true;
      await expect(service.readReadiness(f.source.targetRef,founderFixture)).rejects.toMatchObject({status:403});
      expect(f.state.writes).toBe(0);
    } finally {store.close();}
  });
});
