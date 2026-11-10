import { digest } from "../config.ts";
import { approvalPolicySchema, trustedHumanSchema, slackDecisionSchema, linearReadbackSchema, type ApprovalScope, type ApprovalSources, type ApprovalPolicy,
  type TrustedHuman, type VerifiedSlackDecision, type SlackDecisionLocator, type TrustedApprovalIngress, type LinearRecordIntent, type LinearReadback } from "./contract.ts";

export const sameApprovalScope = (a: ApprovalScope, b: ApprovalScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId && a.environment === b.environment;
export function fresh(observedAt: string, validUntil: string, now: number): boolean {
  const observed = Date.parse(observedAt), until = Date.parse(validUntil);
  return Number.isFinite(now) && Number.isFinite(observed) && Number.isFinite(until) && observed <= now && until > now && until > observed;
}
export function currentPolicy(raw: unknown, scope: ApprovalScope, now: number): ApprovalPolicy | null {
  const parsed = approvalPolicySchema.safeParse(raw);
  return parsed.success && sameApprovalScope(parsed.data.scope, scope) && fresh(parsed.data.observedAt, parsed.data.validUntil, now) ? parsed.data : null;
}
export async function resolveHuman(sources: ApprovalSources, principalRef: string, scope: ApprovalScope, now: () => number): Promise<TrustedHuman | null> {
  try {
    const parsed = trustedHumanSchema.safeParse(await sources.resolveActor?.(principalRef, scope));
    return parsed.success && sameApprovalScope(parsed.data.scope, scope) && parsed.data.principalRef === principalRef && parsed.data.active && fresh(parsed.data.observedAt, parsed.data.validUntil, now()) ? parsed.data : null;
  } catch { return null; }
}
export async function readSlack(sources: ApprovalSources, locator: SlackDecisionLocator, scope: ApprovalScope, now: () => number, ingress?: TrustedApprovalIngress): Promise<VerifiedSlackDecision | null> {
  try {
    const parsed = slackDecisionSchema.safeParse(await sources.readSlackDecision?.(locator, scope, ingress));
    return parsed.success && sameApprovalScope(parsed.data.scope, scope) && digest(parsed.data.locator) === digest(locator) && fresh(parsed.data.observedAt, parsed.data.validUntil, now()) && Date.parse(parsed.data.decidedAt) <= now() ? parsed.data : null;
  } catch { return null; }
}
export async function readLinear(sources: ApprovalSources, intent: LinearRecordIntent, now: () => number): Promise<LinearReadback> {
  try {
    const parsed = linearReadbackSchema.safeParse(await sources.readLinearRecord?.(intent));
    if (!parsed.success) return { state: "unknown", reason: "LINEAR_READBACK_UNAVAILABLE" };
    const value = parsed.data;
    if (value.state !== "recorded") return value;
    if (!sameApprovalScope(value.scope, intent.scope) || value.intentRef !== intent.intentRef || value.issueRef !== intent.issueRef || value.contentHash !== intent.contentHash || !value.active || !fresh(value.observedAt, value.validUntil, now()))
      return { state: "unknown", reason: "LINEAR_READBACK_MISMATCH" };
    return value;
  } catch { return { state: "unknown", reason: "LINEAR_READBACK_UNAVAILABLE" }; }
}
/** Rolling verification times are not part of an immutable source event identity. */
export function stableSlack(decision: VerifiedSlackDecision) {
  return Object.fromEntries(Object.entries(decision).filter(([key]) => key !== "observedAt" && key !== "validUntil"));
}
