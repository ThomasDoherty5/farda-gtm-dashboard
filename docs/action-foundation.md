# Shared approval and action boundary

The creator-agent API composes one exact-action approval repository, the existing durable job runner and source-owned domain services. It does not create a parallel approval, inventory, budget, settlement or scheduling engine. The default runtime has no named-human directory, Slack/Linear decision writer, dispatch handler, worker authority, ledger export source or readiness writer configured.

## Authority and execution

An authenticated reviewer credential identifies an API principal. It does not make that principal a named human, founder, source operator or dispatch worker. Private server bindings resolve the current human directory and source permissions. Approval requests and confirmed decisions require independently verified Linear readback and the configured native Slack origin. In-app approval release remains held.

The approval manifest freezes the account, action, exact item identities and versions, payload identity, policy, phase, applicable product/terms/rights versions, exposure, resource bounds and expiry. Source edits require a new unapproved version. Invitation, activation, shipment and settlement have different applicable gates. Current commission-only acquisition policy does not erase a separately retained historical accepted liability.

Async source observations are followed by mandatory synchronous source-owned fences. `ApprovalSources.assertCurrent` verifies current human, Slack and Linear evidence; `ApprovalRegistry.assertCurrentDraft` verifies the current material source basis. Missing fences hold execution. These callbacks must inspect the trusted source owner’s current backing state, rather than echoing a supplied snapshot. A source adapter must enforce the same version/idempotency conditions at its actual native write boundary.

Dispatch uses source-issued exclusive budget, stock and shared quota grants. Positive approved spend or stock units cannot be relabeled N/A. A provider effect requires a published shared quota allocation within the operating limit. A lease or a remaining-balance snapshot is not a resource grant. Started attempts persist an effect fence independently of approval version or request key. A definitive not-applied readback must close the exact current `attemptRef` and `attemptNumber`; an earlier attempt’s receipt cannot unlock a later unknown effect.

## HTTP routes

| Route | Authority and result |
| --- | --- |
| `POST /v1/action` | Strict scoped preview, approval request, bounded dispatch handoff, run control and original-outcome reconciliation. A queued handoff does not execute its handler. |
| `POST /v1/worker/dispatch` | Machine-only `{runRef}`. Separate configured worker credential and current scoped worker proof, capped at five minutes. The reader, reviewer, relay and browser session cannot substitute. |
| `POST /v1/approvals/observe` | Separate authenticated transformed relay containing only a native Slack locator. The source reader independently verifies the actual current event; client decision or role claims are not accepted. |
| `POST /v1/read` | Browser-safe native approval, run and readiness projections, alongside the existing owned read models. Unknown business fields are not filled from demo data. |
| `GET /v1/action-artifacts/:ref` | Private CSV artifact. Rechecks the named finance/founder grant, source permission, scope, snapshot and expiry. No public download URL or provider credential is returned. |

Raw Slack signed requests and transformed relays are different transports. An original Slack signature cannot authenticate a transformed Zapier payload. No machine credential is synthesized from a reviewer credential, and no default machine route enables a source.

The generic operations routes cannot register, overwrite, ingest, pause or cancel source-owned dispatch/export jobs. Their details and histories are available only through the protected native action views; legacy collections omit these records and disclose the restricted count. Ordinary observation jobs retain their existing operations routes. This boundary prevents a shared reviewer credential from bypassing the current named actor and canonical control receipt.

## Domain records and exports

`exportSnapshot` / `exportLedger` creates a bounded job over a complete authorized source snapshot, including every page matching its immutable filters. The result is a private artifact receipt and actual existing job reference. It confers no release authority. CSV values are escaped for spreadsheet formula injection; source identities are represented by scoped aliases.

`recordSourceDecision` / `recordLaunchReadiness` records the exact founder Go/Revise/Hold intent against the current source version. It needs a source-enforced key and verified Notion acknowledgment. A Go additionally needs an approved launch date, the applicable effective phase and passing required evidence gates. A recorded readiness decision does not activate production, shipping, publication, payments or paid media.

These additive operations require null approval/manifest/run input references. They cannot borrow `dispatchApprovedAction` with invented or null release authorization. The native readiness view exposes opaque actor/target/version/evidence references. Original intent recovery is authenticated, scoped and read-only; rationale is recovered from the server, not copied into browser persistence.

## Certainty and recovery

Repeated keys preserve the original immutable business receipt. Transport request IDs are current; original expected versions, finite item membership and source keys are not silently rebased. Unknown effects stay reconciliation-only until exact current-attempt non-application is proven and preflight is renewed. A failed Linear outcome link never repeats a native effect.

Unknown native or decision-persistence outcomes return `502 OUTCOME_UNCERTAIN`. A current `401`/`403` still clears protected browser data while preserving an actual prior applied or uncertain outcome. Per-principal admission is durable across restart: 120 reads and 30 writes per minute, with `429`, retry metadata and no inference that an earlier lost-acknowledgment command was not applied. Provider quota authority remains separate from this transport counter.

Public errors contain fixed messages, request/correlation references, retry metadata and certainty; they do not serialize arbitrary source exceptions. Error categories preserve capability, approval, resource, authentication and uncertainty distinctions. A valid certainty value is retained even when a newer server code is unfamiliar to the client.

## Verification stages

Fictional source adapters and actual HTTP/SQLite tests establish implementation behavior. They do not establish real account permission, a connected source, production authorization or successful provider execution. Source-qualified bindings, native screen evidence, required repository checks, exact-head CI and applicable release/readback remain separate evidence. Never count an ownership/control inventory as completed provider integrations.
