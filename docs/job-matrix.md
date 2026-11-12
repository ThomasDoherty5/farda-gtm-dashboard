# Agent job coverage matrix

<!-- Generated from src/creator-agent/jobMatrix.ts. Edit the data, then run
     UPDATE_JOB_MATRIX_DOC=1 npx vitest run src/creator-agent/jobMatrix.test.ts -->

This is E2E-01. It maps each agent job, J01 to J21, to its implementing modules, its contract files and the tests for success, failure and recovery. `jobMatrix.test.ts` derives the registered jobs and handlers from the code and scans `server.ts` for action domains. It fails when one has no matrix entry, or when an entry names a missing file or test.

Status: **sandbox** means the job's own service runs its workflow against sandbox fixtures. **partial** means job-specific code exists, but the job's source effects run elsewhere or are unbound. **not-implemented** means nothing job-specific beyond read projections or cross-references. No job is production-authorized.

A name, ticket or owner role appears only where a committed file states it, and that file is cited. Otherwise the value is "not recorded in the repo". Playwright specs under `e2e-agent/` are not mapped yet.

## Keeping the matrix current

The test fails on purpose when a cited file or test title changes, so the matrix cannot drift silently. After renaming or moving a file, or rewording a cited test, update the path or title in `src/creator-agent/jobMatrix.ts` and regenerate this page with the command above. When a new job, handler, domain or job-like literal appears in the code, add it to the matching table in the same file.

The job identity scan reads literal `jobId`, `JOB_ID` and runtime `family` values. A literal that is not J01 to J21 must be listed as a known non-job identity. Computed ids are not literals; they are covered through the handler table.

## Summary

In the coverage columns, *yes* means a cited test exists for this job's code in the repository. For a partial job, that covers only the implemented slice, never the whole job.

| Job | Name | Ticket | Status | Success | Failure | Recovery |
| -- | -- | -- | -- | -- | -- | -- |
| J01 | Creator signup intake and identity resolution | THO-318 | sandbox | yes | yes | yes |
| J02 | not recorded in the repo | not recorded in the repo | sandbox | yes | yes | yes |
| J03 | not recorded in the repo | not recorded in the repo | sandbox | yes | yes | yes |
| J04 | Exact-action approval | THO-321 | sandbox | yes | yes | yes |
| J05 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J06 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J07 | not recorded in the repo | not recorded in the repo | not-implemented | gap | gap | gap |
| J08 | Hourly monitoring | not recorded in the repo | partial | yes | yes | gap |
| J09 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J10 | not recorded in the repo | not recorded in the repo | not-implemented | gap | gap | gap |
| J11 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J12 | not recorded in the repo | not recorded in the repo | not-implemented | gap | gap | gap |
| J13 | Finite bulk orchestration | not recorded in the repo | sandbox | yes | yes | yes |
| J14 | Source health | not recorded in the repo | sandbox | yes | yes | yes |
| J15 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J16 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J17 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J18 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J19 | Daily sourcing | THO-325 | partial | yes | yes | yes |
| J20 | not recorded in the repo | not recorded in the repo | partial | yes | yes | yes |
| J21 | not recorded in the repo | not recorded in the repo | not-implemented | gap | gap | gap |

## J01

| Field | Value |
| -- | -- |
| Name | Creator signup intake and identity resolution (`src/creator-agent/intake/contract.ts`) |
| Ticket | THO-318 (`src/creator-agent/intake/contract.ts`) |
| Owner role | not recorded in the repo |
| Status | sandbox |
| Modules | `src/creator-agent/intake/repository.ts`<br>`src/creator-agent/intake/routes.ts`<br>`src/creator-agent/intake/handoff.ts` |
| Related modules | `src/creator-agent/monitor/contract.ts` |
| Contracts | `src/creator-agent/intake/contract.ts` |
| Declared in code | `src/creator-agent/intake/contract.ts` |
| Success tests | `intake/intake.test.ts`: resolves a signup and an earlier discovery hit into one creator with separate profiles and campaign relationships |
| Failure tests | `intake/intake.test.ts`: rejects missing keys, a fabricated address and a profile on the wrong network before anything is written<br>`intake/intake.test.ts`: pauses a denied or unverified source, keeps its cursor and writes nothing |
| Recovery tests | `intake/intake.test.ts`: recovers a crash between the two writes on replay without a second person or a second Notion write<br>`intake/intake.test.ts`: recovers a previously accepted sink write after a real SQLite close/reopen, with one canonical creator |
| Notes | No qualified production Notion or Sheets writer is bound (intake/README.md, release boundary). |

