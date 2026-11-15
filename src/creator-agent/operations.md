# Authenticated operations API — THO-355 / THO-356

`server.ts` composes the capability ledger and local job repository through `operations.ts` on the existing private SQLite path. It reuses authentication, exact-origin/CSRF protection, no-store responses, the 1-MiB JSON body bound and typed error handling. This is sandbox infrastructure. It does not connect providers, publish schedules, dispatch source actions, change scorecards or complete the broader THO-213/285 acceptance.

## Identity handshake

`GET /v1/identity` requires an existing reader or reviewer credential and returns only:

```json
{
  "service": "farda-creator-agent",
  "schemaVersion": "creator-agent.v1",
  "role": "reader",
  "scope": {
    "workspaceId": "synthetic-workspace",
    "accountIds": ["synthetic-account"],
    "environment": "sandbox",
    "authorizationScopeVersion": "creator-agent.scope.v1"
  }
}
```

These identifiers are synthetic examples. Actual role and scope come from authenticated server configuration, never query/body fields. This endpoint issues no cookie, session, CSRF token or credential. It is suitable for a private reader connection test without putting session-creation output into workflow history. The existing `/v1/session` and scorecard `/v1/capabilities` contracts remain unchanged.

## Operations response and ownership

Successful operations use `{schemaVersion: "farda.operations.v1", scope, data, sourceEffect: "none"}`. Scope has configured workspace, one account ID, sandbox environment and `authorizationScopeVersion: "operations.scope.v1"`. Responses are authenticated and uncached. Configuration saves and reference intake are local records, not evidence of any external dispatch.

Collections accept only `?limit=1..100` (default 100), with duplicate or unknown query keys rejected. They return actual records/total/partial coverage. Job/run ordering is deterministic; no fabricated next cursor is returned. Bounded history is oldest-first and explicitly partial when truncated. Job-run lists contain summaries with `itemsIncluded: false`; the exact run endpoint supplies its bounded item list. A job event contains at most 100 items.

All job responses are recursively projected: `secretRef`, `connectionRef` and lease-token values are omitted, including nested registration, definition, run and transition objects. Private reference presence may be expressed by booleans. Internal worker bindings retain their complete references for exact preflight; clients cannot recover credential-store names through a job read or mutation acknowledgment.

## Connection routes

| Method / route | Body or result |
| --- | --- |
| `GET /v1/connections` | Safe bounded list |
| `GET /v1/connections/:id` | Safe record or 404 |
| `GET /v1/connections/:id/history` | Safe bounded history with total/partial |
| `POST /v1/connections/register` | Reviewer; `{registration, expectedRevision}` |
| `POST /v1/connections/:id/verify` | Reviewer; `{receiptRef, expectedRevision}` only |
| `POST /v1/connections/:id/revoke` | Reviewer; `{reasonCode, expectedRevision}` |

The [connection schema/ledger contract](connections/README.md) defines the registration, observed/effective states, exact binding and receipt freshness. A verifier is injected only through trusted `AgentServerOptions.operations.resolveReceipt`, never an HTTP payload. Default absence produces Unverified. Permission readiness is separate from source-data freshness, business eligibility, financial approval and job activation.

## Job routes

| Method / route | Body or result |
| --- | --- |
| `GET /v1/jobs` | Safe bounded registration list, ordered by job ID |
| `GET /v1/jobs/:jobId` | Safe current registration |
| `GET /v1/job-runs` | Safe bounded run summaries, newest observed first with run-ID tie-break |
| `GET /v1/job-runs/:runId` | Exact run with bounded item state |
| `GET /v1/job-runs/:runId/history` | Bounded oldest-first transition history with total/partial |
| `POST /v1/jobs/register` | Reviewer; `{definition, expectedVersion}` |
| `POST /v1/jobs/ingress` | Reviewer; strict `jobEventSchema` and stable `Idempotency-Key` header |
| `POST /v1/jobs/:jobId/pause` | Reviewer; `{version}` |
| `POST /v1/job-runs/:runId/control` | Reviewer; `{command: "pause" | "cancel"}` |

Registration is disabled by default. HTTP has **no activate, resume, claim, checkpoint, complete or fail route** and accepts no client action outcome. General job ingress runs only local observe/propose reference handlers. J14's separate reviewer endpoint can request a bounded, server-configured read-only health probe after trusted activation; generic claims cannot consume those health items. The repository's worker/activation methods remain internal. Trusted activation resolution is an optional constructor dependency; any configured capability preflight uses the shared ledger's `requireReady`. Neither is supplied by incoming requests. Pause/cancel preserve historical work and cannot imply that a prior source effect was undone.

