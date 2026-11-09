import type { AgentServerOptions, createAgentServer } from "../server.ts";
import { approvalFixture, approvalTestScope as scope } from "../approvals/fixtures.testkit.ts";
import { approvalDispatchBinding } from "../approvals/repository.ts";
import { offerPolicyFixture } from "../offers/policyFixture.testkit.ts";
import { providerMaterial } from "../offers/policy.ts";
import { commercialPolicyFixture } from "../commercialPolicy/fixtures.testkit.ts";
import { assessCreator } from "../policy.ts";
import { digest } from "../config.ts";
import { syntheticBinding, syntheticPacket, SYNTHETIC_READ_TOKEN, SYNTHETIC_REVIEW_TOKEN } from "../testFixtures.ts";
import { InvitationDraftRepository } from "./drafts.ts";
import { recruitmentSourceFixture } from "./fixtures.testkit.ts";
import { recruitmentInvitationOwnerFixture } from "./ownerFixture.testkit.ts";
import { unknownRecruitmentModels } from "./contract.ts";
import { RECRUITMENT_INVITATION_HANDLER } from "./proposalBridge.ts";

/** Actual file-backed offers, assessment engine, J04 and jobs; explicitly fictional sources.
 * The caller owns the temporary directory and creates/listens to the actual server using options.
 * Call close only after closing that server. No provider, Slack or other external call is made. */
