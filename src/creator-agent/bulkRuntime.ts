import type { DatabaseSync } from "node:sqlite";
import { digest } from "./config.ts";
import { type ApprovalManifest, type ApprovalScope } from "./approvals/contract.ts";
import { BulkError, type BulkSnapshot } from "./bulk/contract.ts";
import { runtimeRegistrationSchema, type RuntimeRegistration, type RuntimeRegistry } from "./jobs/runtimeSchema.ts";

/** Compiled J13 registration. Installing or firing it still requires the existing
 * runtime's exact machine and source authority. This factory enables no trigger. */
export function createBulkRuntimeRegistration(input: {
  registrationRef: string; ownerRef: string; sourceRef: string; policyVersion: string;
  budgets: RuntimeRegistration["definition"]["budgets"];
}): RuntimeRegistration {
  return runtimeRegistrationSchema.parse({
    registrationRef: input.registrationRef, version: 1, family: "registered-business",
    ownerRef: input.ownerRef, sourceRef: input.sourceRef,
    sourceSchemaVersion: "farda.bulk-input.v1", outputSchemaVersion: "farda.bulk-output.v1",
    membership: "approved-manifest", cadence: { kind: "event", eventType: "bulk.exact-manifest.v1" },
    definition: { jobId: "J13", version: 1, ownerRef: input.ownerRef, mode: "executeApproved",
      handler: "dispatch-approved.v1", eventType: "bulk.exact-manifest.v1",
      inputSchemaVersion: "job-reference-batch.v1", outputSchemaVersion: "job-dispatch-result.v1",
      policyVersion: input.policyVersion, modelVersion: null, offerVersion: null,
      capabilityBinding: null, budgets: input.budgets },
    // Per-item domain handlers own their actual provider bindings and quotas.
    apiBinding: null, browserBinding: null, executorRef: "dispatch-approved.v1",
    browserExecutorRef: null, apiChannel: "directApi",
  });
}

export function assertBulkRuntimeRegistration(db: DatabaseSync, registry: RuntimeRegistry | undefined,
  descriptor: BulkSnapshot["registration"]): void {
  const parsed = runtimeRegistrationSchema.safeParse(registry?.registrations.get(descriptor.registrationRef));
  if (!parsed.success) throw new BulkError("BULK_RUNTIME_UNCONFIGURED", 503);
  const r = parsed.data;
  if (r.registrationRef !== descriptor.registrationRef || `v${r.version}` !== descriptor.registrationVersion ||
    r.definition.jobId !== descriptor.jobId || r.definition.version !== descriptor.version ||
    r.family !== "registered-business" || r.membership !== "approved-manifest" || r.cadence.kind !== "event" ||
    r.definition.mode !== "executeApproved" || r.definition.handler !== "dispatch-approved.v1" ||
    r.sourceSchemaVersion !== descriptor.inputSchema || r.outputSchemaVersion !== descriptor.outputSchema)
    throw new BulkError("BULK_RUNTIME_BINDING_CHANGED");
  const installed = db.prepare("SELECT body_hash FROM job_runtime_registrations WHERE ref=? AND version=?").get(r.registrationRef, r.version);
  if (installed && installed.body_hash !== digest(r)) throw new BulkError("BULK_RUNTIME_VERSION_REUSED");
}

/** Read the canonical J04 store; no parallel bulk approval or command journal. */
export function findBulkGroupManifest(db: DatabaseSync, scope: ApprovalScope,
  sourceRef: string, basisHash: string, actionKind: string, payloadRef: string) {
  const rows = db.prepare(`SELECT body FROM approval_manifests
    WHERE json_extract(body,'$.scope.workspaceId')=? AND json_extract(body,'$.scope.accountId')=?
      AND json_extract(body,'$.scope.environment')=? AND json_extract(body,'$.draft.sourceBasisRef')=?
      AND json_extract(body,'$.draft.sourceBasisVersion')=? AND json_extract(body,'$.draft.actionKind')=?
      AND json_extract(body,'$.draft.payloadRef')=? ORDER BY version DESC LIMIT 2`)
    .all(scope.workspaceId, scope.accountId, scope.environment, sourceRef, basisHash, actionKind, payloadRef);
  if (rows.length > 1) throw new BulkError("BULK_CANONICAL_APPROVAL_AMBIGUOUS");
  return rows[0] ? JSON.parse(String(rows[0].body)) as ApprovalManifest : null;
}