## Scope, errors and lifecycle

Wrong binding workspace/account/environment is rejected. An existing generic connection does not confer another account/action/route. Readers cannot mutate. Reviewer cookie requests retain both CSRF and exact-origin checks; machine bearer requests remain separate. Schemas reject unexpected Ready/proof/role/activation fields and unsafe reference material without echoing their values. Missing records return 404; scope/shape errors 400; version/replay conflicts 409; role/CSRF denial 403; missing authentication 401; oversized input 413. Write errors retain `executionCertainty: "notApplied"` when no mutation was applied.

The service passes its existing evidence-store database handle to the composition; both `JobRepository` and `CapabilityLedger` borrow that same scoped handle, including for `:memory:`. Standalone composition/ledger callers may instead supply a path, in which case only the component that opens the connection owns its close. Borrowed handles stay open on repository release or initialization failure; the service closes its owner handle once after the requests drain. Startup failure releases owned handles, and service close is idempotent. General jobs have no background worker loop in this HTTP composition; the separately configured mirror-health timer only evaluates local freshness evidence.

## Saved operations dashboard reads

The authenticated `POST /v1/read` adapter supports `connectionsOverview`, `channelCapabilities` and `automationRuns` as views of the existing local ledgers. Each uses empty filters, `period: null`, no sort, and a bounded first page of 1–100 rows. A cursor or unsupported filter/period/sort is rejected. Counts and omitted rows describe saved records only; they do not describe all accounts or activity at any provider.

These responses carry `source: "saved-operations"` in their data. The first two return `kind: "saved-bindings"`; runs return `kind: "saved-runs"` with separate job and run coverage. Lists beyond the requested bound are explicitly partial; there is no fabricated next cursor. Reading a zero-row saved ledger proves only that the scoped local store is empty. Unconnected sources, schedules, grants and source-owned reconciliation remain separate.

The public display projection uses domain-separated, scope-bound HMAC aliases for account, binding, action, owner, job, run, event and receipt locators. Credential-store references, provider account IDs and arbitrary source text never enter this projection. Safe provider/action names are allowlisted; unknown names remain opaque aliases. Read time, receipt verification/expiry, source observation time and last successful source read are distinct. A Ready permission receipt loses readiness when it expires even without a new write. Permission readiness alone does not establish fresh data or business eligibility.

Existing settings routes render these typed reads through the normal adapter. Saved run details are read-only; they do not imply that a broader workflow or provider executor exists. Session loss clears protected data. These views have no source effect and grant no activation, scheduling or execution authority.

## Mirror freshness

The seven mirrors (orders, shipments, stock, support, finance, content and collaborations) share one pure classifier and strict client contract. The native Connections freshness panel, detail dialog and source-run trace consume authenticated adapter views; fixtures are never substituted for missing bindings. Row event dates do not establish sync freshness.

- **Coverage.** A trusted `MirrorRunSource` supplies immutable, exact scoped completion receipts. `MirrorFreshnessRuntime.ingest` validates the binding/version, partitions, exhausted continuation, destination acknowledgment and source as-of watermark inside the source-current commit fence. Partial/failed/revoked runs cannot advance complete coverage. A complete check with zero changed rows is healthy `noChange`; unknown counts remain unknown. Source changes require explicit reconciliation instead of inheriting an old watermark.
- **Policy.** `mirrorFreshness.approval` records a versioned owner adoption receipt, expected cadences, thresholds and America/Los_Angeles. History is immutable by version. The shared proposed defaults confer no approval. An approved configuration requires a 15-minute sweep for every mirror and a stale threshold at least its expected cadence. Application configuration never authorizes recurring provider calls.
- **Schedule.** `mirrorFreshness.deploymentRef` explicitly starts the actual in-process 15-minute health timer after the HTTP service listens. The timer evaluates local completion evidence only; it never calls providers or sends messages. No deployment reference means Unconfigured. Running requires actual start/sweep evidence; failure and stop remove the next-run claim. Source ingestion is trusted server composition, with no public receipt-submission endpoint. The launcher supplies no production mirror source by default.
- **Incidents.** Sweep transactions persist checks, incident state and immutable opened/cleared events. Repeated sweeps suppress duplicates. Removing a binding/threshold holds open incidents; only a later complete healthy source check clears them. The threshold is evaluated in milliseconds, so the first instant after it is stale. Failed, partial and access-revoked observations remain distinct.
- **Reporting.** `mirrorReportEvent` maps durable events into the existing Slack reporting service; `fenceMirrorReporting` adds the current incident/policy check to an already qualified reporting source. Neither supplies authority, a sender, a second queue or a recurring reporting job. A configured source must provide the authorized exact run-evidence link and existing owner/destination/grant binding. Notifications include source, last complete check, watermark, age/threshold, owner and recovery action. Recovery uses the original reporting thread; repeated admission/work retains the original idempotency and uncertain-outcome rules. Suppressed events cannot be sent.
- **Reads.** `mirrorFreshness` uses empty filters. `mirrorRunDetail` accepts one opaque run ID, scoped by the authenticated store; the UI also verifies the selected mirror. Historical alert run links remain inspectable after newer checks. Read refresh cannot clear an incident or fake a scheduled sweep. The observation lease expires at the next 15-minute check or stale boundary, withholding positive badges until refreshed. 401/403 clears protected data.

