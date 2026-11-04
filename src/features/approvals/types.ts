/**
 * View models for the approval and run screens (THO-296). PROPOSED: the handoff lists the required
 * facts (exact payload, recipients, terms, versions, role, expiry, receipts), and THO-283/THO-321
 * freeze the real schemas. Field names here are not an agreed API.
 */
import type { ActionState, ExecutionMode, Money, SourceRef } from "@/adapter/contract";

export type ApprovalDecision = "approved" | "rejected" | "editRequired" | "expired" | "canceled";
export type ApprovalStatus = "pending" | ApprovalDecision;

export type ApprovalPayload = {
  actionLabel: string;
  account: SourceRef;
  creator: SourceRef;
  recipients: SourceRef[];
  recruitmentSource: string;
  publishingNetworks: string[];
  checkout: string;
  message: string;
  terms: { commissionRatePct: number; upfrontFee: Money; sampleCost: Money | null };
};

export type ApprovalVersion = {
  version: string;
  payload: ApprovalPayload;
  payloadHash: string;
  policyVersion: string;
  offerVersion: string | null;
  decision: ApprovalDecision | null;
  decidedByRole: string | null;
  decidedAt: string | null;
  reason: string | null;
  decisionReceiptRef: string | null;
  slackPermalink: string | null;
};

export type QueueItem = { approvalRef: string; handle: string; summary: string; status: string; tone: "warning" | "neutral" };
export type TimelineEvent = { time: string; title: string; note: string };

export type ApprovalDetail = {
  approvalRef: string;
  displayId: string;
  title: string;
  contextLine: string;
  source: string;
  platform: string;
  actionName: string;
  requestedBy: string;
  reviewer: string;
  /** Set on a record kept for history. It explains why the record can't create new commitments. */
  historicalNote: string | null;
  executionPlan: string;
  capabilityLabel: string;
  queueLabel: string;
  queue: QueueItem[];
  timeline: TimelineEvent[];
  status: ApprovalStatus;
  currentVersion: string;
  requiredRole: string;
  expiresAt: string;
  manifestRef: string;
  versions: ApprovalVersion[];
  execution: { runRef: string; state: ActionState; receiptRefs: string[] } | null;
};

export type RunItemState = "confirmed" | "failed" | "held" | "unsent" | "paused" | "uncertain";
export type RunItem = { itemId: string; recipient: SourceRef; state: RunItemState; receiptRef: string | null; reasonCode: string | null };
export type RunCounts = Record<RunItemState, number>;

export type Reconciliation = {
  result: "notChecked" | "sourceReceiptFound" | "confirmedNotExecuted" | "stillUnknown";
  evidence: { receiptRef: string; provider: string; accountId: string; identity: string; observedAt: string } | null;
};

export type RunStep = { title: string; note: string; status: "Complete" | "Waiting" | "Blocked" };

export type RunDetail = {
  runRef: string;
  displayId: string;
  source: string;
  collaboration: string;
  handle: string;
  revision: string;
  decisionLabel: string;
  lastEvent: string;
  historicalNote: string | null;
  steps: RunStep[];
  stages: string[];
  currentStage: string;
  previewMessage: string;
  sourceDetails: { label: string; value: string }[];
  version: string;
  jobId: string;
  jobVersion: string;
  mode: ExecutionMode;
  environment: string;
  trigger: string;
  correlationId: string;
  approvalRef: string;
  state: ActionState;
  attempt: number;
  pausedAt: string | null;
  counts: RunCounts;
  items: RunItem[];
  reconciliation: Reconciliation;
};

export type DecidePayload = { decision: "approved" | "rejected" | "editRequired"; reason?: string; editedMessage?: string };
/** Q-03: the run is the request's top-level `runRef`, not part of the payload. */
export type ControlPayload = { control: "pause" };
export type ReconcilePayload = { request: "lookup" | "recordConfirmedSent" | "freshAttempt" };
