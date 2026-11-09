import type { AgentServerOptions } from "../server.ts";
import { SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN, syntheticBinding, syntheticPacket } from "../testFixtures.ts";
import { createBulkRuntimeRegistration } from "../bulkRuntime.ts";
import { offerPolicyFixture } from "../offers/policyFixture.testkit.ts";
import { commercialPolicyFixture } from "../commercialPolicy/fixtures.testkit.ts";
import { acquisitionTermsOf } from "../commercialPolicy/evaluate.ts";
import { commercialTermsVersion } from "../commercialPolicy/approvalGuard.ts";
import { providerMaterial } from "../offers/policy.ts";
import { costKeys, type OfferTerms } from "../offers/contract.ts";
import { assessCreator } from "../policy.ts";
import { digest } from "../config.ts";
import { bulkFixture } from "./fixtures.testkit.ts";

/** Reusable actual-HTTP fixture. Fictional source observations and local artifacts only;
 * the compiled J13 runtime registration is real, with no installed/activated trigger. */
export function bulkServerFixture(databasePath: string, fixtureOptions: { offerExpiryMs?: number } = {}) {
  if (databasePath === ":memory:") throw new Error("The server fixture requires its shared temporary SQLite path.");
  const w = bulkFixture({ path: databasePath, timestamp: Date.now() });
  const o = offerPolicyFixture(databasePath, w.scope), binding = syntheticBinding(), termsByCreator = new Map<string, OfferTerms>();
  o.advance(w.a.state.now - o.now()); o.source.state.current = commercialPolicyFixture(w.scope, o.now());
  o.terms.expiresAt = new Date(o.now() + 3_600_000).toISOString(); o.terms.commission.effectiveAt = new Date(o.now() - 1000).toISOString();
  o.auth.assessment = creatorId => { const actual = o.store.latest(creatorId); return actual ? { creatorId, runId: actual.runId, route: actual.packet.checkoutRoute,
    modelId: actual.assessment.modelId, configHash: actual.assessment.config.hash, policyVersion: actual.assessment.policyVersion,
    termsRevision: actual.packet.termsRevision, state: actual.assessment.state, stale: actual.assessment.config.hash !== binding.hash } : null; };
  o.auth.suppression = creatorId => ({ scope: w.scope, creatorId, sourceRef: `fictional-suppression-${creatorId}`, sourceVersion: "v1", state: "clear",
    observedAt: w.a.at(), validUntil: o.terms.expiresAt });
  o.auth.cost = sourceRef => {
    for (const terms of termsByCreator.values()) for (const key of costKeys) if (terms.costs[key].sourceRef === sourceRef) return {
      scope: { workspaceId: w.scope.workspaceId, accountId: w.scope.accountId }, creatorId: terms.creatorId, provider: terms.provider, programRef: terms.programRef,
      sourceRef, validUntil: o.terms.expiresAt, costKey: key, minor: terms.costs[key].minor, currency: "USD", productRef: terms.manifest.productRef, productRevision: terms.manifest.productRevision };
    return null;
  };
  o.auth.assertCurrent = proof => {
    const creatorId = proof.assessment?.creatorId ?? "", terms = termsByCreator.get(creatorId);
    const provider = terms ? o.auth.provider?.(terms, w.scope) as { facts: NonNullable<typeof proof.provider> } : null;
    if (w.state.denied || !terms || digest(proof.assessment) !== digest(o.auth.assessment?.(creatorId)) ||
      digest(proof.suppression) !== digest(o.auth.suppression?.(creatorId, w.scope)) || digest(providerMaterial(proof.provider)) !== digest(providerMaterial(provider?.facts ?? null)))
      throw new Error("Fictional commercial owner changed.");
  };
  const invitation = w.packet.groups[0]!, versions: { itemRef: string; offerRef: string; offerVersion: string }[] = [];
  for (const row of w.packet.rows) {
    const terms = { ...structuredClone(o.terms), creatorId: row.recipientRef };
    if (fixtureOptions.offerExpiryMs !== undefined) terms.expiresAt = new Date(o.now() + fixtureOptions.offerExpiryMs).toISOString();
    for (const key of costKeys) terms.costs[key].sourceRef = `fictional-${row.rowId}-${key}`;
    termsByCreator.set(terms.creatorId, terms);
    const offerId = `fictional-offer-${row.rowId}`, offer = o.repo.saveFromAdapter(offerId, null, terms, `fictional-save-${row.rowId}`);
    const packet = { ...syntheticPacket(), creatorId: terms.creatorId, termsRevision: offer.manifestHash };
    o.store.save(packet, assessCreator(packet, binding), 0, `fictional-assessment-${row.rowId}`);
    const itemRef = invitation.members.find(m => m.rowId === row.rowId)!.itemRef;
    versions.push({ itemRef, offerRef: offerId, offerVersion: offer.version });
  }
  invitation.draft!.acquisitionTerms = acquisitionTermsOf(o.terms);
  // The fictional owner permits these offer sample terms; this gate does not
  // approve or execute the separate finite sample-allocation manifest.
  invitation.draft!.gates.sampleAuthority = structuredClone(invitation.draft!.gates.sourcePermission);
  invitation.draft!.commercialOffers = versions.map(({ itemRef, offerRef }) => ({ itemRef, offerRef }));
  invitation.draft!.termsVersion = { state: "required", version: commercialTermsVersion(versions) };
  invitation.draft!.productVersion = { state: "required", version: o.terms.manifest.productRevision! };
  for (const row of w.packet.rows) { row.termsVersions.push(invitation.draft!.termsVersion.version); row.productVersions.push(o.terms.manifest.productRevision!); }
  for (const group of w.packet.groups) { group.providerAccountRef = "synthetic-provider-account"; group.draft!.providerAccountRef = group.providerAccountRef; }
  for (const capacity of w.packet.capacity) capacity.providerAccountRef = "synthetic-provider-account";
  w.seal();
  w.a.humans.set("agent-reviewer", { ...w.a.humans.get(w.principal.principalRef)!, principalRef: "agent-reviewer" });
  w.a.humans.set("agent-reader", { ...w.a.humans.get(w.principal.principalRef)!, principalRef: "agent-reader", roles: ["viewer"] });
  const registration = createBulkRuntimeRegistration({ registrationRef: w.packet.registration.registrationRef, ownerRef: "fictional-j13-owner",
    sourceRef: w.packet.sourceRef, policyVersion: w.a.policy.version, budgets: w.handlers.values().next().value!.budgets });
  const registry = { registrations: new Map([[registration.registrationRef, registration]]), executors: new Map() };
  const options: AgentServerOptions = { databasePath, workspaceId: w.scope.workspaceId, accountId: w.scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, operations: { now: () => w.a.state.now },
    bindings: [binding], offerAuthority: o.auth, commercialPolicy: o.source.source,
    bulkWorkspace: { source: w.source, owners: w.owners }, runtime: { registry },
    actionFoundation: { approvals: w.a.options, resources: w.resources } };
  return { ...w, options, registration, registry, o, termsByCreator, close() { o.store.close(); w.a.db.close(); } };
}
