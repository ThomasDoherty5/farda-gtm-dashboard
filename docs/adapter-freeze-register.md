# Adapter freeze register

Every view key, action kind, resource kind, operation and error code the front end assumes today, in one place, so the THO-283 owner can freeze the adapter contract in one pass.

- **Stage: fixture-complete.** Everything here is read from the code on `main` (commit `2f0c24d`) and from open PRs #22 to #39. Nothing is integration-verified or production-authorized. THO-283 has not published a transport, so `src/adapter/contract.ts` is proposed and every item below is a proposal until it freezes.
- **No backend URLs, hosts or paths are proposed here.** `VITE_FARDA_ADAPTER_BASE_URL` stays reserved (docs/intake.md).
- **Nothing here is copied from Linear or Figma.** Names, shapes and codes come from the source files named in each row.

## How to read the status column

| Status | Meaning |
| -- | -- |
| `contract` | Defined in `src/adapter/contract.ts` (or, for error codes, in the code-to-category table in `src/adapter/errors.ts`). |
| `proposed` | Introduced by a screen or by the demo adapter. The contract has only `string` where it would go (`viewKey: string`, `actionKind: string`), so no screen can be wrong yet, and none is confirmed. |
| `conflict` | Two or more screens, or a screen and the demo adapter, disagree. The conflict IDs (C-nn) are explained in [Conflicts](#conflicts-between-screens). |

The register tables are checked against the source by `npm run test` (`src/adapter/freezeRegister.test.ts`, backed by `scripts/adapter-freeze-extract.mjs`). See [Keeping the register honest](#keeping-the-register-honest). The [Pending in open PRs](#pending-in-open-prs) section is outside that check.

## What `contract.ts` defines

| Area | Defined values |
| -- | -- |
| Operations (`ActionOperation`) | `previewAction`, `requestApproval`, `decideApproval`, `dispatchApprovedAction`, `inspectRun`, `reconcileRun`, `controlRun`. Reads use `readView`, saves use `saveResource`. |
| Resource kinds (`SaveResourceRequest`) | `actionDraft`, `reviewerAssessment`, `evidenceDraft`, `configurationDraft` |
| Action state (`ActionResponse.state`) | `draft`, `approvalPending`, `queued`, `blocked`, `running`, `succeeded`, `partiallySucceeded`, `failed`, `outcomeUncertain`, `reconciling`, `paused`, `canceled` |
| Data state (`ReadResponse.dataState`) | `ready`, `empty`, `partial`, `stale`, `unavailable` |
| Capability state | `available`, `unverified`, `unsupported`, `denied`, `held` |
| Value state | `known`, `unknown`, `notApplicable` |
| Not defined | View keys, action kinds, filters per view, payloads per action, reason codes, `nextAction.kind` values, `executionCertainty` values, run reference on `controlRun` / `reconcileRun`, an "approved" action state, a not-found error code. Each is a proposal below. |

## Operations

Which `operation` values screens send. The demo adapter routes `submitAction` by `actionKind` first (settings, ops, finance, monitor, collaboration, batch), then falls through to a router in `demoApprovals.ts` that switches on `operation`.

| Operation | Status | Sent by | Handled by demo | Note |
| -- | -- | -- | -- | -- |
| `previewAction` | contract | no screen | no | No screen sends a preview. docs/design-map.md (row on batch pause and cancel) says those commands go "with a preview", and another row says the preview intent waits for THO-283. See C-13. |
| `requestApproval` | contract + conflict | collaboration, finance, inventory, operations (2), settings | no router on `operation`; each `actionKind` has its own handler | Used for twelve action kinds from six pages. Answers differ (C-02). |
| `decideApproval` | contract | `approvals/ApprovalPage` | `demoApprovals` | `actionKind` equals the operation name. |
| `dispatchApprovedAction` | contract | `approvals/ApprovalPage` | `demoApprovals` | `actionKind` equals the operation name. |
| `inspectRun` | contract | no screen | no | Runs are read as the `runDetail` view (C-14). `ActionRequest.operation` excludes it by type. |
| `reconcileRun` | contract + conflict | `approvals/RunPage` | `demoApprovals` | `actionKind` is the request name (C-03). |
| `controlRun` | contract + conflict | `approvals/RunPage`, `monitor/HourlyRunPage`, `recruitment/BatchPage` | `demoApprovals` (run pause), `demoMonitor`, `demoBatch` | Three unrelated payload shapes (C-01). |

## View keys

Request shape sent by `useView`: `requestedScope`, `filters`, `period` (always `null` from every screen), `sort` (always `[]`), `page` (always `{ cursor: null, limit: 50 }`). The data type is the `T` in `ReadResponse<T>` named at the call site; most live in `src/fixtures/`.

| View key | Filters sent | Response data type | Read by (screen, under `src/features/`) | Demo handler (under `src/adapter/`) | Status | Note |
| -- | -- | -- | -- | -- | -- | -- |
| `activationRetention` | none | ActivationData | `lifecycle/ActivationPage` | `demoLifecycle` | proposed |  |
| `approvalDetail` | `approvalId` | ApprovalDetail | `approvals/ApprovalPage` | `demoAdapter` | proposed | Shape in `features/approvals/types.ts`, marked PROPOSED (THO-283, THO-321). Demo id `demo-approval-forbidden` answers `FORBIDDEN`. |
| `assessmentRecord` | `creatorId`, `assessmentId` | AssessmentData | `scorecards/AssessmentPage` | `demoAdapter` | proposed |  |
| `attribution` | none | AttributionData | `analytics/AttributionPage` | `demoAnalytics` | proposed |  |
| `automationRuns` | none | AutomationData | `settings/AutomationsPage` | `demoSettings` | proposed |  |
| `batchDetail` | `batchId`, `source`, `deal`, `owner` | BatchData | `recruitment/BatchPage` | `demoAdapter` | proposed + conflict | C-05. Uses `keepPrevious`. Demo refuses unknown values. |
| `campaignFunnel` | `campaignId`, `cohort` | CampaignFunnelData | `analytics/CampaignFunnelPage` | `demoAnalytics` | proposed + conflict | C-05. |
| `channelCapabilities` | none | CapabilityData | `settings/CapabilitiesPage` | `demoSettings` | proposed |  |
| `collaborationDetail` | `collaborationId` | CollaborationData | `collaboration/CollaborationPage` | `demoAdapter` | proposed |  |
| `commissionLedger` | `scenario?` | CommissionLedger | `finance/CommissionLedgerPage` | `demoFinance` | proposed + conflict | C-06. |
| `connectionsOverview` | none | ConnectionsData | `settings/ConnectionsPage` | `demoSettings` | proposed |  |
| `consentEligibility` | none | ConsentData | `lifecycle/ConsentPage` | `demoLifecycle` | proposed |  |
| `contentMonitor` | `source`, `network`, `window`, `q` | ContentMonitorData | `monitor/MonitorPage` | `demoMonitor` | proposed + conflict | C-05, C-16. Uses `keepPrevious`. |
| `customerJourney` | none | CustomerJourneyData | `analytics/CustomerJourneyPage` | `demoAnalytics` | proposed |  |
| `discoverySummary` | none | DiscoveryData | `acquisition/DiscoveryPage` | `demoAdapter` | proposed |  |
| `emailFlow` | `flow` | EmailFlowData | `lifecycle/EmailFlowPage`, `lifecycle/SetupFlowPage` | `demoLifecycle` | proposed | Read by two pages. Allowed: `setup`, `early-access`, `abandoned-checkout`, `review-request`. |
| `evidenceRecord` | `creatorId`, `evidenceId` | EvidenceRecord | `acquisition/EvidencePage` | `demoAdapter` | proposed + conflict | C-07. Shape in `features/acquisition/evidenceTypes.ts`, marked PROPOSED (THO-283, THO-326). |
| `financeDashboard` | `scenario?` | FinanceDashboard | `finance/FinanceAnalyticsPage`, `finance/FinanceDashboardPage` | `demoFinance` | proposed + conflict | C-06. Read by two pages. |
| `fulfillmentAnalytics` | `days` (7 or 14) | FulfillmentAnalytics | `operations/FulfillmentAnalyticsPage` | `demoOps` | proposed + conflict | C-05 (period as `days`). Demo answers `VALIDATION_FAILED` for other values. |
| `hourlyRun` | `runId` | HourlyRunData | `monitor/HourlyRunPage` | `demoMonitor` | proposed |  |
| `inventoryOverview` | `scenario?` | InventoryOverview | `inventory/InventoryPage` | `demoOps` | proposed + conflict | C-06. |
| `invitationDraft` | none | InvitationData | `recruitment/InvitationPage` | `demoAdapter` | proposed |  |
| `launchControl` | none | LaunchControlData | `analytics/LaunchControlPage` | `demoAnalytics` | proposed |  |
| `launchReconciliation` | none | ReconciliationData | `analytics/ReconciliationPage` | `demoAnalytics` | proposed | Not a Figma source (`/launch?view=reconciliation`); see `docs/additions-analytics.md`. Matrix cells carry exact values (cents for money). |
| `launchSnapshot` | none | LaunchSnapshotData | `analytics/LaunchSnapshotPage` | `demoAnalytics` | proposed |  |
| `lifecycleOverview` | none | LifecycleData | `lifecycle/LifecyclePage` | `demoLifecycle` | proposed |  |
| `metricDictionary` | none | MetricDictionaryData | `analytics/AttributionPage` | `demoAnalytics` | proposed | Versioned headline-metric dictionary, cost buckets and hand-checked cases. Read by the definitions dialog. |
| `offerDraft` | `offerId` | OfferDraftRecord | `scorecards/OfferPage` | `demoAdapter` | proposed |  |
| `operationsOverview` | `scenario?` | OperationsOverview | `operations/OperationsPage` | `demoOps` | proposed + conflict | C-06. |
| `opsHealth` | none | OpsHealth | `operations/OpsHealthPage` (route `/analytics/fulfillment?view=health`) | `demoOps` | proposed | No Figma source. Derived in `adapter/opsHealth.ts` from the shipment ledger. |
| `orderDetail` | `orderId` | OrderDetail | `operations/OrderPage` | `demoOps` | proposed |  |
| `overviewSummary` | none | OverviewData | `overview/OverviewPage` | `demoAdapter` | proposed | Nine demo fixture switches are chosen by an adapter option, not by the request. |
| `paidMedia` | `rights`, `platform` | PaidMediaData | `analytics/PaidMediaPage` | `demoAnalytics` | proposed | Uses `keepPrevious`. |
| `payableDetail` | `payableId` | PayableDetail | `finance/PayablePage` | `demoFinance` | proposed |  |
| `periodClose` | `period`, `scenario?` | PeriodClose | `finance/CloseReconciliationPage` | `demoFinance` | proposed + conflict | C-05 (period is a filter, `period` request field is `null`), C-06. |
| `pipelineSummary` | `source`, `network`, `checkout`, `window` | PipelineData | `acquisition/PipelinePage` | `demoAdapter` | proposed + conflict | C-05. Demo refuses unknown facet values with `VALIDATION_FAILED`. |
| `postPerformance` | `postId` | PostPerformanceData | `monitor/PostPage` | `demoMonitor` | proposed |  |
| `recruitmentQueue` | `networks`, `route` | RecruitmentData | `recruitment/RecruitmentPage` | `demoAdapter` | proposed + conflict | C-05. Uses `keepPrevious`. Demo refuses unknown facet values. |
| `returnDetail` | `returnId`, `scenario?` | ReturnDetail | `operations/ReturnPage` | `demoOps` | proposed + conflict | C-06, C-07. |
| `runDetail` | `runId` | RunDetail | `approvals/RunPage` | `demoAdapter` | proposed + conflict | Same PROPOSED shapes. The contract's `inspectRun` operation is not used; runs are read as a view (C-14). |
| `scheduleDetail` | `jobId` | ScheduleData | `settings/SchedulePage` | `demoSettings` | proposed |  |
| `settlementDetail` | `settlementId` | SettlementRecord | `finance/SettlementPage` | `demoFinance` | proposed |  |
| `shippingException` | `shipmentId`, `exceptionId` | ShippingExceptionDetail | `operations/ShippingExceptionPage` | `demoOps` | proposed + conflict | C-07. |
| `socialCatBoard` | `owner` | SocialCatBoardData | `creators/SocialCatPage` | `demoCreators` | proposed | Uses `keepPrevious`. Demo refuses unknown owners. |
| `socialCatDashboard` | `network` | SocialCatDashboardData | `creators/SocialCatPage` | `demoCreators` | proposed + conflict | C-05. Uses `keepPrevious`. |
| `supportWorkspace` | `caseId`, `scenario?` | SupportWorkspace | `support/SupportPage` | `demoOps` | proposed + conflict | C-06. |
| `teamPermissions` | none | TeamData | `settings/TeamPage` | `demoSettings` | proposed |  |
| `tiktokBoard` | `q` | TikTokBoardData | `creators/TikTokPage` | `demoCreators` | proposed + conflict | C-16. Uses `keepPrevious`. |
| `tiktokDashboard` | none | TikTokDashboardData | `creators/TikTokPage` | `demoCreators` | proposed |  |
| `watchlist` | `source`, `state`, `cohort` | WatchlistData | `monitor/WatchlistPage` | `demoMonitor` | proposed + conflict | C-05. The page maps its `only-launch-a` choice to `launch-a`, otherwise `all`. |

## Action kinds

Sent by a screen through `useAction`. Payload shapes are the TypeScript types at the call site. "Errors" lists the error codes the demo raises for that kind; codes common to every kind (`MANIFEST_CHANGED` when one idempotency key is reused with a changed payload) are noted once under [Error codes](#error-codes).

| Action kind | Operation | Payload | Response state (reason code, next action) | Errors | Sent by | Status |
| -- | -- | -- | -- | -- | -- | -- |
| `decideApproval` | `decideApproval` | `{ decision: approved \| rejected \| editRequired, reason?, editedMessage? }`; `entityRefs: [creator]` | approved: `blocked` (`AWAITING_DISPATCH`, next `dispatchApprovedAction`). rejected: `canceled` with receipt. editRequired: `approvalPending` (`EDIT_NEEDS_FRESH_APPROVAL`) with a new payload version | `RECORD_NOT_FOUND`, `APPROVAL_INVALID` (archived or already decided), `SOURCE_AUTHORITY_DENIED` (wrong role), `APPROVAL_EXPIRED`, `STALE_VERSION` (with `currentVersion`), `POLICY_VIOLATION` (upfront fee; `fieldErrors.upfrontFee`), `VALIDATION_FAILED` (`fieldErrors.reason`, `fieldErrors.editedMessage`) | `approvals/ApprovalPage` | proposed + conflict (C-04, C-09, C-10, C-12) |
| `dispatchApprovedAction` | `dispatchApprovedAction` | `{}`; `entityRefs: [creator]` | `succeeded` with `runRef` and receipt; or `outcomeUncertain` (`TIMEOUT_AFTER_SUBMIT`, next `reconcileRun`). A repeat returns the stored execution | `RECORD_NOT_FOUND`, `APPROVAL_REQUIRED` (not approved), `STALE_VERSION` | `approvals/ApprovalPage` | proposed |
| `pauseRun` | `controlRun` | `{ runRef, control: "pause" }` | the run's own state (`paused`, or unchanged `outcomeUncertain`) | `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | conflict (C-01, C-03) |
| `lookup` | `reconcileRun` | `{ runRef, request: "lookup" }` | the run's current state, reason code carries the lookup result (`sourceReceiptFound`, `confirmedNotExecuted`, `stillUnknown`) | `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | conflict (C-03) |
| `recordConfirmedSent` | `reconcileRun` | `{ runRef, request: "recordConfirmedSent" }` | `succeeded` with the source receipt | `OUTCOME_UNCERTAIN` (no verified receipt; `executionCertainty: uncertain`), `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | proposed |
| `freshAttempt` | `reconcileRun` | `{ runRef, request: "freshAttempt" }` | `queued` | `OUTCOME_UNCERTAIN` (not proven failed), `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | conflict (C-03) |
| `retryMonitorProfile` | `controlRun` | `{ profile }` | `blocked` (`SOURCE_LOGIN_REQUIRED`, next `reconnectSource`) | `STALE_VERSION`, `VALIDATION_FAILED` | `monitor/HourlyRunPage` | conflict (C-01) |
| `pauseBatch` | `controlRun` | `{ batchId }` | `paused` (`IN_FLIGHT_DRAINS`) | `STALE_VERSION`, `VALIDATION_FAILED` (already paused) | `recruitment/BatchPage` | conflict (C-01, C-09) |
| `cancelUnsent` | `controlRun` | `{ batchId, itemIds? }` | `canceled`, or `partiallySucceeded` (`SENT_OR_RUNNING_EXCLUDED`) | `STALE_VERSION`, `VALIDATION_FAILED` (nothing unsent) | `recruitment/BatchPage` | conflict (C-01) |
| `reconcileSettlement` | `requestApproval` | `{ settlementId, matches: { statementRef, groupId }[] }` | `approvalPending` (`AWAITING_REVIEW`, next `reconciliationReview`) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors.matches`, already submitted) | `finance/SettlementPage` | conflict (C-02, C-09) |
| `requestTask` | `requestApproval` | `{ jobType, account, scope, reason }`; `expectedVersion: "v1"` is hard-coded | `approvalPending` (`AWAITING_APPROVAL`, next `decideApproval`) | `VALIDATION_FAILED` (`fieldErrors` per field) | `settings/AutomationsPage` | conflict (C-02, C-04) |
| `requestStockTransfer` | `requestApproval` | `{ from, to, units, reason }`; a blank units box is sent as `NaN` | `approvalPending` (`AWAITING_APPROVAL`, next `sourceReceipt`) | `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors` per field; duplicate request), `QUOTA_OR_STOCK_HOLD` (`fieldErrors.units`) | `inventory/InventoryPage` | conflict (C-02, C-09) |
| `recordShippingDecision` | `requestApproval` | `{ shipmentRef, exceptionId, decision: refund \| replacement \| null, reason }` | `approvalPending` (`AWAITING_SOURCE_RECEIPT`, next `sourceReceipt`) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (already recorded; `fieldErrors.decision`, `fieldErrors.reason`) | `operations/ShippingExceptionPage` | conflict (C-02, C-07, C-09) |
| `prepareReturnTask` | `requestApproval` | `{ returnRef, disposition, resolution, reason }` | `approvalPending` (`AWAITING_APPROVAL`, next `approval`) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors` per field; already prepared) | `operations/ReturnPage` | conflict (C-02, C-07, C-09) |
| `queueNextAction` | `requestApproval` | `{ collaborationId, actionKey }` | `approvalPending` (no reason code, next `decideApproval` available) | `RECORD_NOT_FOUND`, `STALE_VERSION` (no `currentVersion`), `POLICY_VIOLATION` (outreach suppressed), `VALIDATION_FAILED` | `collaboration/CollaborationPage` | conflict (C-02) |
| `queueFeedback` | `requestApproval` | `{ collaborationId, text, submissionVersion }` | same as `queueNextAction` | same, plus `VALIDATION_FAILED` for empty text | `collaboration/CollaborationPage` | conflict (C-02) |
| `requestRevision` | `requestApproval` | `{ collaborationId, text, submissionVersion }` | same | same, plus `POLICY_VIOLATION` when revision rounds are used and `STALE_VERSION` for a wrong `submissionVersion` | `collaboration/CollaborationPage` | conflict (C-02) |
| `rejectContent` | `requestApproval` | `{ collaborationId, reason, submissionVersion }` | same | same, plus `VALIDATION_FAILED` for empty reason and `STALE_VERSION` for a wrong `submissionVersion` | `collaboration/CollaborationPage` | conflict (C-02) |
| `closeCollaboration` | `requestApproval` | `{ collaborationId, outcome, reason }` | same | `VALIDATION_FAILED` for an outcome not in the record's allowed list; works while outreach is suppressed | `collaboration/CollaborationPage` | conflict (C-02) |
| `suppressOutreach` | `requestApproval` | `{ collaborationId, reason }` | same | `VALIDATION_FAILED` for empty reason | `collaboration/CollaborationPage` | conflict (C-02) |
| `createCollaboration` | `requestApproval` | `{ collaborationId, reason }` | same, reason code `FRESH_TERMS_REQUIRED` | same | `collaboration/CollaborationPage` | conflict (C-02) |

### Capability-only action kinds

Named in `ReadResponse.capabilities` (and, for some, in a screen's `disabledReason`), but no screen sends them. They say what the server allows, so the freeze needs to say whether each is a real action kind, or only a label. Capability state and reason come from the demo.

| Action kind | Capability state (reason codes) | Carried on view | Screen that names it | Status |
| -- | -- | -- | -- | -- |
| `activateOffer` | `unverified` (`APPROVAL_REQUIRED`, `PROVIDER_ACCESS_UNVERIFIED`) | `offerDraft` | none | proposed |
| `checkConnections` | `available` | `connectionsOverview` | none | proposed |
| `closePeriod` | `held` (`CPA_SIGN_OFF_REQUIRED`, `RECONCILIATION_OPEN`) | `periodClose` | `finance/CloseReconciliationPage` | proposed |
| `closeReturn` | `held` (`RECEIPTS_MISSING`) | `returnDetail` | `operations/ReturnPage` | proposed |
| `enableFlow` | `held` (`PROVIDER_NOT_SELECTED`) | `emailFlow` | none | proposed |
| `enableSchedule` | `held` (`CONNECTION_UNVERIFIED`) | `scheduleDetail` | none | proposed |
| `executePayment` | `held` (`FOUNDER_APPROVAL_PENDING`) | `payableDetail` | `finance/PayablePage` | proposed |
| `holdCandidate` | `held` (`HISTORICAL_SNAPSHOT`) | `assessmentRecord` | none | proposed |
| `lookupSource` | `available`, only while the outcome is uncertain | `runDetail` | `approvals/RunPage` | conflict (C-03) |
| `markWatched` | `unverified` (`PLAYBACK_UNVERIFIED`) | `evidenceRecord` | `acquisition/EvidencePage` | proposed |
| `openEmailTool` | `unverified` (`PROVIDER_NOT_SELECTED`) | `lifecycleOverview` | none | proposed |
| `payCommission` | `unsupported` (`PROVIDER_OWNS_PAYOUT`) | `settlementDetail` | none | proposed |
| `recordDecision` | `unverified` (`DEMO_NO_DISPATCH`) | every analytics view | none | proposed |
| `recordPermissionEvidence` | `available` | `channelCapabilities` | `settings/CapabilitiesPage` | conflict (C-15) |
| `reopenCase` | `unsupported` (`INTERCOM_OWNS_CASES`) | `supportWorkspace` | none | proposed |
| `requestFreshAttempt` | only while the outcome is uncertain: `available`, or `held` (`EVIDENCE_REQUIRED`) until a not-executed result is confirmed | `runDetail` | `approvals/RunPage` | conflict (C-03) |
| `requestReport` | `unverified` (`DEMO_NO_DISPATCH`) | `overviewSummary` | none | proposed |
| `saveEvidenceDraft` | `available` | `evidenceRecord` | `acquisition/EvidencePage` | conflict (C-15) |
| `saveFlowDraft` | `available` | `emailFlow` | none | conflict (C-15) |
| `saveOfferDraft` | `available` | `offerDraft` | none | conflict (C-15) |
| `saveScheduleDraft` | `available` | `scheduleDetail` | `settings/SchedulePage` | conflict (C-15) |
| `sendInvitation` | `unverified` (`SOURCE_ACCESS_UNVERIFIED`) | `invitationDraft` | `recruitment/InvitationPage` | proposed |
| `startLiveDiscovery` | `unverified` (`SOURCE_ACCESS_UNVERIFIED`) | `discoverySummary` | `acquisition/DiscoveryPage` | proposed |
| `takeOverTask` | `held` (`TAKEOVER_NOT_ASSIGNED`) | `automationRuns` | none | proposed |

Action kinds that screens send are also carried as capabilities: `cancelUnsent`, `decideApproval`, `dispatchApprovedAction`, `pauseBatch`, `pauseRun`, `reconcileSettlement`, `recordConfirmedSent`, `recordShippingDecision`, `prepareReturnTask`, `requestStockTransfer`, `requestTask`, `retryMonitorProfile`, and the seven collaboration commands.

## Resource kinds

Sent by a screen through `useSave`. The request has no `actionKind`, so the demo adapter picks a service from `resourceKind` and then from a prefix of `resourceRef`.

| Resource kind | Status | `resourceRef` | Payload | Errors | Sent by |
| -- | -- | -- | -- | -- | -- |
| `actionDraft` | contract | the offer id; `expectedVersion` is the record version | `OfferDraftPayload` (commission, compensation, provider, sample shipping, upfront fee in minor units, and others) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `POLICY_VIOLATION` (`fieldErrors`); reason code `NO_CHANGE` on an identical save | `scorecards/OfferPage` |
| `configurationDraft` | contract + conflict | `schedule-<jobId>` or `flow-<flow>` (C-15) | `ScheduleDraft` `{ cadence, localTime, timezone, activeCohortOverride }`, or `FlowDraft` `{ timing, template }` | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors`); `NO_CHANGE` | `settings/SchedulePage`, `lifecycle/EmailFlowPage` |
| `evidenceDraft` | contract + conflict | the evidence ref, or `permission-<rowId>` (C-15); a first permission save sends `expectedVersion: null` | `EvidenceDraft` `{ mediaUrl, checkoutRoute, observations[] }`, or `PermissionEvidence` `{ rowId, reviewer, evidence, observedOn }` | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors`, including dotted paths such as `observations.0.text`); `NO_CHANGE` | `acquisition/EvidencePage`, `settings/CapabilitiesPage` |
| `reviewerAssessment` | contract | none | none | none | no screen on `main`; added by PR #29 |

## Error codes

The table is the code-to-category map in `src/adapter/errors.ts` joined with where the demo raises each code. `errors.ts` is headed as the handoff's section 5 categories; it does not mark which codes the handoff defines, and docs/intake.md says the catalogue has no not-found code, so `RECORD_NOT_FOUND` is proposed. Whether every other code is in the handoff is not recorded in the code (Q-14).

`MANIFEST_CHANGED` is also raised by `demoOnce.ts` and by six demo services when one idempotency key is reused with a changed payload (C-08). `FORBIDDEN` is also raised client-side by `useView` when a response's verified scope differs from the requested scope.

| Error code | Category | Raised by (under `src/adapter/`) |
| -- | -- | -- |
| `APPROVAL_EXPIRED` | approvalHold | `demoApprovals` |
| `APPROVAL_INVALID` | conflict | `demoApprovals` |
| `APPROVAL_REQUIRED` | approvalHold | `demoApprovals` |
| `BUDGET_HOLD` | resourceHold | never raised |
| `CAPABILITY_UNSUPPORTED` | capabilityHold | never raised |
| `CAPABILITY_UNVERIFIED` | capabilityHold | never raised |
| `FORBIDDEN` | forbidden | `demoAdapter`, `demoAnalytics`, `demoApprovals`, `demoMonitor`, `demoScorecards`, `useView` |
| `INTEGRATION_PENDING` | unavailable | `demoAdapter`, `demoApprovals`, `demoBatch`, `demoCollaboration`, `liveAdapter` |
| `LEASE_CONFLICT` | conflict | never raised |
| `MANIFEST_CHANGED` | conflict | `demoApprovals`, `demoEvidence`, `demoFinance`, `demoOnce`, `demoOps`, `demoScorecards` |
| `OFFLINE_NOT_SENT` | unavailable | `useAction`, `useSave` (client-side: the browser was offline, so nothing was sent) |
| `OUTCOME_UNCERTAIN` | outcomeUncertain | `demoApprovals` |
| `POLICY_VIOLATION` | validation | `demoApprovals`, `demoCollaboration`, `demoScorecards` |
| `QUOTA_OR_STOCK_HOLD` | resourceHold | `demoOps` |
| `RATE_LIMITED` | rateLimited | never raised |
| `RECORD_NOT_FOUND` | notFound | `demoApprovals`, `demoBatch`, `demoCollaboration`, `demoEvidence`, `demoFinance`, `demoLifecycle`, `demoMonitor`, `demoOps`, `demoScorecards`, `demoSettings` |
| `SESSION_EXPIRED` | unauthenticated | `demoAdapter`, `demoAnalytics`, `demoMonitor`, `demoScorecards` |
| `SOURCE_AUTHORITY_DENIED` | forbidden | `demoApprovals` |
| `SOURCE_LOGIN_REQUIRED` | capabilityHold | never raised |
| `SOURCE_UI_CHANGED` | capabilityHold | never raised |
| `SOURCE_UNAVAILABLE` | unavailable | `demoAdapter`, `demoAnalytics`, `demoFinance`, `demoMonitor`, `demoOps`, `demoScorecards` |
| `STALE_VERSION` | conflict | `demoApprovals`, `demoBatch`, `demoCollaboration`, `demoEvidence`, `demoFinance`, `demoLifecycle`, `demoMonitor`, `demoOps`, `demoScorecards`, `demoSettings` |
| `TIMEOUT` | unavailable | never raised |
| `UNAUTHENTICATED` | unauthenticated | never raised |
| `VALIDATION_FAILED` | validation | `demoAdapter`, `demoApprovals`, `demoBatch`, `demoCollaboration`, `demoCreators`, `demoEvidence`, `demoFinance`, `demoLifecycle`, `demoMonitor`, `demoOps`, `demoSettings` |

Never raised by the demo: `UNAUTHENTICATED`, `LEASE_CONFLICT`, `CAPABILITY_UNVERIFIED`, `CAPABILITY_UNSUPPORTED`, `SOURCE_LOGIN_REQUIRED` (used only as a reason code), `SOURCE_UI_CHANGED`, `BUDGET_HOLD`, `RATE_LIMITED`, `TIMEOUT`. They are in the map, so screens map them to a category, but no screen behavior for them has been exercised.

Categories (`ErrorCategory`): `unauthenticated`, `forbidden`, `notFound`, `validation`, `conflict`, `approvalHold`, `capabilityHold`, `resourceHold`, `rateLimited`, `unavailable`, `outcomeUncertain`, `replayed`, `unknown`. `replayed` has no code mapped to it. `unknown` is the fallback for a code not in the map. `unauthenticated` and `forbidden` clear protected data (`mustClearProtectedData`).

Error body (`AdapterErrorBody`, in `errors.ts`, not in `contract.ts`): `code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs`, `fieldErrors?`, `currentVersion?`, `executionCertainty?`. No demo path sets `retryAfterMs`; `retryable` is true only for `SOURCE_UNAVAILABLE`.

## Vocabularies the contract does not define

### `nextAction.kind` returned on action responses

| Kind | Returned by |
| -- | -- |
| `approval` | `demoOps` |
| `decideApproval` | `demoCollaboration`, `demoSettings` |
| `dispatchApprovedAction` | `demoApprovals` |
| `reconcileRun` | `demoApprovals` |
| `reconciliationReview` | `demoFinance` |
| `reconnectSource` | `demoMonitor` |
| `sourceReceipt` | `demoOps` |

### Reason codes

Free strings on `ActionResponse.reasonCodes`, capability `reasonCodes` and `coverage.reasonCodes`. The contract has no catalogue. This table is informational and is **not** checked by the drift test; it lists the upper-case literals found next to `reasonCodes` in `src/adapter/`. Camel-case results (for example `sourceReceiptFound`) are also carried as reason codes by `reconcileRun`. Per-value `reasonCode` strings inside fixtures (for example `RATE_NOT_READ`) are a separate class and are not listed.

| Reason code | Used in (under `src/adapter/`) |
| -- | -- |
| `ALREADY_PAUSED` | `demoBatch` |
| `ALREADY_RECONCILED` | `demoApprovals` |
| `ALREADY_SUBMITTED` | `demoFinance` |
| `APPROVAL_EXPIRED` | `demoApprovals` |
| `APPROVAL_REQUIRED` | `demoScorecards` |
| `AWAITING_APPROVAL` | `demoOps`, `demoSettings` |
| `AWAITING_DISPATCH` | `demoApprovals` |
| `AWAITING_REVIEW` | `demoFinance` |
| `AWAITING_SOURCE_RECEIPT` | `demoOps` |
| `CONNECTION_UNVERIFIED` | `demoSettings` |
| `CPA_SIGN_OFF_REQUIRED` | `demoFinance` |
| `DECISION_ALREADY_RECORDED` | `demoOps` |
| `DEMO_NO_DISPATCH` | `demoAdapter`, `demoAnalytics` |
| `EDIT_NEEDS_FRESH_APPROVAL` | `demoApprovals` |
| `EVIDENCE_REQUIRED` | `demoApprovals` |
| `FOUNDER_APPROVAL_PENDING` | `demoFinance` |
| `HISTORICAL_SNAPSHOT` | `demoScorecards` |
| `IN_FLIGHT_DRAINS` | `demoBatch` |
| `INTERCOM_OWNS_CASES` | `demoOps` |
| `NO_CHANGE` | `demoLifecycle`, `demoScorecards` |
| `NOTHING_TO_CANCEL` | `demoBatch` |
| `NOTHING_TO_PAUSE` | `demoApprovals`, `demoBatch` |
| `PLAYBACK_UNVERIFIED` | `demoEvidence` |
| `POST_SNAPSHOTS_UNAVAILABLE` | `demoMonitor` |
| `PROPOSAL_ALREADY_PREPARED` | `demoOps` |
| `PROVIDER_ACCESS_UNVERIFIED` | `demoScorecards` |
| `PROVIDER_NOT_SELECTED` | `demoLifecycle` |
| `PROVIDER_OWNS_PAYOUT` | `demoFinance` |
| `RECEIPTS_MISSING` | `demoOps` |
| `RECONCILIATION_OPEN` | `demoFinance` |
| `ROLE_REQUIRED` | `demoApprovals` |
| `SOURCE_ACCESS_UNVERIFIED` | `demoAdapter` |
| `SOURCE_LOGIN_REQUIRED` | `demoMonitor` |
| `SOURCE_ROWS_DEFERRED` | `demoAdapter`, `demoAnalytics`, `demoFinance` |
| `SOURCE_STALE` | `demoOps` |
| `TAKEOVER_NOT_ASSIGNED` | `demoSettings` |
| `TIMEOUT_AFTER_SUBMIT` | `demoApprovals` |

### `executionCertainty`

Defined only as `"notApplied" | "uncertain" | "applied"` in `errors.ts`. Demo action and save failures set `notApplied`; `uncertain` is set only on `OUTCOME_UNCERTAIN`; `applied` is never produced. Read failures set none.

## Conflicts between screens

| ID | Conflict | Where | Suggested question for the freeze |
| -- | -- | -- | -- |
| C-01 | `controlRun` carries unrelated work. Run pause sends `{ runRef, control }`; monitor retry sends `{ profile }`; batch pause and cancel send `{ batchId, itemIds? }`. The request has no run reference field (Q-03), and the demo adapter routes by `actionKind` for three of the four. | `approvals/RunPage`, `monitor/HourlyRunPage`, `recruitment/BatchPage`; `demoAdapter.ts`, `demoApprovals.ts` | Is `controlRun` only for runs, and are batch and monitor retries separate operations? |
| C-02 | `requestApproval` is used for twelve action kinds from six pages and they answer differently. All return `approvalPending`, but the reason code is `AWAITING_APPROVAL`, `AWAITING_REVIEW`, `AWAITING_SOURCE_RECEIPT` or none, and `nextAction.kind` is `sourceReceipt`, `approval`, `reconciliationReview` or `decideApproval`. `approvalRef` is set only by collaboration. | finance, inventory, operations, settings, collaboration | One acknowledgement shape for "queued for approval"? |
| C-03 | `approvals/RunPage` sends `actionKind` `lookup` and `freshAttempt` but gates the buttons on capabilities named `lookupSource` and `requestFreshAttempt`; only `recordConfirmedSent` and `pauseRun` match. The demo handler switches on `payload.request`, not on `actionKind`. | `approvals/RunPage.tsx`, `demoApprovals.ts` | One name per reconcile request, used for both the capability and the request. |
| C-04 | The record version lives in six places: `ReadResponse.dataVersion` (discovery), `data.version` (most), `data.currentVersion` (approval), `data.draftVersion` (schedule, email flow), `record.version` (evidence, offer), and `data.recorded[id]?.version` (permissions). `requestTask` sends a constant `"v1"`. Version tokens differ in shape (`v3`, `r2`, `st2`, `ex2`, `inv2`, `ret2`, `collab-v2`, `x@1`). | all action and save screens | Which field is `expectedVersion`, and is its format opaque? |
| C-05 | Filters disagree. "No filter" is `all` on most views and `both` on pipeline `source` and recruitment `networks`. The network filter is `network` on pipeline, social cat and monitor, and `networks` on recruitment. Intake source uses three vocabularies: `tiktok-affiliate` / `social-cat` (monitor), `social-cat` / `tiktok-shop` (pipeline), `tiktok` / `all` (batch). `cohort` is `first-wave` / `launch-a` on campaign funnel and `all` / `launch-a` on watchlist. Time windows are `window` (`sep-oct`, `last-30`), `days`, and `period` inside filters, while every screen passes the request's `period` as `null`. | pipeline, recruitment, batch, monitor, watchlist, campaignFunnel, fulfillmentAnalytics, periodClose | Shared filter names and values, and where a period goes. |
| C-06 | `scenario` is a filter on seven views (`commissionLedger`, `financeDashboard`, `inventoryOverview`, `operationsOverview`, `periodClose`, `returnDetail`, `supportWorkspace`). `demoOps.ts` calls it demo-only ("the live adapter never reads it"). Screens read it from the URL and send it as a filter. | the seven screens | Reject or ignore `scenario` outside demo? |
| C-07 | Ids differ between a view and its actions: filters use `shipmentId`, `returnId`, `runId`, `evidenceId`; payloads use `shipmentRef`, `returnRef`, `runRef`; the evidence save uses `evidenceRef`. `entityRefs` is `[]` on every action except approval decide and dispatch, so the field that should name the entity is unused. | operations, approvals, acquisition | What identifies the target: `entityRefs`, a payload id, or `resourceRef`? |
| C-08 | `MANIFEST_CHANGED` means "this idempotency key was reused with a different payload" in seven demo files, but its category is `conflict` and the field it is named for is `manifestRef`. (PR #37 adds a second meaning, below.) | `demoOnce.ts`, `demoApprovals.ts`, `demoEvidence.ts`, `demoFinance.ts`, `demoOps.ts`, `demoScorecards.ts` | Is there a separate code for key reuse? `replayed` has no code. |
| C-09 | "Already done" is reported three ways. Approval already decided: `APPROVAL_INVALID`. Shipping decision, return proposal, stock transfer duplicate, settlement match, pause when paused: `VALIDATION_FAILED`. Reconcile on a succeeded run: success with reason `ALREADY_RECONCILED`. | `demoApprovals.ts`, `demoOps.ts`, `demoFinance.ts`, `demoBatch.ts` | One representation for a duplicate. |
| C-10 | A wrong role is an error `SOURCE_AUTHORITY_DENIED` on `decideApproval`, a capability with state `denied` and reason `ROLE_REQUIRED` on the read, and (PR #30) a `blocked` response with reason `SOURCE_AUTHORITY_DENIED`. | `demoApprovals.ts` | Which of the three is authoritative? |
| C-11 | `fieldErrors` keys are flat names (`units`), dotted paths (`observations.0.text`), and keys not matching a form field. `POLICY_VIOLATION` and `VALIDATION_FAILED` both carry `fieldErrors`. `STALE_VERSION` carries `currentVersion` in eleven places and omits it in batch and collaboration. | demo services | Required fields of the error body per category. |
| C-12 | An approved decision is `blocked` with `AWAITING_DISPATCH`; the contract has no approved state (Q-01). Rejected is `canceled`. | `demoApprovals.ts` | Add an approved state, or confirm this. |
| C-13 | docs/design-map.md says batch pause and cancel go "with a preview" and that the preview intent waits for THO-283. No screen sends `previewAction`. | docs/design-map.md; `recruitment/BatchPage` | Is preview a separate call, or part of the action? |
| C-14 | `inspectRun` is in the contract. Runs are read through the `runDetail` view. | `approvals/RunPage` | Keep both? |
| C-15 | `useSave` sends only `resourceKind`, but capabilities gate saves by action kind (`saveEvidenceDraft`, `saveFlowDraft`, `saveOfferDraft`, `saveScheduleDraft`, `recordPermissionEvidence`). Two unrelated resources share `evidenceDraft` (video evidence and permission evidence) and two share `configurationDraft` (schedule and email flow); the demo tells them apart by a `resourceRef` prefix. An unknown `resourceKind` falls through to the evidence service. | `useSave.ts`, `demoAdapter.ts`, `demoSettings.ts`, `demoLifecycle.ts` | Map capability to resource kind, and give each resource its own kind. |
| C-16 | `useView` hard-codes `sort: []` and `page.limit: 50` with no cursor. Search is a filter (`q`) on `contentMonitor` and `tiktokBoard`. | `useView.ts`, `monitor/MonitorPage`, `creators/TikTokPage` | Server-side search, sort and paging: filters or request fields? |

## Open questions and proposals

Where each was raised, and where it is used. Status uses the same legend as above.

| ID | Question or proposal | Raised in | Used in | Status |
| -- | -- | -- | -- | -- |
| Q-01 | `ActionResponse.state` has no value for "approved, awaiting dispatch". The demo returns `blocked` with `AWAITING_DISPATCH`. | docs/intake.md; comment at `demoApprovals.ts` (decide) | `demoApprovals.ts`, `approvals/ApprovalPage` | proposed |
| Q-02 | The error catalogue has no not-found code. The demo uses `RECORD_NOT_FOUND`. | docs/intake.md | raised by ten demo files | proposed |
| Q-03 | `ActionRequest` has no run reference for `controlRun` and `reconcileRun`. The demo puts `runRef` in the payload. | docs/intake.md | `approvals/RunPage`, `demoApprovals.ts` | conflict (C-01) |
| Q-04 | `executionCertainty` has no defined values. The demo uses `notApplied`, `uncertain` and `applied`. | docs/intake.md | `errors.ts`, `approvals/shared.tsx` (`ActionError`), demo services | proposed |
| Q-05 | Approval and run view models are proposals; THO-283 and THO-321 freeze the schemas. | docs/intake.md; header of `features/approvals/types.ts` | `approvalDetail`, `runDetail` | proposed |
| Q-06 | Evidence view models are a proposal; THO-283 and THO-326 freeze the schemas. | header of `features/acquisition/evidenceTypes.ts`; PR #25 | `evidenceRecord`, `evidenceDraft` saves | proposed |
| Q-07 | The contract is proposed because THO-283 has not published a transport. | docs/intake.md; header of `contract.ts` | everything | contract |
| Q-08 | Domain payloads for actions come with THO-283 and THO-321. | comment above `actionOperations` in `contract.ts` | every action kind above | proposed |
| Q-09 | Live scope comes from the authenticated session (THO-283), never from the URL. Demo scope is fixed. | docs/intake.md; comment in `src/app/App.tsx` | `scope.tsx`, `useView.ts` | proposed |
| Q-10 | `VITE_FARDA_ADAPTER_BASE_URL` is reserved for the THO-283 adapter and unused until the transport is published. | docs/intake.md | `liveAdapter.ts`, which answers `INTEGRATION_PENDING` for every read, action and save | proposed |
| Q-11 | The adapter's preview intent waits for THO-283 (preview replacement plan is a dialog built from the record, no adapter call). | docs/design-map.md | `operations/ReturnPage` | conflict (C-13) |
| Q-12 | The demo adapter serves labeled fixtures; `scenario` is a demo-only filter the live adapter never reads. | comment in `demoOps.ts` | seven views | conflict (C-06) |
| Q-13 | The Pay capability is `unsupported` because the provider owns payout; no screen offers a manual Pay action. | docs/design-map.md (finance rows); `demoFinance.ts` | `settlementDetail` capabilities | proposed |
| Q-14 | `errors.ts` does not record which codes are from the handoff's section 5 and which the demo added; only `RECORD_NOT_FOUND` is documented as added. | `errors.ts`; docs/intake.md | all error codes | proposed |
| Q-15 | In-app decisions beside the Slack thread are a product decision beyond Figma; "the server decides who may use this". | comment in `approvals/ApprovalPage.tsx`; docs/design-map.md | `decideApproval` | proposed |
| Q-16 | "The server decides which actions are allowed" for a collaboration, from the record's `allowedActions`. | `collaboration/CollaborationPage.tsx` | `queueNextAction` | proposed |
| Q-17 | PR #29 exercises the empty, partial, stale, offline and 403 states on every data route, against the demo adapter only. Server behavior (THO-283, THO-285) is not exercised. | PR #29 description | all view keys | proposed |
| Q-18 | Real Slack handoff, real TikTok authority and live dispatch need THO-283 and THO-285. | PR #30 description | `requestBatchApproval`, `decideTikTokSample` (PR #30) | proposed |
| Q-19 | Source freshness from real syncs and QuickBooks/Shopify reconciliation are blocked on THO-283 and THO-285. | PR #32 description | `launchReconciliation` (PR #32) | proposed |
| Q-20 | Real dates, reminders and closure need THO-283. | PR #33 description | collaboration posting timing (no new adapter key) | proposed |
| Q-21 | Live data and real attribution windows are blocked on THO-283, THO-285, THO-166 and THO-195. | PR #36 description | `metricDictionary` (PR #36) | proposed |
| Q-22 | Server-side enforcement of the commission-only rule is blocked on THO-283, THO-285, THO-173 and THO-245; the demo service is evidence only. | PR #37 description | policy actions (PR #37) | proposed |
| Q-23 | The live checkout and payout owner need THO-283. | PR #39 description | creator pages, no adapter key | proposed |
| Q-24 | Other proposals that are not adapter shapes: the proposed pass mark for visual diffs (not agreed with the design reviewer), Automations under More, the demo badge in the header, a seven-day invitation validity, "Contribution definition: proposed", responsive adaptations. | PR #23, PR #27; docs/design-map.md; `overview/OverviewPage.tsx` | UI only | not an adapter item |

## Pending in open PRs

Not on `main`. Read from each PR's diff against `main` on 2026-11-04. This section is **not** checked by the drift test, so merging or closing a PR needs a manual move into the tables above. The tool `scripts/adapter-freeze-extract.mjs` does not read these branches.

| PR | Adds | Detail | Conflicts with |
| -- | -- | -- | -- |
| #25 | Resource kind `reviewerAssessment` in use; capability `recordDisagreement` | Screen `acquisition/EvidenceDisputes` saves `{ kind: "dispute", observationId, stance, reason, proposed }` against the evidence ref with `expectedVersion`. Errors `RECORD_NOT_FOUND`, `STALE_VERSION` (with `currentVersion`), `VALIDATION_FAILED` (`fieldErrors`). Capability `recordDisagreement` is `held` with `NO_REVIEW_ON_FILE` until a first review exists. PR #29 is stacked on this PR, so its diff includes the same change. | C-13 (the kind shares a ref with `evidenceDraft`) |
| #26 | View `offerRewards` | Filters `{ offerId, scenario }` (typed `scenario: string`, required here, optional elsewhere). Data `RewardsRecord`. Screen `scorecards/RewardsPage`. Handler in `demoScorecards.ts`. Capability `purchaseReward` (`unverified`; `OWNER_APPROVAL_PENDING`, `PROVIDER_ACCESS_UNVERIFIED`). Errors `RECORD_NOT_FOUND` for an unknown offer or scenario. Also changes `assessmentRecord`: an assessment id `<id>--media`, `--terms` or `--policy` returns the same snapshot with that part of its basis changed. | C-06 (`scenario`) || #26 | View `offerRewards` | Filters `{ offerId, scenario }` (typed `scenario: string`, required here, optional elsewhere). Data `RewardsRecord`. Screen `scorecards/RewardsPage`. Handler in `demoScorecards.ts`. Capability `purchaseReward` (`unverified`; `OWNER_APPROVAL_PENDING`, `PROVIDER_ACCESS_UNVERIFIED`). Errors `RECORD_NOT_FOUND` for an unknown offer or scenario. Also changes `assessmentRecord`: an assessment id `<id>--media`, `--terms` or `--policy` returns the same snapshot with that part of its basis changed. | C-06 (`scenario`) |
| #28 | View `pipelineBranches` | Filters `{ source }` (`both`, `social-cat`, `tiktok-shop`; the demo answers `VALIDATION_FAILED` otherwise). Data `BranchesData`. Screen `acquisition/BranchesView`, shown from the pipeline page. Handler in `demoAdapter.ts`. | C-05 (`both` as the no-filter value) |
| #29 | none of its own | Stacked on #25 and #22. Adds, through a test-only fault adapter, the reason codes `SOURCE_ROWS_INACCESSIBLE`, `SOURCE_BEHIND` and `NOT_REPORTED`, and a `ReadState` notice on 20 pages. No new view key, action kind or error code beyond #25. | none |
| #30 | Action kinds `requestBatchApproval`, `decideTikTokSample`; capability `requestBatchApproval` on `discoverySummary` | `requestBatchApproval`: operation `requestApproval`, payload `{ batchId, recipients, rateLabel, sampleUnits, sampleUnitCostMinor, upfrontFeeMinor, policyVersion }`, `expectedVersion` is `res.dataVersion`; answers `approvalPending` with reason `AWAITING_DECISION` (a fourth wording, C-02), `approvalRef` `demo-approval-batch-024`, `manifestRef`, next `decideApproval` for `Thomas`. Errors `MANIFEST_CHANGED`, `STALE_VERSION`, `POLICY_VIOLATION` (upfront fee), `RECORD_NOT_FOUND`, `VALIDATION_FAILED` (finite recipients). `decideTikTokSample`: operation `controlRun`, payload `{ batchId, sampleId, decision: approve \| decline }`; answers `succeeded` with a receipt, or `blocked` with `SOURCE_AUTHORITY_DENIED` and next `ownerHandoff`. Errors `RECORD_NOT_FOUND`, `VALIDATION_FAILED`, and `STALE_VERSION` (batch version). Also adds an `actorRole` option to the demo adapter, so a founder can decide what a reviewer is refused (`SOURCE_AUTHORITY_DENIED`). New `nextAction.kind`: `ownerHandoff`. | C-01 (a decision under `controlRun`), C-02, C-10 |
| #32 | View `launchReconciliation` | Filters none. Data `ReconciliationData`. Screen `analytics/ReconciliationPage` (route `/launch?view=reconciliation`). Handler in `demoAnalytics.ts`. Also lets `collaborationDetail` return an affiliate record whose capabilities are all `held` with `DEMO_RECORD_READ_ONLY`. | none |
| #33 | No new key | Makes `collaborationDetail` and the seven collaboration commands work per `collaborationId` (a fixtures table instead of one record). Adds demo rules: `POLICY_VIOLATION` for `queueNextAction` with action key `remindCreator` when the accepted posting terms are voluntary; `VALIDATION_FAILED` for feedback, revision or rejection when nothing has been submitted; `STALE_VERSION` against the record's own submission version. | C-02, C-11 |
| #35 | View `opsHealth` | Filters none. Data `OpsHealth`. Screen `operations/OpsHealthPage`. Handler in `demoOps.ts`, derived in `adapter/opsHealth.ts`. | none |
| #36 | View `metricDictionary` | Filters none. Data `MetricDictionaryData`. Read by `analytics/AttributionPage`. Handler in `demoAnalytics.ts`. | none |
| #37 | Action kinds `createOffer`, `editOffer`, `importOffers`, `dispatchOffer`, `recordCreatorReply`, `changeAcquisitionPolicy` | Demo service `demoPolicy.ts`, handled by `actionKind`; no screen sends them yet (tests only, with `operation` set to the action kind). Payloads `{ offerId?, terms }`, `{ offers[] }`, `{ creatorRef, sourceRef, text }`, a partial policy with `version`. Answers `draft`, `succeeded` (`POLICY_VERSION_CHANGED`) or `blocked` (`TERMS_MISMATCH`, `CREATOR_FEE_REQUEST`; next `reviewTermsMismatch`). Errors `POLICY_VIOLATION` (`fieldErrors`, dotted per-row keys), and `MANIFEST_CHANGED` when an approval was made under an older policy and is dispatched after a conflicting change. Eligibility blocker codes inside `fieldErrors` messages: `UPFRONT_FEE_PROHIBITED`, `GUARANTEED_FEE_PROHIBITED`, `PAID_COMPONENT_PROHIBITED`, `PAID_OR_HYBRID_PROHIBITED`, `GIFTED_ONLY_PROHIBITED`, `COMMISSION_REQUIRED`, `COMMISSION_ABOVE_CAP`, `SAMPLE_ABOVE_CAP`, `INVALID_AMOUNT` (not error codes). | C-08 (a second meaning of `MANIFEST_CHANGED`), C-11 |
| #38 | View `closePackage` | Filters `{ period, scenario? }`. Data `ClosePackage`. Screen `finance/ClosePackagePage`. Handler in `demoFinance.ts`. Capability `closePeriod` is `held` with the package's blocker codes as reasons (`ADJUSTMENT_REVIEW_OPEN`, `UNRESOLVED_DIFFERENCE`, `LANDED_COST_INCOMPLETE`, `CPA_SIGN_OFF_PENDING`, `EXPORT_INCOMPLETE`), or `unsupported` with `ALREADY_CLOSED`. Error `RECORD_NOT_FOUND`. | C-05, C-06 |
| #39 | none | Only changes copy and layout on the creator pages. No view key, action kind or error code. | none |
PRs #22, #23, #27, #31 and #34 add no view key, action kind, resource kind or error code that this register tracks. The task named #26, #29, #30, #32 and #35 to #39; #25, #28 and #33 are listed too because their diffs also change what the demo adapter answers.

## Keeping the register honest

`npm run adapter:register` prints the usage map the register was built from (who reads, sends and handles each name). `src/adapter/freezeRegister.test.ts` runs `scripts/adapter-freeze-extract.mjs --json` and compares it with the first column of the tables above:

- A name in the source and not in the register fails the test (drift).
- A name in the register and not in the source also fails (a stale row).

Checked: operations, view keys, action kinds (sent and capability-only), resource kinds, error codes, and `nextAction.kind` values. Not checked: reason codes, filters, payloads, data types and the narrative rows; those are reviewed by hand. The extractor reads `src/adapter/*.ts`, `src/features/**` and `src/fixtures/**` (not tests) and the catalogues in `errors.ts` and `contract.ts`. It works on string literals: a view key or action kind built at run time is not seen, so keep them literal at the call site.

To add one: add the row to the matching table (first column in backticks), then run `npm run test`.
