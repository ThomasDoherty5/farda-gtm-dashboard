/**
 * @internal Pure envelope helpers shared by the repository and the action adapter. They never decide whether an
 * intent may be submitted: callers must pass an intent they have just re-read from the repository.
 */
import { SCHEMA_VERSION } from "../../adapter/contract.ts";
import { foundationActionSchema, type FoundationAction } from "../actions/wire.ts";
import type { OperationsScope } from "../operations.ts";
import type { StoredIntent } from "./contract.ts";

export const FOLLOW_UP_ACTION_KIND = "creatorFollowUpReminder";
export const requestedScopeOf = (scope: OperationsScope) => ({ workspaceId: scope.workspaceId, accountIds: [scope.accountId], environment: scope.environment });
export const previewKeyOf = (intentRef: string) => "follow-up-preview:" + intentRef;

/** The J04 preview for one reserved reminder. The approval binds to the exact intent version. */
export function previewEnvelope(intent: StoredIntent, scope: OperationsScope, requestId: string): FoundationAction {
  return foundationActionSchema.parse({ schemaVersion: SCHEMA_VERSION, requestId, requestedScope: requestedScopeOf(scope),
    operation: "previewAction", actionKind: FOLLOW_UP_ACTION_KIND, expectedVersion: intent.intentVersion, idempotencyKey: previewKeyOf(intent.intentRef),
    entityRefs: [], approvalRef: null, manifestRef: null,
    payload: { entityRef: intent.collaborationId, entityVersion: intent.intentVersion, selectionRefs: [intent.intentRef] } });
}
