import type { ActionFoundationBindings } from "./actionFoundation.ts";
import { ApprovalError, type ApprovalRegistry } from "./approvals/contract.ts";
import type { RegisteredAction } from "./actions/service.ts";
import type { DispatchHandler } from "./jobs/dispatchSchema.ts";

export type ActionDomain = {
  registry: ApprovalRegistry;
  actions: ReadonlyMap<string, RegisteredAction>;
  handlers: ReadonlyMap<string, DispatchHandler>;
};

/** Combine domain consumers behind the one J04/runner composition. No domain can replace another's authority. */
export function composeActionDomains(base: ActionFoundationBindings | undefined, domains: readonly ActionDomain[]): ActionFoundationBindings | undefined {
  if (!domains.length) return base;
  const registry = new Map(base?.registry ?? []), handlers = new Map(base?.handlers ?? []);
  const owners = new Map<string, ApprovalRegistry>();
  for (const domain of domains) {
    for (const [action, value] of domain.actions) {
      if (registry.has(action)) throw new Error("Duplicate native action registration");
      if (!domain.handlers.has(value.handlerRef)) throw new Error("Domain action requires its registered handler");
      registry.set(action, value); owners.set(action, domain.registry);
    }
    for (const [handler, value] of domain.handlers) {
      if (handlers.has(handler)) throw new Error("Duplicate native handler registration");
      handlers.set(handler, value);
    }
  }
  const owner = (action: string) => {
    const source = owners.get(action) ?? base?.approvals?.registry;
    if (!source) throw new ApprovalError("SOURCE_ACTION_UNSUPPORTED");
    return source;
  };
  const combined: ApprovalRegistry = {
    resolvePreview: (command, principal, scope) => owner(command.actionKind).resolvePreview(command, principal, scope),
    currentDraft: manifest => owner(manifest.draft.actionKind).currentDraft(manifest),
    assertCurrentDraft: (manifest, observed, now) => {
      const source = owner(manifest.draft.actionKind);
      if (!source.assertCurrentDraft) throw new ApprovalError("APPROVAL_CURRENT_SOURCE_UNVERIFIED");
      source.assertCurrentDraft(manifest, observed, now);
    },
  };
  return { ...base, approvals: { ...base?.approvals, registry: combined }, registry, handlers };
}
