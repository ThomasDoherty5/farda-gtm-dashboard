/**
 * E2E-01 agent job coverage matrix: J01 to J21.
 *
 * Plain data plus a Markdown renderer. `jobMatrix.test.ts` checks it against the code:
 * the set of job identities the code declares or registers, the handler and action-domain
 * registrations, every referenced file and every cited test title. `docs/job-matrix.md` is
 * rendered from this data. Nothing here grants authority or changes runtime behavior.
 *
 * Status vocabulary:
 * - `sandbox`: the job's own service runs its workflow against sandbox fixtures. No job is
 *   production-authorized; live sources and activation remain separate gates.
 * - `partial`: job-specific code exists (a proposal bridge, local drafts, a runtime registration
 *   family), but the job's own source effects run outside this repository or are unbound.
 * - `not-implemented`: nothing job-specific beyond read-only projections or cross-references.
 *
 * Coverage lists cite exact test titles. `{ none }` is an explicit gap and gives the reason.
 */

export const JOB_IDS = ["J01", "J02", "J03", "J04", "J05", "J06", "J07", "J08", "J09", "J10", "J11",
  "J12", "J13", "J14", "J15", "J16", "J17", "J18", "J19", "J20", "J21"] as const;
export type JobId = (typeof JOB_IDS)[number];
export type JobStatus = "sandbox" | "partial" | "not-implemented";
export type TestRef = { file: string; title: string };
export type Coverage = TestRef[] | { none: string };
export type TicketEvidence =
  /** The ticket id appears beside the job id in this committed file. */
  | { kind: "repo"; file: string }
  /** Confirmed only in the gitignored local Linear snapshot (`.handoff/job-registry.md`, build index). */
  | { kind: "handoff" };

export type JobMatrixEntry = {
  job: JobId;
  name: string;
  ticket: string;
  ticketEvidence: TicketEvidence;
  status: JobStatus;
  /** Job-specific implementing modules. Empty only when not implemented. */
  modules: string[];
  /** Read projections, consumers and cross-references. They are not the job's implementation. */
  relatedModules: string[];
  /** Schema or contract files. Empty means the repository has none for this job. */
  contracts: string[];
  /** Files that declare this job's identity in code; checked against a scan of the source. */
  declaredIn: string[];
  ownerRole: "backend owner";
  coverage: { success: Coverage; failure: Coverage; recovery: Coverage };
  qaLinks?: { id: string; files: string[] }[];
  notes: string;
};

const ca = (path: string) => `src/creator-agent/${path}`;
const t = (file: string, title: string): TestRef => ({ file: ca(file), title });
const none = (reason: string) => ({ none: reason });