Qualification stages remain separate: fictional-source/cloud tests, actual native sandbox receipts and pause/recovery, released unconfigured application reads, and future production source/notification activation. Passing one stage does not claim the next. Private native evidence belongs in the owning issue, never this public repository.

## Read-only provider health

`providerHealth.ts` composes bounded, server-owned probes with the shared durable job repository. Health observations never grant permission receipts. The configured account/action/route, capability revision, current lease, job policy and activation are checked around asynchronous source reads. Source success/event times and coverage stay distinct from probe and mirror-write time. Failure preserves the last native success; unknown quota/deadline values retain explicit states. Required unknown capacity/deadline values hold dependent execution.

| Method / route | Result |
| --- | --- |
| `GET /v1/provider-health` | Saved binding health with configured/total/partial coverage; optional `limit=1..100` |
| `GET /v1/provider-health/:capabilityId` | Current effective health, evaluated at read time |
| `GET /v1/provider-health/:capabilityId/history` | Bounded observation receipt history |
| `GET /v1/provider-health/:capabilityId/exceptions` | Current owned exception states, retaining durable history |
| `POST /v1/provider-health/check` | Reviewer-only `{capabilityId, eventId}` plus stable `Idempotency-Key`; no client-supplied result |

Health routes reuse the operations envelope and `sourceEffect: "none"`. Duplicate/unknown query fields and extra body assertions are rejected. Reader authentication, reviewer write authorization and cookie CSRF checks remain shared with the service. No route activates a job, changes provider permissions, dismisses an exception or dispatches business work. A fresh matching source result is required for recovery. A repeated event preserves its observation receipt while reporting current health, so an expired or revoked receipt cannot become Ready through replay. Health claims cannot drain another business run; pending receipts and uncertain items remain in their original states.

The native launcher optionally accepts private `FARDA_PROVIDER_HEALTH_CONFIG` with `notionRegistryTargets` and an optional opaque `activationRef`. Each target pins the exact server scope/binding, registry, owner, freshness age and documentation-check time. Only Notion API observe actions `read-content-registry` and `read-collaborations-registry` are supported by this launcher helper. It reuses the private registry reader from asset-source configuration; no arbitrary endpoint or credential is accepted from the frontend. A successful registry read proves that operation only, not a write scope, plan, role or business eligibility.

The registry probe scans at most three pages of 100 records within six seconds and rechecks native workspace identity. It distinguishes a terminal continuation from provider query truncation. Only an exhausted, untruncated scan supplies complete coverage and a registry-wide last-edit timestamp; cap exhaustion, truncation or a mid-scan failure keeps readiness held. The outer job probe is independently bounded.

Configuration alone does not activate J14. The activation reference is only a locator for the separately trusted job activation resolver. That resolver remains absent by default. A configured check without trusted activation produces a held local run and no source call; missing configuration/grants are unverified. There is no production health schedule or provider business executor in this release.

## Verification and release stage

Actual HTTP tests cover authentication/roles, the safe identity endpoint, exact scope, cookie CSRF/origin checks, strict body/query bounds, injected versus missing verification, revocation, disabled held jobs, ingress replay/conflicts, pause/cancel, absent worker routes, recursive private-reference redaction and resource cleanup. An additional integration test runs the existing online-backup helper, creates an isolated restored database and reopens the actual server with both repositories, preserving capability/job identity, held state and ingress idempotency. This is distinct from the backup inspector's existing assessment/request checks.

All inputs are synthetic; tests make no provider calls. HTTP integration verification does not prove a real connection, source permission, enabled schedule or deployed release. Complete repository/cloud checks and an exact deployment receipt remain required before claiming that release stage.
