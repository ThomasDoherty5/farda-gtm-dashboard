/**
 * Approval and run fixture family (FX-10..FX-18) — SYNTHETIC. All people, handles and receipts are
 * invented, and nothing here can reach a provider. Separate dataset from overview-original.
 */
import type { Money, SourceRef } from "@/adapter/contract";
import type { ApprovalDetail, ApprovalPayload, ApprovalVersion, Reconciliation, RunDetail, RunItem } from "@/features/approvals/types";
import { DEMO_ACCOUNT, DEMO_NOW } from "./overview";

const LATER = "2026-11-05T17:00:00.000Z";
const EARLIER = "2026-11-01T17:00:00.000Z";
const usd = (minorUnits: number): Money => ({ minorUnits, currency: "USD" });

const ref = (source: string, sourceId: string): SourceRef => ({
  source,
  accountId: DEMO_ACCOUNT,
  sourceId,
  canonicalId: `demo-creator-${sourceId}`,
  url: null,
  identityState: "resolved",
  provenanceRef: `demo:approvals:${sourceId}`,
});

const payload = (over: Partial<ApprovalPayload> = {}): ApprovalPayload => {
  const creator = ref("social-cat", "demo-handle-one");
  return {
    actionLabel: "Send commission-only invitation",
    account: { ...ref("social-cat", "demo-account"), canonicalId: null },
    creator,
    recipients: [creator],
    recruitmentSource: "Social Cat",
    publishingNetworks: ["Instagram", "TikTok"],
    checkout: "Website",
    message: "Hi, this is a synthetic invitation with a per-sale commission and no upfront fee.",
    terms: { commissionRatePct: 15, upfrontFee: usd(0), sampleCost: usd(1_200) },
    ...over,
  };
};

const version = (over: Partial<ApprovalVersion> = {}): ApprovalVersion => ({
  version: "v1",
  payload: payload(),
  payloadHash: "demo-hash-1",
  policyVersion: "commission-only@demo",
  offerVersion: "offer@demo-1",
  decision: null,
  decidedByRole: null,
  decidedAt: null,
  reason: null,
  decisionReceiptRef: null,
  slackPermalink: null,
  ...over,
});

const queue = [
  { approvalRef: "demo-approval-042", handle: "@routine.with.ella", summary: "UGC brief · version 3", status: "Selected · pending", tone: "warning" as const },
  { approvalRef: "demo-approval-exact", handle: "@mira.moves", summary: "Collaboration invitation", status: "Awaiting review", tone: "warning" as const },
  { approvalRef: "demo-approval-founder", handle: "@cozybyclaire", summary: "Direct fee $150 · founder only", status: "Awaiting review", tone: "warning" as const },
  { approvalRef: "demo-approval-conflict", handle: "@rae.routines", summary: "Follow-up message", status: "Awaiting review", tone: "neutral" as const },
];

const approval = (approvalRef: string, over: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  approvalRef,
  displayId: approvalRef.replace("demo-approval-", "APR-").toUpperCase(),
  title: "Send a commission-only invitation",
  contextLine: "Social Cat · drafted by creator agent",
  source: "Social Cat",
  platform: "Social Cat web",
  actionName: "Send invitation message",
  requestedBy: "Creator agent",
  reviewer: "Assigned operator",
  historicalNote: null,
  executionPlan: "Zapier queues the approved task → browser agent opens this Social Cat collaboration → sends the locked payload → captures message receipt → updates the Notion record.",
  capabilityLabel: "Browser capability · to validate",
  queueLabel: "8 waiting · oldest first",
  queue,
  timeline: [
    { time: "10:42", title: "Draft created", note: "Creator agent · payload v1" },
    { time: "—", title: "Execution receipt", note: "Not sent · no receipt yet" },
  ],
  status: "pending",
  currentVersion: "v1",
  requiredRole: "reviewer",
  expiresAt: LATER,
  manifestRef: `demo-manifest-${approvalRef}`,
  versions: [version()],
  execution: null,
  ...over,
});

/** The server-derived role of the demo session. Nothing the client sends can change it. */
export const DEMO_ACTOR_ROLE = "reviewer";

const ELLA_MESSAGE = "Hi Ella! We'd love one 30–45 second Instagram Reel showing how Farda fits into your daily routine. The proposed fee is $150, including one revision and 90 days of organic usage. Please confirm the brief and delivery date before we arrange your sample.";
const ELLA = { ...ref("social-cat", "@routine.with.ella") };

