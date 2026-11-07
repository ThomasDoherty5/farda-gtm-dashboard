import { digest } from "../config.ts";
import { commercialPolicySnapshotSchema, rewardPolicySnapshotSchema, type CommercialPolicySnapshot, type CommercialPolicySource, type CommercialScope, type RewardPolicySnapshot } from "./contract.ts";

export const sameCommercialScope = (a: CommercialScope, b: CommercialScope) => a.workspaceId === b.workspaceId && a.accountId === b.accountId && a.environment === b.environment;
export function commercialLease(observedAt: string, validUntil: string, now: number): boolean {
  const observed = Date.parse(observedAt), until = Date.parse(validUntil);
  return Number.isSafeInteger(now) && Number.isFinite(observed) && Number.isFinite(until) && observed <= now && until > now && until > observed;
}
export function rewardPolicyMaterial(snapshot: RewardPolicySnapshot) {
  const { observedAt: _observed, validUntil: _until, execution, ...material } = snapshot; void _observed; void _until;
  const { observedAt: _executionObserved, validUntil: _executionUntil, ...permission } = execution; void _executionObserved; void _executionUntil;
  return { ...material, execution: permission };
}
export function commercialPolicyMaterial(snapshot: CommercialPolicySnapshot) {
  const { observedAt: _observed, validUntil: _until, performanceReward, ...material } = snapshot; void _observed; void _until;
  return { ...material, performanceReward: performanceReward ? rewardPolicyMaterial(performanceReward) : null };
}
export const commercialPolicyHash = (snapshot: CommercialPolicySnapshot) => digest(commercialPolicyMaterial(snapshot));
export type CommercialPolicyRead = { snapshot: CommercialPolicySnapshot | null; reasonCodes: string[] };
export function readCommercialPolicy(source: CommercialPolicySource | undefined, scope: CommercialScope, now: number): CommercialPolicyRead {
  if (!source) return { snapshot: null, reasonCodes: ["COMMERCIAL_POLICY_UNAVAILABLE"] };
  try {
    const parsed = commercialPolicySnapshotSchema.safeParse(source.readCurrent(scope));
    if (!parsed.success || !sameCommercialScope(parsed.data.scope, scope)) return { snapshot: null, reasonCodes: ["COMMERCIAL_POLICY_UNVERIFIED"] };
    const snapshot = parsed.data;
    assertCommercialPolicyCurrent(source, snapshot, scope, now);
    const reasons: string[] = [];
    if (snapshot.state !== "effective") reasons.push(snapshot.state === "revoked" ? "COMMERCIAL_POLICY_REVOKED" : "COMMERCIAL_POLICY_PROPOSED");
    if (snapshot.state === "effective" && (!snapshot.effectiveAt || Date.parse(snapshot.effectiveAt) > now)) reasons.push("COMMERCIAL_POLICY_NOT_EFFECTIVE");
    return { snapshot, reasonCodes: reasons };
  } catch { return { snapshot: null, reasonCodes: ["COMMERCIAL_POLICY_SOURCE_HELD"] }; }
}
export function assertCommercialPolicyCurrent(source: CommercialPolicySource | undefined, snapshot: CommercialPolicySnapshot, scope: CommercialScope, now: number): void {
  const value = commercialPolicySnapshotSchema.parse(snapshot);
  if (!source || !sameCommercialScope(value.scope, scope) || !commercialLease(value.observedAt, value.validUntil, now)) throw new Error("COMMERCIAL_POLICY_SOURCE_HELD");
  source.assertCurrent(value, now);
}
export function readRewardPolicy(source: CommercialPolicySource | undefined, input: { scope: CommercialScope; programmeRef: string; rewardVersion: string }, now: number): RewardPolicySnapshot | null {
  if (!source) return null;
  try {
    const result = rewardPolicySnapshotSchema.safeParse(source.readRewardPolicy(input));
    if (!result.success || result.data.programmeRef !== input.programmeRef || result.data.rewardVersion !== input.rewardVersion) return null;
    assertRewardPolicyCurrent(source, result.data, input.scope, now);
    return result.data;
  } catch { return null; }
}
/** Checks the exact historical terms and current source lease. It does not reprice an earned J11 entitlement. */
export function assertRewardPolicyCurrent(source: CommercialPolicySource | undefined, snapshot: RewardPolicySnapshot, scope: CommercialScope, now: number): void {
  const value = rewardPolicySnapshotSchema.parse(snapshot);
  if (!source || !sameCommercialScope(value.scope, scope) || !commercialLease(value.observedAt, value.validUntil, now) ||
    !commercialLease(value.execution.observedAt, value.execution.validUntil, now)) throw new Error("REWARD_POLICY_SOURCE_HELD");
  if(value.terms.state==="effective" && (!value.terms.effectiveAt || Date.parse(value.terms.effectiveAt)>now))throw new Error("REWARD_POLICY_NOT_EFFECTIVE");
  source.assertRewardCurrent(value, now);
}
