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

Registration is disabled by default. HTTP has **no activate, resume, claim, checkpoint, complete, fail or worker execution route** and accepts no client action outcome. The only registered handlers are bounded local observe/propose reference handlers. The repository's worker/activation methods remain internal. Trusted activation resolution is an optional constructor dependency; the actual capability preflight always uses the shared ledger's `requireReady`. Neither is supplied by incoming requests. Pause/cancel preserve historical work and cannot imply that a prior source effect was undone.

## Scope, errors and lifecycle

Wrong binding workspace/account/environment is rejected. An existing generic connection does not confer another account/action/route. Readers cannot mutate. Reviewer cookie requests retain both CSRF and exact-origin checks; machine bearer requests remain separate. Schemas reject unexpected Ready/proof/role/activation fields and unsafe reference material without echoing their values. Missing records return 404; scope/shape errors 400; version/replay conflicts 409; role/CSRF denial 403; missing authentication 401; oversized input 413. Write errors retain `executionCertainty: "notApplied"` when no mutation was applied.

The service passes its existing evidence-store database handle to the composition; both `JobRepository` and `CapabilityLedger` borrow that same scoped handle, including for `:memory:`. Standalone composition/ledger callers may instead supply a path, in which case only the component that opens the connection owns its close. Borrowed handles stay open on repository release or initialization failure; the service closes its owner handle once after the requests drain. Startup failure releases owned handles, and service close is idempotent. There is no background worker loop or scheduler in this HTTP composition.

## Verification and release stage

Actual HTTP tests cover authentication/roles, the safe identity endpoint, exact scope, cookie CSRF/origin checks, strict body/query bounds, injected versus missing verification, revocation, disabled held jobs, ingress replay/conflicts, pause/cancel, absent worker routes, recursive private-reference redaction and resource cleanup. An additional integration test runs the existing online-backup helper, creates an isolated restored database and reopens the actual server with both repositories, preserving capability/job identity, held state and ingress idempotency. This is distinct from the backup inspector's existing assessment/request checks.

All inputs are synthetic; tests make no provider calls. HTTP integration verification does not prove a real connection, source permission, enabled schedule or deployed release. Complete repository/cloud checks and an exact deployment receipt remain required before claiming that release stage.