export const seedApprovals = (): ApprovalDetail[] => [
  /* The sample in Figma source 6:234: an archived fee proposal, so it can be read but never decided. */
  approval("demo-approval-042", {
    displayId: "APR-0042",
    title: "Send a creator brief",
    contextLine: "Social Cat · collaboration COL-SC-042 · drafted by creator agent",
    actionName: "Send brief message",
    expiresAt: "2026-10-31T01:00:00.000Z",
    currentVersion: "v3",
    historicalNote: "COL-SC-042 is an earlier $150 content-fee example. This archived proposal cannot create a new upfront-fee commitment under the current acquisition policy.",
    versions: [
      version({ payload: payload({ creator: ELLA, recipients: [ELLA], message: ELLA_MESSAGE }), decision: "editRequired", decidedByRole: "reviewer", decidedAt: EARLIER, reason: "Superseded.", decisionReceiptRef: "demo-decision-receipt-042-1" }),
      version({ version: "v2", payloadHash: "demo-hash-042-2", payload: payload({ creator: ELLA, recipients: [ELLA], message: ELLA_MESSAGE }), decision: "editRequired", decidedByRole: "reviewer", decidedAt: EARLIER, reason: "Superseded.", decisionReceiptRef: "demo-decision-receipt-042-2" }),
      version({ version: "v3", payloadHash: "demo-hash-042-3", payload: payload({ actionLabel: "Send a creator brief", creator: ELLA, recipients: [ELLA], message: ELLA_MESSAGE, terms: { commissionRatePct: 0, upfrontFee: usd(15_000), sampleCost: null } }) }),
    ],
    timeline: [
      { time: "10:42", title: "Draft created", note: "Creator agent · payload v1" },
      { time: "10:46", title: "Text revised", note: "Operator · payload v2 superseded" },
      { time: "10:50", title: "Awaiting Slack decision", note: "Current payload v3 · outbound blocked" },
      { time: "—", title: "Execution receipt", note: "Not sent · no receipt yet" },
    ],
  }),
  approval("demo-approval-exact"),
  approval("demo-approval-conflict"),
  approval("demo-approval-uncertain"),
  approval("demo-approval-fee", { versions: [version({ payload: payload({ terms: { commissionRatePct: 15, upfrontFee: usd(50_000), sampleCost: null } }) })] }),
  approval("demo-approval-expired", { status: "expired", expiresAt: EARLIER }),
  approval("demo-approval-founder", {
    title: "Pay accepted historical fee",
    requiredRole: "founder",
    reviewer: "Founder",
    versions: [version({ payload: payload({ actionLabel: "Pay accepted historical fee", terms: { commissionRatePct: 0, upfrontFee: usd(25_000), sampleCost: null } }), policyVersion: "historical-liability@demo" })],
  }),
  approval("demo-approval-history", {
    status: "approved",
    currentVersion: "v2",
    execution: { runRef: "demo-run-batch", state: "partiallySucceeded", receiptRefs: ["demo-source-receipt-a"] },
    versions: [
      version({ decision: "editRequired", decidedByRole: "reviewer", decidedAt: EARLIER, reason: "Tone the opening down.", decisionReceiptRef: "demo-decision-receipt-h1" }),
      version({ version: "v2", payloadHash: "demo-hash-2", payload: payload({ message: "Hi, this is the edited synthetic invitation." }), decision: "approved", decidedByRole: "reviewer", decidedAt: DEMO_NOW, decisionReceiptRef: "demo-decision-receipt-h2" }),
    ],
  }),
];

/** What a source lookup finds for each uncertain run. */
export const sourceLookups: Record<string, Reconciliation> = {
  "demo-run-uncertain": {
    result: "sourceReceiptFound",
    evidence: { receiptRef: "demo-source-receipt-prior", provider: "social-cat", accountId: DEMO_ACCOUNT, identity: "demo-handle-one", observedAt: DEMO_NOW },
  },
  "demo-run-unsent": { result: "confirmedNotExecuted", evidence: null },
  "demo-run-noevidence": { result: "stillUnknown", evidence: null },
};

const item = (itemId: string, state: RunItem["state"], receiptRef: string | null = null, reasonCode: string | null = null): RunItem => ({
  itemId,
  recipient: ref("social-cat", itemId),
  state,
  receiptRef,
  reasonCode,
});

