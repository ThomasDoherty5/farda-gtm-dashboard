import { sourceScreens } from "../../src/routes/manifest.generated";

/** Synthetic record ids from src/fixtures, one per manifest path pattern (and variant where one path holds several screens). */
const RECORDS: Record<string, string> = {
  "/creators/:creatorId/evidence/:evidenceId": "/creators/demo-creator-1/evidence/demo-evidence-1",
  "/campaigns/:campaignId": "/campaigns/demo-campaign-first-wave",
  "/collaborations/:collaborationId": "/collaborations/demo-collaboration-1",
  "/approvals/:approvalId": "/approvals/demo-approval-exact",
  "/runs/:runId|approval": "/runs/demo-run-approval",
  "/runs/:runId|recovery": "/runs/demo-run-uncertain",
  "/runs/:runId|hourly monitor variant": "/runs/demo-run-hourly",
  "/creators/:creatorId/assessments/:assessmentId|CONTENT-v2 history": "/creators/demo-creator-1/assessments/demo-assessment-content",
  "/creators/:creatorId/assessments/:assessmentId|TT-v2 history": "/creators/demo-creator-1/assessments/demo-assessment-tiktok",
  "/creators/:creatorId/assessments/:assessmentId|SC-v2 history": "/creators/demo-creator-1/assessments/demo-assessment-sc-commerce",
  "/offers/:offerId": "/offers/demo-offer-1",
  "/batches/:batchId": "/batches/demo-batch-tt-024",
  "/content/:postId": "/content/P-001",
  "/finance/payables/:payableId": "/finance/payables/PAY-0012",
  "/finance/settlements/:settlementId|external provider": "/finance/settlements/COMM-DEMO-D",
  "/finance/settlements/:settlementId|TikTok": "/finance/settlements/TT-NATIVE-DEMO",
  "/orders/:orderId": "/orders/TEST-SH-1042",
  "/shipments/:shipmentId/exceptions/:exceptionId": "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129",
  "/returns/:returnId|active": "/returns/TEST-RET-028",
  "/returns/:returnId|resolved": "/returns/TEST-RET-028?scenario=resolved",
  "/support/cases/:caseId": "/support/cases/TEST-ISS-021",
  "/finance/close/:period": "/finance/close/2026-10",
  "/automations/:jobId/schedule": "/automations/zap-12/schedule",
};

const tabOf = (query: Record<string, string>) => query.tab;

function urlFor(s: (typeof sourceScreens)[number]): string {
  const variant = s.variant ?? "";
  const key = s.path.includes(":")
    ? [`${s.path}|${tabOf(s.query) ?? ""}`, `${s.path}|${variant}`, s.path].find((k) => k in RECORDS)
    : undefined;
  if (s.path.includes(":") && !key) throw new Error(`e2e/support/routes.ts has no demo record for ${s.path} (${s.screen}, variant "${variant}")`);
  const base = key ? RECORDS[key]! : s.path;
  const query = new URLSearchParams(s.query).toString();
  if (!query) return base;
  return base + (base.includes("?") ? "&" : "?") + query;
}

/**
 * One concrete URL per manifest screen, built on real synthetic records so a page shows its data and not "Record not found".
 * Distinct screens that share one URL collapse into one entry. A new manifest path with an id fails here until it is mapped.
 */
export const routeUrls: string[] = [...new Set(sourceScreens.map(urlFor))];

/** Other records of the same pages, in states the main record does not show (conflict, expired, history, uncertain, no evidence, unsent). */
export const extraRecordUrls: string[] = [
  "/approvals/demo-approval-042",
  "/approvals/demo-approval-conflict",
  "/approvals/demo-approval-expired",
  "/approvals/demo-approval-history?view=history",
  "/approvals/demo-approval-uncertain",
  "/runs/demo-run-batch",
  "/runs/demo-run-noevidence",
  "/runs/demo-run-unsent",
  "/orders/TEST-SC-0081",
  "/orders/TEST-SH-1031",
  "/creators/demo-creator-1/evidence/demo-evidence-2",
  "/approvals",
  "/runs",
  "/creators",
  "/nope-this-is-not-a-route",
];
