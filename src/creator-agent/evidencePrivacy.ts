import { createHmac, timingSafeEqual } from "node:crypto";
import type { EvidencePacket, PostEvidence } from "./evidence.ts";
import type { OperationsScope } from "./operations.ts";

const alias = /^author:([0-9a-f]{32})([0-9a-f]{32})$/;
function authorAlias(author: string, network: PostEvidence["network"], scope: OperationsScope, secret: string): string {
  const mac = (purpose: string, input: string) => createHmac("sha256",secret)
    .update(JSON.stringify(["evidence-comment-author.v1",scope.workspaceId,scope.accountId,scope.environment,network,purpose,input]))
    .digest("hex").slice(0,32);
  // Authenticate the scope and network of an existing alias before preserving it on a retry.
  const prior = alias.exec(author);
  if (prior && timingSafeEqual(Buffer.from(prior[2]!, "hex"),Buffer.from(mac("tag",prior[1]!),"hex"))) return author;
  const value = mac("identity",author);
  return `author:${value}${mac("tag",value)}`;
}

/** Apply to new source intake and outgoing historical projections without mutating the source packet. */
export function protectCommentAuthors(packet: EvidencePacket, scope: OperationsScope, privateOperationsSecret: string): EvidencePacket {
  if (!privateOperationsSecret || !scope.workspaceId || !scope.accountId || !scope.environment)
    throw new Error("COMMENT_AUTHOR_PROTECTION_UNAVAILABLE");
  return {...packet,posts:packet.posts.map(post => {
    if (post.comments.status !== "observed") return post;
    const rows = post.comments.rows.map(row => row.authorRef === null ? row : {...row,authorRef:authorAlias(row.authorRef,post.network,scope,privateOperationsSecret)});
    return {...post,comments:{...post.comments,rows}};
  })};
}
