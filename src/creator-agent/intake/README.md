# J01 creator intake

The scoped sandbox service accepts normalized signup, discovery, profile-change and reviewer-correction facts. It preserves the source identity, provenance and timestamps. The intake kernel writes canonical identity and campaign/brief observations through trusted Notion and Sheets sinks. It emits review work only after qualified canonical enrollment.

## Identity and event ownership

Native profile IDs and URL fingerprints belong to their publishing network and source account. Display names never merge people. A new native ID cannot inherit another known native ID through a recycled URL. Conflicting stored IDs or reviewed crosswalk entries quarantine the incoming event for review.

Source events are keyed by recruitment source, external source account and event ID. Every accepted idempotency key is reserved, including a new key replaying an existing event. Event reads accept an optional `accountId` query parameter. An ambiguous account-free event read returns a conflict.

The source route, current suppression list and reviewed identity map are checked again on replay and before dispatch. The trusted resolvers must return the current permitted snapshot for the supplied scope and requested version. A missing or obsolete version leaves enrollment pending. Observed opt-outs are sticky. A verified exclusion creates its own canonical revision, retaining earlier active observations and their audit history.

## Immutable revision handoff

Each creator revision freezes its canonical profile facts, campaign identity/provenance, brief version, source context and intended eligibility before a writer runs. A later revision cannot rebuild or overwrite these earlier bytes. Updates with unchanged profile text still advance the source watermark. Late records cannot reverse that watermark. Source-update, event, observation, handoff and verification times have separate meanings.

A durable SQLite claim serializes handoffs for each creator. The claim has a random ownership token and finite lease. Before every external upsert, the attempt and exact payload hash are persisted. A concurrent request can record a newer revision locally, but dispatch waits until any earlier uncertain external operation has a qualified outcome. Late acknowledgments from a replaced worker cannot modify the newer claim.

Notion receives the canonical creator revision first. Sheets then receives the same frozen revision with the exact Notion receipt as its canonical foreign key. Campaign and brief history remain attached to the appropriate relationship. Closed relationships stay closed.

## Sink contract

A configured sink implements `upsert(key, record, binding)` and `read(key, binding)`. The binding includes workspace/account scope, target, key, creator, revision, full-record hash, canonical Notion reference and a unique attempt ID. Each callback returns one of the typed terminal results.

- An `applied` receipt repeats every binding field, includes a receipt reference and source observation time, and declares a future verification expiry.
- A `notApplied` receipt repeats the binding, identifies its source proof and explicitly states that the original attempt is terminal. The sink must fence that attempt so a delayed writer cannot apply afterward. This permits a new attempt only after current authorization is rechecked.
- Null, malformed, denied, mismatched, stale or thrown responses remain uncertain. They never mean verified absence or permission to retry.

The sinks must enforce keyed idempotency and creator-revision ordering at the canonical sources. A positive source receipt can reconcile an earlier operation after its local revision changed. Source permission remains required for further reads. A later revision can retire an older unattempted request, but cannot skip an uncertain external write.

Delivery attempts and their first terminal proofs remain in the audit table. A refresh can confirm the same exact saved record with a newer observation expiry. A purported absence cannot erase a previously confirmed write. Provider deletion, correction or inaccessible data requires source-owner reconciliation.

## Read and monitor behavior

`GET /v1/intake/creators/:creatorId` returns scoped identity history. Event and source-status routes preserve the checkpoints. `monitorMembership(limit)` keeps the shared monitor shape and reports explicit bounded coverage. Active membership requires the latest local revision, current source/identity/suppression evidence, fresh qualified receipts from both targets and the exact Sheets-to-Notion foreign key. An expired proof requires source readback before new review work is emitted.

A known exclusion remains excluded. Unknown identity, permissions, handoff outcome or receipt coverage remains pending or unavailable. Legacy receipt-reference-only rows are retained but cannot assert verified source enrollment. New profiles migrate into account-scoped keys without discarding their canonical creator history.

## Release boundary

Unit and authenticated HTTP tests use synthetic identities and source-owned sink fixtures. The application has no qualified production Notion/Sheets writer bound by this implementation. The real route authority, current suppression/crosswalk readers, idempotent source writers with terminal-attempt fencing, source receipt validation and operational recovery still require their owners' integration proof. Scoring, invitation, messaging, samples and payment remain outside J01. This code does not activate a live creator program.
