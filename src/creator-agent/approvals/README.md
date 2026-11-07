# Exact approval authority

This server-only module owns finite approval previews, request idempotency, source decision verification, the Linear outbox and immutable readback receipts. It performs no provider business operation and does not create a second job runner. `sourceEffect: none` describes that absence of business execution; Linear approval-record writes and their readback state are separately reported in `outbox`.

`ApprovalRepository` uses the existing scoped SQLite connection. Supply trusted `sources`, a registered domain `registry`, current versioned policy and a clock. Defaults have no source authority. Browser data must never be projected into those callbacks as a verified actor, source grant or decision. Synthetic test principals are not company identities.

## Source and identity boundary

- `registry.resolvePreview` builds the exact action from current domain sources. `registry.currentDraft` must freshly validate the same source identities, terms and applicable gates. A satisfied gate is a server attestation of the exact returned action, not a caller checkbox.
- `sources.resolveActor` resolves the authenticated principal through an explicit human directory, including the stable person identity, current roles and directory version. Alias principals for the same person do not satisfy second-person approval.
- `sources.readSlackDecision` verifies the configured source workspace/channel/thread, exact displayed request/version, current message author, native event/version and edit/delete/revocation state. An authenticated transformed callback is not an original Slack-signed raw request. No custom app or unverified display-name mapping is implied.
- `sources.writeLinearRecord` may attempt an exact server-built intent; its returned success alone never establishes authority. `readLinearRecord` must independently verify the exact configured issue, record, content hash and active source version. Unknown or ambiguous source results hold.
- `sources.assertCurrent` and `registry.assertCurrentDraft` are mandatory synchronous source-owned fences. After all awaited reads, and again inside the final transaction, they compare the returned actor/source snapshots and material draft to current authoritative versions and leases. They must inspect the owning source/cache, not echo the supplied object. Missing fences hold; a copied source snapshot cannot grant execution. A known negative readback or known changed Slack event also durably increments the local authorization revision, so source recovery requires a new proof and cannot revive the old one.

Current policy allows Slack-origin decisions. There is no in-app decision release method. App orchestration can create/read previews, request approval, and request reconciliation. Second person applies to money, creator sends and policy; commitments strictly over USD 500 and the named founder categories also require founder authority. Unknown exposure is never treated as zero. Current role grants, policy and exact material source versions are checked again for release.

## Persistence and recovery

`preparePreview` freezes an exact finite version. `requestDecision` persists the request through the outbox. `observeDecision` accepts a source locator through trusted ingress, verifies the human and phase policy, and confirms a Linear decision readback before creating a receipt. It rejects edited/deleted ambiguity, stale versions, source changes and duplicate decision consumption. An edit-required receipt preserves its proposed edit reference; an explicit trusted new preview creates a fresh unapproved version, even if domain material has not otherwise changed.

The outbox records an attempt before awaiting the writer. A lost/unknown response cannot gain another attempt through a new caller key, restart, or an absent read. A never-attempted local intent can be resumed with the same request after fresh validation. Reconciliation reads exact existing intents; it does not infer non-application from missing data. Original manifests, decisions and provider receipt links remain immutable.

`readApproval(ref, version?)` can return historical records with current eligibility held. `readCommand` is a server-internal exact certainty lookup for an authenticated action boundary: after access denial, use only the certainty needed for a safe error and do not return protected records.

## Dispatch seam

Call `resolveCurrentProof` with the exact finite item binding. A verified result includes a repository-issued verification reference, current local revision, immutable decision receipt, exact item resources and rolling source lease. `assertCurrentProof` verifies that persisted proof synchronously inside the dispatch owner's final SQLite transaction, without opening a nested transaction. It rejects changes, cancellation, policy/role mismatches, expiry, forged proofs and stale caller clocks. A new source hold invalidates previously issued local proofs.

The dispatcher still owns current capability, budget, stock, suppression, quota, resource locks, source idempotency and uncertain-attempt reconciliation. It must fence unresolved native effects across new preview versions and new caller keys. A decision receipt is not a send, label, payment or settlement receipt. Local SQLite fencing does not make remote revocation atomic: sources are freshly reread under bounded leases and missing authority holds.

After a native outcome is durably recorded, `recordOutcomeLink` accepts it only through the configured `verifyOutcome` callback against the existing job/provider ledger. `syncOutcomeLink` uses the same outbox to link that verified historical fact to Linear. Cancellation/expiry does not erase a confirmed outcome or prevent recording its history; recording it does not revive permission to execute.

## Verification and deployment state

Focused tests use actual SQLite and explicitly fictional source adapters. They exercise the complete positive readback path, independent human checks, phase and economic rules, exact-version edits, concurrent duplicate events, loss/restart, source holds, expiry, historical outcomes and native Node strip-types import. These establish sandbox software behavior, not production source access. Real human mapping, Slack ingress/read authority, Linear writer/readback grants, domain facts and provider executors must be configured and verified separately. No live provider connection is enabled by importing this module.
