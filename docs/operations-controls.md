# Native operations controls

The authenticated `operationsControl` read enriches existing saved bindings, paged runs and versioned schedule drafts. It does not replace the capability ledger, J14 health service, job repository, source mirrors or scheduler. A deployment without an injected source reader returns explicit unknown/not-connected evidence; it never substitutes a demo dataset.

## Source-to-code mapping

| Original source | Route | Native composition |
| --- | --- | --- |
| Connections `7:876` | `/settings/connections` | Existing paged bindings, J14 source health, `NativeOperationsControls` connection evidence, `NativeHealthCheck` |
| Team `7:1085` | `/settings/team` | `NativeControlsPage` team read; server-derived reader/reviewer matrix, separate source roles and owner evidence |
| Runs `14:637` | `/automations`, `?tab=zaps`, `?tab=reporting` | Existing paged registry/drafts; finite task and takeover review, bounded current checkpoint/history and source membership |
| Schedule `14:911` | `/automations/:opaqueJobRef/schedule` | Existing `NativeScheduleEditor`; exact-job report configuration, safe aggregate preview and delivery evidence |
| Capabilities `66:641` | `/settings/capabilities` | Existing paged capabilities plus source attribution/permission evidence and validation dialog |
| Reconciliation companion | `/automations?tab=reconciliation` | `NativeControlsPage` reconciliation read, source-owned key/count/money comparison and guarded repair proposals |

Existing demo routes retain synthetic fixtures and their original controls. Native layouts reuse PageKit, tokens, tables, dialogs, fields, focus and leave guards. Native roles and source records differ from illustrative founder/operator examples. No native provider connection, named assignment, schedule, receipt or zero total is invented to match a mockup.

## Read boundary

`operationsControlsSchema.ts` defines the strict source and browser contracts. `createOperationsControls` accepts the existing scoped SQLite database, server-only reference key, capability ledger, jobs, health service and optional `OperationsControlSource`. The latter is a read-only callback and optional exact server-approved handoff URL/origin allowlists.

The supplemental read is bounded, without a cursor, period or sort. Filters are `section`, optional exact `targetRef`, `jobRef` for reports, `q`, closed source `platform`, and reviewer-only `proposalRequestKey`. The existing paged registry remains available for all runs/jobs/bindings. The supplemental run history explicitly reports inspected, matching and total counts; unknown platform memberships remain unknown. A role-scoped token cannot establish a named owner, so Assigned to me is held with its reason.

Source snapshots bind workspace/account/environment, revision, observation time and complete/partial coverage. Every record has a source version/evidence reference/observation. A 15-minute maximum observation age and finite dates prevent old source observations authorizing new work. Unknown source fields stay null. Authorization denial remains403 and clears protected frontend data; unavailable or malformed sources do not certify a clean/empty result.

Reconciliation requires a grain, exact period/timezone/currency/cutoff, nullable safe-integer counts and signed minor-unit amounts. Conflicts use closed safe fields and values: aggregate money/count, presence, status, or redacted fingerprint. Free credentials, contact details, arbitrary repair fields and private destination/preview strings fail source validation. Source IDs, owner references, versions and provider-account strings are aliased before the browser. Report labels and preview metrics are finite enums. Handoffs require both an exact configured HTTPS URL and origin; the source cannot nominate an arbitrary URL.

## Review proposals

`POST /v1/action` accepts `operation:requestApproval`, `actionKind:proposeOperationsReview` with strict `payload:{kind,targetRef,reason}`. Kinds are task, takeover, repair and permissionEvidence. The server derives the actor and scope and requires reviewer authorization, JSON/origin/CSRF protections, exact version and stable idempotency key. A client cannot set approval, assignment, readiness or execution flags.

Task proposals bind a registered job/version and finite source-authorized item manifest within the job budget. Takeover proposals bind a real run/item and source reason; they do not acquire a lease or establish assignment. Permission evidence binds a verified source receipt to the current capability revision and cannot set Ready. Repair proposals require complete current comparison, authoritative and mirror versions, source field ownership and an open repairable conflict. Local/unknown ownership, missing-source/orphan records and uncertain versions remain held.

Source membership is reread after awaited source resolution, then the current local job/capability/run basis is checked in the proposal transaction. One immutable local request/manifest/receipt is stored. `approvalPending` plus the exact proposal receipt means local review recorded, not provider approval or source execution. Existing domain owners retain dispatch, source edits, financial changes, actual repair, assignment and schedule activation.

Uncertain submission keeps only nonsensitive original scope/actor/key/base/opaque-target/digest metadata across reload. The raw reason and complete payload remain in the full-scope protected QueryClient cache and are purged on401/403; no protected text is stored in browser storage. Legacy markers in every control namespace are scrubbed before source data is available. Exact receipt lookup searches the complete request ledger independently of the20-row displayed history. Current complete verified absence permits only the original request retry when its exact protected payload is still available. If reload or authorization loss removed that payload, the request remains held; no reason is reconstructed and no new key is allowed. A changed original basis can be sealed as a terminal no-op before an explicit new proposal. Partial/stale/failed lookup cannot unlock another write. Auth-loss clears protected views and drafts.

## Health observation command

`refreshOperationsHealth` is a distinct `refreshObservation` action with `payload:{targetRef}` and the same strict actor/scope/version/key envelope. It delegates to existing `providerHealth.check`; no new provider client, tool dispatcher or scheduler is introduced. Only configured probes with current verified capability and no explicit denied route can proceed. Existing J14 activation/lease/budget gates remain required.

The command is bound durably to the request, exact binding revision and payload. An unconfigured/held target returns blocked/notApplied. An actual observation carries its J14 receipt; a denied/unhealthy observation returns blocked/applied, never healthy. An in-flight original request returns outcomeUncertain/uncertain, and same-key reconciliation does not start a duplicate probe. Cached receipts retain their immutable observation while current source authorization, binding and health freshness are rechecked; expiry/revocation returns blocked/applied, and source403 clears protected state. Source authorization is checked again after the awaited probe. Exceptions report applied or uncertain if the original observation/request already exists.

## Verification

`operationsControls.test.ts` covers durable finite requests, source/local races, exact request lookup beyond displayed history, terminal stale no-op, restart, ownership/currency/privacy, source403, platform membership and takeover checkpoints. `operationsControls.health.test.ts` uses the actual native HTTP server and SQLite for role/scope/CSRF/schema checks, observed and held targets, original-key concurrency, expiry/revocation and authorization loss during the probe. `e2e-agent/controls.spec.ts` uses the real server for form/reload/uncertain recovery, source denial, repair intent and accessible desktop/mobile controls. CI captures are synthetic under `testInfo.outputPath('controls-evidence')`; the optional `FARDA_CONTROLS_PROOF_DIR` override supports ignored local evidence. Original Figma captures and private source material never enter CI or Git.

Release remains integration-verified only when the exact final revision passes consolidated checks and release readback. Provider authority is a separate deployment prerequisite; this UI implementation cannot supply source-owned role, assignment, report, comparison, approval or activation evidence that is absent.