const run = (runRef: string, approvalRef: string, state: RunDetail["state"], items: RunItem[]): Omit<RunDetail, "counts"> => ({
  runRef,
  version: "r1",
  jobId: "demo-recruitment-job",
  jobVersion: "demo-1",
  mode: "executeApproved",
  environment: "demo",
  trigger: "Approved action",
  correlationId: `corr-${runRef}`,
  displayId: "SC-1042",
  source: "Social Cat",
  collaboration: "COL-SC-042",
  handle: "@routine.with.ella",
  revision: "3",
  decisionLabel: "Approved in Slack",
  lastEvent: "Send clicked · 14:32",
  historicalNote: "This COL-SC-042 content-fee action belongs to the earlier workflow. Current acquisition creates only commission-based offers; existing accepted terms and their evidence remain preserved.",
  steps: [
    { title: "Locate the Social Cat collaboration", note: "Match the creator handle and collaboration before acting.", status: "Complete" },
    { title: "Read the latest conversation", note: "Terms and last reply checked against the current source page.", status: "Complete" },
    { title: "Draft the next message", note: "One UGC video · delivery date proposed · usage rights explicit.", status: "Complete" },
    { title: "Wait for the exact message approval", note: "A person replies approve, edit: or reject: in the Slack thread.", status: "Waiting" },
    { title: "Send inside Social Cat", note: "Use only the approved revision in the source conversation.", status: "Blocked" },
    { title: "Confirm the source result", note: "Match the sent message and timestamp; retain a redacted receipt.", status: "Blocked" },
    { title: "Write the outcome and advance", note: "Update Notion collaboration; Zapier publishes run status.", status: "Blocked" },
  ],
  stages: ["Vet", "Pitch", "Terms & brief", "Sample", "Review & revise", "Pay", "Close & rights"],
  currentStage: "Terms & brief",
  previewMessage: ELLA_MESSAGE,
  sourceDetails: [
    { label: "Task", value: "Brief & outreach" },
    { label: "Source record", value: "COL-SC-042" },
    { label: "Execution mode", value: "Browser agent" },
    { label: "Access status", value: "To validate" },
  ],
  approvalRef,
  state,
  attempt: 1,
  pausedAt: null,
  items,
  reconciliation: { result: "notChecked", evidence: null },
});

export const seedRuns = (): Omit<RunDetail, "counts">[] => [
  { ...run("demo-run-approval", "demo-approval-042", "approvalPending", [item("@routine.with.ella", "unsent", null, "APPROVAL_REQUIRED")]), mode: "propose", trigger: "Agent proposal" },
  run("demo-run-uncertain", "demo-approval-uncertain", "outcomeUncertain", [item("demo-handle-one", "uncertain", null, "TIMEOUT_AFTER_SUBMIT")]),
  run("demo-run-unsent", "demo-approval-uncertain", "outcomeUncertain", [item("demo-handle-one", "uncertain", null, "TIMEOUT_AFTER_SUBMIT")]),
  run("demo-run-noevidence", "demo-approval-uncertain", "outcomeUncertain", [item("demo-handle-one", "uncertain", null, "TIMEOUT_AFTER_SUBMIT")]),
  run("demo-run-batch", "demo-approval-history", "partiallySucceeded", [
    item("demo-handle-a", "confirmed", "demo-source-receipt-a"),
    item("demo-handle-b", "failed", null, "SOURCE_REJECTED"),
    item("demo-handle-c", "held", null, "QUOTA_OR_STOCK_HOLD"),
    item("demo-handle-d", "unsent"),
    item("demo-handle-e", "unsent"),
  ]),
];

export const demoScenarios = {
  approvals: [
    ["demo-approval-042", "Figma sample: archived fee proposal"],
    ["demo-approval-exact", "Exact approval, then send"],
    ["demo-approval-conflict", "Terms change while you review"],
    ["demo-approval-fee", "Blocked: includes an upfront fee"],
    ["demo-approval-expired", "Expired approval"],
    ["demo-approval-founder", "Needs a founder"],
    ["demo-approval-uncertain", "Send has an unknown outcome"],
    ["demo-approval-history", "Decided, with version history"],
  ],
  runs: [
    ["demo-run-approval", "approval", "Run waiting on approval"],
    ["demo-run-uncertain", "recovery", "Unknown outcome: source receipt found"],
    ["demo-run-unsent", "recovery", "Unknown outcome: source shows it never ran"],
    ["demo-run-noevidence", "recovery", "Unknown outcome: no evidence"],
    ["demo-run-batch", "approval", "Partial batch"],
  ],
} as const;