export function recruitmentServerFixture(databasePath: string, timestamp = Date.now()) {
  if (databasePath === ":memory:") throw new Error("The HTTP fixture requires one shared temporary SQLite file.");
  const o = offerPolicyFixture(databasePath, scope), a = approvalFixture(), binding = syntheticBinding();
  o.advance(timestamp - o.now());
  o.source.state.current = commercialPolicyFixture(scope, o.now());
  o.terms.expiresAt = new Date(o.now() + 3_600_000).toISOString();
  o.terms.commission.effectiveAt = new Date(o.now() - 1_000).toISOString();
  const offer = o.save();
  a.state.now = o.now(); a.policy.observedAt = a.at(); a.policy.validUntil = a.until();
  a.draft.expiresAt = a.until(); a.draft.sourceValidUntil = a.until();
  a.draft.providerAccountRef = "synthetic-provider-account";
  for (const human of a.humans.values()) { human.observedAt = a.at(); human.validUntil = a.until(); }
  for (const gate of Object.values(a.draft.gates)) if (gate.state === "satisfied") gate.validUntil = a.until();
  a.draft.gates.sampleAuthority = structuredClone(a.draft.gates.providerTerms);
  a.humans.set("agent-reviewer", { ...a.humans.get("synthetic:requester")!, principalRef: "agent-reviewer" });
  a.humans.set("agent-reader", { ...a.humans.get("synthetic:requester")!, principalRef: "agent-reader", roles: ["viewer"] });
  const packet = { ...syntheticPacket(), termsRevision: offer.manifestHash };
  const savedAssessment = o.store.save(packet, assessCreator(packet, binding), 0, "synthetic-recruitment-assessment");
  const state = { commercialAllowed: true };
  o.auth.assessment = creatorId => {
    const actual = o.store.latest(creatorId); if (!actual) return null;
    return { creatorId, runId: actual.runId, route: actual.packet.checkoutRoute, modelId: actual.assessment.modelId,
      configHash: actual.assessment.config.hash, policyVersion: actual.assessment.policyVersion,
      termsRevision: actual.packet.termsRevision, state: actual.assessment.state,
      stale: actual.assessment.config.hash !== binding.hash };
  };
  o.auth.assertCurrent = proof => {
    const provider = o.auth.provider?.(o.terms, scope) as { facts: NonNullable<typeof proof.provider> };
    if (!state.commercialAllowed || digest(proof.assessment) !== digest(o.auth.assessment?.(proof.assessment?.creatorId ?? "")) ||
      digest(proof.suppression) !== digest(o.auth.suppression?.(o.terms.creatorId, scope)) ||
      digest(providerMaterial(proof.provider)) !== digest(providerMaterial(provider.facts)))
      throw new Error("Fictional recruitment commercial backing changed.");
  };
  const drafts = new InvitationDraftRepository(o.store.database, scope, o.now);
  const source = recruitmentSourceFixture(scope, o.now);
  const owner = recruitmentInvitationOwnerFixture({ drafts, offers: o.repo, baseDraft: a.draft, now: o.now });
  const options: AgentServerOptions = { databasePath, workspaceId: scope.workspaceId, accountId: scope.accountId,
    readToken: SYNTHETIC_READ_TOKEN, reviewToken: SYNTHETIC_REVIEW_TOKEN, bindings: [binding], operations: { now: o.now },
    offerAuthority: o.auth, commercialPolicy: o.source.source, recruitmentWorkspace: { source: source.source, invitationOwner: owner.owner },
    actionFoundation: { approvals: a.options } };
  const principal = { principalRef: "agent-reviewer" };
  const filters = { context: "recruitment" as const, creatorId: offer.terms.creatorId, offerId: offer.offerId, offerVersion: offer.version };
  function publishBatch(app: ReturnType<typeof createAgentServer>, approvalRef: string, runRef: string) {
    const approval = app.actionFoundation.approvals.readApproval(approvalRef), run = app.actionFoundation.dispatch.read(runRef, false);
    if (!approval || run.intent.approval.approvalRef !== approvalRef) throw new Error("An actual matching canonical run is required.");
    source.state.batch = { approvalRef, manifestVersion: approval.manifest.manifestVersion, manifestHash: approval.manifest.manifestHash,
      runRef, runRevision: run.revision, complete: true, total: run.items.length, models: unknownRecruitmentModels(),
      rows: approval.manifest.items.filter(item => run.items.some(row => row.intent.approval.itemRef === item.itemRef)).map(item => ({ itemRef: item.itemRef,
        creatorRef: item.targetRef, source: "social-cat", deal: "affiliate", ownerRef: "synthetic-private-owner", owner: source.visible("Fictional owner"),
        deadline: approval.manifest.draft.expiresAt, membership: "included", holdReasons: [], recipient: source.visible("Fictional creator"),
        product: source.visible("Fictional product"), terms: source.visible("Commission only; no guaranteed fee.") })),
      owners: [{ ref: "synthetic-private-owner", label: source.visible("Fictional owner") }], capacity: [], samples: [],
      forecastCommissionMinor: null, sourceLink: { state: "unavailable", url: null, label: "Open source record", reasonCode: "SOURCE_LINK_UNAVAILABLE" } };
    return { approval, run };
  }
  async function approveAndQueue(app: ReturnType<typeof createAgentServer>, approvalRef: string) {
    const repo = app.actionFoundation.approvals, preview = repo.readApproval(approvalRef);
    if (!preview) throw new Error("An actual saved invitation preview is required.");
    const requested = await repo.requestDecision({ approvalRef, expectedVersion: preview.manifest.manifestVersion }, principal, `synthetic-request-${approvalRef}`);
    const event = a.event(requested, "approved", "synthetic:founder", `synthetic-event-${approvalRef}`);
    const approved = await repo.observeDecision(event.locator, { ingressRef: "synthetic:verified-ingress" });
    const run = await app.actionFoundation.dispatch.handoff({ handlerRef: RECRUITMENT_INVITATION_HANDLER, payloadRef: approved.manifest.draft.payloadRef,
      approval: approvalDispatchBinding(approved.manifest, approved.manifest.items[0]!.itemRef) },
    { principalRef: principal.principalRef, idempotencyKey: `synthetic-queue-${approvalRef}` });
    return publishBatch(app, approvalRef, run.runRef);
  }
  return { options, o, a, source, owner, drafts, state, offer, savedAssessment, scope, principal, filters, publishBatch, approveAndQueue,
    close: () => { o.store.close(); a.db.close(); } };
}
