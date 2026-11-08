# Adapter freeze register

Every view key, action kind, resource kind, operation and error code the front end assumes today, in one place, so the THO-283 owner can freeze the adapter contract in one pass.

- **Stage varies by path.** Historical fixture proposals remain recorded alongside implemented native variants. The authenticated transport and scoped native service now exist; module documentation and revision-specific verification determine each route's actual stage. A native implementation never establishes provider permission or production execution by itself.
- **No additional backend host is proposed here.** The transport uses its configured `VITE_FARDA_ADAPTER_BASE_URL`; see docs/intake.md for the current published integration boundary.
- **Nothing here is copied from Linear or Figma.** Names, shapes and codes come from the source files named in each row.

## How to read the status column

| Status | Meaning |
| -- | -- |
| `contract` | Defined in `src/adapter/contract.ts` (or, for error codes, in the code-to-category table in `src/adapter/errors.ts`). |
| `proposed` | Introduced by a screen or by the demo adapter. The contract has only `string` where it would go (`viewKey: string`, `actionKind: string`), so no screen can be wrong yet, and none is confirmed. |
| `decided` | Answered in `docs/adapter-decisions.md` on 2026-11-04 by the project owner, as a default for the build. Implemented in the front end; not verified against any service, and the backend owner may change it. |
| `native` | Typed authenticated service path exists. Its release evidence and source authority remain separate; see the owning module and current verification. |
| `conflict` | Two or more screens, or a screen and the demo adapter, disagree. The conflict IDs (C-nn) are explained in [Conflicts](#conflicts-between-screens). |

The register tables are checked against the source by `npm run test` (`src/adapter/freezeRegister.test.ts`, backed by `scripts/adapter-freeze-extract.mjs`). See [Keeping the register honest](#keeping-the-register-honest). The [Merged PRs outside the drift check](#merged-prs-outside-the-drift-check) section is outside that check.

## What `contract.ts` defines

| Area | Defined values |
| -- | -- |
| Operations (`ActionOperation`) | `previewAction`, `requestApproval`, `decideApproval`, `dispatchApprovedAction`, `inspectRun`, `reconcileRun`, `controlRun`, `refreshObservation`, `recordSourceDecision`, `exportSnapshot`. Reads use `readView`, saves use `saveResource`. |
| Resource kinds (`SaveResourceRequest`) | `actionDraft`, `reviewerAssessment`, `evidenceDraft`, `configurationDraft` |
| Action state (`ActionResponse.state`) | `draft`, `approvalPending`, `approved`, `queued`, `blocked`, `running`, `succeeded`, `partiallySucceeded`, `failed`, `outcomeUncertain`, `reconciling`, `paused`, `canceled` |
| Data state (`ReadResponse.dataState`) | `ready`, `empty`, `partial`, `stale`, `unavailable` |
| Capability state | `available`, `unverified`, `unsupported`, `denied`, `held` |
| Value state | `known`, `unknown`, `notApplicable` |
| Not defined | View keys, action kinds, filters per view, payloads per action, reason codes, `nextAction.kind` values, a per-source freshness state is defined only as an optional field (D-13). Q-01 to Q-04 are decided and in `contract.ts`; the rest is a proposal below. |

## Operations

Which `operation` values screens send. The demo adapter routes `submitAction` by `actionKind` first (settings, ops, finance, monitor, collaboration, batch), then falls through to a router in `demoApprovals.ts` that switches on `operation`.

| Operation | Status | Sent by | Handled by demo | Note |
| -- | -- | -- | -- | -- |
| `previewAction` | contract | no screen | no | No screen sends a preview. docs/design-map.md (row on batch pause and cancel) says those commands go "with a preview", and another row says the preview intent waits for THO-283. See C-13. |
| `requestApproval` | contract + conflict | collaboration, finance, inventory, operations (2), settings | no router on `operation`; each `actionKind` has its own handler | Used for twelve action kinds from six pages. Answers differ (C-02). |
| `decideApproval` | contract | `approvals/ApprovalPage` | `demoApprovals` | `actionKind` equals the operation name. |
| `dispatchApprovedAction` | contract | `approvals/ApprovalPage` | `demoApprovals` | `actionKind` equals the operation name. |
| `inspectRun` | contract | no screen | no | Runs are read as the `runDetail` view (C-14). `ActionRequest.operation` excludes it by type. |
| `reconcileRun` | contract | `approvals/RunPage` | `demoApprovals` | `actionKind` is the request name, and the run capability uses the same name (C-03, resolved). |
| `controlRun` | contract + conflict | `approvals/RunPage`, `monitor/HourlyRunPage`, `recruitment/BatchPage` | `demoApprovals` (run pause), `demoMonitor`, `demoBatch` | Three unrelated payload shapes (C-01). |
| `refreshObservation` | native | `settings/NativeHealthCheck` | none | Exact bounded `refreshOperationsHealth` read only. No input run reference; the existing J14 service owns any resulting run. Run-control requirements remain unchanged. |
| `recordSourceDecision` | native | `analytics/NativeLaunchDecision` | none | Exact founder readiness record; verified source acknowledgment confers no release. |
| `exportSnapshot` | native | typed authorized ledger client | none | Bounded existing-runner source snapshot with private CSV artifact receipt. |

## View keys

Request shape sent by `useView`: `requestedScope`, `filters`, `period`, `sort` and `page`. Bounded detail views use a null cursor; paged native lists continue with opaque scope/filter/role-bound cursors. Data types are declared at the call site and validated by the adapter registry. Demo and native variants remain separate.

| View key | Filters sent | Response data type | Read by (screen, under `src/features/`) | Demo handler (under `src/adapter/`) | Status | Note |
| -- | -- | -- | -- | -- | -- | -- |
| `activationRetention` | none | ActivationData / NativeActivation | `lifecycle/ActivationPage`, `NativeLifecycleViews` | `demoLifecycle` | native + historical demo | Anonymous matched cohort/window, nullable counts and export approval; app interaction is not ingestion. |
| `approvalDetail` | `approvalId` | ApprovalDetail / NativeApprovalView | `approvals/ApprovalPage`, `NativeApprovalPage` | `demoAdapter` | native + historical demo | Exact finite manifest and current source decision projection; no fabricated creator payload or app decision release. |
| `assessmentRecord` | `creatorId`, `assessmentId` | AssessmentData | `scorecards/AssessmentPage` | `demoAdapter` | proposed |  |
| `attribution` | none | AttributionData | `analytics/AttributionPage` | `demoAnalytics` | proposed |  |
| `automationRuns` | none | AutomationData | `settings/AutomationsPage` | `demoSettings` | proposed |  |
| `batchDetail` | `batchId`, `source`, `deal`, `owner` | BatchData | `recruitment/BatchPage` | `demoAdapter` | proposed + conflict | C-05. Uses `keepPrevious`. Demo refuses unknown values. |
| `campaignFunnel` | `campaignId`, `cohort` | CampaignFunnelData | `analytics/CampaignFunnelPage` | `demoAnalytics` | proposed + conflict | C-05. |
| `channelCapabilities` | none | CapabilityData | `settings/CapabilitiesPage` | `demoSettings` | proposed |  |
| `collaborationDetail` | `collaborationId` | CollaborationData | `collaboration/CollaborationPage` | `demoAdapter` | proposed |  |
| `collaborationEvidence` | `collaborationId`; cursor pages | CollaborationEvidenceData | `collaboration/CollaborationEvidence` | `demoCollaborationEvidence` | scoped saved-record projection | The authenticated service reads exact collaboration links. |
| `commissionLedger` | `scenario?` (demo); none (native) | CommissionLedger | `finance/CommissionLedgerPage` | `demoFinance` | native + historical demo + conflict | C-06. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `connectionsOverview` | none | ConnectionsData | `settings/ConnectionsPage` | `demoSettings` | proposed |  |
| `consentEligibility` | none | ConsentData / NativeConsent | `lifecycle/ConsentPage`, `NativeLifecycleViews` | `demoLifecycle` | native + historical demo | Exclusive source-defined consent categories and exact cohort; unknown is distinct from zero. |
| `contentMonitor` | `source`, `network`, `window`, `q` | ContentMonitorData | `monitor/MonitorPage` | `demoMonitor` | proposed + conflict | C-05, C-16. Uses `keepPrevious`. |
| `customerJourney` | none | CustomerJourneyData | `analytics/CustomerJourneyPage` | `demoAnalytics` | proposed |  |
| `discoverySummary` | none | DiscoveryData | `acquisition/DiscoveryPage` | `demoAdapter` | proposed |  |
| `emailFlow` | `flow`, optional reviewer-only `draftRequestKey` | EmailFlowData / NativeEmailFlow | `lifecycle/EmailFlowPage`, `SetupFlowPage`, `NativeEmailFlowPage` | `demoLifecycle` | native + historical demo | Setup is read-only. Three editable flow catalogs, local draft/history and exact-key request proof; absent is not terminal. |
| `evidenceRecord` | `creatorId`, `evidenceId` | EvidenceRecord | `acquisition/EvidencePage` | `demoAdapter` | proposed + conflict | C-07. Shape in `features/acquisition/evidenceTypes.ts`, marked PROPOSED (THO-283, THO-326). |
| `financeDashboard` | `scenario?` (demo); none (native) | FinanceDashboard | `finance/FinanceAnalyticsPage`, `finance/FinanceDashboardPage` | `demoFinance` | native + historical demo + conflict | C-06. Read by two pages. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `fulfillmentAnalytics` | `days` (7 or 14) | FulfillmentAnalytics | `operations/FulfillmentAnalyticsPage` | `demoOps` | native + historical demo + conflict | C-05 (period as `days`). Demo answers `VALIDATION_FAILED` for other values; native refuses them with 400 and requires the record's `periodDays` to equal `days`. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `hourlyRun` | `runId` | HourlyRunData | `monitor/HourlyRunPage` | `demoMonitor` | proposed |  |
| `inventoryOverview` | `scenario?` | InventoryOverview | `inventory/InventoryPage` | `demoOps` | proposed + conflict | C-06. |
| `invitationDraft` | none | InvitationData | `recruitment/InvitationPage` | `demoAdapter` | native + historical demo | A read model of the composer's source facts, not a saved draft: the screen edits terms locally and saves nothing, so no `saveResource` path is involved. Native: `quota` stays the `unknown` marker and `automateInvitations` stays `off` (the schema refuses anything else); `sendInvitation` is `denied` (`REVIEWER_REQUIRED`) for a reader and `held` (`INVITATION_ACTIONS_NOT_CONNECTED`) for a reviewer; nothing is sent. The schema pins `datasetKey` to `invitation-demo`, so a live source must carry that key until the schema is widened. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/teamInvitationReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `INVITATION_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `launchControl` | optional original `requestKey` | LaunchControlData / NativeReadinessView | `analytics/LaunchControlPage`, `NativeLaunchControl` | `demoAnalytics` | native + historical demo | Source-owned readiness facts and exact original request recovery; recording does not grant release. |
| `launchReconciliation` | none | ReconciliationData | `analytics/ReconciliationPage` | `demoAnalytics` | proposed | Not a Figma source (`/launch?view=reconciliation`); see `docs/additions-analytics.md`. Matrix cells carry exact values (cents for money). |
| `launchSnapshot` | none | LaunchSnapshotData | `analytics/LaunchSnapshotPage` | `demoAnalytics` | proposed |  |
| `lifecycleOverview` | none | LifecycleData / NativeLifecycle | `lifecycle/LifecyclePage`, `NativeLifecycleViews` | `demoLifecycle` | native + historical demo | Source catalog/outcome evidence remains separate from local configuration and provider sends. |
| `metricDictionary` | none | MetricDictionaryData | `analytics/AttributionPage` | `demoAnalytics` | proposed | Versioned headline-metric dictionary, cost buckets and hand-checked cases. Read by the definitions dialog. |
| `offerDraft` | `offerId` | OfferDraftRecord | `scorecards/OfferPage` | `demoAdapter` | proposed |  |
| `offerRewards` | `offerId`, `scenario` | RewardsRecord | `scorecards/RewardsPage` | `demoScorecards` | proposed + conflict | C-06. Typed `scenario: string`; an unknown scenario is `RECORD_NOT_FOUND`. |
| `operationsOverview` | `scenario?` (demo); none (native) | OperationsOverview | `operations/OperationsPage` | `demoOps` | native + historical demo + conflict | C-06. The `home` and `view` URL parameters are applied on the screen, never sent. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `nightlyReconciliation` | none | ReconciliationData | `settings/ReconciliationPage` | `demoReconciliation` | proposed | Nightly pairs, conflicts that name the authoritative side, and an append-only audit trail. Distinct from `launchReconciliation`. |
| `operationsShipping` | none | shipments, exceptions, chain | `operations/ShippingPanels` | `demoOps` | native + historical demo | In transit is counted on the screen from carrier states. The frontend schema still pins `datasetKey` to `operations-shipping-demo`, so a live source must carry that key until the schema is widened. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `shippingHub` | optional demo scenario | recipient/origin-separated parcel queue, source freshness, label and physical state, bounded review | `operations/shippingHub/ShippingHubPage` | `demoShippingHub`; authenticated service pending sources | proposed | No label purchase endpoint; draft review only until shipping executor integration. |
| `orderCustomer` | `orderId` | OrderCustomerData | `operations/CustomerReveal` | `demoOps` | native + historical demo | Restricted. Details appear only for an allowed role after an audited reveal. Native: only schema-declared keys leave the service; a reader always receives `access: denied` (`REVIEWER_REQUIRED`) and `revealed: null`; every audit entry must name the requested order; `revealCustomerDetails` is held (`OPERATIONS_ACTIONS_NOT_CONNECTED`) for a reviewer. The schema pins `datasetKey` to `operations-customer-demo`. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `opsHealth` | none | OpsHealth | `operations/OpsHealthPage` (route `/analytics/fulfillment?view=health`) | `demoOps` | native + historical demo | No Figma source. Demo derived in `adapter/opsHealth.ts` from the shipment ledger; native never derives it. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `orderDetail` | `orderId` | OrderDetail | `operations/OrderPage` | `demoOps` | native + historical demo | The record's `orderRef` must equal `orderId`; the strict schema refuses customer data under a new key. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `overviewSummary` | none | OverviewData | `overview/OverviewPage` | `demoAdapter` | proposed | Nine demo fixture switches are chosen by an adapter option, not by the request. |
| `paidMedia` | `rights`, `platform` | PaidMediaData | `analytics/PaidMediaPage` | `demoAnalytics` | proposed | Uses `keepPrevious`. |
| `payableDetail` | `payableId` | PayableDetail | `finance/PayablePage` | `demoFinance` | native + historical demo | `executePayment` is held for a reviewer and denied (`REVIEWER_REQUIRED`) for a reader; no payment path exists. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `closePackage` | `period`, `scenario?` (demo); `period` (native) | ClosePackage | `finance/ClosePackagePage` | `demoFinance` | native + historical demo + conflict | C-05, C-06. Read from the same fixture evidence as `periodClose`, so the two cannot disagree. An unknown `scenario` is refused with `VALIDATION_FAILED`. `closePeriod` stays held. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `monthsHistory` | none | months list | `finance/CloseViews` | `demoFinance` | native + historical demo | Synthetic months. October's status is read from the close package. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `periodClose` | `period`, `scenario?` (demo); `period` (native) | PeriodClose | `finance/CloseReconciliationPage` | `demoFinance` | native + historical demo + conflict | C-05 (period is a filter, `period` request field is `null`), C-06. `closePeriod` stays held. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `pipelineBranches` | `source` | BranchesData | `acquisition/BranchesView` | `demoAdapter` | proposed | Splits by source only; the page shows the other pipeline filters it was opened with and says they do not change these counts. |
| `pipelineSummary` | `source`, `route`, `network`, `checkout`, `window`, `policy` | PipelineData | `acquisition/PipelinePage` | `demoAdapter` | proposed + conflict | C-05. Demo refuses unknown facet values with `VALIDATION_FAILED`. |
| `postPerformance` | `postId` | PostPerformanceData | `monitor/PostPage` | `demoMonitor` | proposed |  |
| `recruitmentQueue` | `networks`, `route` | RecruitmentData | `recruitment/RecruitmentPage` | `demoAdapter` | proposed + conflict | C-05. Uses `keepPrevious`. Demo refuses unknown facet values. |
| `reportManifest` | none | Manifest | `finance/CloseViews` | `demoFinance` | native + historical demo | Synthetic dry-run manifest of the seven package reports. Nothing is generated. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `returnDetail` | `returnId`, `scenario?` (demo); `returnId` (native) | ReturnDetail | `operations/ReturnPage` | `demoOps` | native + historical demo + conflict | C-06, C-07. The record's `returnRef` must equal `returnId`. `prepareReturnTask` and `closeReturn` held for a reviewer. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `runDetail` | `runId` | RunDetail / NativeRunView | `approvals/RunPage`, `NativeRunPage` | `demoAdapter` | native + historical demo | The existing runner supplies finite item outcomes; local artifacts and provider effects remain distinct. `inspectRun` is not sent. |
| `scheduleDetail` | `jobId` | ScheduleData | `settings/SchedulePage` | `demoSettings` | proposed |  |
| `settlementDetail` | `settlementId` | SettlementRecord | `finance/SettlementPage` | `demoFinance` | native + historical demo | `reconcileSettlement` held for a reviewer, `payCommission` unsupported (`PROVIDER_OWNS_PAYOUT`); both denied for a reader. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/finance/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `FINANCE_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `shippingException` | `shipmentId`, `exceptionId` | ShippingExceptionDetail | `operations/ShippingExceptionPage` | `demoOps` | native + historical demo + conflict | C-07. The record's `shipmentRef` and `exceptionId` must both match. `recordShippingDecision` held for a reviewer. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/operationsReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `OPERATIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `socialCatBoard` | `owner` | SocialCatBoardData | `creators/SocialCatPage` | `demoCreators` | proposed | Uses `keepPrevious`. Demo refuses unknown owners. |
| `socialCatDashboard` | `network` | SocialCatDashboardData | `creators/SocialCatPage` | `demoCreators` | proposed + conflict | C-05. Uses `keepPrevious`. |
| `supportWorkspace` | `caseId`, `scenario?` | SupportWorkspace | `support/SupportPage` | `demoOps` | proposed + conflict | C-06. |
| `teamPermissions` | none | TeamData | `settings/TeamPage` | `demoSettings` | native + historical demo | The live team screen renders `operationsControl` (section `team`); this read model is what the demo screen reads. Native: no capabilities are carried, so nothing on it can grant a role or assign an owner; keys outside `teamPermissionsSchema` are dropped and a source-supplied capability is refused. Native (THO-367): served by the creator agent at `/v1/read` through `src/creator-agent/teamInvitationReads/`; no `scenario`; with no configured source it answers `503 INTEGRATION_PENDING` (reason `TEAM_PERMISSIONS_SOURCE_UNCONFIGURED`) and no data. Sandbox, unconfigured source; not integration-verified. |
| `operationsControl` | `section`, optional `targetRef`, reviewer-only `proposalRequestKey`, bounded `q`/`platform`/`mine`, reports-only `jobRef` | NativeOperationsControl | `settings/NativeOperationsControls` | native only | native | Supplemental source-owned team/run/report/capability/reconciliation detail. Existing paged lists and schedule drafts remain authoritative; no duplicate executor or ledger. |
| `tiktokBoard` | `q` | TikTokBoardData | `creators/TikTokPage` | `demoCreators` | proposed + conflict | C-16. Uses `keepPrevious`. |
| `tiktokDashboard` | none | TikTokDashboardData | `creators/TikTokPage` | `demoCreators` | proposed |  |
| `watchlist` | `source`, `state`, `cohort` | WatchlistData | `monitor/WatchlistPage` | `demoMonitor` | proposed + conflict | C-05. The page maps its `only-launch-a` choice to `launch-a`, otherwise `all`. |

| `ledgerExportRequest` | exact original key/version/export payload | NativeLedgerExportRequest | `finance/NativeExportDialog` | none | native only | Pure authorized lookup; no regeneration. |
| `ledgerExportArtifact` | artifact reference | NativeLedgerExportArtifact | `finance/NativeExportDialog` | none | native only | Whole source CSV with protected receipt, expiry and integrity. |
| `fulfillmentProposal` | kind, source-owned target, optional original key | FulfillmentProposal | `operations/NativeFulfillmentControl` | none | native only | Exact plans and original request lookup; no source effect. |

## Action kinds

Sent by a screen through `useAction`. Payload shapes are the TypeScript types at the call site. "Errors" lists the error codes the demo raises for that kind; codes common to every kind (`MANIFEST_CHANGED` when one idempotency key is reused with a changed payload) are noted once under [Error codes](#error-codes).

| Action kind | Operation | Payload | Response state (reason code, next action) | Errors | Sent by | Status |
| -- | -- | -- | -- | -- | -- | -- |
| `decideApproval` | `decideApproval` | `{ decision: approved \| rejected \| editRequired, reason?, editedMessage? }`; `entityRefs: [creator]` | approved: `approved` (`AWAITING_DISPATCH`, next `dispatchApprovedAction`; nothing sent). rejected: `canceled` with receipt. editRequired: `approvalPending` (`EDIT_NEEDS_FRESH_APPROVAL`) with a new payload version | `RECORD_NOT_FOUND`, `APPROVAL_INVALID` (archived or already decided), `SOURCE_AUTHORITY_DENIED` (wrong role), `APPROVAL_EXPIRED`, `STALE_VERSION` (with `currentVersion`), `POLICY_VIOLATION` (upfront fee; `fieldErrors.upfrontFee`), `VALIDATION_FAILED` (`fieldErrors.reason`, `fieldErrors.editedMessage`) | `approvals/ApprovalPage` | proposed + conflict (C-04, C-09, C-10, C-12) |
| `dispatchApprovedAction` | `dispatchApprovedAction` | `{}`; `entityRefs: [creator]` | `succeeded` with `runRef` and receipt; or `outcomeUncertain` (`TIMEOUT_AFTER_SUBMIT`, next `reconcileRun`). A repeat returns the stored execution | `RECORD_NOT_FOUND`, `APPROVAL_REQUIRED` (not approved), `STALE_VERSION` | `approvals/ApprovalPage` | proposed |
| `requestConflictRepair` | `requestApproval` | `{ conflictId }`; `entityRefs: []` | `approvalPending` (`AWAITING_APPROVAL`, next `decideApproval`). Neither system is changed | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` | `settings/ReconciliationPage` | proposed |
| `revealCustomerDetails` | `controlRun` | `{ orderRef, reason }`; `entityRefs: []` | `succeeded` with an audit entry as `actionRef` (values are synthetic placeholders) | `SOURCE_AUTHORITY_DENIED`, `RECORD_NOT_FOUND`, `VALIDATION_FAILED` | `operations/CustomerReveal` | proposed (the operation `controlRun` is borrowed; THO-283 should name a reveal operation) |
| `pauseRun` | `controlRun` | `{ control: "pause" }` and top-level `runRef` | the run's own state (`paused`, or unchanged `outcomeUncertain`) | `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | conflict (C-01) |
| `lookup` | `reconcileRun` | `{ request: "lookup" }` and top-level `runRef` | the run's current state, reason code carries the lookup result (`sourceReceiptFound`, `confirmedNotExecuted`, `stillUnknown`). Also the capability name on `runDetail`: `available` only while the outcome is uncertain | `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | proposed (C-03 resolved) |
| `recordConfirmedSent` | `reconcileRun` | `{ request: "recordConfirmedSent" }` and top-level `runRef` | `succeeded` with the source receipt | `OUTCOME_UNCERTAIN` (no verified receipt; `executionCertainty: uncertain`), `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | proposed |
| `freshAttempt` | `reconcileRun` | `{ request: "freshAttempt" }` and top-level `runRef` | `queued`. Also the capability name on `runDetail`: only while the outcome is uncertain, `available`, or `held` (`EVIDENCE_REQUIRED`) until a not-executed result is confirmed | `OUTCOME_UNCERTAIN` (not proven failed), `RECORD_NOT_FOUND`, `STALE_VERSION` | `approvals/RunPage` | proposed (C-03 resolved) |
| `retryMonitorProfile` | `controlRun` | `{ profile }` | `blocked` (`SOURCE_LOGIN_REQUIRED`, next `reconnectSource`) | `STALE_VERSION`, `VALIDATION_FAILED` | `monitor/HourlyRunPage` | conflict (C-01) |
| `requestBatchApproval` | `requestApproval` | `{ batchId, recipients, rateLabel, sampleUnits, sampleUnitCostMinor, upfrontFeeMinor, policyVersion }`; `expectedVersion` is the read's `dataVersion` | `approvalPending` (`AWAITING_DECISION`, next `decideApproval`); `approvalRef` and `manifestRef` are derived from the request, and a new key is a new approval | `MANIFEST_CHANGED`, `STALE_VERSION` (stale plan or stale policy, with the current terms in the message), `POLICY_VIOLATION` (upfront fee, flat or wrong commission, oversized sample), `RECORD_NOT_FOUND`, `VALIDATION_FAILED` (malformed manifest, finite recipients) | `acquisition/PlanView` | proposed |
| `decideTikTokSample` | `controlRun` | `{ batchId, sampleId, decision: approve \| decline }` | `succeeded` with a demo receipt, or `blocked` (`SOURCE_AUTHORITY_DENIED`, next `ownerHandoff`) | `MANIFEST_CHANGED` (same key, changed payload), `STALE_VERSION`, `RECORD_NOT_FOUND`, `VALIDATION_FAILED` | `recruitment/BatchPage` | proposed |
| `pauseBatch` | `controlRun` | `{ batchId }` | `paused` (`IN_FLIGHT_DRAINS`) | `STALE_VERSION`, `VALIDATION_FAILED` (already paused) | `recruitment/BatchPage` | conflict (C-01, C-09) |
| `cancelUnsent` | `controlRun` | `{ batchId, itemIds? }` | `canceled`, or `partiallySucceeded` (`SENT_OR_RUNNING_EXCLUDED`) | `STALE_VERSION`, `VALIDATION_FAILED` (nothing unsent) | `recruitment/BatchPage` | conflict (C-01) |
| `reconcileSettlement` | `requestApproval` | `{ settlementId, matches: { statementRef, groupId }[] }` | `approvalPending` (`AWAITING_REVIEW`, next `reconciliationReview`) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED` (`fieldErrors.matches`, already submitted) | `finance/SettlementPage` | conflict (C-02, C-09) |
| `requestTask` | `requestApproval` | `{ jobType, account, scope, reason }`; `expectedVersion: "v1"` is hard-coded | `approvalPending` (`AWAITING_APPROVAL`, next `decideApproval`) | `VALIDATION_FAILED` (`fieldErrors` per field) | `settings/AutomationsPage` | conflict (C-02, C-04) |
| `requestStockTransfer` | `requestApproval` | Native: `{scope:{home?,sku?,windowRef?},sku,windowRef,from,to,units,reasonCode}` bound to `ss1-` version; positive whole units. Historical demo retains `{from,to,units,reason}`. | Native durable local `approvalPending`; exact actor/key receipt, no physical reservation or transfer. | `STALE_VERSION`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `QUOTA_OR_STOCK_HOLD`, `STOCK_BASIS_UNKNOWN`, `STOCK_CONFLICT`, `RECEIPTS_MISSING` | `inventory/StockSupportProposal` | native proposal; J04/J15 execution held |
| `requestSupportHandoff` | `requestApproval` | `{caseId,reasonCode}` bound to current scoped case and `ss1-` version | Durable local `approvalPending`; exact actor/key receipt. No Intercom write, refund or replacement. | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED`, `IDEMPOTENCY_CONFLICT`, `CASE_HANDOFF_HELD` | `inventory/StockSupportProposal` | native proposal; J04/J16 execution held |
| `previewOperationsControl` | `previewAction` | `{kind,targetRef,reason,itemRefs?}`; exact finite source aliases, named actor, provider account/version, `oc1-` basis and original key | Immutable application intent delegates to existing J04 preview. Exact readback opens its approval route. No decision, dispatch, repair, permission grant or activation occurs here. | Current named/source permission, original-key conflict, version/selection change and missing compiled owner holds | `settings/NativeOperationsControls` | canonical source-guarded preview; provider execution remains separately gated |
| `proposeOperationsReview` | `requestApproval` | Historical `{kind,targetRef,reason}` with exact scope/actor and `oc1-` version | Existing immutable local receipts remain readable. The current native UI creates canonical previews instead; a historical local receipt cannot become approval authority. | `SOURCE_CHANGED`, `TASK_PERMISSION_UNVERIFIED`, `TASK_BUDGET_EXCEEDED`, `TAKEOVER_HELD`, `RECONCILIATION_INCOMPLETE`, `REPAIR_OWNERSHIP_HELD`, `PERMISSION_EVIDENCE_UNVERIFIED` | historical controls adapter | preserved local proposal history |
| `refreshOperationsHealth` | `refreshObservation` | `{targetRef}` with exact opaque binding, actor, current `oc1-` version and stable key | Existing bounded J14 observation only. Succeeded requires its actual current observation; unconfigured/denied/held and uncertain states retain their own receipts/reasons. No permission grant or business dispatch. | `STALE_VERSION`, `IDEMPOTENCY_CONFLICT`, source/health permission and target holds | `settings/NativeHealthCheck` | native bounded source read; existing probe/activation/lease authority applies |
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
| `closePeriod` | `held` (the blockers of the period, for example `UNRESOLVED_DIFFERENCE`, `CPA_SIGN_OFF_PENDING`, `EXPORT_INCOMPLETE`; `CLOSE_OWNER_ACTION_REQUIRED` if none is named) or `unsupported` (`ALREADY_CLOSED`) | `periodClose`, `closePackage` | `finance/CloseReconciliationPage` | proposed |
| `closeReturn` | `held` (`RECEIPTS_MISSING`) | `returnDetail` | `operations/ReturnPage` | proposed |
| `enableFlow` | `held` (`PROVIDER_NOT_SELECTED`) | `emailFlow` | none | proposed |
| `enableSchedule` | `held` (`CONNECTION_UNVERIFIED`) | `scheduleDetail` | none | proposed |
| `executePayment` | `held` (`FOUNDER_APPROVAL_PENDING`) | `payableDetail` | `finance/PayablePage` | proposed |
| `holdCandidate` | `held` (`HISTORICAL_SNAPSHOT`) | `assessmentRecord` | none | proposed |
| `markWatched` | `unverified` (`PLAYBACK_UNVERIFIED`) | `evidenceRecord` | `acquisition/EvidencePage` | proposed |
| `openEmailTool` | `unverified` (`PROVIDER_NOT_SELECTED`) | `lifecycleOverview` | none | proposed |
| `payCommission` | `unsupported` (`PROVIDER_OWNS_PAYOUT`) | `settlementDetail` | none | proposed |
| `purchaseReward` | `unverified` (`OWNER_APPROVAL_PENDING`, `PROVIDER_ACCESS_UNVERIFIED`) | `offerRewards` | none | proposed |
| `recordDecision` | `unverified` (`DEMO_NO_DISPATCH`) | every analytics view | none | proposed |
| `recordDisagreement` | `held` (`NO_REVIEW_ON_FILE`) until a first review exists, then `available` | `evidenceRecord` | `acquisition/EvidenceDisputes` | proposed |
| `recordPermissionEvidence` | `available` | `channelCapabilities` | `settings/CapabilitiesPage` | conflict (C-15) |
| `reopenCase` | `unsupported` (`INTERCOM_OWNS_CASES`) | `supportWorkspace` | none | proposed |
| `requestReport` | `unverified` (`DEMO_NO_DISPATCH`) | `overviewSummary` | none | proposed |
| `saveEvidenceDraft` | `available` | `evidenceRecord` | `acquisition/EvidencePage` | conflict (C-15) |
| `saveFlowDraft` | `available` | `emailFlow` | none | conflict (C-15) |
| `saveOfferDraft` | `available` | `offerDraft` | none | conflict (C-15) |
| `saveScheduleDraft` | `available` | `scheduleDetail` | `settings/SchedulePage` | conflict (C-15) |
| `sendInvitation` | `unverified` (`SOURCE_ACCESS_UNVERIFIED`) (demo); native `denied` (`REVIEWER_REQUIRED`) for a reader, `held` (`INVITATION_ACTIONS_NOT_CONNECTED`) for a reviewer | `invitationDraft` | `recruitment/InvitationPage` | proposed |
| `startLiveDiscovery` | `unverified` (`SOURCE_ACCESS_UNVERIFIED`) | `discoverySummary` | `acquisition/DiscoveryPage` | proposed |
| `takeOverTask` | `held` (`TAKEOVER_NOT_ASSIGNED`) | `automationRuns` | none | proposed |

Action kinds that screens send are also carried as capabilities: `cancelUnsent`, `decideApproval`, `dispatchApprovedAction`, `pauseBatch`, `pauseRun`, `lookup`, `freshAttempt`, `reconcileSettlement`, `recordConfirmedSent`, `recordShippingDecision`, `prepareReturnTask`, `requestStockTransfer`, `requestTask`, `retryMonitorProfile`, and the seven collaboration commands.

Native sandbox action added in the review-completion increment:

| Action kind | Operation and binding | Result and owner |
| -- | -- | -- |
| `proposeCollaborationReview` | `requestApproval`; typed collaboration/kind/reason and optional exact deliverable/submission/outcome; empty entity refs and null approval/manifest/run | Durable local `approvalPending` proposal; J04 decision/dispatch held. `collaboration/NativeCollaboration`; see `collaboration-workflow.md`. |

### Native action foundation variants

| Action kind | Operation | Payload | Result | Holds | Sent by | Stage |
| -- | -- | -- | -- | -- | -- | -- |
| `requestApproval` | `requestApproval` | `{}` plus exact approval/manifest/version | recorded request; no dispatch | current named/source approval holds | native approval | native |
| `reconcileApproval` | `requestApproval` | `{}` plus original exact approval/manifest/version | current source readback; no dispatch | original persistence uncertainty | native approval | native |
| `resumeRun` | `controlRun` | `{ control: "resume" }` plus top-level run reference/version | original run-control receipt | current owner/version/lease holds | native run | native |
| `exportLedger` | `exportSnapshot` | exact snapshot filters and CSV format; null approval/manifest/run input | actual artifact/job receipt | source permission, completeness, expiry | typed ledger export | native source-bound |
| `recordLaunchReadiness` | `recordSourceDecision` | exact scoped source reference/version, verdict/date/rationale/evidence | verified Notion record receipt; no release | named founder, phase, source and Go gates | native launch control | native source-bound |

| `previewFulfillmentDecision` | `previewAction` | exact source kind/target/plan/reason with version and original key | canonical approval preview | named actor, exact source plan, prior uncertainty and duplicate-plan holds | `operations/NativeFulfillmentControl` | native source-bound |

## Resource kinds

Sent by a screen through `useSave`. The request has no `actionKind`, so the demo adapter picks a service from `resourceKind` and then from a prefix of `resourceRef`.

| Resource kind | Status | `resourceRef` | Payload | Errors | Sent by |
| -- | -- | -- | -- | -- | -- |
| `actionDraft` | contract | the offer id; `expectedVersion` is the record version | `OfferDraftPayload` (commission, compensation, provider, sample shipping, upfront fee in minor units, and others) | `RECORD_NOT_FOUND`, `STALE_VERSION`, `POLICY_VIOLATION` (`fieldErrors`); reason code `NO_CHANGE` on an identical save | `scorecards/OfferPage` |
| `configurationDraft` | contract; native resource dispatch explicit | `schedule-<opaque job reference>` or exactly `flow-early-access`/`flow-abandoned-checkout`/`flow-review-request` | Native schedule schema or strict flow event/timing/timezone/template catalog references and local title. Lifecycle canonical save `record` contains the full immutable scoped SaveReceipt, whose nested `record` is the DraftRecord. | `RECORD_NOT_FOUND`, `STALE_VERSION`, `VALIDATION_FAILED`, source/catalog/permission holds; `NO_CHANGE` | `settings/SchedulePage`, `lifecycle/NativeEmailFlowPage` |
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
| `CREATOR_IDENTITY_CHANGED` | conflict | An existing offer cannot be rebound to a different creator. |
| `IDEMPOTENCY_KEY_REUSED` | conflict | The signed-in reviewer retried a command key with different input. |
| `INVALID_INPUT` | validation | The service rejected an invalid request or schema before writing. |
| `INVALID_OFFER_TERMS` | validation | The offer failed the terms or provider contract. |
| `VERSION_CONFLICT` | conflict | The requested offer revision is not current; reload before modifying it. |
| `INVALID_CURSOR` | validation | `demoCollaborationEvidence` |
| `INVALID_MONITOR_CURSOR` | validation | The monitor cursor belongs to a different view, role, scope, filter or limit, or cannot be authenticated. |
| `MONITOR_CURSOR_EXPIRED` | conflict | Refresh the expired monitor snapshot before continuing. |
| `MONITOR_SNAPSHOT_CHANGED` | conflict | Source membership or snapshot basis changed; do not append mixed pages. |
| `MONITOR_SOURCE_INVALID` | unavailable | The trusted monitor response failed source/schema validation. |
| `INVALID_REQUEST` | validation | Unsupported source view/filter or malformed selection. |
| `IDEMPOTENCY_CONFLICT` | conflict | A local request key was reused with different canonical parameters. |
| `STOCK_BASIS_UNKNOWN` | capabilityHold | Physical, reservation or storefront source proof is missing. |
| `STOCK_CONFLICT` | conflict | Authoritative balance or reservation evidence disagrees. |
| `RECEIPTS_MISSING` | capabilityHold | A source movement lacks its qualifying receipt. |
| `CASE_HANDOFF_HELD` | capabilityHold | The source case does not currently permit human handoff. |
| `LIFECYCLE_SOURCE_UNCONFIGURED` | unavailable | No trusted lifecycle source is configured. |
| `LIFECYCLE_SOURCE_UNAVAILABLE` | unavailable | The configured lifecycle source could not be read. |
| `LIFECYCLE_SOURCE_INVALID` | unavailable | Source/schema/provenance validation failed. |
| `LIFECYCLE_SOURCE_CONFLICT` | conflict | Source facts conflict under their version or observation basis. |
| `LIFECYCLE_SOURCE_REGRESSED` | conflict | A newer source observation is already retained. |
| `FLOW_CATALOG_UNAVAILABLE` | capabilityHold | No current same-flow event/timing/template catalog exists. |
| `FLOW_CATALOG_SELECTION_INVALID` | validation | The submitted choice does not match the current flow catalog. |
| `FLOW_DRAFT_DENIED` | forbidden | Current source authority forbids drafting this flow. |
| `SETUP_FLOW_READ_ONLY` | forbidden | Setup is a source-owned read-only flow. |
| `PERSISTENCE_UNCERTAIN` | outcomeUncertain | Reconcile the exact request before issuing another save. |
| `INVALID_CONTROL_REFERENCE` | validation | An opaque scoped control reference could not be verified. |
| `SOURCE_CHANGED` | conflict | Source facts changed before the proposal could commit. |
| `TASK_PERMISSION_UNVERIFIED` | capabilityHold | Task account/action authority is unverified. |
| `TASK_BUDGET_EXCEEDED` | resourceHold | A finite task plan exceeds registered bounds. |
| `TAKEOVER_HELD` | capabilityHold | Current assignment/recovery evidence does not permit takeover review. |
| `RECONCILIATION_INCOMPLETE` | capabilityHold | Source/mirror comparison coverage is incomplete. |
| `REPAIR_OWNERSHIP_HELD` | capabilityHold | The discrepancy lacks permitted source-owned repair authority. |
| `PERMISSION_EVIDENCE_UNVERIFIED` | capabilityHold | Submitted source evidence is not independently verified permission. |
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

Historical demo coverage (native coverage is recorded separately): `UNAUTHENTICATED`, `LEASE_CONFLICT`, `CAPABILITY_UNVERIFIED`, `CAPABILITY_UNSUPPORTED`, `SOURCE_LOGIN_REQUIRED` (used only as a reason code), `SOURCE_UI_CHANGED`, `BUDGET_HOLD`, `RATE_LIMITED`, `TIMEOUT`. They are in the map, so screens map them to a category, but no screen behavior for them has been exercised.

Categories (`ErrorCategory`): `unauthenticated`, `forbidden`, `notFound`, `validation`, `conflict`, `approvalHold`, `capabilityHold`, `resourceHold`, `rateLimited`, `unavailable`, `outcomeUncertain`, `replayed`, `unknown`. `replayed` has no code mapped to it. `unknown` is the fallback for a code not in the map. `unauthenticated` and `forbidden` clear protected data (`mustClearProtectedData`).

Error body (`AdapterErrorBody`, in `errors.ts`, not in `contract.ts`): `code`, `message`, `requestId`, `correlationId`, `retryable`, `retryAfterMs`, `fieldErrors?`, `currentVersion?`, `executionCertainty?`. No demo path sets `retryAfterMs`; `retryable` is true only for `SOURCE_UNAVAILABLE`.

Native review-completion error codes (same adapter catalogue):

| Error code | Category | Recovery |
| -- | -- | -- |
| `ASSET_EVIDENCE_UNVERIFIED` | unavailable | Verify the registered asset receipt. |
| `SOURCE_VERSION_CHANGED` | conflict | Read current source membership and submission versions. |
| `SOURCE_COVERAGE_INCOMPLETE` | capabilityHold | Complete the source read before exact request reconciliation. |
| `OBSERVATION_OUTSIDE_REVIEW` | validation | Use a source-observed interval. |
| `EVIDENCE_REVIEW_LIMIT` | resourceHold | Inspect the exact revision's immutable entry limit. |
| `INVALID_COLLABORATION_REFERENCE` | validation | Reopen the scoped source link. |
| `INVALID_PROPOSAL_TARGET` | validation | Read the exact current deliverable/submission. |
| `SOURCE_RESPONSE_INVALID` | unavailable | Verify the native source response. |
| `SOURCE_TIME_UNVERIFIED` | unavailable | Verify the source checked time. |
| `SOURCE_STALE` | conflict | Refresh source evidence before proposing changes. |
| `SOURCE_SCOPE_DENIED` | forbidden | Clear protected data and check source access. |
| `SOURCE_COVERAGE_PARTIAL` | capabilityHold | Complete the source read. |
| `SUBMISSION_UNVERIFIED` | capabilityHold | Verify the registered submission version. |
| `OUTREACH_SUPPRESSED` | capabilityHold | Preserve suppression. |
| `SUPPRESSION_UNVERIFIED` | capabilityHold | Verify outreach eligibility. |
| `RELATIONSHIP_CLOSED` | capabilityHold | Preserve the closed relationship. |
| `POSTING_OBLIGATION_UNVERIFIED` | capabilityHold | Verify accepted posting terms before a reminder. |
| `CREATOR_PLATFORM_CURSOR_INVALID` | conflict | Reload the same view and filters. |
| `CREATOR_PLATFORM_SCOPE_MISMATCH` | forbidden | Clear protected data and check account scope. |
| `FUNNEL_NARROW_COHORT_WINDOW` | validation | Narrow cohort dates rather than truncating. |


### Native approval, domain-action and dispatch errors

These source-derived catalogue entries preserve distinct typed recovery categories. Their implementation tests use fictional adapters; source-qualified permission and production release remain separate.

| Error code | Category | Recovery |
| -- | -- | -- |
| `SOURCE_ACTION_BOUNDARY_REQUIRED` | forbidden | Use the protected native read/action boundary; legacy routes cannot expose or control source-owned jobs. |
| `ACTION_SCOPE_DENIED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `ACTOR_AUTHORITY_FENCE_UNCONFIGURED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `ACTOR_PROOF_INVALID` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `APPROVAL_CHANNEL_REQUIRED` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_CURRENT_AUTHORITY_UNAVAILABLE` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_CURRENT_SOURCE_UNVERIFIED` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_INGRESS_UNCONFIGURED` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `APPROVAL_NOT_CURRENT` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_POLICY_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `APPROVAL_POLICY_UNAVAILABLE` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `APPROVAL_PROOF_EXPIRED` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_PROOF_UNVERIFIED` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_REQUEST_UNVERIFIED` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `APPROVAL_SOURCE_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `APPROVAL_SOURCE_UNAVAILABLE` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `APPROVAL_VERSION_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `AUTHORITY_REQUIRED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `DISPATCH_APPROVAL_BINDING_MISMATCH` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_BATCH_BOUND` | validation | Use the exact bounded registered envelope and manifest membership. |
| `DISPATCH_BUDGET_REQUIRED` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_CLOSURE_ATTEMPT_MISMATCH` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_GRANT_ALREADY_CLAIMED` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_HANDLER_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_IDEMPOTENCY_KEY_REUSED` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_IDEMPOTENCY_UNSUPPORTED` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `DISPATCH_ITEM_ALREADY_IN_RUN` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_ITEM_REUSED` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_ITEM_SPEND_BOUND` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_ITEM_UNIT_BOUND` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_MIXED_MANIFEST_OR_BINDING` | validation | Use the exact bounded registered envelope and manifest membership. |
| `DISPATCH_NO_ACTIVE_LEASE` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_POLICY_STALE` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `DISPATCH_PRIOR_OUTCOME_UNCERTAIN` | outcomeUncertain | Reconcile the original source key and attempt; do not mint a new effect. |
| `DISPATCH_PROVIDER_AUTHORITY_UNKNOWN` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `DISPATCH_PROVIDER_BINDING_MISMATCH` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_RECEIPT_CONFLICT` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_RECEIPT_REUSED` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_RECONCILIATION_BINDING_MISMATCH` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `DISPATCH_RESOURCE_AUTHORITY_UNAVAILABLE` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_RESOURCE_POLICY_MISMATCH` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_RESOURCE_PROOF_INVALID` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_SCOPE_DENIED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `DISPATCH_SHARED_QUOTA_REQUIRED` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_SHARED_QUOTA_UNVERIFIED` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_STOCK_REQUIRED` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `DISPATCH_VERSION_CONFLICT` | conflict | Reconcile the original immutable request/version before changing it. |
| `DISPATCH_WORKER_AUTHORITY_INVALID` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `DISPATCH_WORKER_UNCONFIGURED` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `EXACT_MANIFEST_ITEM_REQUIRED` | validation | Use the exact bounded registered envelope and manifest membership. |
| `EXPORT_ACCESS_DENIED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `EXPORT_EXPIRED` | conflict | Reconcile the original immutable request/version before changing it. |
| `EXPORT_RECONCILIATION_REQUIRED` | outcomeUncertain | Reconcile the original source key and attempt; do not mint a new effect. |
| `EXPORT_REQUEST_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `EXPORT_SNAPSHOT_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `EXPORT_SOURCE_INVALID` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `EXPORT_SOURCE_UNCONFIGURED` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `EXPORT_TOO_LARGE` | resourceHold | Obtain current source-issued allocation or lease; do not infer remaining capacity. |
| `LAUNCH_GO_HELD` | approvalHold | Read current exact approval, policy, phase and source evidence. |
| `NAMED_ACTOR_UNCONFIGURED` | forbidden | Restore the current named actor/source authority; clear protected data. |
| `PREVIEW_SELECTION_MISMATCH` | validation | Use the exact bounded registered envelope and manifest membership. |
| `READINESS_BASIS_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `READINESS_PRIOR_OUTCOME_UNCERTAIN` | outcomeUncertain | Reconcile the original source key and attempt; do not mint a new effect. |
| `READINESS_RECEIPT_CONFLICT` | outcomeUncertain | Reconcile the original source key and attempt; do not mint a new effect. |
| `READINESS_SOURCE_INVALID` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `READINESS_SOURCE_UNCONFIGURED` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `SOURCE_ACTION_UNCONFIGURED` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `SOURCE_ACTION_UNSUPPORTED` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `SOURCE_CAPABILITY_UNAVAILABLE` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `SOURCE_EVENT_CHANGED` | conflict | Reconcile the original immutable request/version before changing it. |
| `SOURCE_OUTCOME_UNCERTAIN` | outcomeUncertain | Reconcile the original source key and attempt; do not mint a new effect. |
| `SOURCE_RECONCILIATION_CAPABILITY_UNAVAILABLE` | capabilityHold | Resolve the registered account/action capability; never bypass a denial. |
| `SOURCE_RECONCILIATION_UNAVAILABLE` | unavailable | Restore the configured source/readback boundary; no provider success is inferred. |
| `SOURCE_REGRESSED` | conflict | Reconcile the original immutable request/version before changing it. |
| `SOURCE_VERSION_CONFLICT` | conflict | Reconcile the original immutable request/version before changing it. |

## Vocabularies the contract does not define

### `nextAction.kind` returned on action responses

| Kind | Returned by |
| -- | -- |
| `approval` | `demoOps` |
| `decideApproval` | `demoCollaboration`, `demoSettings` |
| `dispatchApprovedAction` | `demoApprovals` |
| `ownerHandoff` | `demoBatch` |
| `reconcileRun` | `demoApprovals` |
| `reconciliationReview` | `demoFinance` |
| `reconnectSource` | `demoMonitor` |
| `sourceReceipt` | `demoOps` |

### Reason codes

Free strings on `ActionResponse.reasonCodes`, capability `reasonCodes` and `coverage.reasonCodes`. The contract has no catalogue. This table is informational and is **not** checked by the drift test; it lists the upper-case literals found next to `reasonCodes` in `src/adapter/`. Camel-case results (for example `sourceReceiptFound`) are also carried as reason codes by `reconcileRun`. Per-value `reasonCode` strings inside fixtures (for example `RATE_NOT_READ`) are a separate class and are not listed.

| Reason code | Used in (under `src/adapter/`) |
| -- | -- |
| `ALREADY_CLOSED` | `demoFinance` |
| `ALREADY_PAUSED` | `demoBatch` |
| `ALREADY_RECONCILED` | `demoApprovals` |
| `ALREADY_SUBMITTED` | `demoFinance` |
| `APPROVAL_EXPIRED` | `demoApprovals` |
| `APPROVAL_REQUIRED` | `demoScorecards` |
| `AWAITING_APPROVAL` | `demoOps`, `demoSettings` |
| `AWAITING_DISPATCH` | `demoApprovals` |
| `AWAITING_REVIEW` | `demoFinance` |
| `AWAITING_SOURCE_RECEIPT` | `demoOps` |
| `CLOSE_OWNER_ACTION_REQUIRED` | `demoFinance` |
| `CONNECTION_UNVERIFIED` | `demoSettings` |
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
| `ROLE_REQUIRED` | `demoApprovals` |
| `SOURCE_ACCESS_UNVERIFIED` | `demoAdapter` |
| `SOURCE_LOGIN_REQUIRED` | `demoMonitor` |
| `SOURCE_ROWS_DEFERRED` | `demoAdapter`, `demoAnalytics`, `demoFinance` |
| `SOURCE_STALE` | `demoOps` |
| `TAKEOVER_NOT_ASSIGNED` | `demoSettings` |
| `TIMEOUT_AFTER_SUBMIT` | `demoApprovals` |

### `executionCertainty`

Decided (Q-04): `"notApplied" | "uncertain" | "applied"`, in `contract.ts` as `executionCertaintySchema`. Required on every write error, on every `ActionResponse` and on every `SaveResourceResponse`; reads carry none. A server that omits it on a write error is read as `uncertain`, never `notApplied`; an action or save answer without it is unreadable and a write outcome is `uncertain`. The demo services and the reference server describe the command the request made, not a later dispatch (`certaintyOfState` in `contract.ts`): blocked, failed and draft answers are `notApplied`, an unknown outcome is `uncertain`, anything else is `applied`. An approved decision is `applied` (the decision is stored) and still not sent.

### `freshnessState` (D-13)

`sourceFreshness[].freshnessState` is optional in the schema: `current`, `noChange`, `partial`, `error` or `neverSynced`. The server computes it. When it is absent the client falls back to the reason-code mapping in `src/adapter/freshness.ts`: a stale reason code is `error`, no successful sync and no reason is `neverSynced`, a successful sync and no reason is `current`; `partial` and `noChange` are never guessed. **Open for the backend owner:** D-13 lists no state for "past its allowed age", so the demo reports a stale source as `error` with its reason code. Decide whether to add `stale`.

## Conflicts between screens

| ID | Conflict | Where | Suggested question for the freeze |
| -- | -- | -- | -- |
| C-01 | `controlRun` carries unrelated work. Run pause sends `{ control }` with a top-level `runRef` (Q-03); monitor retry sends `{ profile }`; batch pause and cancel send `{ batchId, itemIds? }`. The request now has a run reference field (Q-03), but monitor and batch do not use it, and the demo adapter routes by `actionKind` for three of the four. | `approvals/RunPage`, `monitor/HourlyRunPage`, `recruitment/BatchPage`; `demoAdapter.ts`, `demoApprovals.ts` | Is `controlRun` only for runs, and are batch and monitor retries separate operations? |
| C-02 | `requestApproval` is used for twelve action kinds from six pages and they answer differently. All return `approvalPending`, but the reason code is `AWAITING_APPROVAL`, `AWAITING_REVIEW`, `AWAITING_SOURCE_RECEIPT` or none, and `nextAction.kind` is `sourceReceipt`, `approval`, `reconciliationReview` or `decideApproval`. `approvalRef` is set only by collaboration. | finance, inventory, operations, settings, collaboration | One acknowledgement shape for "queued for approval"? |
| C-03 | **Resolved.** `approvals/RunPage` sent `actionKind` `lookup` and `freshAttempt` but gated the buttons on capabilities named `lookupSource` and `requestFreshAttempt`. The native service names the run capability `lookup` (`src/creator-agent/server.ts`, `runDetail` capabilities `pauseRun`, `cancelUnsent`, `resumeRun`, `lookup`) and accepts `reconcileRun` action kinds `lookup`, `recordConfirmedSent` and `freshAttempt` (`src/creator-agent/actions/wire.ts`), so the request name is canonical: `RunPage` now gates on `lookup` and `freshAttempt`, and `demoApprovals.ts` advertises those capability names. The demo handler still switches on `payload.request`, which carries the same name. | `approvals/RunPage.tsx`, `demoApprovals.ts` | none left; the native service does not yet advertise `recordConfirmedSent` or `freshAttempt` capabilities |
| C-04 | The record version lives in six places: `ReadResponse.dataVersion` (discovery), `data.version` (most), `data.currentVersion` (approval), `data.draftVersion` (schedule, email flow), `record.version` (evidence, offer), and `data.recorded[id]?.version` (permissions). `requestTask` sends a constant `"v1"`. Version tokens differ in shape (`v3`, `r2`, `st2`, `ex2`, `inv2`, `ret2`, `collab-v2`, `x@1`). | all action and save screens | Which field is `expectedVersion`, and is its format opaque? |
| C-05 | Filters disagree. "No filter" is `all` on most views and `both` on pipeline `source` and recruitment `networks`. The network filter is `network` on pipeline, social cat and monitor, and `networks` on recruitment. Intake source uses three vocabularies: `tiktok-affiliate` / `social-cat` (monitor), `social-cat` / `tiktok-shop` (pipeline), `tiktok` / `all` (batch). `cohort` is `first-wave` / `launch-a` on campaign funnel and `all` / `launch-a` on watchlist. Time windows are `window` (`sep-oct`, `last-30`), `days`, and `period` inside filters, while every screen passes the request's `period` as `null`. | pipeline, recruitment, batch, monitor, watchlist, campaignFunnel, fulfillmentAnalytics, periodClose | Shared filter names and values, and where a period goes. |
| C-06 | `scenario` is a filter on seven views (`commissionLedger`, `financeDashboard`, `inventoryOverview`, `operationsOverview`, `periodClose`, `returnDetail`, `supportWorkspace`). `demoOps.ts` calls it demo-only ("the live adapter never reads it"). Screens read it from the URL and send it as a filter. | the seven screens | Reject or ignore `scenario` outside demo? |
| C-07 | Ids differ between a view and its actions: filters use `shipmentId`, `returnId`, `runId`, `evidenceId`; payloads use `shipmentRef`, `returnRef`, `runRef`; the evidence save uses `evidenceRef`. `entityRefs` is `[]` on every action except approval decide and dispatch, so the field that should name the entity is unused. | operations, approvals, acquisition | What identifies the target: `entityRefs`, a payload id, or `resourceRef`? |
| C-08 | `MANIFEST_CHANGED` means "this idempotency key was reused with a different payload" in seven demo files, but its category is `conflict` and the field it is named for is `manifestRef`. (PR #37 adds a second meaning, below.) | `demoOnce.ts`, `demoApprovals.ts`, `demoEvidence.ts`, `demoFinance.ts`, `demoOps.ts`, `demoScorecards.ts` | Is there a separate code for key reuse? `replayed` has no code. |
| C-09 | "Already done" is reported three ways. Approval already decided: `APPROVAL_INVALID`. Shipping decision, return proposal, stock transfer duplicate, settlement match, pause when paused: `VALIDATION_FAILED`. Reconcile on a succeeded run: success with reason `ALREADY_RECONCILED`. | `demoApprovals.ts`, `demoOps.ts`, `demoFinance.ts`, `demoBatch.ts` | One representation for a duplicate. |
| C-10 | A wrong role is an error `SOURCE_AUTHORITY_DENIED` on `decideApproval`, a capability with state `denied` and reason `ROLE_REQUIRED` on the read, and (PR #30) a `blocked` response with reason `SOURCE_AUTHORITY_DENIED`. | `demoApprovals.ts` | Which of the three is authoritative? |
| C-11 | `fieldErrors` keys are flat names (`units`), dotted paths (`observations.0.text`), and keys not matching a form field. `POLICY_VIOLATION` and `VALIDATION_FAILED` both carry `fieldErrors`. `STALE_VERSION` carries `currentVersion` in eleven places and omits it in batch and collaboration. | demo services | Required fields of the error body per category. |
| C-12 | An approved decision was `blocked` with `AWAITING_DISPATCH`. **Resolved by Q-01**: it is now `approved`, reason `AWAITING_DISPATCH`. Rejected is `canceled`. | `demoApprovals.ts` | none left, pending the backend owner |
| C-13 | docs/design-map.md says batch pause and cancel go "with a preview" and that the preview intent waits for THO-283. No screen sends `previewAction`. | docs/design-map.md; `recruitment/BatchPage` | Is preview a separate call, or part of the action? |
| C-14 | `inspectRun` is in the contract. Runs are read through the `runDetail` view. | `approvals/RunPage` | Keep both? |
| C-15 | `useSave` sends only `resourceKind`, but capabilities gate saves by action kind (`saveEvidenceDraft`, `saveFlowDraft`, `saveOfferDraft`, `saveScheduleDraft`, `recordPermissionEvidence`). Two unrelated resources share `evidenceDraft` (video evidence and permission evidence) and two share `configurationDraft` (schedule and email flow); the demo tells them apart by a `resourceRef` prefix. An unknown `resourceKind` falls through to the evidence service. | `useSave.ts`, `demoAdapter.ts`, `demoSettings.ts`, `demoLifecycle.ts` | Map capability to resource kind, and give each resource its own kind. |
| C-16 | `useView` hard-codes `sort: []` and `page.limit: 50` with no cursor. Search is a filter (`q`) on `contentMonitor` and `tiktokBoard`. | `useView.ts`, `monitor/MonitorPage`, `creators/TikTokPage` | Server-side search, sort and paging: filters or request fields? |

## Open questions and proposals

Where each was raised, and where it is used. Status uses the same legend as above.

| ID | Question or proposal | Raised in | Used in | Status |
| -- | -- | -- | -- | -- |
| Q-01 | `ActionResponse.state` has no value for "approved, awaiting dispatch". **Decided 2026-11-04** (docs/adapter-decisions.md): add `approved`. It is not a success state. | docs/intake.md; docs/adapter-decisions.md | `contract.ts`, `demoApprovals.ts`, `liveAdapter.ts` (`assertAuthoritative`), `approvals/ApprovalPage`, `approvals/shared.tsx` | decided, implemented in the front end, not verified against a service |
| Q-02 | The error catalogue has no not-found code. **Decided 2026-11-04**: `RECORD_NOT_FOUND`, category `notFound`, returned only for a record inside the verified scope; outside it the answer is `FORBIDDEN`. | docs/intake.md; docs/adapter-decisions.md | raised by ten demo files; `errors.ts` | decided, implemented in the front end, not verified against a service |
| Q-03 | `ActionRequest` has no run reference for `controlRun` and `reconcileRun`. **Decided 2026-11-04**: an optional top-level `runRef: string \| null`. The payload no longer carries it, and the live adapter refuses `controlRun` and `reconcileRun` without one (`VALIDATION_FAILED`, `notApplied`, nothing sent). | docs/intake.md; docs/adapter-decisions.md | `contract.ts`, `useAction.ts`, `approvals/RunPage`, `demoApprovals.ts`, `liveAdapter.ts` | decided, implemented in the front end, not verified against a service (C-01 remains for monitor and batch `controlRun`) |
| Q-04 | `executionCertainty`. **Decided 2026-11-04**: `notApplied`, `uncertain`, `applied`; required on every write error and on every `ActionResponse` and `SaveResourceResponse`. `notApplied` only when the server holds proof nothing reached the provider. | docs/intake.md; docs/adapter-decisions.md | `contract.ts`, `wire.ts`, `errors.ts`, `approvals/shared.tsx` (`ActionError`), demo services, `liveAdapter.ts` | decided, implemented in the front end, not verified against a service |
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

## Merged PRs outside the drift check

On 2026-11-04 this section listed PRs #25, #26, #28, #29, #30, #32, #33 and #35 to #39 as open. All of them are now merged into `main`. The names they added (`reviewerAssessment`, `recordDisagreement`, `offerRewards`, `pipelineBranches`, `requestBatchApproval`, `decideTikTokSample`, `launchReconciliation`, `opsHealth`, `metricDictionary`, `closePackage`, `purchaseReward`) are rows in the checked tables above.

One exception remains. The six PR #37 action kinds are handled by `demoPolicy.ts` (`POLICY_ACTIONS`), but no screen sends them and `scripts/adapter-freeze-extract.mjs` does not see them, so they are not in the checked tables. Their detail is kept here and is **not** checked by the drift test.

| PR | Adds | Detail | Conflicts with |
| -- | -- | -- | -- |
| #37 | Action kinds `createOffer`, `editOffer`, `importOffers`, `dispatchOffer`, `recordCreatorReply`, `changeAcquisitionPolicy` | Demo service `demoPolicy.ts`, handled by `actionKind`; no screen sends them yet (tests only, with `operation` set to the action kind). Payloads `{ offerId?, terms }`, `{ offers[] }`, `{ creatorRef, sourceRef, text }`, a partial policy with `version`. Answers `draft`, `succeeded` (`POLICY_VERSION_CHANGED`) or `blocked` (`TERMS_MISMATCH`, `CREATOR_FEE_REQUEST`; next `reviewTermsMismatch`). Errors `POLICY_VIOLATION` (`fieldErrors`, dotted per-row keys; also an approved dispatch whose terms never passed the policy in force, or whose terms can't be read, which fails closed), `VALIDATION_FAILED` (bad payload shape or policy value), `STALE_VERSION` (offer actions check `expectedVersion`; an unstored offer is `v1`, an edit moves it), `FORBIDDEN` (`changeAcquisitionPolicy` is founder-only; the message carries `AUTHORITY_REQUIRED` because the error body has no reason field), and `MANIFEST_CHANGED` when an approval was made under an older policy and is dispatched after a conflicting change, or when a key is reused with a changed payload. A replay of a dispatch that already ran returns its stored result, not a policy error. Eligibility blocker codes inside `fieldErrors` messages: `UPFRONT_FEE_PROHIBITED`, `GUARANTEED_FEE_PROHIBITED`, `PAID_COMPONENT_PROHIBITED`, `PAID_OR_HYBRID_PROHIBITED`, `GIFTED_ONLY_PROHIBITED`, `COMMISSION_REQUIRED`, `COMMISSION_ABOVE_CAP`, `PER_SALE_FIXED_ABOVE_CAP`, `RELATIONSHIP_NOT_COMMISSION_ONLY`, `SAMPLE_ABOVE_CAP`, `INVALID_AMOUNT` (not error codes). | C-08 (a second meaning of `MANIFEST_CHANGED`), C-11 |

## Native review-completion increment — November 6

The historical demo contracts above remain reproduction references. The native sandbox increment uses the existing adapter envelope and the versioned source schemas described in `review-completion-api.md`, `evidence-review.md`, `creator-platform-views.md` and `collaboration-workflow.md`.

| Surface | Native contract |
| -- | -- |
| `evidenceRecord` | Exact creator/post plus optional immutable run. `sourceReview` binds media, evidence, policy, model, terms and annotation versions. |
| `evidenceDraft`, `reviewerAssessment` | Append-only observations or disagreements, with the exact source basis and `er-` expected version. No source review completion or source fact overwrite. |
| `socialCatBoard`, `tiktokBoard`, `socialCatDashboard`, `tiktokDashboard` | Saved canonical funnel projections with owner/search/network/cohort filters, scoped fixed-membership cursors and unknown provider-wide coverage. |
| `collaborationDetail`, `collaborationEvidence` | Same canonical or scoped opaque collaboration reference; authoritative source membership and exact saved asset/portfolio evidence stay separate. |
| `proposeCollaborationReview` | Operation `requestApproval`; empty `entityRefs`, null approval/manifest/run, exact source/proposal version and typed collaboration/deliverable/submission intent. Returns only a durable local `approvalPending` proposal, with `LOCAL_PROPOSAL_ONLY`; J04 decision/dispatch remains held. |

New native error classifications and recovery:

| Code | Category | Recovery |
| -- | -- | -- |
| `OBSERVATION_OUTSIDE_REVIEW` | validation | Choose an interval covered by the recorded source method. |
| `EVIDENCE_REVIEW_LIMIT` | resourceHold | Inspect immutable history; the exact basis has reached its entry limit. |
| `INVALID_COLLABORATION_REFERENCE` | validation | Reopen the collaboration from its current scoped list. |
| `INVALID_PROPOSAL_TARGET` | validation | Read the current deliverable/submission before proposing again. |
| `SOURCE_RESPONSE_INVALID` | unavailable | Verify the source response; never substitute fixtures. |
| `SOURCE_TIME_UNVERIFIED` | unavailable | Obtain a source observation with a valid checked time. |
| `SOURCE_STALE` | conflict | Refresh source evidence before a new proposal. |
| `SOURCE_SCOPE_DENIED` | forbidden | Clear protected data and verify source access. |
| `SOURCE_COVERAGE_PARTIAL` | capabilityHold | Complete the source read before proposing changes. |
| `SUBMISSION_UNVERIFIED` | capabilityHold | Obtain the exact registered submission version. |
| `OUTREACH_SUPPRESSED` | capabilityHold | Preserve suppression; no outbound proposal may bypass it. |
| `SUPPRESSION_UNVERIFIED` | capabilityHold | Verify suppression status before outreach. |
| `RELATIONSHIP_CLOSED` | capabilityHold | Preserve the closed relationship and its history. |
| `POSTING_OBLIGATION_UNVERIFIED` | capabilityHold | Verify accepted posting terms before a reminder. |
| `CREATOR_PLATFORM_CURSOR_INVALID` | conflict | Reload the list for the same view and filters. |
| `CREATOR_PLATFORM_SCOPE_MISMATCH` | forbidden | Clear protected data and check account scope. |
| `FUNNEL_NARROW_COHORT_WINDOW` | validation | Narrow the cohort date range instead of silently truncating. |

`EVIDENCE_DISPUTED` is a qualification reason, not an HTTP success or permission. Identical resaves and revision-label changes cannot resolve it. Mutations retain explicit `executionCertainty`; an uncertain save requires independent readback before another request.

## Native finance and payable reads (THO-367)

Stage: **sandbox, unconfigured source.** The creator agent serves the eight finance view keys at the authenticated `/v1/read` boundary through `src/creator-agent/finance/`. No accounting or provider reader exists in this repository, so nothing here is integration-verified, and no Pay, reconcile, close, sign-off or export path is added.

| Surface | Native contract |
| -- | -- |
| `financeDashboard`, `commissionLedger`, `monthsHistory`, `reportManifest` | Filters `{}` exactly. A configured reader's record must parse with the view's schema in `viewSchemas/finance.ts`. `record: null` is `dataState: "empty"` only when the source counted zero expected rows. |
| `periodClose`, `closePackage` | Filters `{ period: "YYYY-MM" }`. The source period and the record's `period` must equal the requested period. A source `null` is `RECORD_NOT_FOUND`. |
| `settlementDetail`, `payableDetail` | Filters `{ settlementId }` or `{ payableId }`. The record id must equal the requested id. A source `null` is `RECORD_NOT_FOUND`. |
| All eight | `scenario`, `fixture` and any other filter are refused with 400 `INVALID_INPUT` (D-11). A non-null cursor is 400 `INVALID_CURSOR`. `period` and `sort` are `null` and `[]`. Capabilities are `denied` with `REVIEWER_REQUIRED` for a reader. For a reviewer, `reconcileSettlement`, `executePayment` and `closePeriod` are `held` with `FINANCE_ACTIONS_NOT_CONNECTED`, and `payCommission` is `unsupported` with `PROVIDER_OWNS_PAYOUT`. Nothing is cached between reads. |

Outcomes (error bodies use the D-14 envelope with `executionCertainty: "notApplied"`):

| Situation | HTTP and code | Reason codes |
| -- | -- | -- |
| No reader configured (the default) | 503 `INTEGRATION_PENDING`, no `data` | `FINANCE_SOURCE_UNCONFIGURED` |
| Reader threw or returned `null` | 503 `SOURCE_UNAVAILABLE` | `FINANCE_SOURCE_UNAVAILABLE` |
| Reader exceeded 10 s | 504 `TIMEOUT` | `FINANCE_SOURCE_TIMEOUT` |
| Reader denied (401/403), or answered for another scope | 403 `SOURCE_AUTHORITY_DENIED`, neutral message, no hints | none |
| Invalid snapshot, wrong view, period or record address, future observation | 502 `SOURCE_RESPONSE_INVALID` | `FINANCE_SOURCE_INVALID`, `FINANCE_SOURCE_VIEW_MISMATCH`, `FINANCE_PERIOD_MISMATCH`, `FINANCE_RECORD_ADDRESS_MISMATCH`, `FINANCE_RECORD_INVALID`, `SOURCE_TIME_UNVERIFIED` |
| Older than the source lease or the 24-hour D-13 accounting ceiling | 200 `dataState: "stale"`, `coverage.complete: false`, `sourceFreshness[0].staleReasonCode` | `FINANCE_SOURCE_STALE` |
| Partial source coverage | 200 `dataState: "partial"`, counts as given (`null` stays `null`) | the source's own reason codes |
| Client disconnected | the source signal is aborted; the 499 `REQUEST_CANCELLED` answer reaches no one | none |

`/v1/capabilities` reports `financeReads: { sourceAuthority: "notConnected", paymentExecution: "notConnected", closeExecution: "notConnected", exportExecution: "notConnected" }` until a reader is injected.

## Native operations reads (THO-367)

Stage: **sandbox, unconfigured source.** The creator agent serves the eight THO-301 operations view keys at the authenticated `/v1/read` boundary through `src/creator-agent/operationsReads/`. No order, shipping or returns reader exists in this repository, so nothing here is integration-verified. No shipping decision, return task, close or customer reveal is executed: `recordShippingDecision` and `prepareReturnTask` remain approval-request intents owned elsewhere, and no dispatch is added. `shippingHub`, `inventoryOverview` and `supportWorkspace` keep their existing handlers.

| Surface | Native contract |
| -- | -- |
| `operationsOverview`, `operationsShipping`, `opsHealth` | Filters `{}` exactly. `record: null` is `dataState: "empty"` only when the source counted zero expected rows. |
| `fulfillmentAnalytics` | Filters `{ days: 7 \| 14 }` (a number). The record's `periodDays` must equal `days`. |
| `orderDetail`, `orderCustomer` | Filters `{ orderId }`. The record's `orderRef` must equal it. A source `null` is `RECORD_NOT_FOUND`. |
| `shippingException` | Filters `{ shipmentId, exceptionId }`. Both must match the record. A source `null` is `RECORD_NOT_FOUND`. |
| `returnDetail` | Filters `{ returnId }`. The record's `returnRef` must match. A source `null` is `RECORD_NOT_FOUND`. |
| All eight | A configured reader's record must parse with the view's schema in `viewSchemas/ops.ts`, and only that schema's output is returned. `scenario`, `fixture` and any other filter are refused with 400 `INVALID_INPUT` (D-11) before the source is read. A non-null cursor is 400 `INVALID_CURSOR`. `period` and `sort` are `null` and `[]`. Capabilities are `denied` with `REVIEWER_REQUIRED` for a reader; for a reviewer `recordShippingDecision`, `prepareReturnTask`, `closeReturn` and `revealCustomerDetails` are `held` with `OPERATIONS_ACTIONS_NOT_CONNECTED`. Nothing is cached between reads. |

Outcomes (error bodies use the D-14 envelope with `executionCertainty: "notApplied"`):

| Situation | HTTP and code | Reason codes |
| -- | -- | -- |
| No reader configured (the default) | 503 `INTEGRATION_PENDING`, no `data` | `OPERATIONS_SOURCE_UNCONFIGURED` |
| Reader threw or returned `null` | 503 `SOURCE_UNAVAILABLE` | `OPERATIONS_SOURCE_UNAVAILABLE` |
| Reader exceeded 10 s | 504 `TIMEOUT` | `OPERATIONS_SOURCE_TIMEOUT` |
| Reader denied (401/403), or answered for another scope | 403 `SOURCE_AUTHORITY_DENIED`, neutral message, no hints | none |
| Invalid snapshot, wrong view or record address, future observation | 502 `SOURCE_RESPONSE_INVALID` | `OPERATIONS_SOURCE_INVALID`, `OPERATIONS_SOURCE_VIEW_MISMATCH`, `OPERATIONS_RECORD_ADDRESS_MISMATCH`, `OPERATIONS_RECORD_INVALID`, `SOURCE_TIME_UNVERIFIED` |
| Older than the source lease or the 15-minute D-13 order-source ceiling | 200 `dataState: "stale"`, data kept, `coverage.complete: false`, `sourceFreshness[0].staleReasonCode` | `OPERATIONS_SOURCE_STALE` |
| Partial source coverage | 200 `dataState: "partial"`, counts as given (`null` stays `null`) | the source's own reason codes |
| Client disconnected | the source signal is aborted; the 499 `REQUEST_CANCELLED` answer reaches no one | none |

`orderCustomer` is personal data. A reader role never receives `revealed` values, whatever the source says. Keys outside `orderCustomerSchema` (for example a phone number, address or provider customer id) are stripped by the schema, the bearer credential and the source version never appear (the version is an HMAC alias), and the reveal itself is not connected. `/v1/capabilities` reports `operationsReads: { sourceAuthority: "notConnected", shippingDecisionExecution: "notConnected", returnExecution: "notConnected", customerReveal: "notConnected" }` until a reader is injected.

## Native team permission and invitation draft reads (THO-367)

Stage: **sandbox, unconfigured source.** The creator agent serves `teamPermissions` (THO-305) and `invitationDraft` (THO-298) at the authenticated `/v1/read` boundary through `src/creator-agent/teamInvitationReads/`. No provider role register or TikTok Affiliate Center reader exists in this repository, so nothing here is integration-verified. No role is granted or changed, no owner is assigned and no invitation is sent: the team view carries no capability, and `sendInvitation` stays held. `invitationDraft` is a read model (the composer edits locally and saves nothing), so no versioned save path is involved. The existing PR #87 operations controls (`operationsControl`, section `team`) remain the live team screen and are unchanged; their source snapshot is a different shape and is not reused here.

| Surface | Native contract |
| -- | -- |
| `teamPermissions` | Filters `{}` exactly. The record must parse with `teamPermissionsSchema` in `viewSchemas/settings.ts`, and only its output is returned. `capabilities` is always `[]`. A snapshot that carries its own capabilities is refused (strict), so recorded permission evidence can never be presented as an available grant. |
| `invitationDraft` | Filters `{}` exactly. The record must parse with the `invitationDraft` schema in `viewSchemas/recruitment.ts`: `quota` is only the `unknown` marker (a numeric quota is refused) and `automateInvitations` is only `off`. `sendInvitation` is `denied` (`REVIEWER_REQUIRED`) for a reader and `held` (`INVITATION_ACTIONS_NOT_CONNECTED`) for a reviewer, plus `SOURCE_STALE` or `SOURCE_COVERAGE_PARTIAL` when applicable. |
| Both | `record: null` is `dataState: "empty"` only when the source counted zero expected rows; an uncounted null is refused, and a partial null stays `partial`. `scenario`, `fixture` and any other filter are refused with 400 `INVALID_INPUT` (D-11) before the source is read. A non-null cursor is 400 `INVALID_CURSOR`. `period` and `sort` are `null` and `[]`. Freshness is capped at 15 minutes (the operations-controls ceiling for source role facts; D-13 names no class for these sources). Nothing is cached between reads. |

Outcomes (error bodies use the D-14 envelope with `executionCertainty: "notApplied"`; `<P>` is `TEAM_PERMISSIONS` or `INVITATION`):

| Situation | HTTP and code | Reason codes |
| -- | -- | -- |
| No reader configured (the default) | 503 `INTEGRATION_PENDING`, no `data` | `<P>_SOURCE_UNCONFIGURED` |
| Reader threw or returned `null` | 503 `SOURCE_UNAVAILABLE` | `<P>_SOURCE_UNAVAILABLE` |
| Reader exceeded 10 s | 504 `TIMEOUT` | `<P>_SOURCE_TIMEOUT` |
| Reader denied (401/403), or answered for another scope | 403 `SOURCE_AUTHORITY_DENIED`, neutral message, no hints | none |
| Invalid snapshot, wrong view, invalid record, future observation | 502 `SOURCE_RESPONSE_INVALID` | `<P>_SOURCE_INVALID`, `<P>_SOURCE_VIEW_MISMATCH`, `<P>_RECORD_INVALID`, `SOURCE_TIME_UNVERIFIED` |
| Older than the source lease or the 15-minute ceiling | 200 `dataState: "stale"`, data kept, `coverage.complete: false`, `sourceFreshness[0].staleReasonCode` | `<P>_SOURCE_STALE` |
| Partial source coverage | 200 `dataState: "partial"`, counts as given (`null` stays `null`) | the source's own reason codes |
| Client disconnected | the source signal is aborted; the 499 `REQUEST_CANCELLED` answer reaches no one | none |

`/v1/capabilities` reports `teamInvitationReads: { sourceAuthority: "notConnected", views: "read-only-projections", roleChangeExecution: "notConnected", ownerAssignmentExecution: "notConnected", invitationSendExecution: "notConnected" }` until a reader is injected.

## Keeping the register honest

`npm run adapter:register` prints the usage map the register was built from (who reads, sends and handles each name). `src/adapter/freezeRegister.test.ts` runs `scripts/adapter-freeze-extract.mjs --json` and compares it with the first column of the tables above:

- A name in the source and not in the register fails the test (drift).
- A name in the register and not in the source also fails (a stale row).

Checked: operations, view keys, action kinds (sent and capability-only), resource kinds, error codes, and `nextAction.kind` values. Not checked: reason codes, filters, payloads, data types and the narrative rows; those are reviewed by hand. The extractor reads `src/adapter/*.ts`, `src/features/**` and `src/fixtures/**` (not tests) and the catalogues in `errors.ts` and `contract.ts`. It works on string literals: a view key or action kind built at run time is not seen, so keep them literal at the call site.

To add one: add the row to the matching table (first column in backticks), then run `npm run test`.


## Native ledger export recovery and artifact reads

| View key | Scope and behavior |
| -- | -- |
| `ledgerExportRequest` | Authenticated named-actor original-request lookup with exact key, expected version and frozen export payload; never starts generation. Returns absent/pending/failed/succeeded and confirmed artifact receipt. |
| `ledgerExportArtifact` | Authenticated actor-owned whole-snapshot CSV and receipt. Source/actor authority, expiry, byte length and digest are checked at retrieval and final publication. No demo fallback. |

These reads use the existing canonical export service and do not release a payment, message or media action.

| `fulfillmentProposal` | Native-only exact source plan and original-key recovery | `fulfillmentDomain/contract.ts` | No demo approval or provider effect |