## J02

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | sandbox |
| Modules | `src/creator-agent/policy.ts`<br>`src/creator-agent/evidence.ts`<br>`src/creator-agent/routeEvidence.ts`<br>`src/creator-agent/ratingPolicy.ts`<br>`src/creator-agent/config.ts` |
| Related modules | `src/creator-agent/scorecardPreview.ts`<br>`src/creator-agent/configurations/website-affiliate-v3.2026-11-04.json`<br>`src/creator-agent/configurations/tiktok-shop-affiliate-v3.2026-11-04.json` |
| Contracts | `src/creator-agent/assessmentSchema.ts`<br>`src/creator-agent/evidence.ts` |
| Declared in code | none |
| Success tests | `policy.test.ts`: requires three independent complete posts on two dates with two meaningful use examples<br>`approvedBaseline.test.ts`: loads exactly the two approved vectors, original bands and explicit phase rules |
| Failure tests | `policy.test.ts`: cannot compensate for a critical failure with a high weighted total<br>`server.test.ts`: rejects stale policy/configuration and forged input before persistence |
| Recovery tests | `server.test.ts`: persists a real assessment in SQLite and preserves it across restart<br>`server.test.ts`: replays an identical idempotency key and refuses a changed payload without overwriting history |
| QA31-02/03 | `src/creator-agent/policy.test.ts`<br>`src/creator-agent/approvedBaseline.test.ts` |
| Notes | policy.ts describes itself as the deterministic J02 decision. J02 has no registered job identity in code; scoring runs through the agent HTTP service. |

## J03

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | sandbox |
| Modules | `src/creator-agent/offers/job.ts`<br>`src/creator-agent/offers/repository.ts`<br>`src/creator-agent/offers/economics.ts`<br>`src/creator-agent/offers/policy.ts`<br>`src/creator-agent/offers/validation.ts`<br>`src/creator-agent/offers/routes.ts` |
| Related modules | `src/creator-agent/commercialPolicy/evaluate.ts` |
| Contracts | `src/creator-agent/offers/job.ts`<br>`src/creator-agent/offers/contract.ts` |
| Declared in code | `src/creator-agent/offers/job.ts` |
| Success tests | `offers/offers.test.ts`: processes a reviewer-authorized J03 proposal envelope once and binds it to scope, input and deadline |
| Failure tests | `offers/policy.test.ts`: keeps proposed and missing policy explicit, even with a high score and provider facts |
| Recovery tests | `offers/saveRecovery.test.ts`: reads the exact recorded original after a later revision without claiming current acceptance<br>`offers/offers.test.ts`: preserves proposals over restart, rejects fees, conflicts and unauthorized source decisions |
| Notes | offers/job.ts declares the J03 proposal envelope. Propose mode only: no invitation, reservation, funding or activation (offers/README.md). |

## J04

