import { z } from "zod";
import { capabilityIdForBinding } from "./connections/ledger.ts";
import { expectedBindingSchema, MAX_VERIFICATION_AGE_MS } from "./connections/schema.ts";
import type { CapabilityScope, ExpectedBinding } from "./connections/schema.ts";
import { AssetRegistryReadError } from "./notionDriveAssetSource.ts";
import type { AssetRegistryQuery, AssetRegistryPage } from "./notionDriveAssetSource.ts";
import type { AssetScope } from "./assets.ts";
import { digest } from "./config.ts";

const instant = z.string().datetime({ offset: true }).refine(value=>Number.isFinite(Date.parse(value)),"Invalid timestamp or offset.");
const safeRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).refine(v => !v.includes("://"));
const policy = z.object({
  binding: expectedBindingSchema, ownerRef: safeRef, maxAgeSeconds: z.number().int().min(1).max(2_592_000),
  documentationCheckedAt: instant,
});
export const notionHealthTargetConfigSchema = policy.extend({ registry: z.enum(["content", "collaborations"]) }).strict();
export type NotionHealthTargetConfig = z.infer<typeof notionHealthTargetConfigSchema>;
export const sourceHealthPolicySchema = policy.extend({
  documentationRef: safeRef, freshnessBasis: z.enum(["successful_read", "source_event"]),
  requiresKnownQuota: z.boolean().optional(), requiresNativeDeadline: z.boolean().optional(),
}).strict();
export const healthObservationSchema = z.object({
  // Source adapter attests the exact account, route, action and scope digest from private configuration.
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: instant,
  status: z.enum(["observed", "unsupported", "missing_access", "failed", "account_mismatch", "restricted", "quota_discrepancy"]),
  permission: z.enum(["allowed", "denied", "unknown"]),
  session: z.enum(["authenticated", "expired", "mfa", "ui_changed", "unknown"]),
  roleScopePlan: z.enum(["verified", "unknown"]), coverage: z.enum(["complete","partial","unknown"]),
  sourceLastSuccess: instant.nullable(), sourceUpdatedAt: instant.nullable(), mirrorUpdatedAt: instant.nullable(),
  quotaState: z.enum(["not_applicable","unknown","known"]), quotaRemaining: z.number().int().nonnegative().safe().nullable(),
  deadline: instant.nullable(), deadlineState: z.enum(["not_applicable","unknown","known"]).default("unknown"),
}).strict().superRefine((o,c) => {
  if ((o.quotaState === "known") !== (o.quotaRemaining !== null)) c.addIssue({ code: "custom", message: "Known quota requires native remaining units." });
  if ((o.deadlineState === "known") !== (o.deadline !== null)) c.addIssue({ code: "custom", message: "Known deadline requires native time." });
  if ([o.sourceLastSuccess,o.sourceUpdatedAt,o.mirrorUpdatedAt].some(t => t && Date.parse(t) > Date.parse(o.checkedAt))) c.addIssue({ code: "custom", message: "Observed evidence cannot be in the future." });
});
export type HealthObservation = z.infer<typeof healthObservationSchema>;
export type HealthTarget = z.infer<typeof sourceHealthPolicySchema> & { probe?: (signal: AbortSignal) => Promise<HealthObservation> };
export type HealthOptions = { catalog?: readonly HealthTarget[]; activationRef?: string; now?: () => number };
export type HealthSummary = {
  capabilityId: string; preflightVersion: string; configured: boolean; state: "ready"|"unverified"|"blocked"|"unsupported"; reasonCodes: string[];
  permission: HealthObservation["permission"]; session: HealthObservation["session"]; roleScopePlan: HealthObservation["roleScopePlan"];
  checkedAt: string|null; sourceLastSuccess: string|null; sourceUpdatedAt: string|null; mirrorUpdatedAt: string|null;
  freshness: "current"|"stale"|"unknown"; coverage: HealthObservation["coverage"]; ownerRef: string;
  nextAction: string; deadline: string|null; deadlineState: HealthObservation["deadlineState"]; quotaState: HealthObservation["quotaState"]; quotaRemaining: number|null;
  unknowns: string[];
  documentationRef: string|null; documentationCheckedAt: string|null; missingScope: string[];
};
export const healthBindingDigest = (b: ExpectedBinding) => digest({ ...b, requiredScopes: [...b.requiredScopes].sort() });
export const healthPolicyDigest = (target:HealthTarget) => digest(Object.fromEntries(Object.entries(target).filter(([key])=>key!=="probe")));
export type HealthActionBinding = CapabilityScope & Pick<ExpectedBinding,"provider"|"providerAccountId"|"action">;
export const actionGroup = (b: HealthActionBinding) => digest({ scope: [b.workspaceId,b.accountId,b.environment], account: b.providerAccountId, provider: b.provider, action: b.action });
export const noObservation = (binding: ExpectedBinding, now: number, status: HealthObservation["status"]): HealthObservation => ({
  bindingDigest: healthBindingDigest(binding), checkedAt: new Date(now).toISOString(), status, permission: "unknown", session: "unknown", roleScopePlan: "unknown",
  sourceLastSuccess: null, sourceUpdatedAt: null, mirrorUpdatedAt: null, coverage: "unknown", quotaState: "unknown", quotaRemaining: null, deadline: null, deadlineState: "unknown",
});
export type RegistryReader = (scope: AssetScope, query: AssetRegistryQuery, signal?:AbortSignal) => Promise<AssetRegistryPage>;
const registryPageSize=100;
const registryMaxPages=3;

