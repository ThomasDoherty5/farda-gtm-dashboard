# Adapter conformance

The shared suite in `src/adapter/conformance.ts` checks frontend adapter semantics. `src/adapter/conformance.test.ts` runs demo, unconfigured live, and injected-transport targets; the reference-server target is a separate test double. The authenticated service exists in `src/creator-agent/server.ts`. Its actual HTTP, SQLite, source-family and browser tests provide separate integration evidence, mapped below. A passing demo or reference target never substitutes for actual-service proof.

The suite builds no transport and knows no backend URL.

## What it checks

| Rule ids | Rule |
| -- | -- |
| `IDENT-*` | The adapter reports its kind and environment. A live adapter is never `demo`. Responses carry the adapter's own environment. |
| `SCOPE-*` | Reads, actions and saves send the full requested scope. Responses echo it and match the contract strictly. A foreign environment is refused as forbidden. |
| `KEY-*` | Query keys include principal, environment, workspace and accounts. Changing any of them never shows the previous scope's data, with or without `keepPrevious`. |
| `AUTH-*` | 401 and 403 clear protected data. A 401 on an action does too. A 403 on an action fails that action only. |
| `PENDING-*` | An unavailable backend (`SOURCE_UNAVAILABLE`, `INTEGRATION_PENDING`) rejects, shows an error with no data, and never falls back to demo data. Unavailable writes report `notApplied`. |
| `VALUE-*` | Known zero, unknown and N/A stay distinct through the contract schemas and through adapter data. Missing data never becomes zero. |
| `IDEM-*` | A write needs an idempotency key. Repeating it returns the first answer. The same key with a changed payload is refused. |
| `VER-*` | A stale expected version is a recoverable `STALE_VERSION` conflict. It applies nothing and returns `currentVersion`. |
| `SENT-*` | Approved is not Sent. An approval has no receipt and no success state. Dispatch before approval is refused. A success needs a source receipt. An unknown outcome is not success: `SENT-4` expects an answer with state `outcomeUncertain`, and `SENT-5` (added with the reference server, D-12) accepts that or a rejected `OUTCOME_UNCERTAIN` with `executionCertainty: uncertain`. |
| `SCHEMA-*` | Bad shapes and unknown fields are rejected. See the note on strictness below. |

## Adding a shared conformance target

1. Add a target in a test file. Copy the demo target in `conformance.test.ts`.
2. Fill `create` (a fresh adapter per call), `scope`, `read` and `canServeData: true`.
3. Add scenarios as the sandbox allows:
   - `unauthenticated`, `forbidden` and `unavailable`: adapters whose reads fail in that way. These may wrap the real adapter over a test double for the network. They must not stub the adapter's own error mapping.
   - `actions`: an approval that can be decided and dispatched, plus `uncertainApprovalRef` for an unknown outcome.
   - `saves`: a versioned resource and a payload that changes it.
   - `valueStates`: reads that return a known zero, an unknown and a not-applicable value.
4. Delete the target's `gaps` entries as each scenario lands. Run `npm test`.

A rule with no scenario is never skipped quietly. It must have a reason in `gaps`, which registers an `it.todo`. A rule with no scenario and no reason fails. `knownFailures` registers an `it.fails` with its reason, and it goes red when the rule starts passing so the entry gets removed. A reason that names no registered rule fails too.

## Live adapter over a transport

`conformance.test.ts` runs the live adapter over a transport that round-trips the demo adapter's answers as JSON (`transportTestKit.ts`). Every rule has a scenario, with no entry in `gaps`. This proves the front end only. It does not prove the authenticated service; use the actual-service tests below (see also `docs/live-adapter.md`).

## Intentionally unconfigured live target

The stub rejects every call with `INTEGRATION_PENDING`. It passes the `PENDING-*` rules and `IDENT-1`, and the hook-level scope checks that only need a recorded request. The rules that need an answer from a backend are `it.todo` with the reason, 34 of them at the time of writing.

## Shared schema decisions

- The contract's zod schemas are plain `z.object`, so they strip unknown fields instead of rejecting them. The suite parses responses with `deepStrict`, a strict copy of the same schemas, so a backend that adds fields fails. `SCHEMA-3` is an expected failure that records this. Decide whether the contract itself becomes strict, then remove it.
- The save response schema is frozen in `contract.ts` (`saveResourceResponseSchema`, D-14), and the suite parses saves with it rather than a local mirror.
- The demo adapter now refuses an empty idempotency key with `VALIDATION_FAILED`, which `IDEM-1` and `IDEM-4` required.
- `PENDING-4` has a demo scenario: `createDemoAdapter({ writes: "unavailable" })` refuses every action and save as `SOURCE_UNAVAILABLE` with `executionCertainty: notApplied`, before any demo service runs.

## The reference server target

