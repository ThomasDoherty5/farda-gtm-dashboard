# Adapter backend requirements

What the service behind the Farda dashboard must do, written for a backend engineer who has never seen this repo.

**Stage: proposal for the owner to decide. Nothing here is a decision, and nothing is integration-verified.** The front end is fixture-complete against a proposed contract. No transport exists. This document does not name a URL, path, header, cookie or database design, and the owner chooses all of those.

Part of THO-283 (the authenticated frontend read/action adapter).

## How to read this document

Every rule carries a tag so you can tell who asked for it.

| Tag | Meaning |
| -- | -- |
| **[T]** | Required by a Linear ticket. The ticket id and criterion id are given. Ticket text is paraphrased, never copied. |
| **[A]** | Required by `AGENTS.md` (the repo rules). |
| **[C]** | What the front-end code does today. The server must be compatible with it. File cited. |
| **[P]** | A proposal made here. The owner may change it. |

Sources: `src/adapter/contract.ts` (the types), `src/adapter/errors.ts` (error codes), `src/adapter/useView.ts`, `useAction.ts`, `useSave.ts`, `scope.tsx` (what the client sends), `src/adapter/liveAdapter.ts` (the stub that fails every call). Two open PRs are cited by branch, and neither is merged: #46 (`adapter-freeze-register`, file `docs/adapter-freeze-register.md`, "the register") and #44 (`adapter-conformance-suite`, files `src/adapter/conformance.ts` and `docs/adapter-conformance.md`, "the suite"). The tickets are THO-283, THO-284 (commission-only terms), THO-285 (scheduling and job execution) and THO-321 (exact-action approval). The ticket THO-283 has one comment listing four contract gaps; section 7 answers them.

## 1. What the front end calls and expects

The front end reaches data through one interface, `FardaAdapter`, with three methods: `readView`, `submitAction` and `saveResource` (`src/adapter/adapter.ts`). The live adapter must implement all three. The transport under them is the owner's choice; the client has a reserved setting `VITE_FARDA_ADAPTER_BASE_URL` that is unused today (`docs/intake.md`).

### 1.1 Request envelopes

All field names are camelCase and come from `contract.ts`.

**Scope, sent on every request.** `requestedScope` is `{ workspaceId, accountIds[], environment }`, where `environment` is `demo`, `sandbox` or `production`. **[C]** The client takes it from the signed-in session and never from the URL (register Q-09). It is a *request*, not a grant. See section 2.

**Read (`ReadRequest`).** `schemaVersion`, `operation: "readView"`, `viewKey`, `requestedScope`, `filters` (shape depends on the view), `period` (or null), `sort[]`, `page { cursor, limit }`, `requestId`. **[C]** Today every screen sends `period: null`, `sort: []` and `page: { cursor: null, limit: 50 }` (`useView.ts`), and puts time windows, search text and facets inside `filters`. Whether those move into the request fields is open (register C-05, C-16; decision D-11).

**Action (`ActionRequest`).** `schemaVersion`, `operation`, `requestedScope`, `actionKind`, `entityRefs[]`, `expectedVersion`, `approvalRef`, `manifestRef`, `idempotencyKey`, `payload`, `requestId`. The operations are `previewAction`, `requestApproval`, `decideApproval`, `dispatchApprovedAction`, `reconcileRun`, `controlRun`; `inspectRun` exists in the list but the request type excludes it, and runs are read as a view (register C-14).

**Save (`SaveResourceRequest`).** `operation: "saveResource"`, `resourceKind` (`actionDraft`, `reviewerAssessment`, `evidenceDraft`, `configurationDraft`), `resourceRef` (or null for a first save), `expectedVersion` (or null), `idempotencyKey`, `payload`, plus scope, `schemaVersion` and `requestId`. A save never dispatches a provider action. **[T]** THO-283 FHAD-02: a saved draft is never reported as an approved or executed action, and there is no client-only "saved" state.

### 1.2 The three identifiers the server must treat differently

| Field | Who makes it | What the server does with it |
| -- | -- | -- |
| `requestId` | Client, a counter per page load (`req-1`, `act-1`, `save-1`) **[C]** | Echo it back and log it. It is **not** unique across sessions and is not an idempotency key. |
| `idempotencyKey` | Client, a random UUID, one per *logical* action or save **[C]** | Makes a write safe to repeat. See 1.4. |
| `expectedVersion` | Client, copied from the record it last read | Optimistic concurrency. See 1.5. |

### 1.3 Response envelopes

**Read (`ReadResponse`).** `schemaVersion`, `requestId`, `scope` (the *verified* scope), `dataVersion`, `dataState`, `data` (or null), `sourceFreshness[]`, `coverage`, `capabilities[]`, `page { nextCursor, hasMore }`, `refresh { nextPollAfterMs }`.

- `dataState` is one of `ready`, `empty`, `partial`, `stale`, `unavailable`. **[C]** A successful empty result is `empty`, not `ready` with no rows.
- `scope` is what the server actually authorized. **[C]** The client compares it with what it asked for and throws `FORBIDDEN` if workspace, environment or the set of accounts differs (`assertScopeMatches` in `useView.ts`). A server that silently narrows the scope will therefore show up as an error on the screen. Decide deliberately (D-4).
- `capabilities[]` lists, per `actionKind`, whether the caller may do it now: `available`, `unverified`, `unsupported`, `denied` or `held`, with `reasonCodes`. **[C]** Screens enable and disable buttons from this list. It is advice for the user interface, never authorization (section 2).