| Field | Value |
| -- | -- |
| Name | Exact-action approval (`docs/adapter-backend-requirements.md`) |
| Ticket | THO-321 (`docs/adapter-backend-requirements.md`) |
| Owner role | backend owner (`docs/adapter-backend-requirements.md`) |
| Status | sandbox |
| Modules | `src/creator-agent/approvals/repository.ts`<br>`src/creator-agent/approvals/authority.ts`<br>`src/creator-agent/approvals/policy.ts`<br>`src/creator-agent/actions/service.ts`<br>`src/creator-agent/actions/registration.ts`<br>`src/creator-agent/actionFoundation.ts`<br>`src/creator-agent/actionDomains.ts`<br>`src/creator-agent/jobs/dispatchGuard.ts` |
| Related modules | `src/creator-agent/commercialPolicy/approvalGuard.ts` |
| Contracts | `src/creator-agent/approvals/contract.ts`<br>`src/creator-agent/actions/contract.ts`<br>`src/creator-agent/jobs/dispatchSchema.ts` |
| Declared in code | none |
| Success tests | `approvals/repository.test.ts`: completes preview, Linear request, verified second-person Slack decision, Linear readback and dispatch proof without a provider action<br>`jobs/dispatchGuard.test.ts`: executes exact approved local artifact once and returns actual receipt on replay |
| Failure tests | `approvals/repository.test.ts`: rejects a same-person decision despite a distinct principal and rejects forged source identity<br>`approvals/repository.test.ts`: does not authorize forged proofs, foreign scope or changed per-item payload/bounds |
| Recovery tests | `approvals/repository.test.ts`: recovers an applied but lost Linear response by exact readback without another write<br>`jobs/dispatchGuard.test.ts`: expired started work survives restart as reconcile and never blindly retries |
| Notes | Every action domain composes behind J04 (actionDomains.ts). No production Slack or Linear decision write is configured (actions/README.md). |

## J05

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/recruitment/service.ts`<br>`src/creator-agent/recruitment/proposalBridge.ts`<br>`src/creator-agent/recruitment/drafts.ts` |
| Related modules | `src/creator-agent/recruitment/source.ts`<br>`src/creator-agent/commercialPolicy/recruitment.ts` |
| Contracts | `src/creator-agent/recruitment/contract.ts` |
| Declared in code | none |
| Success tests | `recruitment/service.test.ts`: records the exact public selection and raw target/payload once, without acceptance or dispatch |
| Failure tests | `recruitment/service.test.ts`: rejects foreign manifest membership and permission denial browser fallback |
| Recovery tests | `recruitment/service.test.ts`: recovers only the original preview after newer draft, offer and source revisions without preparing or sending<br>`recruitmentHttp.test.ts`: withholds a postcommit acknowledgment after caller revocation and recovers the immutable original without a second save |
| Notes | Inferred mapping: portfolioStore.ts hands approved creators to J05/J06, and the recruitment workspace prepares those invitations through J04. The repo does not say how the work splits between J05 and J06, so both list the same module and shared tests. The native invitation handler is injected; it is not in this repository. |

## J06

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/recruitment/service.ts`<br>`src/creator-agent/recruitment/proposalBridge.ts`<br>`src/creator-agent/recruitment/drafts.ts` |
| Related modules | `src/creator-agent/recruitment/source.ts`<br>`src/creator-agent/commercialPolicy/recruitment.ts` |
| Contracts | `src/creator-agent/recruitment/contract.ts` |
| Declared in code | none |
| Success tests | `recruitment/service.test.ts`: records the exact public selection and raw target/payload once, without acceptance or dispatch |
| Failure tests | `recruitment/service.test.ts`: preserves explicit 16022020 owner handoff after a deadline and permits another browser route only with independent capability |
| Recovery tests | `recruitment/service.test.ts`: recovers only the original preview after newer draft, offer and source revisions without preparing or sending |
| Notes | Inferred mapping, shared with J05 (see J05). The native invitation handler is injected; it is not in this repository. |

## J07

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | not-implemented |
| Modules | not implemented |
| Related modules | `src/creator-agent/offers/repository.ts`<br>`src/creator-agent/portfolioStore.ts`<br>`src/creator-agent/bulk/contract.ts` |
| Contracts | none |
| Declared in code | none |
| Success tests | **gap**: No J07 module. |
| Failure tests | **gap**: No J07 module. |
| Recovery tests | **gap**: No J07 module. |
| Notes | Only cross-references: accepted offers with a requested sample record a J07/J15 handoff (offers/repository.ts), and portfolioStore.ts lists J07 as a later step. J13 batches carry separate sampleDecision groups. |

## J08

