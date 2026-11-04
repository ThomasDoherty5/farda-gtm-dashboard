import { SCHEMA_VERSION, type ReadRequest, type ReadResponse, type SaveResourceRequest, type SaveResourceResponse } from "./contract";
import { createOnce } from "./demoOnce";
import { respondWith } from "./demoViews";
import { AdapterError } from "./errors";
import { validateFlowDraft, type FlowDraft } from "@/features/lifecycle/flowDraft";
import { activationDemo, consentDemo, emailFlows, FLOW_KEYS, lifecycleDemo, type EmailFlowData, type FlowKey } from "@/fixtures/lifecycle";
import { DEMO_NOW } from "@/fixtures/overview";

export const lifecycleViewKeys = ["lifecycleOverview", "emailFlow", "consentEligibility", "activationRetention"] as const;

const fail = (code: string, message: string, requestId: string, extra: { fieldErrors?: Record<string, string>; currentVersion?: string } = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

/**
 * In-memory stand-in for the email-flow configuration service. It serves labeled synthetic aggregates, keeps versioned
 * drafts for the session and sends nothing: saving a draft never enables or publishes a flow, and no provider is contacted.
 */
export function createDemoLifecycle() {
  const drafts = new Map<FlowKey, { draft: FlowDraft; version: string }>(FLOW_KEYS.map((k) => [k, { draft: { ...emailFlows[k].draft }, version: emailFlows[k].draftVersion }]));
  const once = createOnce();

  return {
    read(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
      switch (request.viewKey) {
        case "lifecycleOverview":
          return respondWith(request, lifecycleDemo, { dataVersion: "lifecycle-demo@1", capabilities: [{ actionKind: "openEmailTool", state: "unverified", reasonCodes: ["PROVIDER_NOT_SELECTED"] }] });
        case "emailFlow": {
          const flow = (request.filters as { flow: string }).flow as FlowKey;
          if (!FLOW_KEYS.includes(flow)) return fail("RECORD_NOT_FOUND", "This email flow does not exist.", request.requestId);
          const current = drafts.get(flow)!;
          const data: EmailFlowData = { ...emailFlows[flow], draft: { ...current.draft }, draftVersion: current.version };
          return respondWith(request, data, {
            dataVersion: `${flow}@${current.version}`,
            capabilities: [{ actionKind: "saveFlowDraft", state: "available", reasonCodes: [] }, { actionKind: "enableFlow", state: "held", reasonCodes: ["PROVIDER_NOT_SELECTED"] }],
          });
        }
        case "consentEligibility":
          return respondWith(request, consentDemo, { dataVersion: "consent-demo@1" });
        case "activationRetention":
          return respondWith(request, activationDemo, { dataVersion: "activation-demo@1", dataState: "partial" });
        default:
          return null;
      }
    },

    handlesSave(request: SaveResourceRequest<unknown>) {
      return request.resourceKind === "configurationDraft" && Boolean(request.resourceRef?.startsWith("flow-"));
    },

    save(request: SaveResourceRequest<unknown>): Promise<SaveResourceResponse<FlowDraft>> {
      const hash = JSON.stringify([request.resourceKind, request.resourceRef, request.expectedVersion, request.payload]);
      try {
        return Promise.resolve(once(request.idempotencyKey, hash, request.requestId, () => saveDraft(request as SaveResourceRequest<FlowDraft>)));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };

  function saveDraft(request: SaveResourceRequest<FlowDraft>): SaveResourceResponse<FlowDraft> {
    const rid = request.requestId;
    const flow = request.resourceRef?.slice("flow-".length) as FlowKey;
    const current = FLOW_KEYS.includes(flow) ? drafts.get(flow) : undefined;
    if (!current) return fail("RECORD_NOT_FOUND", "This email flow does not exist.", rid);
    if (request.expectedVersion !== current.version) fail("STALE_VERSION", "This flow changed. Reload it before saving.", rid, { currentVersion: current.version });
    const errors = validateFlowDraft(flow, request.payload);
    if (Object.keys(errors).length) fail("VALIDATION_FAILED", "Fix the highlighted fields and save again.", rid, { fieldErrors: errors });
    const next: FlowDraft = { timing: request.payload.timing, template: request.payload.template.trim() };
    const same = JSON.stringify(next) === JSON.stringify(current.draft);
    if (!same) {
      current.draft = next;
      current.version = `v${Number(current.version.slice(1)) + 1}`;
    }
    return { schemaVersion: SCHEMA_VERSION, requestId: rid, scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" }, resourceRef: request.resourceRef!, resourceVersion: current.version, persistedAt: DEMO_NOW, persistedByRef: "demo-owner", record: { ...current.draft }, reasonCodes: same ? ["NO_CHANGE"] : [] };
  }
}
