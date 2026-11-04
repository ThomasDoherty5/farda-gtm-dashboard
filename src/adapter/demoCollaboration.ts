import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError } from "./errors";
import { respondWith } from "./demoViews";
import { collaborationFixtures, revisionsRemaining, type CollaborationData } from "@/fixtures/collaboration";

const fail = (code: string, message: string, requestId: string): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
};

export type CollaborationCommand = "queueNextAction" | "queueFeedback" | "requestRevision" | "rejectContent" | "closeCollaboration" | "suppressOutreach" | "createCollaboration";
export const COMMANDS: readonly string[] = ["queueNextAction", "queueFeedback", "requestRevision", "rejectContent", "closeCollaboration", "suppressOutreach", "createCollaboration"];
export type CommandPayload = { collaborationId: string; text?: string; reason?: string; outcome?: string; actionKey?: string; submissionVersion?: string };

const SUMMARY: Record<CollaborationCommand, (p: CommandPayload) => string> = {
  queueNextAction: (p) => `Next action: ${p.actionKey}`,
  queueFeedback: () => "Feedback on draft v2",
  requestRevision: (p) => `Revision request on ${p.submissionVersion}`,
  rejectContent: (p) => `Rejection of ${p.submissionVersion}`,
  closeCollaboration: (p) => `Close as ${p.outcome}`,
  suppressOutreach: () => "Suppress outreach",
  createCollaboration: () => "New collaboration proposal",
};

/**
 * In-memory stand-in for the collaboration service. Every command here only queues a request for human
 * approval: nothing is sent, closed or suppressed, and a queued request is not an approved one. It
 * enforces the same rules the real server must (required reasons, applicable obligations, expected
 * version, idempotency) and resets on reload.
 */
export function createDemoCollaboration() {
  const requests: (CollaborationData["requests"][number] & { collaborationId: string })[] = [];
  const results = new Map<string, ActionResponse>();
  const version = () => `collab-v${requests.length + 1}`;

  const response = (request: ActionRequest<unknown>, reasonCodes: string[]): ActionResponse => ({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
    actionRef: `demo-action-${request.idempotencyKey}`,
    state: "approvalPending",
    runRef: null,
    approvalRef: `demo-approval-collab-${requests.length}`,
    manifestRef: null,
    payloadVersion: `collab-v${requests.length + 1}`,
    policyVersion: "commission-only@demo",
    modelVersion: null,
    offerVersion: null,
    reasonCodes,
    receiptRefs: [],
    nextAction: { kind: "decideApproval", ownerRef: null, dueAt: null, available: true },
    nextPollAfterMs: null,
    executionCertainty: "applied",
  });

  return {
    read(request: ReadRequest<unknown>): ReadResponse<CollaborationData> {
      const { collaborationId } = (request.filters ?? {}) as { collaborationId?: string };
      const record = (collaborationId ? collaborationFixtures[collaborationId] : undefined) ?? fail("RECORD_NOT_FOUND", "This collaboration does not exist or was removed.", request.requestId);
      const mine = requests.filter((r) => r.collaborationId === collaborationId).map(({ collaborationId: _ignored, ...r }) => r);
      return respondWith(request, { ...structuredClone(record), requests: structuredClone(mine) }, {
        dataVersion: version(),
        capabilities: COMMANDS.map((actionKind) => ({ actionKind, state: record.eligibility.suppressed && actionKind !== "closeCollaboration" ? ("held" as const) : ("available" as const), reasonCodes: [] })),
      });
    },
    async submit(request: ActionRequest<unknown>): Promise<ActionResponse> {
      const prior = results.get(request.idempotencyKey);
      if (prior) return prior;
      if (request.expectedVersion !== version()) fail("STALE_VERSION", "This collaboration changed since you opened it. Reload to see the current state.", request.requestId);
      const kind = request.actionKind as CollaborationCommand;
      if (!COMMANDS.includes(kind)) throw new AdapterError({ code: "INTEGRATION_PENDING", message: `No demo behavior for ${request.actionKind}.`, requestId: request.requestId, correlationId: null, retryable: false, retryAfterMs: null, executionCertainty: "notApplied" });
      const p = (request.payload ?? {}) as CommandPayload;
      const c = (p.collaborationId ? collaborationFixtures[p.collaborationId] : undefined) ?? fail("RECORD_NOT_FOUND", "This collaboration does not exist or was removed.", request.requestId);
      if (c.eligibility.suppressed && kind !== "closeCollaboration") fail("POLICY_VIOLATION", "Outreach is suppressed, so no outbound request can be queued.", request.requestId);
      if (kind === "queueNextAction" && p.actionKey === "remindCreator" && c.terms.posting.kind === "voluntary") fail("POLICY_VIOLATION", "No posting is owed under the accepted terms, so a posting reminder can't be queued. A voluntary post is observed, not chased.", request.requestId);
      if ((kind === "queueFeedback" || kind === "requestRevision" || kind === "rejectContent") && c.content === null) fail("VALIDATION_FAILED", "Nothing has been submitted, so there is no content to give feedback on, revise or reject.", request.requestId);
      if ((kind === "queueFeedback" || kind === "requestRevision") && !(p.text ?? "").trim()) fail("VALIDATION_FAILED", "Feedback text is required.", request.requestId);
      if ((kind === "rejectContent" || kind === "suppressOutreach") && !(p.reason ?? "").trim()) fail("VALIDATION_FAILED", "A reason is required.", request.requestId);
      if (kind === "closeCollaboration" && !c.closureOutcomes.includes(p.outcome ?? "")) fail("VALIDATION_FAILED", "Choose one of the allowed outcomes.", request.requestId);
      if (kind === "queueNextAction" && !c.allowedActions.some((a) => a.key === p.actionKey)) fail("VALIDATION_FAILED", "That action isn't allowed for this collaboration.", request.requestId);
      if ((kind === "requestRevision" || kind === "rejectContent") && p.submissionVersion !== c.content?.version) fail("STALE_VERSION", `The current submission is ${c.content?.version}, not ${p.submissionVersion}.`, request.requestId);
      if (kind === "requestRevision" && revisionsRemaining(c.terms.revisionRounds) === 0) fail("POLICY_VIOLATION", "The agreed revision rounds are used. Another round needs new terms.", request.requestId);
      requests.push({ collaborationId: p.collaborationId, id: `req-${requests.length + 1}`, kind, summary: SUMMARY[kind](p), version: `collab-v${requests.length + 2}`, state: "approvalPending" });
      const result = response(request, kind === "createCollaboration" ? ["FRESH_TERMS_REQUIRED"] : []);
      results.set(request.idempotencyKey, result);
      return result;
    },
  };
}
