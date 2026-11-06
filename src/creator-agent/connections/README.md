# Scoped capability ledger — THO-356

This server-only module persists versioned action/account bindings in the existing private agent SQLite file. It does not connect an app, resolve credentials, probe a provider, start J14 monitoring, dispatch an action or publish a schedule. The approved scorecards are unchanged. Broader THO-213 connection acceptance remains open.

`schema.ts` exports browser-safe Zod contracts. `ledger.ts` uses native Node 24 SQLite and must not enter a browser bundle. Storage uses `capability_meta` version 1, `capability_scope` and append-only `capability_events`; it does not change the existing agent storage version. The configured workspace/account must match any existing `agent_scope`, and the ledger file is additionally bound to its configured environment. Use the existing private-volume path/permissions and close the ledger during service shutdown.

## Identity and permission

`expectedBindingSchema` / `ExpectedBinding` contain:

- Internal workspace/account/environment; provider and exact provider account ID.
- Specific action, mode (`observe`, `propose`, `executeApproved`, `reconcile`), route (`api`, `mcp`, `browser`, `webhook`, `manual`) and `routeRef`.
- Authorization-scope version, tool version and required scopes.
- Optional `connectionRef` and `secretRef` identifying private stores. They are references, never credential values.

The stable capability ID hashes the internal scope plus provider/action/mode/route/route reference. Rebinding that slot to a different provider account, permission version, required scope, tool or credential reference starts a new Unverified revision. Changing other registration metadata also invalidates verification. No generic `connected` or client `Ready` field is accepted. A verified read never authorizes another action, mode, account or browser route. Permission denial does not create fallback permission.

Registration also requires an opaque `ownerRef` and explicit known/unknown cost basis. Unknown cost has a reason; known zero remains zero. These describe configuration/measurement and are not budget approval.

All reference fields are bounded, namespaced opaque IDs, such as `route:synthetic-reader`, `connection:synthetic-reader`, `secretref:synthetic-reader`, `owner:synthetic-operator`, `receipt:synthetic-test` or `source:synthetic-measurement`. Raw tokens, authenticated URLs and query-string secrets are not valid references. Do not place real provider identifiers or handoff content in public fixtures.

## Trusted verification and revocation

Construct `CapabilityLedger(databasePathOrBorrowedDatabase, configuredScope, {resolveReceipt?, now?})`. A path opens an owned connection; a supplied `DatabaseSync` handle is borrowed and remains open on ledger close or initialization failure. The service shares its existing evidence-store handle so an in-memory database also retains one scope and one set of tables. A verifier is injected by trusted server configuration, never supplied in a request. `verify(id, receiptRef, expectedRevision)` accepts only a receipt reference; its resolver must retrieve an actual immutable action-specific observation. Without a resolver, a missing receipt or a failed verifier, the new revision is Unverified. Errors from a verifier are not persisted or returned.

The trusted receipt must match the exact binding and requested reference. Ready also requires authenticated connection health, all required operation scopes, a nonfuture `checkedAt` and explicit expiry no later than 15 minutes after checking. Proof is never usable beyond that ceiling. Reference/identity/version mismatch, missing scopes and malformed/expired proof fail closed. Persisted `verifiedScopes`, outcome, timestamps and receipt reference retain the observation. Expiration changes the effective read/preflight state without rewriting the saved outcome.

`revoke(id, reasonCode, expectedRevision)` records an authoritative Denied revision. An old proof cannot restore readiness after revocation; successful re-verification must be observed strictly after revocation. An awaited verifier cannot overwrite a concurrent revoke or rebind: all mutations check the expected revision inside a SQLite write transaction.

Connection health, operation permission, source-data freshness and business eligibility are separate. Unknown data/business facts remain explicit. `requireReady(binding)` is **permission preflight only**. It does not approve a campaign, offer, shipment, budget, business eligibility or external execution. The job/executor owners must retain those independent gates. No production capability is inferred from sandbox proof.

## Server and job interfaces

| Method | Result |
| --- | --- |
| `register({binding, ownerRef, costBasis}, expectedRevision)` | New Unverified binding revision; scope is checked against trusted constructor scope |
| `verify(id, receiptRef, expectedRevision)` | New observation from the configured trusted resolver; no client proof/Ready flag |
| `revoke(id, reasonCode, expectedRevision)` | New Denied revision retaining history |
| `get(id)`, `history(id, limit = 100)` | Safe current/history projections; history is oldest-first and bounded |
| `historyPage(id, limit = 100)` | Bounded oldest-first history with actual total/partial coverage |
| `list(limit = 100)` | Bounded safe records plus actual total/partial coverage; limits 1–100 |
| `requireReady(expectedBinding)` | Synchronous server preflight verdict for the durable runtime |

`CapabilityReadiness` exposes allowed/state/reasonCodes, capability ID/revision, checked/expiry/receipt reference and owner/recovery hints where authorized. Wrong internal scope returns a denial without another scope's record metadata. Exact account/binding checks apply before Ready. The runtime snapshots its required binding and calls this same interface at claim/preflight instead of copying permission rules.

Safe projections omit even `secretRef` and `connectionRef` values, exposing only whether those references exist. They preserve opaque route/evidence references and the owner, observed versus effective state, freshness and recovery. HTTP handlers must use generic schema errors, not dump rejected payloads or verifier exceptions.

## Frozen authenticated HTTP integration

The existing agent server owns routing/authentication/CSRF, body bounds and error mapping. Root integrates these operations without changing the existing `/v1/capabilities` scorecard endpoint:

| Route | Authorized operation |
| --- | --- |
| `GET /v1/connections` | Scoped safe list |
| `GET /v1/connections/:id` | Scoped safe record |
| `GET /v1/connections/:id/history` | Scoped safe history |
| `POST /v1/connections/register` | Reviewer only; `{registration, expectedRevision}` |
| `POST /v1/connections/:id/verify` | Reviewer only; `{receiptRef, expectedRevision}` and no supplied proof |
| `POST /v1/connections/:id/revoke` | Reviewer only; `{reasonCode, expectedRevision}` |

Request scope is the authenticated server's configured scope. Incoming role, Ready, verifier, provider permission or credential material must not override it. Cookie writes retain the existing same-origin/CSRF checks; machine bearer access stays separate. An unconfigured verifier remains visibly Unverified. Authenticated HTTP/security acceptance is verified against the actual shared server integration, not a second test server. The versioned response envelope and safe identity handshake are documented in [the operations API contract](../operations.md).

## Verification

Focused synthetic SQLite tests cover unknown/known-zero facts, exact action/account/mode/route matching, missing verifier, forged/mismatched receipts, stale context, scope loss, future/expired proof, explicit unsupported/denied outcomes, verifier-error redaction, revocation and concurrent late proof, rebinding, restart persistence, existing-agent scope, bounded list coverage and credential-reference redaction. They make no network calls or claims about actual connected providers. Server HTTP tests and complete repository/cloud checks remain part of the owning integration PR.