export function createNotionRegistryHealthTargets(scope: CapabilityScope, inputs: readonly NotionHealthTargetConfig[], reader?: RegistryReader, readNotionWorkspace?: (signal?:AbortSignal) => Promise<string|null>): HealthTarget[] {
  return inputs.map(input => {
    const config = notionHealthTargetConfigSchema.parse(input);
    const { registry, ...targetPolicy } = config;
    const b = config.binding;
    const action = config.registry === "content" ? "read-content-registry" : "read-collaborations-registry";
    if (b.workspaceId !== scope.workspaceId || b.accountId !== scope.accountId || b.environment !== scope.environment
      || b.provider !== "notion" || b.action !== action || b.route !== "api" || b.mode !== "observe") throw new Error("INVALID_NOTION_HEALTH_BINDING");
    return { ...targetPolicy, documentationRef: "docs:notion-query-data-source", freshnessBasis: "successful_read" as const,
      probe: reader && readNotionWorkspace ? async (signal: AbortSignal) => {
        const base = noObservation(b, Date.now(), "missing_access");
        // Leave time for a partial/failed receipt before the job's outer probe timeout.
        const scanSignal=AbortSignal.any([signal,AbortSignal.timeout(6000)]);
        let pagesRead=0;
        try {
          scanSignal.throwIfAborted();
          const workspace = await readNotionWorkspace(scanSignal);
          if (!workspace) return base;
          if (workspace !== b.providerAccountId) return { ...base,status:"account_mismatch" };
          let cursor:string|null=null, latestEdit:number|null=null;
          let observedAt=base.checkedAt;
          let complete=false;
          for (let n=0;n<registryMaxPages;n++) {
            scanSignal.throwIfAborted();
            const page=await reader({workspaceId:scope.workspaceId,accountId:scope.accountId},
              {registry,limit:registryPageSize,...(cursor ? {cursor}:{})},scanSignal);
            if (page.registry!==registry) return {...base,status:"account_mismatch"};
            if (page.records.length>registryPageSize) throw new Error("INVALID_REGISTRY_PAGE");
            pagesRead++;
            observedAt=page.observedAt;
            for (const record of page.records) {
              const edited=Date.parse(record.registryEditedAt);
              if (!Number.isFinite(edited)) throw new Error("INVALID_REGISTRY_TIME");
              latestEdit=Math.max(latestEdit ?? edited,edited);
            }
            if (page.queryTruncated) break;
            if (!page.nextCursor) {
              // A continuation page alone is partial. An untruncated native terminal page
              // completes a scan that started at the beginning of this same registry.
              complete=pagesRead===1 ? page.coverage==="complete" : page.queryTruncated===false;
              break;
            }
            cursor=page.nextCursor;
          }
          scanSignal.throwIfAborted();
          const currentWorkspace=await readNotionWorkspace(scanSignal);
          if (!currentWorkspace || currentWorkspace!==workspace) return {...base,status:currentWorkspace ? "account_mismatch" : "missing_access"};
          return { ...base, checkedAt:observedAt,status:"observed",permission:"allowed",session:"authenticated",
            // The read proves this operation and its observed coverage, not a billing plan, role, or write scope.
            sourceLastSuccess:observedAt,sourceUpdatedAt:complete && latestEdit!==null ? new Date(latestEdit).toISOString():null,coverage:complete ? "complete":"partial",
            quotaState: "unknown", deadlineState: "not_applicable" };
        } catch (error) {
          const failed={...base,checkedAt:new Date().toISOString(),coverage:pagesRead ? "partial" as const : "unknown" as const};
          if (error instanceof AssetRegistryReadError && error.authority === "denied") {
            return { ...failed,status:"restricted",permission:"denied" };
          }
          if (error instanceof AssetRegistryReadError && error.authority === "expired") {
            return { ...failed,session:"expired" };
          }
          return { ...failed,
            status: error instanceof AssetRegistryReadError && error.code === "SOURCE_ACCESS_UNAVAILABLE" ? "missing_access" : "failed" };
        }
      } : undefined,
    };
  });
}