`tools/reference-server/conformance.test.ts` runs the suite against `createLiveAdapter` + `createHttpTransport` over real HTTP to the reference server (a test double). It has a scenario for every rule. `SENT-4` is a registered known failure there, because D-12 makes an uncertain write an error and never a 2xx; `SENT-5` checks the decided behavior. This is reference-server-verified only. It is not integration verification.

## Authenticated service coverage

`dashboardConformance.integration.test.ts` starts `createAgentServer` with real SQLite and sends requests through `createHttpTransport` and `createLiveAdapter`. It exercises all seven analytics variants, actual authorization denials, cancellation, the nightly reconciliation compatibility key, and an immutable override save/replay. All injected source records are explicitly fictional. It does not use the reference server or demo-backed transport.

The integration inventory is grouped by source/schema family. Shared authentication, HTTP-envelope validation, cache isolation and browser clearing are reused; each family still owns its unknown, freshness, version and source-permission behavior.

| Family (registered views) | Actual-service and source tests |
| -- | -- |
| Analytics (9, including independent readiness and traffic owners) | `analyticsReads.integration.test.ts`, `dashboardConformance.integration.test.ts`, `actionReviewHttp.test.ts`, `siteTrafficHttp.test.ts`, `overview-analytics.spec.ts` |
| Approvals and runs (2) | `actionReviewHttp.test.ts`, `approvalExecution.review.test.ts`, runtime API tests, `policy-runtime.spec.ts` |
| Collaboration (2) | collaboration workflow/evidence reader and race tests, `collaboration-workflow.spec.ts`, `collaboration-evidence.spec.ts` |
| Creator channels (4) | `creatorPlatformReader.test.ts` and native recruitment/channel browser journeys |
| Evidence (1) | `server.test.ts` real transport round trip, `evidencePrivacyIntegration.test.ts`, `evidenceWrite.review.test.ts`, `evidence-review.spec.ts` |
| Finance and settlements (8) | `financeReads.integration.test.ts`, settlement HTTP tests, `finance-reads.spec.ts` |
| Lifecycle (4) | `controlsLifecycle.integration.test.ts`, `lifecycleAuthority.review.test.ts`, `lifecycle.spec.ts` |
| Monitor (4) | monitor reader tests and `monitor-evidence.spec.ts` |
| Operations, stock and support (10) | `operationsReads.integration.test.ts`, stock/support crosswalk tests, `stock-support.spec.ts` |
| Recruitment and funnels (6) | `recruitmentHttp.test.ts`, `teamInvitationReads.integration.test.ts`, `bulkHttp.test.ts`, `server.test.ts` and native recruitment journeys |
| Scorecards and offers (3) | `server.test.ts`, commercial offer/source tests and native offer save/reload journeys |
| Settings (7) | operations-control HTTP tests, `controlsLifecycle.integration.test.ts`, `dashboardConformance.integration.test.ts`, `teamInvitationReads.integration.test.ts`, `overnight-operations.spec.ts` |
| Shipping hub (1) | `shippingHubRead.integration.test.ts`, `shipping-hub.spec.ts` |
| Ledger exports (2) | canonical snapshot export tests, settlement HTTP and native export journeys |
| Fulfillment proposal (1) | fulfillment HTTP tests and original-request recovery browser journeys |
| Sourcing plan (1) | `sourcingPlan.integration.test.ts`, `sourcing-plan.spec.ts` |

The six non-dispatching save variants share the wire envelope but keep their domain owners:

| Save variant | Evidence |
| -- | -- |
| Offer `actionDraft` | actual HTTP offer persistence/restart/replay in `server.test.ts` and recruitment browser journeys |
| Invitation `configurationDraft` | `recruitmentHttp.test.ts`: original receipt, exact inner/outer identity, version and caller fences |
| Flow `configurationDraft` | `controlsLifecycle.integration.test.ts` and `lifecycleAuthority.review.test.ts`: allowlisted configuration, current source and caller, transaction fence and uncertain original outcome |
| Schedule `configurationDraft` | schedule repository tests and `overnight-operations.spec.ts`: versioned save/reload, DST and conflict; no activation |
| Observation `evidenceDraft` | evidence review repository tests and `evidence-review.spec.ts`: time-coded annotation, immutable source |
| Disagreement or override `reviewerAssessment` | `evidenceWrite.review.test.ts` and `dashboardConformance.integration.test.ts`: immutable scored run, annotation receipt and replay |

This map describes test ownership, not a claim that an unrun candidate passes. Release evidence must identify the exact commit, successful cloud jobs, original-source visual and actual screen-reader review for changed screens, merged tree, deployment and authenticated hosted readback. A configured synthetic source demonstrates application integration; an unconfigured deployed source remains held. Neither authorizes provider activation, outreach, shipping purchases or spend.