| Field | Value |
| -- | -- |
| Name | Hourly monitoring (`docs/monitor-views.md`) |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/jobs/runtime.ts`<br>`src/creator-agent/jobs/runtimeCadence.ts` |
| Related modules | `src/creator-agent/monitor/reader.ts`<br>`src/creator-agent/monitor/posts.ts` |
| Contracts | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/monitor/contract.ts` |
| Declared in code | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/jobs/runtimeViews.ts` |
| Success tests | `jobs/runtime.test.ts`: hourly enrolled monitoring preserves both real fall-back hours, unlike daily discovery |
| Failure tests | `jobs/runtime.test.ts`: hourly J08 has a separate queue and rejects loss of enrolled membership during a read |
| Recovery tests | **gap**: No test exercises J08-family recovery. The shared runtime recovery tests use the synthetic J19 registration. |
| Notes | The shared runtime accepts an hourly enrolled-only J08 family; the monitoring executor is injected. docs/monitor-views.md: the launcher supplies no live J08 source. Monitor reader tests cover the read projection, not J08. |

## J09

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/collaborationWorkflow.ts` |
| Related modules | `src/creator-agent/notionCollaboration.ts`<br>`src/creator-agent/collaborationEvidenceReader.ts`<br>`src/creator-agent/assets.ts`<br>`src/creator-agent/assetStore.ts` |
| Contracts | `src/creator-agent/collaborationWorkflowSchema.ts` |
| Declared in code | none |
| Success tests | `collaborationWorkflow.test.ts`: persists an immutable approval proposal across restarts, private routing, retries, concurrent versions and changed native facts |
| Failure tests | `reviewCollaborationIntegration.test.ts`: keeps reminders held when the posting obligation or suppression clearance is unknown |
| Recovery tests | `collaborationWorkflow.test.ts`: preserves one original proposal receipt after postcommit revocation<br>`reviewCollaborationIntegration.test.ts`: does not acknowledge a lost request from an independently submitted identical proposal |
| Notes | Inferred mapping: the collaboration workflow does not name J09; it reads current J09 rights observations (docs/collaboration-workflow.md), as the asset modules do. Local review and reminder proposals only; nothing is sent. |

## J10

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | not-implemented |
| Modules | not implemented |
| Related modules | none |
| Contracts | none |
| Declared in code | none |
| Success tests | **gap**: No J10 module. |
| Failure tests | **gap**: No J10 module. |
| Recovery tests | **gap**: No J10 module. |
| Notes | No committed file references J10. |