export const JOB_MATRIX: readonly JobMatrixEntry[] = [
  {
    job: "J01", name: "Creator signup intake and identity resolution", ticket: "THO-318",
    ticketEvidence: { kind: "repo", file: ca("intake/contract.ts") }, status: "sandbox",
    modules: [ca("intake/repository.ts"), ca("intake/routes.ts"), ca("intake/handoff.ts")],
    relatedModules: [ca("monitor/contract.ts")],
    contracts: [ca("intake/contract.ts")], declaredIn: [ca("intake/contract.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("intake/intake.test.ts", "resolves a signup and an earlier discovery hit into one creator with separate profiles and campaign relationships")],
      failure: [t("intake/intake.test.ts", "rejects missing keys, a fabricated address and a profile on the wrong network before anything is written"),
        t("intake/intake.test.ts", "pauses a denied or unverified source, keeps its cursor and writes nothing")],
      recovery: [t("intake/intake.test.ts", "recovers a crash between the two writes on replay without a second person or a second Notion write"),
        t("intake/intake.test.ts", "recovers a previously accepted sink write after a real SQLite close/reopen, with one canonical creator")],
    },
    notes: "No qualified production Notion or Sheets writer is bound (intake/README.md, release boundary).",
  },
  {
    job: "J02", name: "Evidence collection and versioned scoring", ticket: "THO-319",
    ticketEvidence: { kind: "handoff" }, status: "sandbox",
    modules: [ca("policy.ts"), ca("evidence.ts"), ca("routeEvidence.ts"), ca("ratingPolicy.ts"), ca("config.ts")],
    relatedModules: [ca("scorecardPreview.ts"), ca("configurations/website-affiliate-v3.2026-11-04.json"),
      ca("configurations/tiktok-shop-affiliate-v3.2026-11-04.json")],
    contracts: [ca("assessmentSchema.ts"), ca("evidence.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("policy.test.ts", "requires three independent complete posts on two dates with two meaningful use examples"),
        t("approvedBaseline.test.ts", "loads exactly the two approved vectors, original bands and explicit phase rules")],
      failure: [t("policy.test.ts", "cannot compensate for a critical failure with a high weighted total"),
        t("server.test.ts", "rejects stale policy/configuration and forged input before persistence")],
      recovery: [t("server.test.ts", "persists a real assessment in SQLite and preserves it across restart"),
        t("server.test.ts", "replays an identical idempotency key and refuses a changed payload without overwriting history")],
    },
    qaLinks: [{ id: "QA31-02/03", files: [ca("policy.test.ts"), ca("approvedBaseline.test.ts")] }],
    notes: "policy.ts describes itself as the deterministic J02 decision. J02 has no registered job identity in code; scoring runs through the agent HTTP service.",
  },
  {
    job: "J03", name: "Creator offer drafting and economics", ticket: "THO-320",
    ticketEvidence: { kind: "handoff" }, status: "sandbox",
    modules: [ca("offers/job.ts"), ca("offers/repository.ts"), ca("offers/economics.ts"), ca("offers/policy.ts"),
      ca("offers/validation.ts"), ca("offers/routes.ts")],
    relatedModules: [ca("commercialPolicy/evaluate.ts")],
    contracts: [ca("offers/job.ts"), ca("offers/contract.ts")], declaredIn: [ca("offers/job.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("offers/offers.test.ts", "processes a reviewer-authorized J03 proposal envelope once and binds it to scope, input and deadline")],
      failure: [t("offers/policy.test.ts", "keeps proposed and missing policy explicit, even with a high score and provider facts")],
      recovery: [t("offers/saveRecovery.test.ts", "reads the exact recorded original after a later revision without claiming current acceptance"),
        t("offers/offers.test.ts", "preserves proposals over restart, rejects fees, conflicts and unauthorized source decisions")],
    },
    notes: "Propose mode only: no invitation, reservation, funding or activation (offers/README.md).",
  },
  {
    job: "J04", name: "Exact-action approval and release", ticket: "THO-321",
    ticketEvidence: { kind: "repo", file: "docs/adapter-backend-requirements.md" }, status: "sandbox",
    modules: [ca("approvals/repository.ts"), ca("approvals/authority.ts"), ca("approvals/policy.ts"), ca("actions/service.ts"),
      ca("actions/registration.ts"), ca("actionFoundation.ts"), ca("actionDomains.ts"), ca("jobs/dispatchGuard.ts")],
    relatedModules: [ca("commercialPolicy/approvalGuard.ts")],
    contracts: [ca("approvals/contract.ts"), ca("actions/contract.ts"), ca("jobs/dispatchSchema.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("approvals/repository.test.ts", "completes preview, Linear request, verified second-person Slack decision, Linear readback and dispatch proof without a provider action"),
        t("jobs/dispatchGuard.test.ts", "executes exact approved local artifact once and returns actual receipt on replay")],
      failure: [t("approvals/repository.test.ts", "rejects a same-person decision despite a distinct principal and rejects forged source identity"),
        t("approvals/repository.test.ts", "does not authorize forged proofs, foreign scope or changed per-item payload/bounds")],
      recovery: [t("approvals/repository.test.ts", "recovers an applied but lost Linear response by exact readback without another write"),
        t("jobs/dispatchGuard.test.ts", "expired started work survives restart as reconcile and never blindly retries")],
    },
    notes: "Every action domain composes behind J04 (actionDomains.ts). No production Slack or Linear decision write is configured (actions/README.md).",
  },
  {
    job: "J05", name: "Social Cat recruitment, inbox and contracts", ticket: "THO-322",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("recruitment/service.ts"), ca("recruitment/proposalBridge.ts"), ca("recruitment/drafts.ts")],
    relatedModules: [ca("recruitment/source.ts"), ca("commercialPolicy/recruitment.ts")],
    contracts: [ca("recruitment/contract.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("recruitment/service.test.ts", "records the exact public selection and raw target/payload once, without acceptance or dispatch")],
      failure: [t("recruitment/service.test.ts", "rejects foreign manifest membership and permission denial browser fallback")],
      recovery: [t("recruitment/service.test.ts", "recovers only the original preview after newer draft, offer and source revisions without preparing or sending"),
        t("recruitmentHttp.test.ts", "withholds a postcommit acknowledgment after caller revocation and recovers the immutable original without a second save")],
    },
    notes: "The recruitment workspace (shared with J06) saves invitation drafts and bridges them to J04. The native invitation handler is source-owned and injected; no Social Cat inbox or contract execution exists here. Tests are shared with J06 and are not Social Cat specific.",
  },
  {
    job: "J06", name: "TikTok recruitment, invitations and native offers", ticket: "THO-323",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("recruitment/service.ts"), ca("recruitment/proposalBridge.ts"), ca("recruitment/drafts.ts")],
    relatedModules: [ca("recruitment/source.ts"), ca("commercialPolicy/recruitment.ts")],
    contracts: [ca("recruitment/contract.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("recruitment/service.test.ts", "records the exact public selection and raw target/payload once, without acceptance or dispatch")],
      failure: [t("recruitment/service.test.ts", "preserves explicit 16022020 owner handoff after a deadline and permits another browser route only with independent capability")],
      recovery: [t("recruitment/service.test.ts", "recovers only the original preview after newer draft, offer and source revisions without preparing or sending")],
    },
    notes: "Shares the recruitment workspace with J05. The native TikTok invitation or offer handler is source-owned and injected; it is not in this repository.",
  },
  {
    job: "J07", name: "Sample decisions and stock-reservation handoff", ticket: "THO-324",
    ticketEvidence: { kind: "handoff" }, status: "not-implemented",
    modules: [], relatedModules: [ca("bulk/contract.ts"), ca("offers/repository.ts")],
    contracts: [], declaredIn: [], ownerRole: "backend owner",
    coverage: { success: none("No J07 module."), failure: none("No J07 module."), recovery: none("No J07 module.") },
    notes: "Only cross-references: J13 batches carry sampleDecision groups, and accepted offers record a J07/J15 handoff label. No sample decision or reservation handoff is implemented.",
  },
  {
    job: "J08", name: "Hourly creator content and inbox monitoring", ticket: "THO-307",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("jobs/runtime.ts"), ca("jobs/runtimeCadence.ts")],
    relatedModules: [ca("monitor/reader.ts"), ca("monitor/posts.ts")],
    contracts: [ca("jobs/runtimeSchema.ts"), ca("monitor/contract.ts")],
    declaredIn: [ca("jobs/runtimeSchema.ts"), ca("jobs/runtimeViews.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("jobs/runtime.test.ts", "hourly enrolled monitoring preserves both real fall-back hours, unlike daily discovery")],
      failure: [t("jobs/runtime.test.ts", "hourly J08 has a separate queue and rejects loss of enrolled membership during a read")],
      recovery: none("No test exercises J08-family recovery. The shared runtime recovery tests use the synthetic J19 registration."),
    },
    notes: "The shared runtime accepts an hourly enrolled-only J08 family; the monitoring executor is injected. docs/monitor-views.md: the launcher supplies no live J08 source. Monitor reader tests cover the read projection, not J08.",
  },
  {
    job: "J09", name: "Creator follow-up, content review and rights expiry", ticket: "THO-308",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("collaborationWorkflow.ts")],
    relatedModules: [ca("notionCollaboration.ts"), ca("collaborationEvidenceReader.ts"), ca("assets.ts"), ca("assetStore.ts")],
    contracts: [ca("collaborationWorkflowSchema.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("collaborationWorkflow.test.ts", "persists an immutable approval proposal across restarts, private routing, retries, concurrent versions and changed native facts")],
      failure: [t("reviewCollaborationIntegration.test.ts", "keeps reminders held when the posting obligation or suppression clearance is unknown")],
      recovery: [t("collaborationWorkflow.test.ts", "preserves one original proposal receipt after postcommit revocation"),
        t("reviewCollaborationIntegration.test.ts", "does not acknowledge a lost request from an independently submitted identical proposal")],
    },
    notes: "Local review and reminder proposals only; no follow-up send. Asset modules consume J09 rights observations supplied by a trusted adapter. The workflow module does not name J09; the mapping comes from docs/collaboration-workflow.md.",
  },
  {
    job: "J10", name: "Website affiliate onboarding and attribution validation", ticket: "THO-309",
    ticketEvidence: { kind: "handoff" }, status: "not-implemented",
    modules: [], relatedModules: [], contracts: [], declaredIn: [], ownerRole: "backend owner",
    coverage: { success: none("No J10 module."), failure: none("No J10 module."), recovery: none("No J10 module.") },
    notes: "Website-route activation evidence is part of J02 scoring (routeEvidence.ts). No onboarding or attribution validation job exists.",
  },
  {
    job: "J11", name: "Commission ingestion and payout reconciliation", ticket: "THO-310",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("settlements/proposalBridge.ts")],
    relatedModules: [ca("settlements/source.ts"), ca("settlements/reader.ts"), ca("rewards/approvalBridge.ts"), ca("commercialPolicy/authority.ts")],
    contracts: [ca("settlements/contract.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("settlements/proposalBridge.test.ts", "persists exact statement selection in the actual canonical J04 request; neither paid nor reconciled")],
      failure: [t("settlements/proposalBridge.test.ts", "refuses candidate conflicts and source version drift before creating an approval")],
      recovery: [t("settlements/proposalBridge.test.ts", "reconstructs owner observations from the canonical manifest after bridge restart without changing its identity")],
    },
    notes: "Statement matching is prepared through J04 with an injected J11 owner; the default executor is unbound (J11_RECONCILIATION_UNBOUND). No commission ingestion exists here.",
  },
  {
    job: "J12", name: "Settlement of existing external fixed-fee payables", ticket: "THO-311",
    ticketEvidence: { kind: "handoff" }, status: "not-implemented",
    modules: [], relatedModules: [ca("settlements/source.ts"), ca("settlements/reader.ts")],
    contracts: [], declaredIn: [], ownerRole: "backend owner",
    coverage: { success: none("No J12 module."), failure: none("No J12 module."), recovery: none("No J12 module.") },
    notes: "Settlement reads project existing J11/J12 source records only. Execution is unbound (J12_EXECUTION_UNBOUND in settlements/contract.ts).",
  },
  {
    job: "J13", name: "Finite bulk preview, dispatch and recovery", ticket: "THO-312",
    ticketEvidence: { kind: "handoff" }, status: "sandbox",
    modules: [ca("bulk/service.ts"), ca("bulk/material.ts"), ca("bulk/projection.ts"), ca("bulk/views.ts"), ca("bulkRuntime.ts")],
    relatedModules: [],
    contracts: [ca("bulk/contract.ts"), ca("jobs/runtimeSchema.ts")], declaredIn: [ca("bulk/contract.ts"), ca("bulkRuntime.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("bulk/service.test.ts", "keeps24 recipients,12 separate approved25USD samples and12 no-new-sample rows through actual J04/run receipts"),
        t("bulkRuntime.test.ts", "J13 executes exact canonical approvals through the registered durable runtime; retries and restart keep original per-row actions")],
      failure: [t("bulk/service.test.ts", "rejects all membership, version, economics and product-version mutations without rebasing the old proposal"),
        t("bulk/service.test.ts", "denial during owner await and a final transactional revocation produce no manifest or effects")],
      recovery: [t("bulkRecovery.test.ts", "source confirmation reconciles the original uncertain sample receipt without a second invocation"),
        t("bulk/service.test.ts", "keeps expired batch receipts and original uncertain recovery readable under current source permission")],
    },
    notes: "Per-item provider handlers are owned by the action domains; createBulkRuntimeRegistration enables no trigger.",
  },
  {
    job: "J14", name: "Provider capability and source-health monitoring", ticket: "THO-313",
    ticketEvidence: { kind: "handoff" }, status: "sandbox",
    modules: [ca("providerHealth.ts"), ca("operations.ts")],
    relatedModules: [ca("connections/ledger.ts"), ca("operationsControls.ts")],
    contracts: [ca("providerHealthSchema.ts")], declaredIn: [ca("providerHealth.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("providerHealth.test.ts", "binds a native observation to its saved action, persists a checkpoint, and replays once across request keys"),
        t("operationsControls.health.test.ts", "observes exactly once through native HTTP and returns actual J14 receipt, keeping business authority separate")],
      failure: [t("providerHealth.test.ts", "enforces a ledger revocation on the same action before any new health observation"),
        t("operationsControls.health.test.ts", "holds unconfigured and subsequently denied bindings without a provider observation")],
      recovery: [t("providerHealth.test.ts", "deduplicates failure across restart, keeps past native success and requires fresh permitted recovery"),
        t("providerHealthIntegration.test.ts", "observes, owns a deduplicated failure, recovers from fresh evidence and replays without bypassing expiry")],
    },
    notes: "Read-only probes registered as j14-<capability> jobs. Configuration alone does not activate J14 (operations.md).",
  },
  {
    job: "J15", name: "Order, inventory and fulfillment orchestration", ticket: "THO-314",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("stockSupport.ts"), ca("fulfillmentDomain/service.ts")],
    relatedModules: [ca("notionStockSupportSource.ts"), ca("shippingHubRead.ts"), ca("operationsReads/reader.ts")],
    contracts: [ca("stockSupportSchema.ts"), ca("fulfillmentDomain/contract.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("stockSupport.test.ts", "commits one local receipt across racing submissions; exact scoped lookup and rejected stale nonce survive retries"),
        t("fulfillmentDomain/service.test.ts", "binds a replacement to its new keys, exact stock, home and spend without reserving or shipping")],
      failure: [t("stockSupport.test.ts", "rejects shortages, incomplete receipts and conflicting or unknown balances without making a second stock ledger")],
      recovery: [t("stockSupport.test.ts", "keeps the exact original receipt when authority is revoked after the actual commit")],
    },
    notes: "Local stock-transfer review requests and J04 proposal translation only. J15 owns movements, reservations and physical writes outside this repository (docs/stock-support-workspaces.md).",
  },
  {
    job: "J16", name: "Support, return, replacement and refund recovery", ticket: "THO-315",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("fulfillmentDomain/service.ts"), ca("stockSupport.ts")],
    relatedModules: [ca("notionStockSupportSource.ts"), ca("operationsReads/reader.ts")],
    contracts: [ca("fulfillmentDomain/contract.ts"), ca("stockSupportSchema.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("stockSupport.test.ts", "keeps 7 all-time and 6 cohort-open apart, rejects private fields and submits only an allowed case review")],
      failure: [t("fulfillmentDomain/service.test.ts", "rejects over-refund, mixed remedies, missing inspection and excess/unsafe restock quantity")],
      recovery: [t("fulfillmentDomain/service.test.ts", "keeps an uncertain original proposal across restart and blocks a fresh-key bypass"),
        t("fulfillmentIntegration.test.ts", "preserves original uncertainty, fails closed on revocation and refuses a new-key recovery bypass")],
    },
    notes: "Refund or replacement decisions are translated into J04 proposals; support handoffs are local review requests. J16 owns conversations, returns, refunds and replacements outside this repository.",
  },
  {
    job: "J17", name: "Consent-aware customer flows and activation signals", ticket: "THO-316",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("lifecycle/repository.ts")], relatedModules: [ca("lifecycle/source.ts")],
    contracts: [ca("lifecycle/contract.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("controlsLifecycle.integration.test.ts", "persists each allowlisted flow once and returns the exact immutable request receipt without changing the source")],
      failure: [t("lifecycle/repository.test.ts", "rejects reader writes, setup edits, foreign catalog selectors and altered timezone")],
      recovery: [t("lifecycleAuthority.review.test.ts", "suppresses a postcommit success after token rotation and recovers only the original immutable receipt under current authorization")],
    },
    notes: "Local flow configuration drafts and read projections only. enableFlow is held with J17_PROVIDER_EXECUTION_NOT_CONNECTED; enrollments, consent and sends are not implemented here.",
  },
  {
    job: "J18", name: "Performance, launch and close reporting", ticket: "THO-317",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("actions/domainServices.ts")],
    relatedModules: [ca("analytics/reader.ts"), ca("finance/reader.ts"), ca("monitor/reader.ts")],
    contracts: [ca("actions/wire.ts")], declaredIn: [], ownerRole: "backend owner",
    coverage: {
      success: [t("actions/domainServices.test.ts", "requires exact Notion ACK and readback; receipt replay is historical and never writes twice")],
      failure: [t("actions/domainServices.test.ts", "rejects forged role/release/gates and non-founders without source writes")],
      recovery: [t("actions/readinessRecovery.test.ts", "can recover pending original intent and reconcile lost ACK without another source write"),
        t("actions/domainServices.test.ts", "SQLite reopen keeps an unknown request fenced and recovers its original source receipt")],
    },
    notes: "Launch readiness recording only, and it is not release authority. No qualified Notion readiness writer is configured. Analytics and finance reads are projections. No report generation or period close exists.",
  },
  {
    job: "J19", name: "Daily creator discovery within verified source quotas", ticket: "THO-325",
    ticketEvidence: { kind: "repo", file: ca("sourcing/source.ts") }, status: "partial",
    modules: [ca("jobs/runtime.ts"), ca("jobs/runtimeCadence.ts"), ca("jobs/runtimeExecutors.ts")],
    relatedModules: [ca("sourcing/reader.ts"), ca("sourcing/nativeReader.ts"), ca("sourcing/source.ts")],
    contracts: [ca("jobs/runtimeSchema.ts"), ca("sourcing/contract.ts")],
    declaredIn: [ca("jobs/runtimeSchema.ts"), ca("jobs/runtimeViews.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("jobs/runtime.test.ts", "runs a real bounded HTTP read after canonical fire and records measured calls without invented paid cost")],
      failure: [t("jobs/runtime.test.ts", "holds unknown authority, quota and policy changes before a transport call")],
      recovery: [t("jobs/runtime.test.ts", "persists page checkpoint before safe-read retry and resumes after a new runtime instance"),
        t("jobs/runtime.test.ts", "worker expiry permits bounded safe-read recovery but the late worker cannot overwrite the result")],
    },
    notes: "The runtime tests use a synthetic J19 registration with synthetic executors; no discovery executor or live source exists here. The sourcing plan is a read-only projection of the J19 service.",
  },
  {
    job: "J20", name: "Direct lifestyle-video review and evidence ledger", ticket: "THO-326",
    ticketEvidence: { kind: "handoff" }, status: "partial",
    modules: [ca("jobs/runtime.ts"), ca("evidenceReviewStore.ts")], relatedModules: [],
    contracts: [ca("jobs/runtimeSchema.ts"), ca("evidenceReviewContract.ts")],
    declaredIn: [ca("jobs/runtimeSchema.ts"), ca("jobs/runtimeViews.ts")], ownerRole: "backend owner",
    coverage: {
      success: [t("reviewSprintIntegration.test.ts", "acknowledges one immutable local annotation, rejects changed replay and preserves the original J20 packet")],
      failure: [t("reviewSprintIntegration.test.ts", "enforces reader denial, exact workspace and payload/resource kind at the authenticated route")],
      recovery: [t("evidenceReviewStore.test.ts", "binds annotations to their source and historical revisions across restart, with safe retries and no changed source assessment")],
    },
    notes: "Reviewer annotations beside the immutable J20 packet. The runtime accepts a daily J20 family, but no test registers one and no review executor exists here.",
  },
  {
    job: "J21", name: "Human-reviewed creator trend and calibration proposals", ticket: "THO-327",
    ticketEvidence: { kind: "handoff" }, status: "not-implemented",
    modules: [], relatedModules: [], contracts: [], declaredIn: [], ownerRole: "backend owner",
    coverage: { success: none("No J21 module."), failure: none("No J21 module."), recovery: none("No J21 module.") },
    notes: "No calibration or trend proposal code exists in the repository.",
  },
];

/** Every handler in `jobDefinitionSchema`. `jobs: []` means no J01 to J21 owner is named in code or docs. */
export const HANDLER_MATRIX: Readonly<Record<string, { jobs: JobId[]; modules: string[]; note: string }>> = {
  "record-reference.v1": { jobs: [], modules: [ca("jobs/schema.ts"), ca("operations.ts")], note: "Shared local no-source job foundation (jobs/README.md)." },
  "draft-reference.v1": { jobs: [], modules: [ca("jobs/schema.ts"), ca("operations.ts")], note: "Shared local no-source job foundation (jobs/README.md)." },
  "probe-provider-health.v1": { jobs: ["J14"], modules: [ca("providerHealth.ts")], note: "Bounded read-only provider health probe." },
  "dispatch-approved.v1": { jobs: ["J04", "J13"], modules: [ca("jobs/dispatchGuard.ts"), ca("bulkRuntime.ts")], note: "Exact approved manifest dispatch." },
  "export-ledger-snapshot.v1": { jobs: [], modules: [ca("actions/domainServices.ts")], note: "Canonical ledger export. Unknown owner: no job id in code or docs." },
  "registered-source.v1": { jobs: ["J08", "J19", "J20"], modules: [ca("jobs/runtime.ts")], note: "Registered source runtime families." },
  "deliver-report.v1": { jobs: [], modules: [ca("slackReporting/service.ts")], note: "Operational report delivery. Unknown owner: no job id in code or docs." },
};

/** Every action domain composed in server.ts, keyed by its expression there. `jobs: []` means unassigned. */
export const ACTION_DOMAIN_MATRIX: Readonly<Record<string, { module: string; jobs: JobId[]; note: string }>> = {
  rewardDomain: { module: ca("rewards/approvalBridge.ts"), jobs: [], note: "Reward redemption consumes J04, J11, J15 and J16 but is not assigned to a job." },
  mediaDomain: { module: ca("mediaComposition.ts"), jobs: [], note: "Paid media consumes J04 but is not assigned to a job." },
  "operationsBridge.domain": { module: ca("operationsControlBridge.ts"), jobs: [], note: "Operations controls consume J04 but are not assigned to a job." },
  settlementDomain: { module: ca("settlements/proposalBridge.ts"), jobs: ["J11"], note: "Statement matching proposals." },
  "fulfillment.domain": { module: ca("fulfillmentDomain/service.ts"), jobs: ["J15", "J16"], note: "Fulfillment decision proposals." },
  "recruitmentWorkspace.domain": { module: ca("recruitment/proposalBridge.ts"), jobs: ["J05", "J06"], note: "Invitation proposals." },
  "bulkWorkspace.domain": { module: ca("bulk/service.ts"), jobs: ["J13"], note: "Finite batch proposals." },
};

const cell = (value: string) => value.replace(/\|/g, "\\|");
const files = (paths: readonly string[]) => paths.length ? paths.map(path => `\`${path}\``).join("<br>") : "none";
const coverageCell = (coverage: Coverage) => "none" in coverage
  ? `**gap**: ${cell(coverage.none)}`
  : coverage.map(ref => `\`${ref.file.replace(/^src\/creator-agent\//, "")}\`: ${cell(ref.title)}`).join("<br>");
const isGap = (coverage: Coverage) => "none" in coverage;

/** The committed docs/job-matrix.md is exactly this output. */
export function renderJobMatrixMarkdown(): string {
  const lines = [
    "# Agent job coverage matrix",
    "",
    "<!-- Generated from src/creator-agent/jobMatrix.ts. Edit the data, then run",
    "     UPDATE_JOB_MATRIX_DOC=1 npx vitest run src/creator-agent/jobMatrix.test.ts -->",
    "",
    "This is E2E-01 under THO-329. It maps each agent job, J01 to J21, to its Linear child ticket, its implementing modules, its contract files, its owner role and the tests for success, failure and recovery. `jobMatrix.test.ts` derives the registered jobs, handlers and action domains from the code and fails when one has no matrix entry, or when an entry names a missing file or test.",
    "",
    "Status: **sandbox** means the job's own service runs its workflow against sandbox fixtures. **partial** means job-specific code exists, but the job's source effects run elsewhere or are unbound. **not-implemented** means nothing job-specific beyond read projections or cross-references. No job is production-authorized.",
    "",
    "Tickets marked *handoff* are confirmed only in the local Linear snapshot, which is not committed. Tickets marked *repo* appear beside the job id in the named file. Every job's owner role is the backend owner. Playwright specs under `e2e-agent/` are not mapped yet.",
    "",
    "## Summary",
    "",
    "In the coverage columns, *yes* means a cited test exists for this job's code in the repository. For a partial job, that covers only the implemented slice, never the whole job.",
    "",
    "| Job | Name | Ticket | Status | Success | Failure | Recovery |",
    "| -- | -- | -- | -- | -- | -- | -- |",
    ...JOB_MATRIX.map(entry => `| ${entry.job} | ${cell(entry.name)} | ${entry.ticket} (${entry.ticketEvidence.kind}) | ${entry.status} | ${
      isGap(entry.coverage.success) ? "gap" : "yes"} | ${isGap(entry.coverage.failure) ? "gap" : "yes"} | ${isGap(entry.coverage.recovery) ? "gap" : "yes"} |`),
    "",
  ];
  for (const entry of JOB_MATRIX) {
    lines.push(`## ${entry.job}: ${entry.name}`, "",
      "| Field | Value |", "| -- | -- |",
      `| Ticket | ${entry.ticket} (${entry.ticketEvidence.kind === "repo" ? `repo: \`${entry.ticketEvidence.file}\`` : "handoff"}) |`,
      `| Status | ${entry.status} |`,
      `| Owner role | ${entry.ownerRole} |`,
      `| Modules | ${entry.status === "not-implemented" ? "not implemented" : files(entry.modules)} |`,
      `| Related modules | ${files(entry.relatedModules)} |`,
      `| Contracts | ${files(entry.contracts)} |`,
      `| Declared in code | ${files(entry.declaredIn)} |`,
      `| Success tests | ${coverageCell(entry.coverage.success)} |`,
      `| Failure tests | ${coverageCell(entry.coverage.failure)} |`,
      `| Recovery tests | ${coverageCell(entry.coverage.recovery)} |`,
      ...(entry.qaLinks ?? []).map(link => `| ${link.id} | ${files(link.files)} |`),
      `| Notes | ${cell(entry.notes)} |`, "");
  }
  lines.push("## Registered handlers", "", "| Handler | Jobs | Modules | Note |", "| -- | -- | -- | -- |",
    ...Object.entries(HANDLER_MATRIX).map(([handler, value]) => `| \`${handler}\` | ${value.jobs.join(", ") || "unknown"} | ${files(value.modules)} | ${cell(value.note)} |`),
    "", "## Action domains composed in `server.ts`", "", "| Domain | Module | Jobs | Note |", "| -- | -- | -- | -- |",
    ...Object.entries(ACTION_DOMAIN_MATRIX).map(([domain, value]) => `| \`${domain}\` | \`${value.module}\` | ${value.jobs.join(", ") || "unknown"} | ${cell(value.note)} |`),
    "");
  return lines.join("\n");
}
