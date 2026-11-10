import type { DatabaseSync } from "node:sqlite";
import type { ApprovalScope } from "./approvals/contract.ts";
import type { DispatchApprovalAuthority } from "./jobs/dispatchSchema.ts";
import { PaidMediaRepository, type MediaAuthority } from "./media/repository.ts";
import { MediaReleaseController, type MediaControlAuthority } from "./mediaControl/repository.ts";
import { createMediaDomainBridge, type MediaDomainRegistration } from "./media/approvalBridge.ts";
import type { CanonicalMediaSource, CanonicalStageSource } from "./media/canonicalContract.ts";

/** Private source configuration only. No browser/session payload can create these bindings. */
export type MediaDomainBindings = {
  readers: Pick<MediaAuthority, "account" | "capability" | "checkout" | "offer" | "asset" | "gate">;
  controlReaders: Pick<MediaControlAuthority, "parameters" | "spendReport" | "orders" | "health" | "treasury">;
  source: CanonicalMediaSource;
  stageSource: CanonicalStageSource;
  registration: MediaDomainRegistration;
};

/** Reuse the existing domain records on the application's database and the one actual J04/runner. */
export function createMediaComposition(options: { db: DatabaseSync; scope: ApprovalScope; bindings: MediaDomainBindings;
  stageApprovals: DispatchApprovalAuthority; now?: () => number }) {
  const { db, scope, bindings } = options, now = options.now ?? Date.now;
  const mediaScope = { workspaceId: scope.workspaceId, accountId: scope.accountId };
  const { account, capability, checkout, offer, asset, gate } = bindings.readers;
  const { parameters, spendReport, orders, health, treasury } = bindings.controlReaders;
  // Old domain decision callbacks/executors are deliberately not retained.
  const repository = new PaidMediaRepository(db, mediaScope, { account, capability, checkout, offer, asset, gate }, () => new Date(now()));
  const controller = new MediaReleaseController(db, mediaScope, { parameters, spendReport, orders, health, treasury }, repository, () => new Date(now()));
  const bridge = createMediaDomainBridge({ scope, repository, controller, source: bindings.source, stageSource: bindings.stageSource,
    registration: bindings.registration, stageApprovals: options.stageApprovals, now });
  return { ...bridge, repository, controller };
}
export type MediaComposition = ReturnType<typeof createMediaComposition>;