export function summarize(input: {
  id: string; target?: HealthTarget; ownerRef: string; capabilityState: string; observation?: HealthObservation;
  capabilityRevision:number; observationId?:string; previousEvidence?:boolean; revisionCurrent: boolean; now: number; activeDenial: boolean;
}): HealthSummary {
  const { id,target,now } = input;
  const parsed = healthObservationSchema.safeParse(input.observation);
  const clockValid = Number.isSafeInteger(now) && now>=0;
  // Revalidate saved source data before release, including records written by earlier versions.
  const currentObservation = parsed.success && clockValid && Date.parse(parsed.data.checkedAt)<=now;
  const o = currentObservation ? parsed.data : undefined;
  const reasons: string[] = [];
  if (!clockValid || (input.observation && !currentObservation)) reasons.push("INVALID_HEALTH_OBSERVATION");
  const unknowns = [];
  if (!o || o.quotaState === "unknown") unknowns.push("NATIVE_QUOTA_UNKNOWN");
  if (!o || o.deadlineState === "unknown") unknowns.push("NATIVE_DEADLINE_UNKNOWN");
  const execution = target?.binding.mode === "executeApproved";
  if ((target?.requiresKnownQuota ?? execution) && o?.quotaState !== "known") reasons.push("REQUIRED_QUOTA_UNVERIFIED");
  if ((target?.requiresNativeDeadline ?? execution) && o?.deadlineState !== "known") reasons.push("REQUIRED_DEADLINE_UNVERIFIED");
  if (o?.deadline && Date.parse(o.deadline) <= now) reasons.push("NATIVE_DEADLINE_ELAPSED");
  const time = target?.freshnessBasis === "source_event" ? o?.sourceUpdatedAt : o?.sourceLastSuccess;
  const age = time ? now-Date.parse(time) : null;
  const freshness = !target || age === null || !Number.isFinite(age) || age<0 ? "unknown" : age < target.maxAgeSeconds*1000 ? "current" : "stale";
  if (!target?.probe) reasons.push("PROBE_NOT_CONFIGURED");
  if (!o) reasons.push("NO_NATIVE_OBSERVATION");
  if ((o || input.previousEvidence) && !input.revisionCurrent) reasons.push("BINDING_CHANGED");
  if (o && now-Date.parse(o.checkedAt) >= Math.min(MAX_VERIFICATION_AGE_MS,(target?.maxAgeSeconds ?? 0)*1000)) reasons.push("PREFLIGHT_EXPIRED");
  if (input.activeDenial || input.capabilityState === "Denied" || o?.permission === "denied") reasons.push("PERMISSION_DENIED");
  if (o?.status === "restricted" || o?.status === "account_mismatch") reasons.push(o.status === "restricted" ? "ACCOUNT_RESTRICTED" : "ACCOUNT_MISMATCH");
  if (o?.session === "expired" || o?.session === "mfa" || o?.session === "ui_changed") reasons.push({ expired:"SESSION_EXPIRED",mfa:"MFA_REQUIRED",ui_changed:"UI_DRIFT" }[o.session]);
  if (o?.status === "unsupported" || input.capabilityState === "Unsupported") reasons.push("ROUTE_UNSUPPORTED");
  if (o?.status === "missing_access") reasons.push("ACCESS_UNVERIFIED");
  if (o?.status === "failed") reasons.push("PROBE_FAILED");
  if (o?.status === "quota_discrepancy" || o?.quotaRemaining === 0) reasons.push("CAPACITY_UNAVAILABLE");
  if (o?.status === "observed") {
    if (o.permission !== "allowed" || o.session !== "authenticated") reasons.push("SESSION_OR_PERMISSION_UNVERIFIED");
    if (target?.binding.mode === "executeApproved" && o.roleScopePlan !== "verified") reasons.push("ROLE_SCOPE_PLAN_UNVERIFIED");
    if (o.coverage !== "complete") reasons.push("COVERAGE_INCOMPLETE");
    if (freshness !== "current") reasons.push(freshness === "stale" ? "SOURCE_STALE" : "SOURCE_TIME_UNKNOWN");
  }
  if (o?.status === "observed" && input.capabilityState !== "Ready") reasons.push("CAPABILITY_NOT_VERIFIED");
  if (!target || id !== capabilityIdForBinding(target.binding)) reasons.push("NO_TARGET_BINDING");
  const blocked = reasons.some(code => ["INVALID_HEALTH_OBSERVATION","PERMISSION_DENIED","ACCOUNT_RESTRICTED","ACCOUNT_MISMATCH","SESSION_EXPIRED","MFA_REQUIRED","UI_DRIFT","CAPACITY_UNAVAILABLE","SOURCE_STALE"].includes(code));
  const state = blocked ? "blocked" : reasons.includes("ROUTE_UNSUPPORTED") ? "unsupported" : reasons.length ? "unverified" : "ready";
  const preflightVersion = digest({ schemaVersion:"provider-health.v1", capabilityId:id, capabilityRevision:input.capabilityRevision,
    policy:target ? healthPolicyDigest(target) : null, observationId:input.observationId ?? null, observation:o ? digest(o) : null,
    state, reasons, freshness, unknowns });
  return { capabilityId:id, preflightVersion, configured:!!target?.probe, state, reasonCodes:[...new Set(reasons)],
    permission:o?.permission ?? "unknown", session:o?.session ?? "unknown", roleScopePlan:o?.roleScopePlan ?? "unknown", checkedAt:o?.checkedAt ?? null,
    sourceLastSuccess:o?.sourceLastSuccess ?? null, sourceUpdatedAt:o?.sourceUpdatedAt ?? null, mirrorUpdatedAt:o?.mirrorUpdatedAt ?? null, freshness, coverage:o?.coverage ?? "unknown",
    ownerRef:input.ownerRef, nextAction: state === "ready" ? "none" : blocked ? "owner_takeover_and_reverify" : "verify_exact_route",
    deadline:o?.deadline ?? null, deadlineState:o?.deadlineState ?? "unknown", quotaState:o?.quotaState ?? "unknown", quotaRemaining:o?.quotaRemaining ?? null, unknowns,
    documentationRef:target?.documentationRef ?? null, documentationCheckedAt:target?.documentationCheckedAt ?? null,
    missingScope:o?.coverage === "complete" ? [] : [target?.binding.action ?? "unknown"],
  };
}
