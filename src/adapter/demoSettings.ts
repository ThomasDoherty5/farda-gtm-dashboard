import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { respondWith } from "./demoViews";
import { createOnce } from "./demoOnce";
import { AdapterError } from "./errors";
import { validateSchedule } from "@/features/settings/schedule";
import { automationDemo, capabilityDemo, connectionsDemo, DEMO_JOB_ID, scheduleDemo, teamDemo, type CapabilityData, type ScheduleData, type ScheduleDraft } from "@/fixtures/settings";
import { DEMO_NOW } from "@/fixtures/overview";

export type TaskRequest = { jobType: string; account: string; scope: string; reason: string };
export type PermissionEvidence = { rowId: string; reviewer: string; evidence: string; observedOn: string };
export type PermissionRecord = PermissionEvidence & { version: string; savedAt: string };

const fail = (code: string, message: string, requestId: string, extra: { fieldErrors?: Record<string, string>; currentVersion?: string } = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export const settingsViewKeys = ["connectionsOverview", "teamPermissions", "automationRuns", "scheduleDetail", "channelCapabilities"] as const;

/**
 * In-memory stand-in for the settings, automation and capability services. It serves labeled synthetic data,
 * validates the way the real server must (allowed values, expected version, idempotency), keeps saved drafts
 * for the session and contacts no provider. A saved draft never enables a schedule, and recorded permission
 * evidence never turns a provider capability on.
 */
export function createDemoSettings() {
  let draft: ScheduleDraft = { ...scheduleDemo.draft };
  let draftVersion = scheduleDemo.draftVersion;
  const permissions = new Map<string, PermissionRecord>();
  let tasks = 0;
  const once = createOnce();

  return {
    read(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
      switch (request.viewKey) {
        case "connectionsOverview":
          return respondWith(request, connectionsDemo, { dataVersion: "connections-demo@1", dataState: "partial", capabilities: [{ actionKind: "checkConnections", state: "available", reasonCodes: [] }] });
        case "teamPermissions":
          return respondWith(request, teamDemo, { dataVersion: "team-demo@1" });
        case "automationRuns":
          return respondWith(request, automationDemo, { dataVersion: "automation-demo@1", capabilities: [{ actionKind: "requestTask", state: "available", reasonCodes: [] }, { actionKind: "takeOverTask", state: "held", reasonCodes: ["TAKEOVER_NOT_ASSIGNED"] }] });
        case "scheduleDetail": {
          const { jobId } = request.filters as { jobId: string };
          if (jobId !== DEMO_JOB_ID) return fail("RECORD_NOT_FOUND", "This schedule does not exist or was removed.", request.requestId);
          const data: ScheduleData = { ...scheduleDemo, draft: { ...draft }, draftVersion };
          return respondWith(request, data, {
            dataVersion: draftVersion,
            capabilities: [{ actionKind: "saveScheduleDraft", state: "available", reasonCodes: [] }, { actionKind: "enableSchedule", state: "held", reasonCodes: ["CONNECTION_UNVERIFIED"] }],
          });
        }
        case "channelCapabilities": {
          const data: CapabilityData = { ...capabilityDemo, recorded: Object.fromEntries(permissions) };
          return respondWith(request, data, { dataVersion: `capabilities-demo@${permissions.size + 1}`, capabilities: [{ actionKind: "recordPermissionEvidence", state: "available", reasonCodes: [] }] });
        }
        default:
          return null;
      }
    },

    submit(request: ActionRequest<unknown>): ActionResponse | null {
      if (request.actionKind !== "requestTask") return null;
      const rid = request.requestId;
      return once(request.idempotencyKey, JSON.stringify(request.payload), rid, () => {
        const p = request.payload as Partial<TaskRequest>;
        const errors: Record<string, string> = {};
        // Only registered job types and the listed accounts are accepted; source text never chooses either.
        if (!automationDemo.jobTypes.some((j) => j.value === p.jobType)) errors.jobType = "Choose one of the registered job types.";
        if (!automationDemo.accounts.some((a) => a.value === p.account)) errors.account = "Choose a listed account.";
        if (!p.scope?.trim()) errors.scope = "Name the entity or scope this task covers.";
        if ((p.reason?.trim().length ?? 0) < 10) errors.reason = "Say why in at least 10 characters.";
        if (Object.keys(errors).length) fail("VALIDATION_FAILED", "Fix the highlighted fields and try again.", rid, { fieldErrors: errors });
        tasks += 1;
        return {
          schemaVersion: SCHEMA_VERSION,
          requestId: rid,
          scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
          actionRef: `demo-task-${tasks}`,
          state: "approvalPending",
          runRef: null,
          approvalRef: null,
          manifestRef: null,
          payloadVersion: "v1",
          policyVersion: "demo-policy-1",
          modelVersion: null,
          offerVersion: null,
          reasonCodes: ["AWAITING_APPROVAL"],
          receiptRefs: [],
          nextAction: { kind: "decideApproval", ownerRef: "founder", dueAt: null, available: false },
          nextPollAfterMs: null,
          executionCertainty: "applied",
        };
      });
    },

    handlesSave(request: SaveResourceRequest<unknown>) {
      return (request.resourceKind === "configurationDraft" && Boolean(request.resourceRef?.startsWith("schedule-"))) || (request.resourceKind === "evidenceDraft" && Boolean(request.resourceRef?.startsWith("permission-")));
    },

    save(request: SaveResourceRequest<unknown>): Promise<SaveResourceResponse<unknown>> {
      const hash = JSON.stringify([request.resourceKind, request.resourceRef, request.expectedVersion, request.payload]);
      try {
        return Promise.resolve(once(request.idempotencyKey, hash, request.requestId, () => (request.resourceKind === "configurationDraft" ? saveSchedule(request as SaveResourceRequest<ScheduleDraft>) : savePermission(request as SaveResourceRequest<PermissionEvidence>))));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };

  function reply<T>(request: SaveResourceRequest<unknown>, ref: string, version: string, record: T, reasonCodes: string[]): SaveResourceResponse<T> {
    return { schemaVersion: SCHEMA_VERSION, requestId: request.requestId, scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" }, resourceRef: ref, resourceVersion: version, persistedAt: DEMO_NOW, persistedByRef: "demo-owner", record, reasonCodes, executionCertainty: "applied" };
  }

  function saveSchedule(request: SaveResourceRequest<ScheduleDraft>): SaveResourceResponse<ScheduleDraft> {
    const rid = request.requestId;
    if (request.resourceRef !== `schedule-${DEMO_JOB_ID}`) fail("RECORD_NOT_FOUND", "This schedule does not exist.", rid);
    if (request.expectedVersion !== draftVersion) fail("STALE_VERSION", "This schedule changed. Reload it before saving.", rid, { currentVersion: draftVersion });
    const next = request.payload;
    const errors = validateSchedule(next);
    if (Object.keys(errors).length) fail("VALIDATION_FAILED", "Fix the highlighted fields and save again.", rid, { fieldErrors: errors });
    if (JSON.stringify(next) === JSON.stringify(draft)) return reply(request, request.resourceRef!, draftVersion, draft, ["NO_CHANGE"]);
    draft = { ...next };
    draftVersion = `v${Number(draftVersion.slice(1)) + 1}`;
    return reply(request, request.resourceRef!, draftVersion, draft, []);
  }

  function savePermission(request: SaveResourceRequest<PermissionEvidence>): SaveResourceResponse<PermissionRecord> {
    const rid = request.requestId;
    const p = request.payload;
    const errors: Record<string, string> = {};
    if (!capabilityDemo.rows.some((r) => r.id === p.rowId)) errors.rowId = "Choose a listed source and action.";
    if (!p.reviewer?.trim()) errors.reviewer = "Name the reviewer.";
    if ((p.evidence?.trim().length ?? 0) < 10) errors.evidence = "Describe the evidence in at least 10 characters.";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.observedOn ?? "") || Number.isNaN(Date.parse(p.observedOn))) errors.observedOn = "Enter the date you observed it, as YYYY-MM-DD.";
    else if (p.observedOn > DEMO_NOW.slice(0, 10)) errors.observedOn = "The observation can't be in the future.";
    if (Object.keys(errors).length) fail("VALIDATION_FAILED", "Fix the highlighted fields and save again.", rid, { fieldErrors: errors });
    const current = permissions.get(p.rowId);
    const currentVersion = current?.version ?? null;
    if (request.expectedVersion !== currentVersion) fail("STALE_VERSION", "This evidence changed. Reload it before saving.", rid, { currentVersion: currentVersion ?? "none" });
    const record: PermissionRecord = { ...p, reviewer: p.reviewer.trim(), evidence: p.evidence.trim(), version: `v${current ? Number(current.version.slice(1)) + 1 : 1}`, savedAt: DEMO_NOW };
    permissions.set(p.rowId, record);
    return reply(request, request.resourceRef!, record.version, record, []);
  }
}
