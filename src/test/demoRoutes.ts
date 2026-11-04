import { sourceScreens } from "../routes/manifest.generated";

/** A concrete demo URL for each screen frame. Dynamic segments need the demo record the fixtures hold, not a made-up id. */
export const ROUTES: Record<string, string> = {
  "41:1781": "/collaborations/demo-collaboration-1?tab=overview",
  "41:1918": "/collaborations/demo-collaboration-1?tab=content",
  "41:1637": "/approvals/demo-approval-042",
  "41:2351": "/runs/demo-run-approval?tab=approval",
  "41:2494": "/runs/demo-run-uncertain?tab=recovery",
  "28:6631": "/runs/demo-run-hourly",
  "41:4026": "/creators/demo-creator-1/assessments/demo-assessment-content",
  "41:4203": "/creators/demo-creator-1/assessments/demo-assessment-tiktok",
  "76:3780": "/creators/demo-creator-1/assessments/demo-assessment-sc-commerce",
  "76:3659": "/offers/demo-offer-1",
  "76:4517": "/batches/demo-batch-tt-024",
  "41:3321": "/content/P-001",
  "41:3677": "/campaigns/demo-campaign-first-wave?tab=funnel",
  "41:2033": "/finance/payables/PAY-0012",
  "76:4102": "/finance/settlements/COMM-DEMO-D",
  "76:4247": "/finance/settlements/TT-NATIVE-DEMO",
  "28:2373": "/finance/close/2026-10",
  "28:1563": "/orders/TEST-SH-1042",
  "28:1709": "/shipments/TEST-SP-0093/exceptions/TEST-EVT-129",
  "28:2966": "/returns/TEST-RET-028",
  "28:3105": "/returns/TEST-RET-028?scenario=resolved",
  "41:2158": "/support/cases/TEST-ISS-021",
  "28:5744": "/automations/zap-12/schedule",
  "28:3557": "/design-system/states",
  "111:7219": "/creators/demo-creator-1/evidence/demo-evidence-1",
};
export const concrete = (path: string) => path.replace(/:(\w+)/g, "demo-$1");
export const screenOf = (frame: string) => sourceScreens.find((s) => s.prototypeNodeId === frame);
export function routeOf(frame: string): string | null {
  if (ROUTES[frame]) return ROUTES[frame]!;
  const s = screenOf(frame);
  if (!s) return null;
  const qs = new URLSearchParams(s.query as Record<string, string>).toString();
  return concrete(s.path) + (qs ? `?${qs}` : "");
}


/** Every distinct screen URL in the manifest, with the demo records the fixtures hold. */
export const allDemoRoutes = (): string[] => [...new Set(sourceScreens.map((s) => routeOf(s.prototypeNodeId)!).filter(Boolean))];
