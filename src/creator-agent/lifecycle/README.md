# Lifecycle reads and local configuration drafts

This module projects source-owned customer lifecycle aggregates and stores local configuration drafts. It has no provider writer, recipient list, enrollment store, scheduler or send endpoint. Source publication, activation and delivery remain separate observations.

`createLifecycleService({db, scope, secret, source?, now?})` accepts the existing scoped SQLite connection and private operations reference key. The source is an optional server-only function. It is never supplied by a browser request.

## Adapter seam

`read(viewKey, filters, actorRef)` supports `lifecycleOverview`, `emailFlow`, `consentEligibility` and `activationRetention`. Only email flow has filters: `{flow, draftRequestKey?}`. Its request lookup is reviewer-only. Other views accept an empty object. The result has `{data,version,observedAt,partial,stale,empty,capabilities}` for the existing read envelope.

`saveDraft(request, actorRef)` accepts only the strict domain fields `{resourceKind,resourceRef,expectedVersion,payload,idempotencyKey}`. The authenticated server supplies `actorRef`; it must be `agent-reviewer`. The exact resource allowlist is `flow-early-access`, `flow-abandoned-checkout`, and `flow-review-request`. Setup is read-only. The server retains its outer scope, role, CSRF and transport checks.

The save result is a `SaveReceipt`. Map its resource/version/time/actor into the standard save envelope and put the entire receipt in `record`. This preserves the key, original version, payload digest, scope and immutable draft for exact client acknowledgment verification. No save result means a message was sent.

## Source and policy boundaries

The strict source schema accepts scoped, leased flow catalogs and aggregate observations. Counts are safe nonnegative integers or explicitly unknown. Consent categories share one exclusive cohort. Activation is anonymous, uses one declared device cohort and first-seven-day definition, and does not establish ingestion or a health result. Unverified export approval withholds activation counts. Later retention remains proposed.

References are converted to scoped HMAC aliases before entering browser DTOs. No raw provider link is synthesized. Provider navigation remains unavailable until a separately verified link binding exists. No contact records, per-device observations, medication data, credentials or private message bodies are accepted as fields.

Entry, timing and template choices must come from the exact source flow catalog. Proposed timing remains proposed; a draft title does not approve template content. Source evidence binds catalog, policy, event, timing and template versions and has its own lease. Wrong or expired evidence is shown as unknown. The three mandatory consent/suppression/deduplication policies are always true, repeated as nine read-only controls in the three editable forms. Their fields are excluded from browser payloads. This enforces the configuration boundary; actual pre-send rechecks remain the source execution owner's responsibility.

## Persistence and uncertainty

Draft revisions and request receipts are immutable. A SQLite transaction appends a new revision and its exact receipt together. Scope, actor, flow, original expected version and canonical payload determine request identity. Duplicate keys return the original receipt; changed bodies conflict. A current-source or version rejection records a terminal no-op under that key. Current source permission, lease, catalog and basis are rechecked after asynchronous reads before committing.

An absent request lookup is only an observation. It returns `state: unknown`, and cannot authorize a fresh-key replacement while a delayed original may still arrive. Only exact original replay or readback is safe. A recorded receipt or durable rejected receipt can resolve uncertainty. A newer draft never substitutes for that request's proof. Historical receipts remain historical when current policy changes. Source denial clears protected data; an unconfigured or unavailable source preserves readable local drafts while new saves remain held.

History returns the latest 20 revisions with an exact total and explicit truncation. Old request receipts remain retrievable by exact scoped key. Source-version fingerprints detect conflicting reused versions and regressed observations without creating a second business ledger. The injected test fixtures are entirely fictional and cannot activate a provider.
