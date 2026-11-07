import { digest } from "../config.ts";
import { ApprovalError, approvalDraftSchema, type ApprovalDraft, type ApprovalRegistry } from "../approvals/contract.ts";
import type { OfferRepository } from "../offers/repository.ts";
import type { OfferPhase, OfferPolicyProof } from "../offers/policy.ts";
import { acquisitionTermsOf } from "./evaluate.ts";

type Offers = Pick<OfferRepository, "readOffer" | "resolvePolicyProof" | "assertPolicyProof">;
export function commercialProofHash(proof: OfferPolicyProof) {
  const { observedAt: _observed, validUntil: _until, ...material } = proof;
  void _observed; void _until; return digest(material);
}
/** A batch has one exact terms version even when each item selects a different saved offer. */
export function commercialTermsVersion(offers: { itemRef: string; offerRef: string; offerVersion: string }[]) {
  return offers.length === 1 ? offers[0]!.offerVersion : `commercial-terms:${digest(offers)}`;
}
const held = (code: string): never => { throw new ApprovalError(code); };

/** Adapt source-owned offers into the existing J04 registry. This issues no permission or execution grant. */
export function withCommercialOffers(registry: ApprovalRegistry, offers: Offers, now: () => number = Date.now): ApprovalRegistry {
  // Only this layer owns basisHash. Give the source owner its original material shape,
  // with the actual J04 identifiers/hash retained for native lookups. This projection
  // is never stored, signed, dispatched or passed off as a new approval manifest.
  const sourceView = (draft: ApprovalDraft): ApprovalDraft => draft.commercialOffers ? { ...draft,
    commercialOffers: draft.commercialOffers.map(({ itemRef, offerRef }) => ({ itemRef, offerRef })) } : draft;
  function bind(raw: unknown, requireHash = false): ApprovalDraft {
    const draft = approvalDraftSchema.parse(raw);
    const acquisition = draft.acquisitionTerms !== null || ["invitation", "activation", "shipment"].includes(draft.phase);
    if (!acquisition) return draft;
    if (!["invitation", "activation", "shipment"].includes(draft.phase) || !draft.acquisitionTerms) return held("COMMERCIAL_PHASE_REQUIRED");
    const selected = draft.commercialOffers;
    if (!selected || selected.length !== draft.items.length || new Set(selected.map(row => row.itemRef)).size !== selected.length ||
      selected.some((row, index) => row.itemRef !== draft.items[index]?.itemRef))
      return held("COMMERCIAL_OFFER_BASIS_REQUIRED");
    const versions: { itemRef: string; offerRef: string; offerVersion: string }[] = [];
    const uniqueOffers = new Set<string>();
    let maximumUnits = 0n, maximumSampleSpend = 0n;
    const bound = draft.items.map(item => {
      const row = selected.find(value => value.itemRef === item.itemRef);
      if (!row) return held("COMMERCIAL_OFFER_BASIS_REQUIRED");
      const record = offers.readOffer(row.offerRef);
      const eligible = offers.resolvePolicyProof(row.offerRef, draft.phase as OfferPhase);
      const proof = eligible?.state === "eligible" ? eligible.proof : null;
      if (!record || !proof) return held("COMMERCIAL_OFFER_HELD");
      offers.assertPolicyProof(proof, now());
      if (uniqueOffers.has(record.offerId)) return held("COMMERCIAL_OFFER_REUSED");
      uniqueOffers.add(record.offerId);
      const sample = record.terms.sample;
      const units = sample.requested ? sample.unitsPerCreator : 0;
      const spend = sample.requested ? BigInt(sample.merchandiseCapMinor ?? 0) + BigInt(sample.shippingCapMinor ?? 0) : 0n;
      if (item.units > units || BigInt(item.spendMinor) > spend ||
        draft.phase === "shipment" && (!sample.requested || item.units < 1)) return held("COMMERCIAL_SAMPLE_BOUND_MISMATCH");
      maximumUnits += BigInt(units); maximumSampleSpend += spend;
      if (proof.offerVersion !== record.version || proof.manifestHash !== record.manifestHash ||
        proof.providerAccountRef !== draft.providerAccountRef || item.targetRef !== record.terms.creatorId ||
        digest(draft.acquisitionTerms) !== digest(acquisitionTermsOf(record.terms)) ||
        draft.productVersion.state !== "required" || draft.productVersion.version !== record.terms.manifest.productRevision)
        return held("COMMERCIAL_OFFER_MISMATCH");
      const basisHash = commercialProofHash(proof);
      if (requireHash && row.basisHash !== basisHash) return held("COMMERCIAL_OFFER_CHANGED");
      versions.push({ itemRef: item.itemRef, offerRef: row.offerRef, offerVersion: record.version });
      return { itemRef: item.itemRef, offerRef: row.offerRef, basisHash };
    });
    if (BigInt(draft.bounds.maxUnits) > maximumUnits || BigInt(draft.bounds.maxSpendMinor) > maximumSampleSpend)
      return held("COMMERCIAL_SAMPLE_BOUND_MISMATCH");
    if (draft.termsVersion.state !== "required" || draft.termsVersion.version !== commercialTermsVersion(versions))
      return held("COMMERCIAL_TERMS_VERSION_MISMATCH");
    return { ...draft, commercialOffers: bound };
  }
  return {
    resolvePreview: async (command, principal, scope) => bind(await registry.resolvePreview(command, principal, scope)),
    currentDraft: async manifest => bind(await registry.currentDraft(manifest)),
    assertCurrentDraft: (manifest, observed, timestamp) => {
      if (!registry.assertCurrentDraft) return held("APPROVAL_CURRENT_SOURCE_UNVERIFIED");
      const current = bind(observed, true);
      if (digest(current.commercialOffers ?? null) !== digest(manifest.draft.commercialOffers ?? null)) return held("COMMERCIAL_OFFER_CHANGED");
      registry.assertCurrentDraft({ ...manifest, draft: sourceView(manifest.draft) }, sourceView(observed), timestamp);
    },
  };
}