## J11

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/settlements/proposalBridge.ts` |
| Related modules | `src/creator-agent/settlements/source.ts`<br>`src/creator-agent/settlements/reader.ts`<br>`src/creator-agent/rewards/approvalBridge.ts`<br>`src/creator-agent/commercialPolicy/authority.ts` |
| Contracts | `src/creator-agent/settlements/contract.ts` |
| Declared in code | none |
| Success tests | `settlements/proposalBridge.test.ts`: persists exact statement selection in the actual canonical J04 request; neither paid nor reconciled |
| Failure tests | `settlements/proposalBridge.test.ts`: refuses candidate conflicts and source version drift before creating an approval |
| Recovery tests | `settlements/proposalBridge.test.ts`: reconstructs owner observations from the canonical manifest after bridge restart without changing its identity |
| Notes | Statement matching is prepared through J04 with an injected J11 owner; the default executor is unbound (J11_RECONCILIATION_UNBOUND). J11 owns the earned entitlement (rewards/README.md); no entitlement source exists here. |

## J12

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | not-implemented |
| Modules | not implemented |
| Related modules | `src/creator-agent/settlements/source.ts`<br>`src/creator-agent/settlements/reader.ts` |
| Contracts | none |
| Declared in code | none |
| Success tests | **gap**: No J12 module. |
| Failure tests | **gap**: No J12 module. |
| Recovery tests | **gap**: No J12 module. |
| Notes | Settlement reads project existing J11/J12 source records only. Execution is unbound (J12_EXECUTION_UNBOUND in settlements/contract.ts). |

## J13

| Field | Value |
| -- | -- |
| Name | Finite bulk orchestration (`docs/bulk-orchestration.md`) |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | sandbox |
| Modules | `src/creator-agent/bulk/service.ts`<br>`src/creator-agent/bulk/material.ts`<br>`src/creator-agent/bulk/projection.ts`<br>`src/creator-agent/bulk/views.ts`<br>`src/creator-agent/bulkRuntime.ts` |
| Related modules | none |
| Contracts | `src/creator-agent/bulk/contract.ts`<br>`src/creator-agent/jobs/runtimeSchema.ts` |
| Declared in code | `src/creator-agent/bulk/contract.ts`<br>`src/creator-agent/bulkRuntime.ts` |
| Success tests | `bulk/service.test.ts`: keeps24 recipients,12 separate approved25USD samples and12 no-new-sample rows through actual J04/run receipts<br>`bulkRuntime.test.ts`: J13 executes exact canonical approvals through the registered durable runtime; retries and restart keep original per-row actions |
| Failure tests | `bulk/service.test.ts`: rejects all membership, version, economics and product-version mutations without rebasing the old proposal<br>`bulk/service.test.ts`: denial during owner await and a final transactional revocation produce no manifest or effects |
| Recovery tests | `bulkRecovery.test.ts`: source confirmation reconciles the original uncertain sample receipt without a second invocation<br>`bulk/service.test.ts`: keeps expired batch receipts and original uncertain recovery readable under current source permission |
| Notes | Per-item provider handlers are owned by the action domains; createBulkRuntimeRegistration enables no trigger. |

## J14

| Field | Value |
| -- | -- |
| Name | Source health (`docs/operations-controls.md`) |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | sandbox |
| Modules | `src/creator-agent/providerHealth.ts`<br>`src/creator-agent/operations.ts` |
| Related modules | `src/creator-agent/connections/ledger.ts`<br>`src/creator-agent/operationsControls.ts` |
| Contracts | `src/creator-agent/providerHealthSchema.ts` |
| Declared in code | `src/creator-agent/providerHealth.ts` |
| Success tests | `providerHealth.test.ts`: binds a native observation to its saved action, persists a checkpoint, and replays once across request keys<br>`operationsControls.health.test.ts`: observes exactly once through native HTTP and returns actual J14 receipt, keeping business authority separate |
| Failure tests | `providerHealth.test.ts`: enforces a ledger revocation on the same action before any new health observation<br>`operationsControls.health.test.ts`: holds unconfigured and subsequently denied bindings without a provider observation |
| Recovery tests | `providerHealth.test.ts`: deduplicates failure across restart, keeps past native success and requires fresh permitted recovery<br>`providerHealthIntegration.test.ts`: observes, owns a deduplicated failure, recovers from fresh evidence and replays without bypassing expiry |
| Notes | Read-only provider health probes registered as j14-<capability> jobs. Configuration alone does not activate J14 (operations.md). |

## J15

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/stockSupport.ts`<br>`src/creator-agent/fulfillmentDomain/service.ts` |
| Related modules | `src/creator-agent/notionStockSupportSource.ts`<br>`src/creator-agent/shippingHubRead.ts`<br>`src/creator-agent/operationsReads/reader.ts` |
| Contracts | `src/creator-agent/stockSupportSchema.ts`<br>`src/creator-agent/fulfillmentDomain/contract.ts` |
| Declared in code | none |
| Success tests | `stockSupport.test.ts`: commits one local receipt across racing submissions; exact scoped lookup and rejected stale nonce survive retries<br>`fulfillmentDomain/service.test.ts`: binds a replacement to its new keys, exact stock, home and spend without reserving or shipping |
| Failure tests | `stockSupport.test.ts`: rejects shortages, incomplete receipts and conflicting or unknown balances without making a second stock ledger |
| Recovery tests | `stockSupport.test.ts`: keeps the exact original receipt when authority is revoked after the actual commit |
| Notes | Local stock-transfer review requests and J04 proposal translation only. J15 owns movements, reservations and physical writes outside this repository (docs/stock-support-workspaces.md). |

