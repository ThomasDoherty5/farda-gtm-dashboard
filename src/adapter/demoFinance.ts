import { SCHEMA_VERSION, type ActionRequest, type ActionResponse, type ReadRequest, type ReadResponse } from "./contract";
import { AdapterError, type AdapterErrorBody } from "./errors";
import { respondWith } from "./demoViews";
import { financeDashboardDemo, ledgerDemo, payableDemo, periodCloseDemo, settlementDemo, type CommissionLedger, type FinanceDashboard, type PayableDetail, type PeriodClose, type SettlementRecord } from "@/fixtures/finance";
import { closePackageDemo, type ClosePackage } from "@/fixtures/financeClose";

const fail = (code: string, message: string, requestId: string, extra: Partial<AdapterErrorBody> = {}): never => {
  throw new AdapterError({ code, message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null, executionCertainty: "notApplied", ...extra });
};

export type ReconcilePayload = { settlementId: string; matches: { statementRef: string; groupId: string }[] };

/**
 * Demo stand-in for the finance read models and the one finance intent: submit a statement-to-ledger match for review.
 * The provider owns billing and payout, so nothing here pays, posts or marks anything reconciled. A submitted match is a
 * request waiting for review; paid receipts are never touched. State resets on reload.
 */
export function createDemoFinance() {
  const submitted = new Map<string, NonNullable<SettlementRecord["submitted"]>>();
  const results = new Map<string, { hash: string; result: ActionResponse }>();

  function ledger(request: ReadRequest<{ scenario?: string }>): ReadResponse<CommissionLedger> {
    const scenario = request.filters.scenario;
    if (scenario === "unavailable") fail("SOURCE_UNAVAILABLE", "The commission ledger could not be reached.", request.requestId, { retryable: true });
    const data = ledgerDemo();
    if (scenario === "partial") {
      const res = respondWith(request, { ...data, groups: data.groups.slice(0, 3) }, { dataVersion: data.version, dataState: "partial" });
      res.coverage = { expectedCount: 4, observedCount: 3, missingCount: 1, complete: false, reasonCodes: ["SOURCE_ROWS_DEFERRED"] };
      return res;
    }
    const res = respondWith(request, data, { dataVersion: data.version, dataState: scenario === "stale" ? "stale" : "ready" });
    res.coverage = { expectedCount: data.groups.length, observedCount: data.groups.length, missingCount: 0, complete: true, reasonCodes: [] };
    return res;
  }

  function settlement(request: ReadRequest<{ settlementId: string }>): ReadResponse<SettlementRecord> {
    const base = settlementDemo(request.filters.settlementId) ?? fail("RECORD_NOT_FOUND", "This settlement does not exist or was removed.", request.requestId);
    const mine = submitted.get(base.settlementId) ?? null;
    const data = { ...base, submitted: mine, version: mine ? "st2" : base.version };
    return respondWith(request, data, {
      dataVersion: data.version,
      capabilities: [
        mine ? { actionKind: "reconcileSettlement", state: "held", reasonCodes: ["ALREADY_SUBMITTED"] } : { actionKind: "reconcileSettlement", state: "available", reasonCodes: [] },
        { actionKind: "payCommission", state: "unsupported", reasonCodes: ["PROVIDER_OWNS_PAYOUT"] },
      ],
    });
  }

  function payable(request: ReadRequest<{ payableId: string }>): ReadResponse<PayableDetail> {
    const data = payableDemo(request.filters.payableId) ?? fail("RECORD_NOT_FOUND", "This payable does not exist or was removed.", request.requestId);
    return respondWith(request, data, { dataVersion: data.version, capabilities: [{ actionKind: "executePayment", state: "held", reasonCodes: ["FOUNDER_APPROVAL_PENDING"] }] });
  }

  function dashboard(request: ReadRequest<{ scenario?: string }>): ReadResponse<FinanceDashboard> {
    const scenario = request.filters.scenario;
    if (scenario === "unavailable") fail("SOURCE_UNAVAILABLE", "QuickBooks could not be reached.", request.requestId, { retryable: true });
    const data = financeDashboardDemo(scenario);
    return respondWith(request, data, { dataVersion: data.version, dataState: scenario === "stale" ? "stale" : scenario === "insufficient" ? "partial" : "ready" });
  }

  function close(request: ReadRequest<{ period: string; scenario?: string }>): ReadResponse<PeriodClose> {
    const data = periodCloseDemo(request.filters.period, request.filters.scenario) ?? fail("RECORD_NOT_FOUND", "This accounting period does not exist or was removed.", request.requestId);
    return respondWith(request, data, { dataVersion: data.version, capabilities: [{ actionKind: "closePeriod", state: "held", reasonCodes: ["CPA_SIGN_OFF_REQUIRED", "RECONCILIATION_OPEN"] }] });
  }

  function closePackage(request: ReadRequest<{ period: string; scenario?: string }>): ReadResponse<ClosePackage> {
    const data = closePackageDemo(request.filters.period, request.filters.scenario) ?? fail("RECORD_NOT_FOUND", "This accounting period does not exist or was removed.", request.requestId);
    // The package is read-only evidence. Closing, signing off and exporting belong to their owners and stay unavailable here.
    return respondWith(request, data, { dataVersion: data.version, capabilities: [{ actionKind: "closePeriod", state: data.status === "closed" ? "unsupported" : "held", reasonCodes: data.status === "closed" ? ["ALREADY_CLOSED"] : data.blockers.map((b) => b.code) }] });
  }

  function reconcile(request: ActionRequest<ReconcilePayload>): ActionResponse {
    const { settlementId, matches } = request.payload;
    const base = settlementDemo(settlementId) ?? fail("RECORD_NOT_FOUND", "This settlement does not exist.", request.requestId);
    const current = submitted.has(settlementId) ? "st2" : base.version;
    if (request.expectedVersion !== current) fail("STALE_VERSION", "This settlement changed. Reload it before submitting a match.", request.requestId, { currentVersion: current });
    if (submitted.has(settlementId)) fail("VALIDATION_FAILED", "A match is already submitted for this settlement.", request.requestId);
    if (matches.length === 0) fail("VALIDATION_FAILED", "Choose at least one statement line to match.", request.requestId, { fieldErrors: { matches: "Choose at least one statement line." } });
    const chosen = matches.map((m) => base.candidates.find((c) => c.statementRef === m.statementRef && c.groupId === m.groupId) ?? fail("VALIDATION_FAILED", `${m.statementRef} is not a candidate for ${m.groupId}.`, request.requestId));
    const flagged = chosen.find((c) => c.problem);
    if (flagged) fail("VALIDATION_FAILED", `${flagged.statementRef} is a ${flagged.problem} and stays unresolved. Resolve it in the source first.`, request.requestId, { fieldErrors: { matches: `${flagged.statementRef} stays unresolved (${flagged.problem}).` } });
    if (new Set(chosen.map((c) => c.groupId)).size !== chosen.length) fail("VALIDATION_FAILED", "Two statement lines can't match one group.", request.requestId);
    const response: ActionResponse = {
      schemaVersion: SCHEMA_VERSION,
      requestId: request.requestId,
      scope: { ...request.requestedScope, authorizationScopeVersion: "demo-1" },
      actionRef: `demo-action-${request.idempotencyKey}`,
      state: "approvalPending",
      runRef: null,
      approvalRef: null,
      manifestRef: null,
      payloadVersion: "st2",
      policyVersion: "finance-demo@1",
      modelVersion: null,
      offerVersion: null,
      reasonCodes: ["AWAITING_REVIEW"],
      receiptRefs: [],
      nextAction: { kind: "reconciliationReview", ownerRef: "Finance", dueAt: null, available: false },
      nextPollAfterMs: null,
    };
    submitted.set(settlementId, { state: "Submitted for review. Nothing is marked reconciled and the paid receipt is unchanged.", actionRef: response.actionRef });
    return response;
  }

  return {
    read(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
      switch (request.viewKey) {
        case "commissionLedger":
          return ledger(request as ReadRequest<{ scenario?: string }>);
        case "settlementDetail":
          return settlement(request as ReadRequest<{ settlementId: string }>);
        case "payableDetail":
          return payable(request as ReadRequest<{ payableId: string }>);
        case "financeDashboard":
          return dashboard(request as ReadRequest<{ scenario?: string }>);
        case "periodClose":
          return close(request as ReadRequest<{ period: string; scenario?: string }>);
        case "closePackage":
          return closePackage(request as ReadRequest<{ period: string; scenario?: string }>);
        default:
          return null;
      }
    },
    submit(request: ActionRequest<unknown>): ActionResponse | null {
      if (request.actionKind !== "reconcileSettlement") return null;
      const hash = JSON.stringify([request.operation, request.actionKind, request.expectedVersion, request.payload]);
      const prior = results.get(request.idempotencyKey);
      if (prior) {
        if (prior.hash !== hash) fail("MANIFEST_CHANGED", "This action changed, so it needs a fresh preview.", request.requestId);
        return prior.result;
      }
      const result = reconcile(request as ActionRequest<ReconcilePayload>);
      results.set(request.idempotencyKey, { hash, result });
      return result;
    },
  };
}
