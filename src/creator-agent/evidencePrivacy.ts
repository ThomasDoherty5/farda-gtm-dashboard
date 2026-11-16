import { createHmac, timingSafeEqual } from "node:crypto";
import type { EvidencePacket, PostEvidence } from "./evidence.ts";
import type { OperationsScope } from "./operations.ts";

const alias = /^author:([0-9a-f]{32})([0-9a-f]{32})$/;
const accountAlias = /^account:([0-9a-f]{32})([0-9a-f]{32})$/;
function scopedAlias(kind: "author" | "account", version: string, value: string, network: PostEvidence["network"], scope: OperationsScope, secret: string): string {
  const mac = (purpose: string, input: string) => createHmac("sha256",secret)
    .update(JSON.stringify([version,scope.workspaceId,scope.accountId,scope.environment,network,purpose,input]))
    .digest("hex").slice(0,32);
  // Authenticate the scope and network of an existing alias before preserving it on a retry.
  const prior = (kind === "author" ? alias : accountAlias).exec(value);
  if (prior && timingSafeEqual(Buffer.from(prior[2]!, "hex"),Buffer.from(mac("tag",prior[1]!),"hex"))) return value;
  const hidden = mac("identity",value);
  return `${kind}:${hidden}${mac("tag",hidden)}`;
}
const authorAlias = (author: string, network: PostEvidence["network"], scope: OperationsScope, secret: string) =>
  scopedAlias("author", "evidence-comment-author.v1", author, network, scope, secret);

/** Apply to new source intake and outgoing historical projections without mutating the source packet. Comment authors and J20 provider accounts become scoped aliases. */
export function protectCommentAuthors(packet: EvidencePacket, scope: OperationsScope, privateOperationsSecret: string): EvidencePacket {
  if (!privateOperationsSecret || !scope.workspaceId || !scope.accountId || !scope.environment)
    throw new Error("COMMENT_AUTHOR_PROTECTION_UNAVAILABLE");
  return {...packet,posts:packet.posts.map(post => {
    // A J20 provider account is replaced by a scoped alias before storage and on every outgoing projection.
    const source = post.source?.providerAccountRef ? {...post.source,providerAccountRef:scopedAlias("account","evidence-provider-account.v1",
      post.source.providerAccountRef,post.network,scope,privateOperationsSecret)} : post.source;
    const withSource = source === post.source ? post : {...post,source};
    if (post.comments.status !== "observed") return withSource;
    const rows = post.comments.rows.map(row => row.authorRef === null ? row : {...row,authorRef:authorAlias(row.authorRef,post.network,scope,privateOperationsSecret)});
    return {...withSource,comments:{...post.comments,rows}};
  })};
}
