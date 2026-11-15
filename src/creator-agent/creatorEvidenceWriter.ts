import { digest, type ConfigBinding } from "./config.ts";
import type { EvidencePacket } from "./evidence.ts";
import { protectCommentAuthors } from "./evidencePrivacy.ts";
import type { OfferRepository } from "./offers/repository.ts";
import type { OperationsScope } from "./operations.ts";
import { assessCreator } from "./policy.ts";
import { resolveScorecardEvidence, type ScorecardAuthority } from "./routeEvidence.ts";
import { AgentConflict, type AgentStore, type StoredAssessment } from "./store.ts";

export type CreatorEvidenceWrite = { packet: EvidencePacket; expectedVersion: number; configHash: string | null };
export type CreatorEvidenceWriter = {
  /** Scoped privacy normalization applied to new intake and to every retry comparison. */
  protect(packet: EvidencePacket): EvidencePacket;
  /**
   * The only creator evidence writer. It protects comment authors, resolves server-held route proof, runs J02 and appends an
   * immutable revision. `fence` runs synchronously immediately before the append so a caller can recheck its own source lease.
   */
  write(input: CreatorEvidenceWrite, idempotencyKey: string, options?: { origin?: "reviewer" | "collector"; fence?: () => void }): Promise<StoredAssessment>;
};

/**
 * A reviewer can rate or gate a collected packet, never author or strip J20 collection facts. The rule follows the BASE
 * revision the reviewer edited from. While the reviewer keeps J20 evidence, the brief, route, collection marker, reviewed
 * posts and recent-post rows must come back exactly as stored; only ratings, criterion ratings and their references, gates
 * and revision labels may change. A reviewer leaves collection only by writing an uncollected packet for another brief, or by
 * an audited detach that names the exact collected revision and a reason. A packet that was never collected cannot gain J20
 * provenance, and a detach marker cannot be created or edited outside that exit.
 */
function assertCollectedFactsUnchanged(store: AgentStore, packet: EvidencePacket, expectedVersion: number, protect: (packet: EvidencePacket) => EvidencePacket) {
  const base = expectedVersion ? store.history(packet.creatorId).find(record => record.revision === expectedVersion) : null;
  if (expectedVersion && !base) throw new AgentConflict("VERSION_CONFLICT");
  const basis = base ? protect(base.packet) : null;
  const collectedFacts = (p: EvidencePacket) => digest({ creatorId: p.creatorId, briefId: p.briefId, checkoutRoute: p.checkoutRoute,
    posts: p.posts, recentPosts: p.recentPosts, collection: p.collection ?? null });
  const sourced = Boolean(packet.collection || packet.posts.some(post => post.source));
  const refuse = () => { throw new AgentConflict("J20_COLLECTION_READ_ONLY"); };
  if (basis?.collection) {
    if (sourced) return void (packet.detachedCollection || collectedFacts(basis) !== collectedFacts(packet) ? refuse() : undefined);
    if (packet.briefId !== basis.briefId) return void (packet.detachedCollection ? refuse() : undefined);
    const exit = packet.detachedCollection;
    return void (exit?.fromRevision === expectedVersion && exit.fromEvidenceRevision === basis.evidenceRevision ? undefined : refuse());
  }
  if (sourced || (packet.detachedCollection && digest(packet.detachedCollection) !== digest(basis?.detachedCollection ?? null))) refuse();
}

export function createCreatorEvidenceWriter(deps: { store: AgentStore; scope: OperationsScope; secret: string;
  scorecardAuthority?: ScorecardAuthority; modelBinding(route: EvidencePacket["checkoutRoute"]): ConfigBinding | null;
  acceptedTerms: OfferRepository["acceptedTerms"] }): CreatorEvidenceWriter {
  const protect = (packet: EvidencePacket) => protectCommentAuthors(packet, deps.scope, deps.secret);
  return {
    protect,
    async write(input, idempotencyKey, options = {}) {
      const binding = deps.modelBinding(input.packet.checkoutRoute);
      if (input.configHash !== (binding?.hash ?? null)) throw new AgentConflict("CONFIG_VERSION_CONFLICT");
      const packet = protect(input.packet);
      if ((options.origin ?? "reviewer") === "reviewer") assertCollectedFactsUnchanged(deps.store, packet, input.expectedVersion, protect);
      const proof = await resolveScorecardEvidence(deps.scorecardAuthority, { workspaceId: deps.scope.workspaceId, accountId: deps.scope.accountId },
        packet, Date.now(), id => deps.acceptedTerms(id));
      const assessment = assessCreator(packet, binding, proof);
      options.fence?.();
      return deps.store.save(packet, assessment, input.expectedVersion, idempotencyKey, protect);
    },
  };
}
