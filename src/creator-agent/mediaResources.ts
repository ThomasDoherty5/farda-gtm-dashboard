import { DispatchError, type ResourceAuthority, type ResourceRequirements } from "./jobs/dispatchSchema.ts";
import type { createMediaDomainBridge } from "./media/approvalBridge.ts";

/** Media's existing stage reservation owns its budget. All other source grants retain their existing owner. */
export function createMediaResources(base: ResourceAuthority | undefined, media: ReturnType<typeof createMediaDomainBridge>): ResourceAuthority {
  const ownsBudget = (request: Parameters<ResourceAuthority["resolveGrants"]>[0]) => media.actions.has(request.intent.approval.actionKind) && request.requirements.budget.state === "required";
  const remaining = (request: Parameters<ResourceAuthority["resolveGrants"]>[0]) => ({ ...request,
    requirements: { ...request.requirements, budget: { state: "notApplicable", policyVersion: "canonical-media-budget-owner.v1",
      reason: "The existing media stage owner issues this operation's exclusive budget grant." } } as ResourceRequirements });
  const needsOwner = (request: Parameters<ResourceAuthority["resolveGrants"]>[0]) => Object.values(request.requirements).some(need => need.state === "required");
  return {
    async resolveGrants(request) {
      if (!ownsBudget(request)) {
        if (!base && needsOwner(request)) throw new DispatchError("DISPATCH_RESOURCE_AUTHORITY_REQUIRED");
        return base ? base.resolveGrants(request) : [];
      }
      const rest = remaining(request);
      if (!base && needsOwner(rest)) throw new DispatchError("DISPATCH_RESOURCE_AUTHORITY_REQUIRED");
      const grants = base ? await base.resolveGrants(rest) : [];
      if (grants.some(grant => grant.dimension === "budget")) throw new DispatchError("MEDIA_DUPLICATE_BUDGET_OWNER");
      // Source/J04 fences are checked after the final awaited quota/stock allocation by this owner.
      const budget = media.reserveBudget(request.intent, request.dispatchKey);
      return [...grants, budget];
    },
    assertCurrent(grants, request, now) {
      if (!ownsBudget(request)) {
        if (!base && needsOwner(request)) throw new DispatchError("DISPATCH_RESOURCE_AUTHORITY_REQUIRED");
        base?.assertCurrent(grants, request, now); return;
      }
      const budgets = grants.filter(grant => grant.dimension === "budget");
      if (budgets.length !== 1) throw new DispatchError("MEDIA_EXACT_BUDGET_GRANT_REQUIRED");
      const rest = remaining(request);
      if (!base && needsOwner(rest)) throw new DispatchError("DISPATCH_RESOURCE_AUTHORITY_REQUIRED");
      base?.assertCurrent(grants.filter(grant => grant.dimension !== "budget"), rest, now);
      media.assertBudget(budgets[0]!, request.intent);
    },
  };
}
