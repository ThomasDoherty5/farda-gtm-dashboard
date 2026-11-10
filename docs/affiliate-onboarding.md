# Website affiliate onboarding

`src/creator-agent/affiliateOnboarding/` records website-affiliate onboarding for one merchant, canonical creator and provider programme: preflight, invitation, acceptance, link or code, a sandbox attribution matrix, payout setup and activation. It proposes J04 intents. It never sends an invitation, issues a code, activates a relationship, reads a provider or serves a route.

## What is and is not bound

The module is fixture-complete only. Preflight reads an injected account record and connection-ledger readiness. Tests inject a record marked `origin: "synthetic"`. Such a record blocks with `SYNTHETIC_ACCOUNT_NOT_ALLOWED` unless the authority sets the test-only `allowSyntheticAccounts: true`. Every preflight, `output()` and `phaseReadiness` carries the record's `origin`. The real merchant and Shopify Collabs account, its plan, permissions and quota, are not bound. Until a qualified source supplies them, nothing here shows that a live route is ready.

The J04 action kinds `affiliateInvitation` and `affiliateActivation` are not registered. Registration, the executor and any live send are left to their owners.

## Reused rules

| Concern | Owner |
| -- | -- |
| Fee, paid-hybrid and gifted-only rejection | `evaluateTerms` in `src/adapter/commissionPolicy.ts` |
| Policy, route and account checks, including `COMMISSION_ROUTE_UNSUPPORTED` and `supportsFixedPerSale` | `evaluateCommercialTerms` in `commercialPolicy/evaluate.ts` |
| Creator fee replies | `routeCreatorReply` |
| Attribution test and website commerce shapes | `routeAssessmentSchema` in `routeEvidence.ts` |
| Canonical creator | The J01 intake identity, re-read on every mapping |
| Approval and dispatch | J04, through `previewAction` envelopes |

## Preflight

`runPreflight` records merchant and creator eligibility, account plan, each action's provider permission and connection-ledger readiness, and quota unit, remaining and reset. It reports `ready` only when every required fact is known and passes. Unknown quota is never zero. A stale, malformed or cross-account record blocks. So does a capability that is not `Ready`, is not allowed or has expired.

Rate type, eligible base and currency must be supported by both the commercial policy route and the account. Unsupported fixed-per-sale and ambiguous commission math block the offer. Nothing is converted. Each blocker names an owner.

A fee, paid-hybrid or gifted-only request is refused by `open` with `ACQUISITION_POLICY_VIOLATION` (422) before anything is stored. A product and shipping allocation with its own approval is a sample cost, not a fee. Without that approval it is held, never treated as a fee.

## States

Invitation, acceptance, link or code, checkout test, payout setup and activation are reported separately in `phaseReadiness`.

- A sent invitation moves the onboarding to `invited`. Acceptance stays unknown.
- Expiry, decline, fee request and a terms change each have their own state.
- Acceptance must name the exact current offer version. After a change, the old acceptance stays in history, and `reviseTerms` requires a new invitation.
- `reviseTerms` also clears the link mapping and the matrix. After the new acceptance, the relationship must be observed and mapped again under the new offer version, and the matrix recorded again. Mappings are stored per offer version, so the old one stays in history.
- The relationship and its link or code map once to the canonical creator. A recheck or duplicate import returns the existing mapping. An identifier already mapped to another creator is refused.
- Activation needs current accepted terms, a mapped link or code and a passing matrix for the same offer version. Recording a new matrix or mapping withdraws any unsettled activation; if J04 holds it, a blocking `evidenceChangedWhileLive` conflict opens.
- Payout setup is observed on its own. Link issuance, acceptance, activation and merchant billing never set it. Waiting for creator setup names the creator and links the source.

## Attribution matrix

`evaluateAttributionMatrix` checks sandbox orders for six cases: link only, code only, conflicting identifiers, untracked traffic, the actual storefront route and a refund. All six must pass. Within a case the worst order wins, in this order: exception, fail, unknown, pass. One passing order never hides a failing one.

- A conflict passes only when the provider applied a documented, deterministic precedence. Otherwise it is an exception with no creator revenue.
- A Shopify mirror of a native TikTok Shop order is excluded, so it cannot be entitled twice.
- Provider definitions of gross, eligible, refund and hold are stored with their version. A row under another version is unknown.
- An unknown refund or amount stays unknown.

## Sends

Invitations and activation use the same reserve-then-submit pattern as `followUp/` (PR #113).

1. `proposeInvitation` or `proposeActivation` creates one intent.
2. `reserve` re-reads the intent, onboarding and current offer, re-runs preflight and returns the J04 preview.
3. Answers are recorded with `recordOutcome`. `outcomeFromActionResponse` maps an actions-service answer. A succeeded run counts as sent only with the provider's native receipt.

Builders take an intent reference and re-read it. A J04 registration must call `assertJ04Current(intentRef, intentVersion)` in its current-draft check. That check refuses a withdrawn intent, a changed version or a changed offer. For an activation it also re-runs the activation gate: current acceptance, a mapped link or code, and a passing matrix.

An unknown result, denied permission, login or MFA, and UI drift move the intent to `reconciliationRequired`. The approval, manifest and run references are kept. No new intent, reservation or direct outcome is accepted until `reconcile` records a source answer. `found` records the native receipt. After an unknown send, a terminal `absent` returns an approved intent to `awaitingApproval` for a J04 fresh attempt. After a denied permission, login or MFA, or UI drift, `absent` marks the intent `notSent`, and a new intent with a new J04 approval is required. The reconcile source reference and any native receipt must belong to the onboarding's provider account.

A terms change (`syncTerms`), fee request, decline or closure withdraws unsettled intents. If J04 holds one, or its outcome is unknown, the module opens a blocking conflict. A late outcome for a withdrawn intent is kept as a conflict and never applied. Open blocking conflicts hold new intents.

## Storage

The repository uses the shared agent SQLite connection. It checks `agent_scope`, and `capability_scope` when present, and owns the `affiliate_onboarding_*` tables. Every write runs under `BEGIN IMMEDIATE` with an idempotency key and reads the clock inside the lock. Each record revision is kept.

## Owner decisions

- Whether activation should also wait for completed payout setup. The ticket keeps them separate, so activation does not wait today.
- Which provider account is the chosen route, and its real plan, permissions, quota, definitions and attribution precedence.
- Who registers the two J04 action kinds and their handlers.