**Action (`ActionResponse`).** `schemaVersion`, `requestId`, `scope`, `actionRef`, `state`, `runRef`, `approvalRef`, `manifestRef`, `payloadVersion`, `policyVersion`, `modelVersion`, `offerVersion`, `reasonCodes[]`, `receiptRefs[]`, `nextAction { kind, ownerRef, dueAt, available }`, `nextPollAfterMs`.

`state` is one of `draft`, `approvalPending`, `queued`, `blocked`, `running`, `succeeded`, `partiallySucceeded`, `failed`, `outcomeUncertain`, `reconciling`, `paused`, `canceled`.

**Success means the server acknowledged the request, not that something happened at a provider.** **[C]** (`useAction.ts` comment) **[A]** "Approved is not Sent". The only states the client treats as "sent" are `succeeded` and `partiallySucceeded`, and then only with a non-empty `receiptRefs` (the suite's `claimsSentWithoutReceipt`). See 3.4.

**Save (`SaveResourceResponse`).** `resourceRef`, `resourceVersion`, `persistedAt`, `persistedByRef`, `record`, `reasonCodes`, plus scope and ids. **[C]** The page shows the returned `record` and `resourceVersion`, so the server's answer is the saved state. The contract has no Zod schema for this response; the suite carries a local mirror.

**Error body (`AdapterErrorBody`, in `errors.ts`, not `contract.ts`).** `code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs`, optional `fieldErrors`, `currentVersion`, `executionCertainty`. The full catalogue is in section 5.

### 1.4 Idempotency (required behavior)

- **[T]** THO-283 AD-05 and THO-321 J04-08: concurrent requests with the same stable key produce at most one dispatch. A replay returns the *original* response and receipt.
- **[C]** The client keeps one key per logical action (same operation, kind, approval, expected version and payload) across retries, and makes a new key when any of those change (`useAction.ts`, `useSave.ts`).
- **[C]** The demo refuses the same key with a changed payload (`demoOnce.ts`). The server must do the same. The demo reuses the code `MANIFEST_CHANGED` for this; whether that stays is decision D-9.
- **[C]** A write with an empty or missing key is a validation error and applies nothing (suite IDEM-1, IDEM-4).
- **[P]** Scope a key to the verified principal and workspace, so one user's key can never replay another's response. Store the response with the key. How long keys are kept is decision D-8.

### 1.5 Versions (required behavior)

- **[C]** `expectedVersion` is sent on actions and saves. A stale one must return the recoverable conflict `STALE_VERSION`, apply nothing, and carry `currentVersion` (suite VER-1, VER-2).
- **[C]** Today the record version appears in six different places in the view data and in several string formats (`v3`, `r2`, `x@1`; register C-04). **[P]** Treat the version as an opaque string that the server issues and the client only echoes. The owner must pick which field carries it (D-10).

## 2. Authentication and authorization the server must enforce

The browser is untrusted. **[A]** "A hidden button is never authorization." The capability list in a read response, a disabled control, a role label in a payload and `requestedScope` all exist for display and routing only. Every decision below is made again on the server at the moment of the request.

### 2.1 Identity and scope

| # | Rule | Source |
| -- | -- | -- |
| 2.1.1 | Authenticate the user or service, then derive actor, workspace, role and allowed source scope **on the server**. Never read them from the request body. | [T] THO-283 build scope 2; THO-321 J04-02 |
| 2.1.2 | An unauthenticated request, or one for a workspace the actor cannot access, returns a typed denial with no data and no side effect. | [T] THO-283 AD-01 |
| 2.1.3 | Compare `requestedScope` with the grant. Return the verified scope in every response. A request for an account or environment outside the grant is refused, not narrowed without saying so. | [T] AD-01; [C] `assertScopeMatches` |
| 2.1.4 | Treat a demo, sandbox and production context as separate configurations. Every response carries the environment it was served from. The demo fixture works without credentials and cannot dispatch a production write. | [T] AD-08 |
| 2.1.5 | A live adapter never serves demo data. If the backend cannot answer, answer `unavailable`. | [A] ; [C] `liveAdapter.ts`; suite PENDING-1 to PENDING-4 |
| 2.1.6 | Wrong-workspace and wrong-environment requests must not reveal whether the record exists. | [P] |

### 2.2 Roles and field exposure

- **[T]** AD-01: the same record read by two roles exposes only the fields and actions each role may see, **including when the caller edits a role or approval field on the client**. So the server computes exposure from its own record of the actor and ignores any role value in the payload. Fields a role may not see are omitted or returned as a typed `unknown` with a reason (see 6.3), never as a fake zero.
- **[C]** The front end has demo role labels `founder`, `operator` and `viewer` (a table in `src/fixtures/settings.ts`). They are demo content. The real role model is decision D-3.
- **[A]** Application roles and provider authority are separate: a user's role in this app says nothing about their role in Notion, Sheets or QuickBooks (`src/fixtures/settings.ts`, `sourceRoles`).

### 2.3 Secrets

- **[T]** AD-02 and THO-285 RT-09: no provider or session credential may appear in a response payload, error message, log, browser storage or evidence link. Server-to-provider calls use a configured secret reference. Only safe source and evidence links go back to the client.
- **[A]** "No provider APIs, credentials or tokens in the client."
- **[C]** The stub's comment says the intended session is a same-origin cookie. That is a note in `liveAdapter.ts`, not a decision (D-1).
- **[T]** THO-285 RT-09: content that comes from a source (a creator's message, a page) is untrusted input. It cannot change the task, the model or permission policy, the destination, the secret scope or the approved terms.

### 2.4 Per-action approval authority

- **[T]** THO-321 J04-02: confirm server-side that the approver is a human with authority for *this* action kind, and that the decision arrived through a trusted channel and event. A forged approval, a message from a source, or a client-supplied role claim cannot authorize a command.
- **[C]** The demo refuses a decision from the wrong role with `SOURCE_AUTHORITY_DENIED` (`demoApprovals.ts`) and also reports `denied` with reason `ROLE_REQUIRED` in the capability list. The register (C-10) notes a third form in PR #30. The owner picks the authoritative form (D-5); the server must at least refuse the command.
- **[P]** Define authority per `actionKind` in a server-side table: which roles may request, decide and dispatch. Requester and approver may be the same person only if the owner says so (D-5).

### 2.5 Founder-only actions

Which actions are founder-only is **not defined in the contract**. Evidence in the code and tickets:

- **[T]** THO-283 FHAD-04: the launch Go / Revise / Hold decision (job J18) is a founder decision, and a draft save does not activate a launch, publish a score or decide a sample.
- **[C]** The capability `executePayment` is `held` with reason `FOUNDER_APPROVAL_PENDING` in the demo finance view. `payCommission` is `unsupported` with reason `PROVIDER_OWNS_PAYOUT` (register, capability-only kinds).
- **[C]** PR #30 (unmerged) lets a founder decide what a reviewer is refused for a TikTok sample.

**[P]** The server holds a list of founder-only action kinds and refuses anyone else with a forbidden denial, regardless of the capability list. The list is decision D-5.

### 2.6 Locks, quotas, budgets, stock

- **[T]** THO-283 AD-07: budget, stock, quota and lease checks run on the server at dispatch time. Stale screen data or a doctored request cannot get past them.
- **[T]** THO-285 RT-02: account and action leases prevent conflicting browser and API work, expire, and let a worker resume safely from a checkpoint after a crash. RT-04: the allowed scale is the minimum of verified remaining source quota, the approved finite scope, worker and time budget, review capacity and applicable stock or financial limits. API, browser and manual actions share one quota pool per source. **Unknown quota or permission is a visible hold, never an invented capacity.**
- **[C]** The error codes exist for this (`LEASE_CONFLICT`, `QUOTA_OR_STOCK_HOLD`, `BUDGET_HOLD`, `RATE_LIMITED`), but the demo raises only `QUOTA_OR_STOCK_HOLD` (register, error codes). No screen behavior for the others has been exercised.
- **[T]** AD-07: automatic billing and payout that a provider owns follows the program commitment approved earlier. It is not turned into a new manual Pay action.

### 2.7 Source permission and capability

- **[T]** AD-06 and RT-05: permission denial, an unsupported capability, login expiry, timeout, rate limit and unavailability are *distinguishable* errors. A permission denial never triggers a browser workaround. Login or MFA prompts, CAPTCHAs, changed pages and changed terms pause the work for a person to take over.
- **[T]** THO-285 RT-03: preflight checks current permission, source state, current commission-only policy, exact approval and terms version, suppression, stock, budget, quota and required evidence.

## 3. Rules that need server-side enforcement from THO-284 and THO-321

### 3.1 Commission-only terms (THO-284)

The policy is that new creator acquisition is commission-only. **[A]** "New acquisition is commission-only. Historical v2 scores and accepted fees stay read-only and labeled."

| # | Rule | Source |
| -- | -- | -- |
| 3.1.1 | Creating, editing, bulk-importing or dispatching a new acquisition offer with an upfront content fee, a minimum guaranteed content payment, a paid-hybrid component or a gifted-only relationship returns a policy violation. This holds even if the screen sent a manipulated payload. | [T] THO-284 CP-01 |
| 3.1.2 | A fixed amount per eligible sale is allowed and is not a guaranteed fee. A provider route that cannot support the per-sale calculation is unavailable for those terms. | [T] THO-284 typed policy |
| 3.1.3 | The policy is stored with an id, version, effective time, owner and approval reference. New invitations bind the exact policy, rate, reward and source versions. | [T] THO-284 |
| 3.1.4 | An offer or batch approved under an older policy cannot dispatch after a conflicting policy change. Return the changed terms and require a new finite preview and approval. Each run receipt records the policy, model and offer versions. | [T] THO-284 CP-06; THO-321 J04-05 |
| 3.1.5 | A creator reply that asks for an upfront fee moves the item to terms mismatch and review. It blocks dispatch and automatic counter-offers, and keeps the reason, evidence and suppression rules. | [T] CP-03 |
| 3.1.6 | Samples, shipping and stock reservation keep their own separate approval and preflight. A fit score never issues a sample. | [T] CP-04 |
| 3.1.7 | An invitation, or a high score, is not acceptance. Only a source-confirmed acceptance activates a relationship. | [T] CP-02 |
| 3.1.8 | Historical gifted, paid and hybrid relationships stay readable and reconcilable. Accepted fixed-fee liabilities and native-funded obligations are not cancelled, rewritten or suppressed. New fee commitments cannot be made through the historical-payment screens. | [T] CP-07 |

**[C]** A demo version of rule 3.1.1 to 3.1.4 exists in PR #37 (`demoPolicy.ts`, unmerged). It is evidence of intent only. The register (Q-22) records that real enforcement waits for this service. The demo reports the violation as `POLICY_VIOLATION` with per-field messages, and a stale-policy dispatch as `MANIFEST_CHANGED`; both are proposals.

### 3.2 Exact-action approval (THO-321)

- **[T]** J04-01: the approval binds the exact account, action kind, recipients, text, product, rate and terms, sample exposure, resource bounds and expiry, by hash. A broad flag such as "approved creator" is not enough.
- **[T]** J04-05: a change to recipient, text, account, offer, policy, quantity or economic exposure invalidates the approval. The user must approve a new finite preview. An old approval is never silently extended.
- **[T]** J04-06: a batch is bound to a frozen list of items and versions with ceilings. Cancellation affects unsent items only and never erases a confirmed action.
- **[T]** J04-07: before the provider write, the server runs a final preflight of permissions, quotas, suppression, locks, budget, stock and idempotency. Screen state and a Slack message cannot prove a dispatch.
- **[T]** THO-283 AD-04: a proposed action returns a draft and an approval request without dispatching. Execution accepts only a matching actor, action, payload and terms version in the current workflow phase. An expired or revoked approval, or a changed payload, is blocked and needs a new approval.
- **[T]** THO-321 J04-04: gates differ by phase. An invitation may come before creator acceptance. Activation or shipment needs the actual accepted terms and separate sample authority.

### 3.3 One decision wins: the app and Slack

The decision to approve, edit or reject can arrive from the app or from a configured Slack thread. **A decision recorded in the app and one recorded in Slack must not both win.** (THO-283 comment; THO-321 workflow step 2 and J04-08.)

- **[C]** The demo refuses a second decision on a version that is already decided, with `APPROVAL_INVALID` (`demoApprovals.ts`). The server must do the same.
- **[P]** Record decisions in one place with a single compare-and-set on `(approvalRef, version)`: the first valid decision moves it out of `pending`, and a later one from either channel receives the "already decided" answer plus the recorded decision. Reject decisions that are replayed, expired, from the wrong thread, from an unauthorized person, or that try to consume an approval twice (J04-08).
- **[P]** Keep the audit record of a refused decision (the evidence of who tried and through which channel), without applying it. THO-321 requires audit evidence for invalid or expired events.
- The Slack trust model (which thread, which workspace, how a Slack user maps to an app user) is decision D-6. The front end contains no Slack integration.

### 3.4 Approved is not sent

- **[A]** Show success only after the authoritative acknowledgment or source receipt.
- **[T]** THO-321: an approval is an authorization record, not a source receipt.
- **[C]** Rules the suite already checks against any adapter (SENT-1 to SENT-4): an approval response has no receipt and no success state; dispatch before approval is refused as an approval hold and sends nothing; after approval, dispatch reads as sent only when `receiptRefs` is non-empty; an unknown outcome returns `outcomeUncertain`, no receipt, and is not reported as sent.
- **[P]** The server sets `succeeded` only when it holds a receipt from the provider, or a verified read of the provider that proves the write. A write the server issued but could not confirm is `outcomeUncertain`, then `reconciling` while the server looks it up. See 5.3.

### 3.5 Uncertain outcomes and reconciliation

- **[T]** THO-283 AD-05 and THO-285 RT-06: an uncertain send, accept, label or payment result enters reconciliation before any retry, keeping the original correlation and receipt. It cannot be retried as a new command until non-application is conclusively shown and a fresh preflight passes. Only transient *reads* and *conclusively unapplied* writes may be retried automatically, and then within `Retry-After` and a bounded number of attempts.
- **[C]** The Run screen offers three reconcile requests in the demo: look up the source, record a confirmed send, and make a fresh attempt. `recordConfirmedSent` without a verified receipt fails `OUTCOME_UNCERTAIN`. `freshAttempt` while the outcome is not proven failed fails `OUTCOME_UNCERTAIN` (register, action kinds).
- **[T]** THO-285 RT-07: reconcile mode reads evidence and records facts. It never invents a prior approval or a prior dispatch.
- **[T]** THO-285 RT-08: pause stops new dispatch. Cancel affects unsent items only. Partial batch success is reported per item.

## 4. Environments and who can reach what

| Environment | Requirement | Source |
| -- | -- | -- |
| `demo` | Served by the front end's own fixtures, never by this service. | [C] `selectAdapter.ts` |
| `sandbox` | Real transport, no production side effects. | [T] AD-08; THO-285 RT-11 |
| `production` | Needs the owner's explicit enablement per source account. Code or fixtures alone do not activate a schedule. | [T] THO-285 completion evidence |

The environment value `demo` must not be accepted by the live service as a way to read real data, and `production` must not be reachable from a sandbox session.

## 5. Error catalogue

Every error is a typed `AdapterErrorBody`. The code list below is the map in `src/adapter/errors.ts` plus `RECORD_NOT_FOUND` (added by the front end; see 7.2). The **HTTP status column is a PROPOSAL.** The contract does not define any transport; the owner may map differently, or carry the code only in the body.

### 5.1 Codes, categories and proposed statuses

| Code | Category | Proposed HTTP status | Client behavior today [C] |
| -- | -- | -- | -- |
| `UNAUTHENTICATED`, `SESSION_EXPIRED` | unauthenticated | 401 | Clears all cached protected data for the scope. Not retried. |
| `FORBIDDEN`, `SOURCE_AUTHORITY_DENIED` | forbidden | 403 | Clears protected data on a read. On an action, fails that action only. Not retried. |
| `RECORD_NOT_FOUND` | notFound | 404 | Shows a not-found state. Only for records inside the actor's authorized scope. |
| `VALIDATION_FAILED`, `POLICY_VIOLATION` | validation | 422 (or 400) | Shows `fieldErrors` next to fields. |
| `STALE_VERSION`, `APPROVAL_INVALID`, `MANIFEST_CHANGED`, `LEASE_CONFLICT` | conflict | 409 | Refetches. `STALE_VERSION` should carry `currentVersion`. |
| `APPROVAL_REQUIRED`, `APPROVAL_EXPIRED` | approvalHold | 409 (see D-12) | Shows the hold and its owner. |
| `CAPABILITY_UNVERIFIED`, `CAPABILITY_UNSUPPORTED`, `SOURCE_LOGIN_REQUIRED`, `SOURCE_UI_CHANGED` | capabilityHold | 409 or 422 (D-12) | Shows the hold. Needs a person, not a retry. |
| `QUOTA_OR_STOCK_HOLD`, `BUDGET_HOLD` | resourceHold | 409 or 422 (D-12) | Shows the blocker. |
| `RATE_LIMITED` | rateLimited | 429 with a retry delay | Should wait `retryAfterMs`. Not exercised. |
| `SOURCE_UNAVAILABLE`, `TIMEOUT`, `INTEGRATION_PENDING` | unavailable | 503 (504 for `TIMEOUT`) | Reads retry up to twice when `retryable` is true. Shows an honest pending state and never demo data. |
| `OUTCOME_UNCERTAIN` | outcomeUncertain | see 5.3 | Shows "outcome unknown" and offers reconciliation. Never retried as a new command. |
| any other code | unknown | 500 | Generic failure. |

`replayed` is a category with no code mapped to it (register, error codes). Decision D-9.

### 5.2 Rules for every error

- **401 expired session clears data.** **[A]** "401 and 403 clear protected data." **[C]** `mustClearProtectedData` is true for unauthenticated and forbidden (`errors.ts`); the suite checks it for reads (AUTH-1) and actions (AUTH-2).
- **403 is neutral.** **[P]** The message and body are the same whether the record exists or not, and name no other tenant, record or role. Detail goes to the server log, not to the response.
- **409 for a stale version** returns the new `currentVersion` so the client can refetch. **[C]** Collaboration and batch demos omit it; register C-11 asks the owner to make it required.
- Every error carries `requestId` and, for writes, `correlationId`. **[T]** THO-283 build scope 5 asks for correlated immutable request, action and receipt references.
- No error message contains a credential, session value or raw provider text. **[T]** AD-02.
- `retryable` is true only where an identical retry is safe. **[C]** The demo sets it true only for `SOURCE_UNAVAILABLE` (register, error codes).

### 5.3 Uncertain outcomes are never blindly retried

**[T]** AD-05, RT-06. **[C]** Errors on writes carry `executionCertainty`, which the stub sets to `notApplied`.

- **[P]** A response to a write must say whether anything was applied: `notApplied` (the server holds proof that nothing was sent), `applied`, or `uncertain` (the request left the server and the result is not known). See 7.4.
- **[P]** A write that times out after it was submitted to a provider is `uncertain`, never `notApplied`, and never a plain 5xx the client would treat as retryable. Return the `outcomeUncertain` state (HTTP 200 or 202 with an `ActionResponse`) or the error `OUTCOME_UNCERTAIN`; the owner chooses one (D-12).
- **[P]** The only safe retry of a write is the *same* idempotency key. The server answers it with the stored response. A *new* key for an action in `outcomeUncertain` is refused until reconciliation shows non-application and a new preflight passes.
- A gateway or network failure between browser and service is also uncertain from the client's side. **[C]** TanStack mutations do not retry automatically here, and `useAction` reuses the key on a user-triggered retry, so idempotency is what makes that safe.

## 6. Read semantics

### 6.1 Stale and partial data

- **[T]** AD-03: read responses carry canonical ids and source ids, event and observation times, period and currency where they apply, and freshness and coverage. Missing, private and stale counters are explicit. They cannot become zero, an empty success, or an asserted complete coverage.
- **[C]** `dataState` values: `ready`, `empty`, `partial`, `stale`, `unavailable`. `unavailable` means no usable data, and `data` is null.
- **[C]** `coverage` is `{ expectedCount, observedCount, missingCount, complete, reasonCodes }`; every number and `complete` can be null. **[P]** Null means "not known". `complete: true` requires `expectedCount` to be known and equal to `observedCount`.
- **[C]** `sourceFreshness[]` per source has `lastSourceSuccessAt`, `observedAt`, `mirroredAt` and `staleReasonCode`. The demo sets `staleReasonCode` to `SOURCE_SYNC_DELAYED` when stale (`demoOps.ts`).
- **[P]** Return `stale` when data is served from a mirror older than the source's allowed age, with the age and reason. A stale read is still a success; do not return an error. The allowed age per source is decision D-13.
- **[P]** `refresh.nextPollAfterMs` tells the client when to ask again. Null means "do not poll".

### 6.2 The four per-source freshness states

This work asks for four states for a source: **never synced**, **no change**, **partial** and **error**. **The contract does not define them.** `sourceFreshness` has timestamps and one reason code only, and the front end has no such enum (a search of `src/` finds none). **[P]** This mapping lets the server express them without a contract change; the owner may prefer an explicit field (D-13).

| State | How to express it with today's fields | Must not be shown as |
| -- | -- | -- |
| Never synced | `lastSourceSuccessAt: null`, `mirroredAt: null`, reason code such as `NEVER_SYNCED`, `dataState` `unavailable` or `partial` | Zero rows, or an empty success |
| No change | `lastSourceSuccessAt` is recent and `observedAt` is newer than the data, reason code such as `NO_CHANGE_SINCE_LAST_SYNC`; `dataState` `ready` or `empty` | A failed or stale sync |
| Partial | `dataState: partial`, `coverage.complete: false` with counts where known, reason codes naming what is missing | A complete result |
| Error | `lastSourceSuccessAt` kept at the last good time, reason code naming the error class (login, permission, rate limit, unavailable), `dataState` `stale` or `unavailable` | A fresh result, or an empty one |

The reason codes in that table are examples. The front end has no catalogue for reason codes (register, "Reason codes"). THO-285 RT-10 requires a successfully empty scan to be distinguishable from inaccessible, partial, stale and failed work.

### 6.3 Known zero, unknown and N/A

**[A]** "A known zero, unknown and N/A are different states. Missing data never becomes zero." **[C]** Every metric value uses `ProvenanceValue` (`contract.ts`):

| State | `value` | `reasonCode` | Example meaning |
| -- | -- | -- | -- |
| `known` | the number, **including 0** | may be null | The source reported zero. |
| `unknown` | **null** | required | The server could not read or does not have it (private, not synced, denied). |
| `notApplicable` | **null** | required | The question does not apply to this record. |

The schema rejects a known null, an unknown or N/A with a non-null value, and an unknown or N/A without a reason code. The suite checks the three states survive a JSON round trip and the adapter data (VALUE-1 to VALUE-7).

Server obligations:

- Never coerce an absent or failed source read to `0`, an empty string or an empty list.
- A field a role may not see is `unknown` with a reason such as a permission code, not removed silently and never `0` (ties to 2.2).
- Also carry `sourceRef`, `occurredAt`, `sourceUpdatedAt` and `observedAt`; `observedAt` is required on every value. Money is `{ minorUnits, currency }` and a period has `timezone` and `basis` (`eventTime` or `observationTime`) (`contract.ts`).
- **[C]** Missing identity is `identityState: "unresolved"` with null ids, never an invented id (THO-321 also forbids invented ids).

### 6.4 Paging

**[T]** AD-03 and THO-283 build scope 3: pagination uses safe cursors. **[P]** Cursors are opaque, bound to the actor and scope, and expire. A cursor from another scope is refused. The client currently sends `limit: 50` and a null cursor only (`useView.ts`), so paging beyond a first page is unexercised.

### 6.5 Exports

**[T]** THO-283 FHAD-02 requires authorized snapshot exports of a filtered ledger as CSV: only the explicit allowed columns, escaping and formula protection, limits, asynchronous states and permission checks when fetching the file. **[C]** `contract.ts` has no export envelope and no screen requests one. This is a gap to be specified (D-14).

## 7. The four contract gaps from the THO-283 comment: decisions needed

The same four are in `docs/intake.md` and the register (Q-01 to Q-04). Each needs a decision before the contract can freeze, because `contract.ts` is a transcription of a document and says not to add fields it does not define.

### 7.1 No state for "approved, awaiting dispatch"

The demo returns `blocked` with reason `AWAITING_DISPATCH` (`demoApprovals.ts`).

| Option | Effect |
| -- | -- |
| A. Add an `approved` state | Honest and explicit. Not a success state, so the "approved is not sent" rule is unaffected. Needs a new enum value and screens that switch on state. |
| B. Keep `blocked` + `AWAITING_DISPATCH` | No contract change. `blocked` normally means something stops progress, so an approved action looks stuck. |
| C. Use `queued` | No contract change, but it implies the dispatcher has taken it. |

**Recommendation: A.** The state matters because "approved" is a different fact from "blocked" and from "sent", and a distinct name makes the SENT rules simple to test. If A is not accepted, B with the reason code made mandatory.

### 7.2 No not-found error

The demo uses `RECORD_NOT_FOUND`, and the category `notFound` already exists in `errors.ts`.

| Option | Effect |
| -- | -- |
| A. Add `RECORD_NOT_FOUND` | Clear for a missing id. |
| B. Reuse `FORBIDDEN` for everything | No existence leak, but a mistyped id looks like a permission problem. |

**Recommendation: A, with a rule.** Return `RECORD_NOT_FOUND` only for a record inside the actor's verified scope. For anything outside it, return the neutral `FORBIDDEN` (rule 2.1.6), so the catalogue cannot be used to probe other tenants.

### 7.3 No run reference on `controlRun` and `reconcileRun`

The demo puts `runRef` in the payload, and three unrelated screens send three different `controlRun` payloads (register C-01, C-07).

| Option | Effect |
| -- | -- |
| A. Add an optional top-level `runRef: string \| null` to `ActionRequest` | Validated in one place, usable for authorization and locks. Contract change. |
| B. Keep it in the payload | No contract change. Each `actionKind` carries its own shape and the server must validate each. |
| C. Put it in `entityRefs` as a `SourceRef` | No new field, but a run is not a source object. |

**Recommendation: A.** The server must authorize and lock by run, which is simpler with one typed field. Decide separately whether batch and monitor retries are really `controlRun` (register C-01, decision D-7).

### 7.4 `executionCertainty` has no defined values

The front end uses `notApplied`, `uncertain` and `applied` (`errors.ts`). Only errors carry it.

| Option | Effect |
| -- | -- |
| A. Freeze the three values and require them on every write error and on every `ActionResponse` and `SaveResourceResponse` | The client can always tell whether a write happened. Contract change on the success shapes. |
| B. Freeze the three values on errors only | Smaller change. A success never says `applied`, so it is inferred from state. |
| C. Leave undefined | The client cannot be sure whether to offer a retry. |

**Recommendation: A, with a proof rule.** `notApplied` may be claimed only when the server holds proof that nothing was sent to the provider (for example a refusal before dispatch). A timeout after submission is `uncertain`. The values mean the same thing everywhere (see 5.3).

## 8. Decisions only the backend owner can make

The numbers are referred to above.

1. **D-1 Transport and session.** What carries the calls and how the user is authenticated. The stub's comment assumes a same-origin cookie session; nothing is decided. The front end needs a way to learn the signed-in principal and the allowed scopes.
2. **D-2 Operation names and versioning.** How `viewKey`, `actionKind` and `schemaVersion` map to the real service, and how schema changes roll out. The current `SCHEMA_VERSION` is `2026-11-02.proposed`.
3. **D-3 Role model.** The real roles, and what each sees per view and per field.
4. **D-4 Scope narrowing.** If a request names more accounts than the grant, refuse it or return a narrower verified scope. The client treats any mismatch as `FORBIDDEN` today.
5. **D-5 Approval authority.** Per `actionKind`: who may request, decide and dispatch; the founder-only list; whether requester and approver may be the same person; and which of the three denial forms is authoritative (register C-10).
6. **D-6 Slack trust.** How a Slack decision is verified and mapped to a user, and how the single-winner rule is stored (3.3).
7. **D-7 Shape of `controlRun`.** Whether batch pause, batch cancel and monitor retry stay under it, and whether `previewAction` is a separate call (register C-01, C-13, C-14).
8. **D-8 Idempotency retention.** How long keys and stored responses live, and what a key reused after expiry does.
9. **D-9 Duplicates and replays.** A single code or state for "already done" (register C-09); whether key reuse with a changed payload keeps `MANIFEST_CHANGED` (register C-08); whether `replayed` gets a code.
10. **D-10 Version token.** Which field carries it and whether its format is opaque (register C-04).
11. **D-11 Filters, period, sort and search.** Shared names and values (register C-05, C-16), and whether `scenario` is rejected or ignored outside demo (register C-06).
12. **D-12 HTTP and body for holds and uncertain results.** Whether holds use 409 or 422, and whether an uncertain write is a 2xx `outcomeUncertain` response or an `OUTCOME_UNCERTAIN` error.
13. **D-13 Freshness.** Allowed age per source, and whether the four states in 6.2 become an explicit field.
14. **D-14 Exports and the missing shapes.** The CSV export envelope; a schema for the save response (the suite mirrors it locally); a reason-code catalogue; the required fields of the error body per category (register C-11); and whether the contract schemas become strict (the suite notes they currently strip unknown fields, see its SCHEMA-3).
15. **D-15 Limits.** Rate limits per principal and per source, quota pool definitions (THO-285 RT-04), and lease durations.
16. **D-16 Audit and retention.** What is stored immutably for request, action and receipt (THO-283 build scope 5), for how long, and with what redaction (THO-285 RT-09).
17. **D-17 Environment separation.** How sandbox and production are separated, and who may enable production for a source account.
18. **D-18 Which ticket owns what.** THO-283 is assigned to the backend owner and marked in progress; THO-285 and THO-321 are assigned to the same person and are in Backlog. The service needs the runner (THO-285) and the approval service (THO-321) behind it; the order of delivery is open.

## 9. Acceptance checklist against the conformance suite

The suite (PR #44, not merged) runs the same rules against any adapter. A new target for the live adapter is added in a test file (`docs/adapter-conformance.md`, "Plugging in THO-283"). A rule with no scenario must carry a documented gap, which registers a pending test. **The ids below are the ones in the suite's code on branch `adapter-conformance-suite`. Rows marked "not yet testable" have no suite rule: the ids shown in brackets are proposed names, not existing ones.**

"Target needs" means the scenario the owner supplies for the target (`unauthenticated`, `forbidden`, `unavailable`, `actions`, `saves`, `valueStates`).

### 9.1 Covered by the suite today

| Rule | Source | Suite test | Target needs |
| -- | -- | -- | -- |
| Live adapter reports kind and environment, never `demo` | 2.1.4, 2.1.5 | `IDENT-1` | none |
| Every response is labeled with the service's environment | 2.1.4 | `IDENT-2` | data |
| Read response echoes the verified workspace, accounts, environment | 2.1.3 | `SCOPE-READ-1` | data |
| Response matches the contract with no unknown fields | 1.3 | `SCOPE-READ-2`, `SCOPE-ACTION-1`, `SCOPE-SAVE-1` | data, actions, saves |
| Another environment is refused as forbidden with no data | 2.1.2, 2.1.3 | `SCOPE-READ-3`, `SCOPE-ACTION-2` | data, actions |
| Client sends full scope; refuses a mismatched response | 1.1 | `SCOPE-READ-4`, `SCOPE-READ-5`, `SCOPE-ACTION-3`, `SCOPE-SAVE-2` | client side |
| Query keys include principal, environment, workspace, accounts; scope change never shows old data | [A] | `KEY-1`, `KEY-2:*` | client side |
| 401 and 403 on a read clear cached data | 5.2 | `AUTH-1:*` | `unauthenticated`, `forbidden` |
| 401 on an action clears data; 403 on an action fails that action only | 5.2 | `AUTH-2` | data |
| Expired session reads unauthenticated, missing grant forbidden, neither retryable | 5.1 | `AUTH-3` | `unauthenticated`, `forbidden` |
| Unavailable backend errors, shows no data, never uses demo data | 2.1.5 | `PENDING-1`, `PENDING-2`, `PENDING-3` | `unavailable` |
| Unavailable writes report `notApplied`, never success | 5.3 | `PENDING-4` | `unavailableWrites` |
| Known zero, unknown, N/A stay distinct | 6.3 | `VALUE-1` to `VALUE-4` (schemas); `VALUE-5` to `VALUE-7` (adapter data) | `valueStates` |
| Write without a key is refused and applies nothing | 1.4 | `IDEM-1`, `IDEM-4` | actions, saves |
| Same key returns the first answer; save does not bump the version again | 1.4 | `IDEM-2`, `IDEM-5` | actions, saves |
| Same key with a changed payload is refused | 1.4 | `IDEM-3` | actions |
| Stale `expectedVersion` is a recoverable `STALE_VERSION` that applies nothing | 1.5 | `VER-1`, `VER-2` | actions, saves |
| Approval has no receipt and no success state | 3.4 | `SENT-1` | actions |
| Dispatch before approval is refused and sends nothing | 3.2, 3.4 | `SENT-2` | actions |
| Dispatch reads as sent only with a receipt | 3.4 | `SENT-3` | actions |
| Unknown outcome is not sent and has no receipt | 3.5 | `SENT-4` | `uncertainApprovalRef` |
| Bad shapes and unknown fields are rejected | 1.3 | `SCHEMA-0` to `SCHEMA-3` (`SCHEMA-3` is an expected failure today) | none |

### 9.2 Not yet testable with the suite

These are required by tickets or `AGENTS.md` and no suite rule checks them. They need new rules, then scenarios on the live target. Names in brackets are proposals.

| Requirement | Source | Gap | Proposed rule |
| -- | -- | -- | -- |
| Two roles see different fields and actions for one record; edited client role is ignored | [T] AD-01; 2.2 | The suite's scope has one principal and no role switch | `[ROLE-1]`, `[ROLE-2]` |
| Wrong-workspace request leaks nothing and does not reveal existence | 2.1.2, 2.1.6 | Only a foreign *environment* is tested | `[SCOPE-READ-6]` |
| Founder-only and per-kind approval authority | [T] J04-02; 2.4, 2.5 | No authority scenario | `[AUTH-4]` |
| No credential in payload, error or log | [T] AD-02 | Needs response and log scanning | `[SECRET-1]` |
| Concurrent same-key requests dispatch once | [T] AD-05 | `IDEM-2` repeats sequentially; no parallel test | `[IDEM-6]` |
| Uncertain outcome blocks a new-key retry until reconciliation and fresh preflight | [T] AD-05, RT-06; 3.5 | `SENT-4` stops at the first response | `[SENT-5]`, `[RECON-1]` |
| Changed payload, expiry or revoked approval blocks dispatch | [T] AD-04, J04-05 | Not in the suite | `[APPROVAL-1]` to `[APPROVAL-3]` |
| App and Slack decisions cannot both win | [T] J04-08; 3.3 | Needs a second channel in the test double | `[APPROVAL-4]` |
| Commission-only terms rejected on create, edit, import and dispatch | [T] CP-01; 3.1 | Only demo tests exist (PR #37), not suite rules | `[POLICY-1]` to `[POLICY-3]` |
| Dispatch after a policy change is blocked | [T] CP-06; 3.1.4 | Same | `[POLICY-4]` |
| Budget, stock, quota and lease checks at dispatch | [T] AD-07; 2.6 | Needs a resource scenario | `[RESOURCE-1]`, `[LEASE-1]` |
| Rate limit honors `retryAfterMs` | [T] RT-06; 5.1 | No code is raised by the demo | `[RATE-1]` |
| 5xx and timeout on a write are uncertain, not retried | 5.3 | `PENDING-4` covers only "unavailable" | `[UNCERTAIN-1]` |
| Freshness states and coverage never assert complete without counts | [T] AD-03; 6.1, 6.2 | No freshness or coverage assertions | `[FRESH-1]`, `[FRESH-2]` |
| Exports | [T] FHAD-02; 6.5 | No contract shape | not yet specifiable |
| Cursor bound to scope | 6.4 | Client never pages | `[PAGE-1]` |

### 9.3 What passing means

Passing these tests moves the service to **integration-verified for the rules covered**, only on sandbox with test doubles, and only if the target uses the real adapter's error mapping. It is not production-authorized. Per `AGENTS.md`, `npm run verify` and `npm run test:e2e` must pass, evidence goes on the owning Linear issue, and the stage is stated truthfully. THO-283 also expects a list of provider capabilities that are validated and those that are not (its completion evidence); this document cannot supply it.

## 10. What was not verified

- The suite and the register are read from their branches at the time of writing. If either merges or changes, the rule ids and counts above need a recheck.
- Nothing was run against a backend, because none exists. All statements about the demo come from reading the source.
- Ticket text was read through the Linear tools on 2026-11-04. The linked handoff documents (adapter contracts, control contracts, job registry) were not opened. The contract file is the transcription of the first, so differences between it and the document are possible.
