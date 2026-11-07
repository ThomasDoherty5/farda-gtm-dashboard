# Adapter decisions

Recorded 2026-11-04. These answer the open questions in the backend requirements proposal (PR #48, D-1 to D-18) and the four contract gaps (Q-01 to Q-04 in `docs/intake.md`).

**Status: decided by Thomas Doherty, who delegated the choices to Claude on 2026-11-04 and asked for best practice for a small direct-to-consumer company.** They are defaults for the build to start from, not a ruling over the backend owner. The backend owner may change any of them; when one changes, edit this file and the register (`docs/adapter-freeze-register.md`) in the same PR. Nothing here has been verified against a real service.

## Owner acceptance, 2026-11-06

Thomas Doherty reviewed these defaults on 2026-11-06 and accepted every one that doesn't commit money, data retention or a vendor. The backend owner can still change any of them, using the same rule as above.

| Decision | Status | Note |
| -- | -- | -- |
| Q-01 to Q-04 | Accepted | Already implemented in the client contract. |
| D-1 | Accepted, except the identity provider | HTTPS, same origin, `HttpOnly` cookie session, CSRF header and the four paths are accepted. The identity provider is not chosen; the owner decided on 2026-11-06 to choose it before production. Until then, sandbox keeps the deployed service's separate reader and reviewer credentials. |
| D-2, D-3, D-4 | Accepted | Who holds each D-3 role is assigned separately. |
| D-5 | Accepted, with a USD 500 threshold | Owner decision on 2026-11-06: a second person approves anything that spends money, messages a creator or changes policy; the founder-only threshold is USD 500 instead of the default USD 1,000. |
| D-6 to D-15 | Accepted | |
| D-16 | Held | Retention periods need CPA and legal confirmation. Financial record rules and privacy law apply, and the product is health-adjacent. |
| D-17 | Held | A safe design, but a second deployment and database cost money. No paid infrastructure is approved. |
| D-18 | Accepted | Build-order guidance. The existing child tickets keep their owners. |

Principles behind every choice: the server is the only authority (a hidden button is never authorization); a small team needs fewer moving parts, not more; money and outbound messages get a second person; an unknown outcome is never retried blind; nothing in the browser holds a secret.

## The four contract gaps

| # | Decision | Why |
| -- | -- | -- |
| Q-01 | Add an `approved` value to `ActionResponse.state`. It is not a success state, so "approved is not sent" is unchanged. | Approved is a different fact from blocked or queued, and a distinct name makes the SENT rules testable. |
| Q-02 | Add `RECORD_NOT_FOUND` (category `notFound`). Return it only for a record inside the caller's verified scope; outside it, return `FORBIDDEN`. | A mistyped id is not a permission problem, and the catalogue must not let one tenant probe another. |
| Q-03 | Add an optional top-level `runRef: string \| null` to `ActionRequest`. | The server authorizes and locks by run, which needs one typed field instead of three payload shapes. |
| Q-04 | Freeze `executionCertainty` as `notApplied`, `uncertain`, `applied`, and require it on every write error and on every `ActionResponse` and `SaveResourceResponse`. `notApplied` only when the server holds proof nothing reached the provider; a timeout after submission is `uncertain`. | The client must always be able to tell whether a write happened. |

## D-1 to D-18

| Id | Decision |
| -- | -- |
| D-1 Transport and session | HTTPS with JSON bodies, same origin as the app. Sign-in through the company's identity provider using OpenID Connect; the server sets an `HttpOnly`, `Secure`, `SameSite=Lax` session cookie and the app never sees a token. Writes also carry a per-session CSRF token header. Session lifetime 12 hours, sliding idle timeout 60 minutes. Three POST operations that carry the existing envelopes, one per transport kind (`read`, `action`, `save`), plus one GET that returns the signed-in principal, role and allowed scopes. The base URL is the already reserved `VITE_FARDA_ADAPTER_BASE_URL`. |
| D-2 Operation names and versions | Keep `viewKey` and `actionKind` as the operation names. `schemaVersion` is a date string. Adding an optional field needs no new version; removing or retyping one does. The server accepts the current version and the previous one for 30 days and answers anything else with a typed `VALIDATION_FAILED` that names the supported versions. |
| D-3 Role model | Five roles: `founder`, `operator`, `reviewer`, `finance`, `viewer`, plus a non-human `runner` for the job service. Fields are filtered on the server per role (payout and bank details: `finance` and `founder` only; creator contact data: `operator`, `reviewer`, `founder`). A role never narrows by hiding a button. |
| D-4 Scope narrowing | Refuse, do not narrow. A request that names a workspace, account or environment outside the grant gets `FORBIDDEN`. The response scope equals the requested scope or the answer is discarded (the client already does this). |
| D-5 Approval authority | Requester and approver must be different people for anything that spends money, sends to a creator, or changes policy. Founder-only: changing the acquisition policy, settling a historical fixed-fee liability, the launch Go decision, enabling production for a source account, and any single commitment over USD 500 (owner decision 2026-11-06; the original default was USD 1,000). Authority failure is one form: `FORBIDDEN` with reason `AUTHORITY_REQUIRED` naming the role; state failure (expired, changed, already decided) is `approvalHold`. |
| D-6 Slack trust | Verify every Slack request with the signing secret and reject timestamps older than 5 minutes. Map a Slack user to a Farda user only through an explicit link made by a founder. One decision wins: the decision is a compare-and-set on the approval version, first valid write wins, and the second caller gets a conflict that names the stored decision. |
| D-7 Shape of `controlRun` | Pause, cancel and retry of a batch or monitor run stay under `controlRun`, with `runRef` at the top level. `previewAction` is a separate action kind and never changes state. |
| D-8 Idempotency retention | Keys are scoped to principal and action kind and kept 14 days with the stored response. A key reused after expiry is a new command, still protected by the expected-version check. |
| D-9 Duplicates and replays | Same key and same payload returns the stored answer unchanged, with no extra code. Same key and a different payload is `MANIFEST_CHANGED`. "Already done" is the stored state, not a separate code. |
| D-10 Version token | An opaque string chosen by the server, carried in `expectedVersion` and `dataVersion`. The client compares for equality only and never parses it. |
| D-11 Filters, period, sort, search | Shared names: `period` (an ISO date range or a named preset), `sort` (a list of field and direction), `q` (text search). An unknown filter is `VALIDATION_FAILED` in sandbox and production. `scenario` and `fixture` are accepted only in demo and rejected elsewhere. |
| D-12 HTTP for holds and uncertain results | Holds (approval, capability, resource) are 409. An uncertain write is never a 2xx: it is an error with code `OUTCOME_UNCERTAIN`, `executionCertainty: uncertain`, and a status the proxy would not cache (502 or 504). Success is a 2xx only with the authoritative acknowledgment. |
| D-13 Freshness | Each source entry carries an explicit `freshnessState` of `current`, `noChange`, `partial`, `error` or `neverSynced`, computed by the server. Allowed age before `stale`: order sources 15 minutes, creator monitor 90 minutes, ad platforms 26 hours, accounting 24 hours. The client falls back to the reason-code mapping if the field is absent. |
| D-14 Exports and shapes | A CSV export is a server job that returns a download receipt; the client never reports an export as done on its own. Freeze the save response schema. Error bodies always carry `code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs` and `executionCertainty`. The server sends no field the contract does not define; the client keeps stripping unknown fields on read. A reason-code catalogue lives in this folder and is checked by a test. |
| D-15 Limits | Per principal: 120 reads and 30 writes per minute, answered with `RATE_LIMITED` and `retryAfterMs`. Per source: 80% of the provider's published limit, shared by every caller. Job leases last 5 minutes and must heartbeat. |
| D-16 Audit and retention | Append-only audit record for every sign-in, read of a protected view, action, approval, decision and receipt. Stored immutably. Kept 7 years for financial and approval records, 2 years for the rest. Secrets, tokens and message bodies are redacted; creator contact data is referenced, not copied. |
| D-17 Environments | Sandbox and production are separate deployments with separate databases and credentials, never a flag on one. Enabling production for a source account is founder-only, needs a second person, records a reason, and defaults to off. |
| D-18 Ownership and order | Build in this order: the adapter service (sign-in, envelopes, idempotency, audit), then the approval service, then the job runner. The existing assignees keep their tickets; this file does not reassign anyone. |

## Paths

Decided defaults, recorded 2026-11-04 so the reference server and the HTTP transport agree. They sit under the reserved base URL (`VITE_FARDA_ADAPTER_BASE_URL`) and follow D-1: three POST operations that carry the existing envelopes, and one GET for the signed-in principal. The backend owner may change them; when one changes, edit this section, `src/adapter/httpTransport.ts` and `tools/reference-server/server.ts` in the same PR.

| Method and path | Carries | Answers |
| -- | -- | -- |
| `POST /v1/read` | a `ReadRequest` | a `ReadResponse` |
| `POST /v1/action` | an `ActionRequest` | an `ActionResponse` |
| `POST /v1/save` | a `SaveResourceRequest` | a `SaveResourceResponse` |
| `GET /v1/session` | nothing | the principal, its role, its allowed scopes and the per-session CSRF token |

Writes (`/v1/action`, `/v1/save`) carry the CSRF token from the session call in the `X-CSRF-Token` header. The session itself is the `HttpOnly` cookie. Errors are JSON bodies with the D-14 fields, and statuses follow D-12 (the reference server's table is in `tools/reference-server/README.md`).

## What changes in the code because of these

- Q-01 to Q-04 and D-13 change `src/adapter/contract.ts`, the demo services, the schemas in `src/adapter/viewSchemas/`, and the screens that switch on state. They ship in their own PR with tests.
- D-1 and D-11 define what a reference service built for testing implements. That service (`tools/reference-server/`) is a test double, not the production backend, and it is the only thing that implements the paths above.
- Everything else is for the backend owner.

## Not decided here

Vendor and hosting choices, the identity provider, database technology, and anything about provider accounts. Those belong to the backend owner and the company.
