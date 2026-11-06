// @vitest-environment node
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe,expect,it,vi } from "vitest";
import { AgentStore } from "./store.ts";
import { EvidenceReviewRepository } from "./evidenceReviewStore.ts";
import { assessCreator } from "./policy.ts";
import { evidencePacketSchema, reviewSchema, type EvidencePacket } from "./evidence.ts";
import { syntheticBinding, syntheticPacket } from "./testFixtures.ts";

const scope = { workspaceId:"test-workspace", accountId:"test-account" };
const synthetic = () => {
  const packet = syntheticPacket();
  const post = packet.posts[0]!;
  post.review = {...post.review, visualMethod:"continuous", sampledPoints:[], watchedIntervals:[{startSec:0,endSec:2},{startSec:2,endSec:4},{startSec:7,endSec:8}],
    audioMethod:"heard", claims:[], heardIntervals:[{startSec:1,endSec:3}], reviewedAt:post.observedAt,reviewerRef:"synthetic:reviewer"};
  post.accessObservation = {state:"permitted",observedAt:post.observedAt,sourceRef:"synthetic:source"};
  return packet;
};
function service(path=":memory:") {
  const store = new AgentStore(path,scope);
  const reviews = new EvidenceReviewRepository(store,scope,(record,superseded=false)=>({...record,stale:superseded}));
  const save = (packet: EvidencePacket, expected=0) => store.save(packet,assessCreator(packet,syntheticBinding()),expected,"source-"+expected);
  return {store,reviews,save};
}
describe("immutable reviews of selected source evidence",()=>{
  it("refuses invalid offsets for post publication, source observation and comment sampling time",()=>{
    for(const property of ["publishedAt","observedAt","comment"] as const) {
      const packet=synthetic(),post=packet.posts[0]!,invalid="2026-11-05T16:00:00+99:99";
      if(property==="comment" && post.comments.status==="observed") post.comments.observedAt=invalid;
      else if(property!=="comment") post[property]=invalid;
      expect(evidencePacketSchema.safeParse(packet).success).toBe(false);
    }
  });
  it("binds annotations to their source and historical revisions across restart, with safe retries and no changed source assessment",()=>{
    vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-06T20:00:00.000Z"));
    const dir=mkdtempSync(join(tmpdir(),"farda-evidence-")), path=join(dir,"state.sqlite");
    const first=service(path), packet=synthetic(), creator=packet.creatorId, id=packet.posts[0]!.postId;
    try {
      const initial=first.save(packet), before=first.reviews.read(creator,id)!;
      const input = {kind:"disagree" as const, creatorId:creator, runId:initial.runId, basisHash:before.data.sourceReview.basisHash,
        targetId:"action-0",reason:"The recorded action needs another review."};
      const receipt=first.reviews.saveFromAdapter(id,before.data.version,input,"first","agent-reviewer","reviewerAssessment");
      expect(receipt.resource.original?.label).toContain(packet.posts[0]!.review.observedActions[0]!.action);
      expect(first.reviews.contested(initial)).toBe(true);
      expect(first.store.latest(creator)!.assessment).toEqual(initial.assessment);
      expect(first.reviews.read(creator,id)!.data.qualification).toMatchObject({state:"reviewNeeded",reasonCodes:expect.arrayContaining(["EVIDENCE_DISPUTED"])});
      expect(()=>first.reviews.saveFromAdapter(id,before.data.version,{...input,reason:"Another actual review discrepancy."},"second","agent-reviewer")).toThrow("STALE_VERSION");
      expect(()=>first.reviews.saveFromAdapter(id,before.data.version,input,"first","another-reviewer")).toThrow("IDEMPOTENCY_KEY_REUSED");
      first.store.close();
      const reopened=service(path);
      try {
        expect(reopened.reviews.saveFromAdapter(id,before.data.version,input,"first","agent-reviewer")).toEqual(receipt);
        const repeated=reopened.save(packet,1);
        const relabeled=reopened.save({...packet,evidenceRevision:"revision-label",termsRevision:"new-terms"},2);
        expect(reopened.reviews.contested(repeated)).toBe(true);
        expect(reopened.reviews.contested(relabeled)).toBe(true);
        const rereview=structuredClone(packet);
        rereview.evidenceRevision="changed-media"; rereview.posts[0]!.review.sourceRef="synthetic:fresh-review";
        rereview.posts[0]!.review.reviewedAt=new Date(Date.parse(receipt.updatedAt)-1000).toISOString();
        rereview.posts[0]!.review.observedActions[0]!.action="Corrected observation from new review";
        const beforeChallenge=reopened.save(rereview,3);
        expect(reopened.reviews.contested(beforeChallenge)).toBe(true);
        vi.setSystemTime(Date.parse(receipt.updatedAt)+2000);
        rereview.evidenceRevision="post-challenge-review";rereview.posts[0]!.review.reviewedAt=new Date().toISOString();
        rereview.posts[0]!.review.sourceRef="synthetic:post-challenge-review";
        reopened.save(rereview,4);
        const old=reopened.reviews.read(creator,id,initial.runId)!, current=reopened.reviews.read(creator,id)!;
        expect(old.data.sourceReview).toMatchObject({superseded:true,newerRunId:repeated.runId,annotations:[receipt.resource]});
        expect(current.data.sourceReview).toMatchObject({olderRunId:beforeChallenge.runId,contested:false,annotations:[]});
        expect(current.data.sourceReview.basisHash).not.toBe(input.basisHash);
        expect(()=>reopened.reviews.saveFromAdapter(id,old.data.version,input,"late","agent-reviewer")).toThrow("STALE_VERSION");
        expect(reopened.reviews.read("another-creator",id,initial.runId)).toBeNull();
        expect(()=>new EvidenceReviewRepository(reopened.store,{...scope,accountId:"foreign"},r=>({...r,stale:false}))).toThrow("DATABASE_SCOPE_MISMATCH");
      } finally {reopened.store.close();}
    } finally {try {first.store.close();} catch { /* first connection was closed before restart */ } rmSync(dir,{recursive:true,force:true});vi.useRealTimers();}
  });

  it("allows only actually covered modality intervals, rejects injected source changes, and preserves sampled points",()=>{
    const s=service(), packet=synthetic(), post=packet.posts[0]!, id=post.postId;
    try {
      const stored=s.save(packet), read=s.reviews.read(packet.creatorId,id)!;
      const input={kind:"observation" as const,creatorId:packet.creatorId,runId:stored.runId,basisHash:read.data.sourceReview.basisHash,
        note:{category:"demonstration" as const,startSec:1,endSec:4,text:"Hands open the sample case."}};
      const reject=(data:unknown,code:string)=>expect(()=>s.reviews.saveFromAdapter(id,read.data.version,data,"failed","agent-reviewer","evidenceDraft")).toThrow(code);
      reject({...input,note:{...input.note,endSec:7}},"OBSERVATION_OUTSIDE_REVIEW");
      reject({...input,note:{...input.note,category:"audio"}},"OBSERVATION_OUTSIDE_REVIEW");
      reject({...input,reviewer:"founder"},"VALIDATION_FAILED");
      reject({...input,basisHash:"a".repeat(64)},"STALE_VERSION");
      const saved=s.reviews.saveFromAdapter(id,read.data.version,input,"covered","agent-reviewer","evidenceDraft");
      expect(saved.resource.input).toEqual(input);
      const validAudio={...input,note:{...input.note,category:"audio",endSec:3}};
      expect(s.reviews.saveFromAdapter(id,saved.version,validAudio,"heard","agent-reviewer").resource.revision).toBe(2);
      const sampled=packet.posts[1]!, other=s.reviews.read(packet.creatorId,sampled.postId)!;
      expect(()=>s.reviews.saveFromAdapter(sampled.postId,other.data.version,{...input,basisHash:other.data.sourceReview.basisHash},"sampled","agent-reviewer")).toThrow("OBSERVATION_OUTSIDE_REVIEW");
      expect(reviewSchema.safeParse({...post.review,audioMethod:"asr"}).success).toBe(false);
    } finally {s.store.close();}
  });

  it.each(["sampledPoints","watchedIntervals","heardIntervals","observedActions","claims","inferences","duplicateInference"] as const)(
    "keeps a whole-review dispute active when %s changes representation without changing evidence",field=>{
      vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-11-06T20:00:00.000Z"));
      const s=service(), packet=synthetic(), post=packet.posts[0]!, review=post.review;
      try {
        if(field==="sampledPoints") {review.visualMethod="sampledFrames";review.sampledPoints=[0,4,8];review.watchedIntervals=[];}
        review.observedActions.push({atSec:7,action:"Returns the fictional case to a bag.",meaningfulUse:true});
        review.claims=[{atSec:1,text:"Fictional spoken claim one.",method:"heard"},{atSec:2,text:"Fictional spoken claim two.",method:"heard"}];
        review.inferences=["The original interpretation.","A second source interpretation."];
        const initial=s.save(packet),original=s.reviews.read(packet.creatorId,post.postId)!;
        s.reviews.saveFromAdapter(post.postId,original.data.version,{kind:"disagree",creatorId:packet.creatorId,runId:initial.runId,
          basisHash:original.data.sourceReview.basisHash,targetId:"review",reason:"The source review needs clarification."},"dispute","agent-reviewer");
        vi.advanceTimersByTime(1000);
        const relisted=structuredClone(packet), revised=relisted.posts[0]!.review;
        relisted.evidenceRevision="reordered-with-fresh-receipt"; revised.sourceRef="synthetic:rereview";revised.reviewedAt=new Date().toISOString();
        switch(field) {
          case "watchedIntervals": revised.watchedIntervals=[{startSec:7,endSec:8},{startSec:0,endSec:4},{startSec:1,endSec:3}];break;
          case "heardIntervals": revised.heardIntervals=[{startSec:2,endSec:3},{startSec:1,endSec:2}];break;
          case "duplicateInference": revised.inferences.push(revised.inferences[0]!);break;
          default: revised[field].reverse();
        }
        expect(s.reviews.contested(s.save(relisted,1))).toBe(true);
        vi.advanceTimersByTime(1000);
        const changed=structuredClone(relisted);
        changed.evidenceRevision="changed-source-action";changed.posts[0]!.review.sourceRef="synthetic:new-facts";
        changed.posts[0]!.review.reviewedAt=new Date().toISOString();
        changed.posts[0]!.review.observedActions[0]!.action="A materially corrected source action.";
        expect(s.reviews.contested(s.save(changed,2))).toBe(false);
      } finally {s.store.close();vi.useRealTimers();}
    });
});
