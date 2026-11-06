// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CollaborationEvidenceData } from "./collaborationEvidence.ts";
import { createCollaborationWorkflow } from "./collaborationWorkflow.ts";
import { collaborationAction, collaborationSnapshot, collabTestAt, collabTestId, collabTestScope as scope } from "./collaborationWorkflowFixtures.ts";
import type { CollaborationSourceSnapshot } from "./collaborationWorkflowSchema.ts";
import { AssetRepository } from "./assetStore.ts";
import { assetTestDatabase, assetTestScope, syntheticAsset, syntheticAssetAuthority } from "./assetTestFixtures.ts";

describe("independent adversarial review of collaboration source and evidence ordering",()=>{
  it.each(["removed-membership","reassigned-material","quarantined-asset"] as const)(
    "refuses a stale proposal after %s during authority lookup",async(change)=>{
      const db=assetTestDatabase();
      db.exec("CREATE TABLE capability_scope(id INTEGER PRIMARY KEY,workspace_id TEXT,account_id TEXT,environment TEXT)");
      db.prepare("INSERT INTO capability_scope VALUES(1,?,?,?)").run(scope.workspaceId,scope.accountId,scope.environment);
      let registry:CollaborationSourceSnapshot|null=collaborationSnapshot();
      const deliverable=registry.deliverables[0]!;
      registry.assetBindings=[{deliverableRef:deliverable.ref,assetId:"synthetic-asset"}];
      deliverable.submissionVersion=null;
      const source=syntheticAssetAuthority(), assets=new AssetRepository(db,assetTestScope,source.authority,()=>collabTestAt);
      const submitted=syntheticAsset({deliverableId:deliverable.ref,collaborationId:collabTestId});
      await assets.ingest({scope:assetTestScope,expectedVersion:0,submission:submitted},"original-asset");
      let armed=false, firstAssetRead=false, quarantineRecorded=false;
      const service=createCollaborationWorkflow(db,scope,"synthetic-private-key",async()=>{
        // A local authoritative version is revoked while a final remote membership read is in flight.
        if(armed && firstAssetRead && change==="quarantined-asset" && !quarantineRecorded) {
          quarantineRecorded=true;source.state.availability="quarantined";
          await assets.ingest({scope:assetTestScope,expectedVersion:1,submission:{...submitted,fileVersion:"file-v2"}},"quarantine-v2");
        }
        return structuredClone(registry);
      },()=>Date.parse(collabTestAt),async()=>{
        const head=assets.get(submitted.assetId)!;
        const data:CollaborationEvidenceData={source:"saved-agent-records",kind:"collaboration-evidence",collaborationId:collabTestId,
          observedAt:collabTestAt,total:1,offset:0,hasMore:false,records:[{kind:"asset",id:"synthetic-file-receipt",assetId:"synthetic-asset",
            fileVersion:head.submission.fileVersion,productId:head.submission.productId,productRevision:head.submission.productRevision,
            version:head.version,recordedAt:head.recordedAt,parentAssetId:null,parentVersion:null,availability:head.sourceEvidence.availability,
            reviewState:"pending",rightsState:"unknown",rightsObservedAt:null}]};
        if(armed && !firstAssetRead) {
          firstAssetRead=true;
          if(change==="removed-membership") registry=null;
          if(change==="reassigned-material" && registry) {
            registry=structuredClone(registry);
            registry.sourceRevision="different-material-membership";
            registry.assetBindings=[];
            registry.deliverables=[];
          }
        }
        return {data,nextCursor:null};
      });
      try {
        const before=await service.read(collabTestId);
        const submission=before!.data.deliverables[0]!.submissionVersion!;
        expect(submission).toMatch(/^v1-/); armed=true;
        await expect(service.propose(collaborationAction(before!.version,{
          kind:"approve-content",deliverableRef:deliverable.ref,submissionVersion:submission,
        }),"agent-reviewer")).rejects.toThrow();
        expect(firstAssetRead).toBe(true);
        if(change==="quarantined-asset") expect(assets.get(submitted.assetId)).toMatchObject({version:2,sourceEvidence:{availability:"quarantined"}});
        expect(db.prepare("SELECT COUNT(*) AS n FROM collaboration_review_proposals").get()?.n).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS n FROM collaboration_review_requests").get()?.n).toBe(0);
      } finally {db.close();}
    });
});
