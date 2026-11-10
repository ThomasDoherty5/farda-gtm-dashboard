import type { ApprovalManifest, ApprovalRead, ApprovalScope, TrustedHuman, DecisionReceipt } from "../approvals/contract.ts";
import type { DispatchRead } from "../jobs/dispatchSchema.ts";
import type { NativeApprovalView, NativeRunView } from "./views.ts";
import type { RunAttemptOutcome, RunItemRecovery } from "./reviewViews.ts";

export type ReviewContextField = "provider" | "account" | "requestedBy" | "reviewer" | "historicalRole";
export type ReviewItemField = "recipient" | "product" | "terms" | "payload";
export type ReviewLinkKind = "approval" | "source" | "session" | "settlement";
export type ReviewSourceText = { text: string; redacted: boolean };

/** This is a private source interface, never an accepted HTTP request body. */
export type ActionReviewRequest = {
  scope: ApprovalScope;
  actor: TrustedHuman;
  manifest: ApprovalManifest;
  decisionReceipt: DecisionReceipt | null;
  run: { runRef: string; revision: number } | null;
};

export type ReviewSourceSnapshot = {
  binding: {
    scope: ApprovalScope; principalRef: string; directoryVersion: string;
    approvalRef: string; manifestVersion: number; manifestHash: string; payloadHash: string;
    providerAccountRef: string; providerAccountVersion: string;
    decisionReceiptRef: string | null; decisionReceiptHash: string | null;
    runRef: string | null; runRevision: number | null;
  };
  sourceRef: string; sourceVersion: string; observedAt: string; validUntil: string;
  grants: {
    context: ReviewContextField[];
    items: { itemRef: string; fields: ReviewItemField[]; recovery: boolean }[];
    links: ReviewLinkKind[];
    settlement: boolean;
  };
  context: Record<ReviewContextField, ReviewSourceText | null>;
  items: {
    itemRef: string; itemVersion: string; itemHash: string; targetRef: string; targetVersion: string; payloadHash: string;
    recipient: ReviewSourceText | null; product: ReviewSourceText | null; terms: ReviewSourceText | null; payload: ReviewSourceText | null;
    recovery: { kind: RunItemRecovery["kind"]; owner: ReviewSourceText | null; nextAction: RunItemRecovery["nextAction"];
      deadline: string | null; resetAt: string | null; reasonCodes: string[] } | null;
  }[];
  links: { kind: ReviewLinkKind; url: string; providerAccountRef: string; manifestHash: string }[];
  settlement: { lane: "manualHistoricalPayable" | "collabsAutoSettlement" | "tiktokAutoSettlement" | "notApplicable";
    detail: ReviewSourceText | null } | null;
};

export type ActionReviewSource = {
  /** Returns only source-authorized operational display material. Secrets, contacts and health information are forbidden. */
  read(request: ActionReviewRequest): Promise<unknown | null>;
  /** Must inspect backing permission/material versions, not merely echo the supplied snapshot. */
  assertCurrent(request: ActionReviewRequest, snapshot: ReviewSourceSnapshot, now: number): void;
};

export type ApprovalHistoryRead = {
  records: ApprovalRead[]; total: number; latestVersion: number; nextBeforeVersion: number | null;
};

export type ActionReviewOptions = {
  scope: ApprovalScope; referenceKey: string; source?: ActionReviewSource;
  permittedLinkOrigins?: readonly string[]; now?: () => number;
};
export type ApprovalReviewInput = {
  base: NativeApprovalView; record: ApprovalRead; actor: TrustedHuman;
  history?: ApprovalHistoryRead & { mode: "current" | "history" };
  /** Existing authority owner rechecks the actor and exact local record after source awaits. */
  assertCurrent(): void;
};
export type RunReviewInput = {
  base: NativeRunView; record: ApprovalRead; dispatch: DispatchRead; actor: TrustedHuman;
  /** Read-only projection supplied by the owning dispatcher, keyed by actual dispatchKey. */
  attemptOutcomes?: ReadonlyMap<string, RunAttemptOutcome>;
  assertCurrent(): void;
};
export type ActionReviewService = {
  decorateApproval(input: ApprovalReviewInput): Promise<NativeApprovalView>;
  decorateRun(input: RunReviewInput): Promise<NativeRunView>;
};
