// @vitest-environment node
import { describe,expect,it } from "vitest";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import { deriveCommentStats, type CommentSample, type EvidencePacket } from "./evidence.ts";
import { assessCreator } from "./policy.ts";
import { AgentStore } from "./store.ts";
import { syntheticPacket,syntheticBinding } from "./testFixtures.ts";

const scope={workspaceId:"synthetic-workspace",accountId:"synthetic-account",environment:"sandbox" as const};
const secret="0123456789abcdef".repeat(4);
const rawEmail="sample.commenter@example.invalid", rawId="987654321012345";
const rows=(sample:CommentSample)=>sample.status==="observed"?sample.rows:[];

function packetWithAuthors() {
  const packet=syntheticPacket();
  const sample=packet.posts[0]!.comments;
  if(sample.status!=="observed") throw new Error("Expected observed synthetic comments");
  const first=sample.rows[0]!;
  sample.rows=[rawEmail,rawId,rawEmail,null].map((authorRef,index)=>({...first,commentId:`synthetic-comment-${index}`,authorRef}));
  packet.posts[1]!.comments=structuredClone(sample);
  packet.posts[2]!.network="tiktok";packet.posts[2]!.sourceUrl="https://www.tiktok.com/@synthetic/video/1111111";
  packet.posts[2]!.comments=structuredClone(sample);
  return packet;
}

describe("scoped commenter pseudonyms",()=>{
  it("deduplicates a raw email or native numeric ID across same-network posts without changing counts or other source facts",()=>{
    const packet=packetWithAuthors(), before=structuredClone(packet), safe=protectCommentAuthors(packet,scope,secret);
    const original=rows(packet.posts[0]!.comments), result=rows(safe.posts[0]!.comments);
    expect(result[0]!.authorRef).toMatch(/^author:[0-9a-f]{64}$/);
    expect(result[1]!.authorRef).toMatch(/^author:[0-9a-f]{64}$/);
    expect(result[0]!.authorRef).not.toBe(result[1]!.authorRef);
    expect(result[2]!.authorRef).toBe(result[0]!.authorRef);expect(result[3]!.authorRef).toBeNull();
    expect(rows(safe.posts[1]!.comments)[0]!.authorRef).toBe(result[0]!.authorRef);
    expect(rows(safe.posts[2]!.comments)[0]!.authorRef).not.toBe(result[0]!.authorRef);
    expect(result.map(({authorRef:ignored,...row})=>{void ignored;return row;})).toEqual(original.map(({authorRef:ignored,...row})=>{void ignored;return row;}));
    expect(deriveCommentStats(safe.posts[0]!.comments)).toEqual(deriveCommentStats(packet.posts[0]!.comments));
    expect(assessCreator(safe,syntheticBinding())).toEqual(assessCreator(packet,syntheticBinding()));
    expect(JSON.stringify(safe)).not.toContain(rawEmail);expect(JSON.stringify(safe)).not.toContain(rawId);
    expect(packet).toEqual(before);
  });
  it("preserves only tokens issued in the same network, workspace, account and key domain",()=>{
    const safe=protectCommentAuthors(packetWithAuthors(),scope,secret);
    const author=(p:EvidencePacket)=>rows(p.posts[0]!.comments)[0]!.authorRef;
    expect(protectCommentAuthors(safe,scope,secret)).toEqual(safe);
    for(const change of [{workspaceId:"other-workspace"},{accountId:"other-account"}])
      expect(author(protectCommentAuthors(safe,{...scope,...change},secret))).not.toBe(author(safe));
    expect(author(protectCommentAuthors(safe,scope,"fedcba9876543210".repeat(4)))).not.toBe(author(safe));
    const transferred=structuredClone(safe);
    transferred.posts[0]!.network="tiktok";
    expect(author(protectCommentAuthors(transferred,scope,secret))).not.toBe(author(safe));
    const forged="author:"+"f".repeat(64);rows(transferred.posts[0]!.comments)[0]!.authorRef=forged;
    expect(author(protectCommentAuthors(transferred,scope,secret))).not.toBe(forged);
  });
  it("projects a legacy stored receipt without rewriting its immutable assessment, request or packet hash",()=>{
    const db=new AgentStore(":memory:",scope),packet=packetWithAuthors();
    try {
      const saved=db.save(packet,assessCreator(packet,syntheticBinding()),0,"historical");
      const read=()=>db.database.prepare("SELECT body,packet_hash FROM assessments WHERE run_id=?").get(saved.runId);
      const record=read(), request=db.database.prepare("SELECT * FROM requests").get();
      expect(record?.body).toContain(rawEmail);
      const projection=protectCommentAuthors(db.findRun(packet.creatorId,saved.runId)!.packet,scope,secret);
      expect(JSON.stringify(projection)).not.toContain(rawEmail);expect(JSON.stringify(projection)).not.toContain(rawId);
      expect(read()).toEqual(record);expect(db.database.prepare("SELECT * FROM requests").get()).toEqual(request);
      expect(db.history(packet.creatorId)[0]!.packet).toEqual(packet);
    } finally {db.close();}
  });
});
