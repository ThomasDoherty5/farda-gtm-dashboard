import { createRequire } from "node:module";
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
import { digest } from "../config.ts";
import { ApprovalRepository, stableApprovalDraft } from "./repository.ts";
import { ApprovalError } from "./contract.ts";
import { fresh, stableSlack } from "./authority.ts";
import type { ApprovalDraft, ApprovalPolicy, ApprovalScope, ApprovalSources, LinearRecordIntent, RecordedLinearRecord, TrustedHuman, VerifiedSlackDecision, ApprovalRead, ProposeCommand, VerifiedExistingJobOutcome } from "./contract.ts";

/** Fictional sandbox identities and an in-memory provider boundary; never deployment configuration. */
export const approvalTestScope: ApprovalScope = { workspaceId: "synthetic-workspace", accountId: "synthetic-account", environment: "sandbox" };
export function approvalFixture(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS agent_scope(id INTEGER PRIMARY KEY, workspace_id TEXT, account_id TEXT)");
  db.prepare("INSERT OR IGNORE INTO agent_scope VALUES(1,?,?)").run(approvalTestScope.workspaceId, approvalTestScope.accountId);
  const state = { now: Date.parse("2026-11-06T20:00:00Z"), writes: 0, linearUnavailable: false, writerUnknown: false, denied: false, slackReads: 0, readHook: null as null | ((intent: LinearRecordIntent) => Promise<void>) };
  const at = () => new Date(state.now).toISOString(), until = () => new Date(state.now + 300_000).toISOString();
  const policy: ApprovalPolicy = { scope: approvalTestScope, version: "synthetic-policy-v1", sourceRef: "synthetic:policy-source", observedAt: at(), validUntil: until(), founderThresholdMinor: 50_000, currency: "USD", appDecisionsEnabled: false,
    commission: { version: "synthetic-commission-v1", maxCommissionPct: 20, sampleCapMinor: 5000 } };
  const na = () => ({ state: "notApplicable" as const, policyVersion: policy.version, reason: "Not required for this synthetic invitation phase." });
  const gate = () => ({ state: "satisfied" as const, sourceRef: "synthetic:source-grant", sourceVersion: "grant-v1", validUntil: until() });
  const draft: ApprovalDraft = { actionKind: "synthetic-invitation", phase: "invitation", providerAccountRef: "synthetic:provider-account", providerAccountVersion: "account-v1", payloadHash: digest("synthetic-message"), payloadRef: "synthetic:private-message",
    productVersion: { state: "required", version: "product-v1" }, termsVersion: { state: "required", version: "terms-v1" }, rightsVersion: na(), configVersion: "config-v1", policyVersion: policy.version,
    effects: { spendsMoney: false, sendsCreator: true, changesPolicy: false }, items: [{ itemRef: "synthetic:item-1", itemVersion: "item-v1", targetRef: "synthetic:creator-1", targetVersion: "identity-v1", payloadHash: digest("synthetic-message"), sourceRef: "synthetic:creator-source", units: 0, spendMinor: 0 }],
    bounds: { maxItems: 1, maxUnits: 0, maxSpendMinor: 0, currency: "USD" }, exposure: { state: "known", minor: 0, currency: "USD" },
    acquisitionTerms: { relationship: "commissionOnly", upfrontFeeMinor: 0, guaranteedFeeMinor: 0, paidComponentMinor: 0, commissionPct: 20, perSaleFixedMinor: 0, sampleCostMinor: 0 }, historicalLiability: null,
    gates: { acceptedTerms: na(), sampleAuthority: na(), providerTerms: gate(), launchReadiness: na(), sourcePermission: gate() }, sourceBasisRef: "synthetic:source-packet", sourceBasisVersion: "packet-v1", sourceValidUntil: until(), linearIssueRef: "synthetic:owning-issue", expiresAt: new Date(state.now + 120_000).toISOString() };
  const humans = new Map<string, TrustedHuman>();
  for (const [principalRef, roles] of [["synthetic:requester", ["operator"]], ["synthetic:reviewer", ["reviewer"]], ["synthetic:founder", ["founder"]]] as const)
    humans.set(principalRef, { scope: approvalTestScope, principalRef, personRef: principalRef, roles: [...roles], active: true, directoryVersion: "directory-v1", observedAt: at(), validUntil: until() });
  const linear = new Map<string, RecordedLinearRecord>(), intents = new Map<string, LinearRecordIntent>(), events = new Map<string, VerifiedSlackDecision>();
  const sources: ApprovalSources = {
    resolveActor: async ref => structuredClone(humans.get(ref) ?? null),
    readLinearRecord: async intent => { await state.readHook?.(intent); if (state.denied) return { state: "denied", reason: "Synthetic denied source" }; if (state.linearUnavailable) return { state: "unknown", reason: "Synthetic outage" }; return structuredClone(linear.get(intent.intentRef) ?? { state: "absent", reason: "Synthetic exact intent has not been written" }); },
    writeLinearRecord: async intent => { state.writes++; intents.set(intent.intentRef, structuredClone(intent)); if (state.writerUnknown) return { state: "unknown" }; linear.set(intent.intentRef, { state: "recorded", scope: approvalTestScope, intentRef: intent.intentRef, issueRef: intent.issueRef, recordRef: `synthetic:linear:${digest(intent.intentRef)}`, contentHash: intent.contentHash, sourceVersion: "linear-v1", active: true, observedAt: at(), validUntil: until() }); return { state: "attempted" }; },
    readSlackDecision: async locator => { state.slackReads++; return structuredClone(events.get(locator.eventRef) ?? null); },
    assertCurrent: (snapshot, now) => {
      const current = humans.get(snapshot.actor.principalRef);
      const identity = (human: TrustedHuman) => ({ scope: human.scope, principalRef: human.principalRef, personRef: human.personRef, roles: human.roles, active: human.active, directoryVersion: human.directoryVersion });
      if (!current || !current.active || digest(identity(current)) !== digest(identity(snapshot.actor)) || !fresh(current.observedAt, current.validUntil, now)) throw new ApprovalError("AUTHORITY_REQUIRED");
      if ((snapshot.linearRecords.length || snapshot.linearWriteIntent) && (state.linearUnavailable || state.denied)) throw new ApprovalError("APPROVAL_CURRENT_SOURCE_UNVERIFIED");
      if (snapshot.slack) { const currentEvent = events.get(snapshot.slack.locator.eventRef); if (!currentEvent || currentEvent.state !== "current" || digest(stableSlack(currentEvent)) !== digest(stableSlack(snapshot.slack)) || !fresh(currentEvent.observedAt, currentEvent.validUntil, now)) throw new ApprovalError("SLACK_DECISION_UNVERIFIED"); }
      for (const record of snapshot.linearRecords) { const currentRecord = linear.get(record.intentRef); if (!currentRecord || !currentRecord.active || currentRecord.recordRef !== record.recordRef || currentRecord.sourceVersion !== record.sourceVersion || currentRecord.contentHash !== record.contentHash || !fresh(currentRecord.observedAt, currentRecord.validUntil, now)) throw new ApprovalError("DECISION_READBACK_UNVERIFIED"); }
    },
  };
  const outcomes = new Map<string, VerifiedExistingJobOutcome>();
  const options = { scope: approvalTestScope, sources, currentPolicy: () => structuredClone(policy), registry: { resolvePreview: async () => structuredClone(draft), currentDraft: async () => structuredClone(draft),
    assertCurrentDraft: (_manifest: import("./contract.ts").ApprovalManifest, observed: ApprovalDraft, now: number) => { if (digest(stableApprovalDraft(draft)) !== digest(stableApprovalDraft(observed)) || Date.parse(draft.sourceValidUntil) <= now) throw new ApprovalError("APPROVAL_SOURCE_CHANGED"); } }, now: () => state.now,
    verifyOutcome: (input: VerifiedExistingJobOutcome) => digest(outcomes.get(input.outcomeRef) ?? null) === digest(input) };
  const repo = new ApprovalRepository(db, options);
  const command: ProposeCommand = { actionKind: draft.actionKind, entityRef: "synthetic:offer", entityVersion: "offer-v1", selectionRefs: draft.items.map(item => item.itemRef), expectedVersion: 0 };
  async function requested(key = "synthetic-propose") { const preview = await repo.preparePreview(command, { principalRef: "synthetic:requester" }, key); return repo.requestDecision({ approvalRef: preview.manifest.approvalRef, expectedVersion: preview.manifest.manifestVersion }, { principalRef: "synthetic:requester" }, `request-${key}`); }
  function event(read: ApprovalRead, decision: VerifiedSlackDecision["decision"] = "approved", actor = "synthetic:reviewer", eventRef = "synthetic:event-1") {
    const value: VerifiedSlackDecision = { scope: approvalTestScope, locator: { workspaceRef: "synthetic:slack-workspace", channelRef: "synthetic:approval-channel", threadRef: "synthetic:approval-thread", eventRef }, requestRecordRef: read.request.record!.recordRef,
      approvalRef: read.manifest.approvalRef, manifestVersion: read.manifest.manifestVersion, manifestHash: read.manifest.manifestHash, principalRef: actor, personRef: humans.get(actor)!.personRef,
      decision, proposedEditRef: decision === "editRequired" ? "synthetic:edited-draft" : null, sourceVersion: "slack-v1", decidedAt: at(), observedAt: at(), validUntil: until(), state: "current" };
    events.set(eventRef, value); return value;
  }
  async function approved() { const request = await requested(); const e = event(request); return repo.observeDecision(e.locator, { ingressRef: "synthetic:authenticated-ingress" }); }
  return { db, repo, options, state, draft, policy, humans, sources, linear, intents, events, outcomes, command, requested, event, approved, at, until };
}