## J16

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/fulfillmentDomain/service.ts`<br>`src/creator-agent/stockSupport.ts` |
| Related modules | `src/creator-agent/notionStockSupportSource.ts`<br>`src/creator-agent/operationsReads/reader.ts` |
| Contracts | `src/creator-agent/fulfillmentDomain/contract.ts`<br>`src/creator-agent/stockSupportSchema.ts` |
| Declared in code | none |
| Success tests | `stockSupport.test.ts`: keeps 7 all-time and 6 cohort-open apart, rejects private fields and submits only an allowed case review |
| Failure tests | `fulfillmentDomain/service.test.ts`: rejects over-refund, mixed remedies, missing inspection and excess/unsafe restock quantity |
| Recovery tests | `fulfillmentDomain/service.test.ts`: keeps an uncertain original proposal across restart and blocks a fresh-key bypass<br>`fulfillmentIntegration.test.ts`: preserves original uncertainty, fails closed on revocation and refuses a new-key recovery bypass |
| Notes | Refund or replacement decisions are translated into J04 proposals; support handoffs are local review requests. J16 owns conversations, returns, refunds and replacements outside this repository (docs/stock-support-workspaces.md). |

## J17

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/lifecycle/repository.ts` |
| Related modules | `src/creator-agent/lifecycle/source.ts` |
| Contracts | `src/creator-agent/lifecycle/contract.ts` |
| Declared in code | none |
| Success tests | `controlsLifecycle.integration.test.ts`: persists each allowlisted flow once and returns the exact immutable request receipt without changing the source |
| Failure tests | `lifecycle/repository.test.ts`: rejects reader writes, setup edits, foreign catalog selectors and altered timezone |
| Recovery tests | `lifecycleAuthority.review.test.ts`: suppresses a postcommit success after token rotation and recovers only the original immutable receipt under current authorization |
| Notes | Local flow configuration drafts and read projections only. enableFlow is held with J17_PROVIDER_EXECUTION_NOT_CONNECTED; J17 owns enrollments, consent and sends (lifecycle/repository.ts). |

## J18

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/actions/domainServices.ts` |
| Related modules | `src/creator-agent/analytics/reader.ts`<br>`src/creator-agent/finance/reader.ts`<br>`src/creator-agent/monitor/reader.ts` |
| Contracts | `src/creator-agent/actions/wire.ts` |
| Declared in code | none |
| Success tests | `actions/domainServices.test.ts`: requires exact Notion ACK and readback; receipt replay is historical and never writes twice |
| Failure tests | `actions/domainServices.test.ts`: rejects forged role/release/gates and non-founders without source writes |
| Recovery tests | `actions/readinessRecovery.test.ts`: can recover pending original intent and reconcile lost ACK without another source write<br>`actions/domainServices.test.ts`: SQLite reopen keeps an unknown request fenced and recovers its original source receipt |
| Notes | Launch readiness recording only, which is not release authority (actions/domainServices.test.ts); no qualified Notion readiness writer is configured. The launch Go/Revise/Hold decision belongs to J18 (docs/adapter-backend-requirements.md). Analytics, finance and monitor reads are projections. |

## J19

| Field | Value |
| -- | -- |
| Name | Daily sourcing (`src/creator-agent/sourcing/source.ts`) |
| Ticket | THO-325 (`src/creator-agent/sourcing/source.ts`) |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/jobs/runtime.ts`<br>`src/creator-agent/jobs/runtimeCadence.ts`<br>`src/creator-agent/jobs/runtimeExecutors.ts` |
| Related modules | `src/creator-agent/sourcing/reader.ts`<br>`src/creator-agent/sourcing/nativeReader.ts`<br>`src/creator-agent/sourcing/source.ts` |
| Contracts | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/sourcing/contract.ts` |
| Declared in code | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/jobs/runtimeViews.ts` |
| Success tests | `jobs/runtime.test.ts`: runs a real bounded HTTP read after canonical fire and records measured calls without invented paid cost |
| Failure tests | `jobs/runtime.test.ts`: holds unknown authority, quota and policy changes before a transport call |
| Recovery tests | `jobs/runtime.test.ts`: persists page checkpoint before safe-read retry and resumes after a new runtime instance<br>`jobs/runtime.test.ts`: worker expiry permits bounded safe-read recovery but the late worker cannot overwrite the result |
| Notes | The runtime tests use a synthetic J19 registration with synthetic executors; no discovery executor or live source exists here. The sourcing plan is a read-only projection of the J19 service. |

