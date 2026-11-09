# Finite bulk orchestration

`createBulkService` composes explicit `bulk.*` action owners with the existing approval repository and durable dispatch guard. It does not create a second approval store, scheduler, resource allocator or provider client. The optional server `bulkWorkspace` binding provides a current `BulkSource` and compiled domain owners. An absent source returns `BULK_SOURCE_UNCONFIGURED`; unconfigured runtime registration remains unavailable. No default demo source is installed.

## Immutable source material

`bulkSnapshotSchema` requires the finite rows and action groups, actual products and revisions, payload hashes, model/evidence and terms revisions, source capacity observations, expiry, permission and provenance. Each owner's canonical draft binds the hash of the entire material set, including held rows. Only renewable read leases, caller read context and existing outcome links are excluded. Owner item IDs must already be opaque and remain unchanged through commercial policy binding; target, payload and proof identities are never rewritten.

The source resolves three exact selectors: current batch/version, a preview's opaque group/hash, and retained source reference/hash for approved execution after restart. Each read has a mandatory synchronous final fence. The source must verify current read permission and material authority against its real system; echoing the supplied packet is not a fence. Failing or uncertain evidence does not supply a default quota, term acceptance or financial authority.

Canonical approvals and runs are read from the existing J04/dispatch repositories. Creating the same exact group with a different request key is rejected atomically by the approval transaction. A lost preview acknowledgment retains its original scoped key and payload. A missing result does not authorize rekeying.

## Execution and recovery

`createBulkRuntimeRegistration` declares the registered J13 event job over an exact approved manifest, using `dispatch-approved.v1`. Its input is the canonical reference batch; its domain source/output contracts are `farda.bulk-input.v1` and `farda.bulk-output.v1`. One domain manifest is handed off per approved event. Invitation, activation and sample decisions remain separate groups. The source supplies exact runtime activation/window authority, and the existing runtime machine gateway is required to install, fire, work or reconcile. Merely compiling or displaying the registration enables no trigger.

The same dispatch guard owns per-row IDs, provider/account/action grants, concurrency, original attempt state and immutable receipts for API, browser and runtime delivery. Source-enforced idempotency is mandatory. Synthetic source packets are restricted to local-artifact handlers. Provider-applied handlers cannot consume them. Current policy, offer, permission, sample bounds and provider quotas are rechecked at dispatch/resume, including after asynchronous reads.

Pause stops future starts. Cancel affects only known-unsent work; neither rewrites receipts nor erases an uncertain attempt. Original run recovery remains available from the batch view. Recipient summary counts partition the finite set; action receipts remain distinct when one recipient has multiple actions. Every row retains its blockers, with one deterministic primary reason for the held summary.

## Sample and financial display

A sample commitment is displayed only with its separate canonical approved sample action. Invitation approval limits do not stand in for sample approval. Applied sample receipts consume the recorded allocation, and uncertain attempts make the remaining allocation unknown. A commission forecast is an estimate, never an earned-commission cap. Historical payment obligations cannot be inserted as recruiting actions.

## Native view and proof

The adapter serves `batchDetail` with `{context:"bulk",batchRef,batchVersion}`. The route is `/batches/:batchId?context=bulk&batchVersion=:version`. It uses the existing design-system batch frame, approval page and original run recovery. Only source-permitted labels and scoped opaque IDs cross the read boundary. Source denial clears protected data; stale evidence disables proposals and hides protected display fields.

The executable fixtures use fictional identities and local artifacts with actual SQLite approval, offer, commercial policy, dispatch and runtime services. They do not qualify a real provider account or authorize outreach, sample purchases, recurring triggers or ad spend.
