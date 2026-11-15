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
 * revision the reviewer edited from: if it was collected, the brief, route, collection marker, every reviewed post and every
 * recent-post row must be returned exactly as stored. Only ratings, criterion ratings and their references, gates and
 * revision labels may change. A packet that was never collected cannot gain J20 provenance through this path.
 */
function assertCollectedFactsUnchanged(store: AgentStore, packet: EvidencePacket, expectedVersion: number, protect: (packet: EvidencePacket) => EvidencePacket) {
  const base = expectedVersion ? store.history(packet.creatorId).find(record => record.revision === expectedVersion) : null;
  if (expectedVersion && !base) throw new AgentConflict("VERSION_CONFLICT");
  const basis = base ? protect(base.packet) : null;
  const collectedFacts = (p: EvidencePacket) => digest({ creatorId: p.creatorId, briefId: p.briefId, checkoutRoute: p.checkoutRoute,
    posts: p.posts, recentPosts: p.recentPosts, collection: p.collection ?? null });
  if (basis?.collection ? collectedFacts(basis) !== collectedFacts(packet) : Boolean(packet.collection || packet.posts.some(post => post.source)))
    throw new AgentConflict("J20_COLLECTION_READ_ONLY");
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