## J20

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | partial |
| Modules | `src/creator-agent/jobs/runtime.ts`<br>`src/creator-agent/evidenceReviewStore.ts` |
| Related modules | none |
| Contracts | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/evidenceReviewContract.ts` |
| Declared in code | `src/creator-agent/jobs/runtimeSchema.ts`<br>`src/creator-agent/jobs/runtimeViews.ts` |
| Success tests | `reviewSprintIntegration.test.ts`: acknowledges one immutable local annotation, rejects changed replay and preserves the original J20 packet |
| Failure tests | `reviewSprintIntegration.test.ts`: enforces reader denial, exact workspace and payload/resource kind at the authenticated route |
| Recovery tests | `evidenceReviewStore.test.ts`: binds annotations to their source and historical revisions across restart, with safe retries and no changed source assessment |
| Notes | Reviewer annotations beside the immutable J20 packet (evidenceReviewStore.ts). The runtime accepts a daily J20 family, but no test registers one and no review executor exists here. |

## J21

| Field | Value |
| -- | -- |
| Name | not recorded in the repo |
| Ticket | not recorded in the repo |
| Owner role | not recorded in the repo |
| Status | not-implemented |
| Modules | not implemented |
| Related modules | none |
| Contracts | none |
| Declared in code | none |
| Success tests | **gap**: No J21 module. |
| Failure tests | **gap**: No J21 module. |
| Recovery tests | **gap**: No J21 module. |
| Notes | No committed file references J21. |

## Registered handlers

| Handler | Jobs | Modules | Note |
| -- | -- | -- | -- |
| `record-reference.v1` | unknown | `src/creator-agent/jobs/schema.ts`<br>`src/creator-agent/operations.ts` | Shared local no-source job foundation (jobs/README.md). |
| `draft-reference.v1` | unknown | `src/creator-agent/jobs/schema.ts`<br>`src/creator-agent/operations.ts` | Shared local no-source job foundation (jobs/README.md). |
| `probe-provider-health.v1` | J14 | `src/creator-agent/providerHealth.ts` | Bounded read-only provider health probe. |
| `dispatch-approved.v1` | J04, J13 | `src/creator-agent/jobs/dispatchGuard.ts`<br>`src/creator-agent/bulkRuntime.ts` | Exact approved manifest dispatch. |
| `export-ledger-snapshot.v1` | unknown | `src/creator-agent/actions/domainServices.ts` | Canonical ledger export. Unknown owner: no job id in code or docs. |
| `registered-source.v1` | J08, J19, J20 | `src/creator-agent/jobs/runtime.ts` | Registered source runtime families. |
| `deliver-report.v1` | unknown | `src/creator-agent/slackReporting/service.ts` | Operational report delivery. Unknown owner: no job id in code or docs. |

## Action domains composed in `server.ts`

| Domain | Module | Jobs | Note |
| -- | -- | -- | -- |
| `rewardDomain` | `src/creator-agent/rewards/approvalBridge.ts` | unknown | Reward redemption consumes J04, J11, J15 and J16 but is not assigned to a job. |
| `mediaDomain` | `src/creator-agent/mediaComposition.ts` | unknown | Paid media consumes J04 but is not assigned to a job. |
| `operationsBridge.domain` | `src/creator-agent/operationsControlBridge.ts` | unknown | Operations controls consume J04 but are not assigned to a job. |
| `settlementDomain` | `src/creator-agent/settlements/proposalBridge.ts` | J11 | Statement matching proposals. |
| `fulfillment.domain` | `src/creator-agent/fulfillmentDomain/service.ts` | J15, J16 | Fulfillment decision proposals. |
| `recruitmentWorkspace.domain` | `src/creator-agent/recruitment/proposalBridge.ts` | J05, J06 | Invitation proposals. |
| `bulkWorkspace.domain` | `src/creator-agent/bulk/service.ts` | J13 | Finite batch proposals. |

## Known non-job identities

| Literal | File | Reason |
| -- | -- | -- |
| `registered-business` | `src/creator-agent/jobs/runtimeSchema.ts` | Runtime family for event-driven business registrations, such as J13. |
| `synthetic-controls-job` | `src/creator-agent/operationsControlsFixtures.ts` | Synthetic fixture for operations-control tests. |
