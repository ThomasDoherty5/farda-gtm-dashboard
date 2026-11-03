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

const approval = (approvalRef: string, over: Partial<ApprovalDetail> = {}): ApprovalDetail => ({
  approvalRef,
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

export const seedApprovals = (): ApprovalDetail[] => [
  approval("demo-approval-exact"),
  approval("demo-approval-conflict"),
  approval("demo-approval-uncertain"),
  approval("demo-approval-fee", { versions: [version({ payload: payload({ terms: { commissionRatePct: 15, upfrontFee: usd(50_000), sampleCost: null } }) })] }),
  approval("demo-approval-expired", { status: "expired", expiresAt: EARLIER }),
  approval("demo-approval-founder", {
    requiredRole: "founder",
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
  approvalRef,
  state,
  attempt: 1,
  pausedAt: null,
  items,
  reconciliation: { result: "notChecked", evidence: null },
});

export const seedRuns = (): Omit<RunDetail, "counts">[] => [
  { ...run("demo-run-approval", "demo-approval-exact", "approvalPending", [item("demo-handle-one", "unsent", null, "APPROVAL_REQUIRED")]), mode: "propose", trigger: "Agent proposal" },
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
