import { Suspense, lazy, type ComponentType, type LazyExoticComponent } from "react";

/**
 * Route-level code splitting. Each screen is its own chunk, loaded when its route is first visited.
 * `lazyPage` keeps the loader next to the component so tests can resolve every loader without rendering.
 */
export type PageModule = { default: ComponentType };
export type LazyPage = { load: () => Promise<PageModule>; Component: LazyExoticComponent<ComponentType> };

function lazyPage(load: () => Promise<PageModule>): LazyPage {
  return { load, Component: lazy(load) };
}

/** Honest pending state while a screen's code loads: no data, no heading (route focus waits for the real h1), announced politely. */
export function PageLoading() {
  return (
    <p role="status" aria-live="polite" data-testid="page-loading" style={{ margin: 0, color: "var(--color-ink)" }}>
      Loading page…
    </p>
  );
}

/** Renders a lazy screen inside the shell, so the header stays put and only the main area waits. */
export function renderPage({ Component }: LazyPage) {
  return (
    <Suspense fallback={<PageLoading />}>
      <Component />
    </Suspense>
  );
}

/** The lazy screen when there is one, otherwise the eager fallback element (placeholder or section index). */
export const pageOr = (page: LazyPage | undefined, fallback: JSX.Element) => (page ? renderPage(page) : fallback);

/** Screens implemented so far, keyed by manifest path. Every other manifest path renders a labeled placeholder. */
export const implementedPages: Record<string, LazyPage> = {
  "/overview": lazyPage(() => import("@/features/overview/OverviewPage").then((m) => ({ default: m.OverviewPage }))),
  "/launch": lazyPage(() => import("@/features/analytics/LaunchPage").then((m) => ({ default: m.LaunchPage }))),
  "/analytics/attribution": lazyPage(() => import("@/features/analytics/AttributionPage").then((m) => ({ default: m.AttributionPage }))),
  "/analytics/paid-media": lazyPage(() => import("@/features/analytics/PaidMediaPage").then((m) => ({ default: m.PaidMediaPage }))),
  "/campaigns/:campaignId": lazyPage(() => import("@/features/analytics/CampaignFunnelPage").then((m) => ({ default: m.CampaignFunnelPage }))),
  "/analytics/customer-journey": lazyPage(() => import("@/features/analytics/CustomerJourneyPage").then((m) => ({ default: m.CustomerJourneyPage }))),
  "/creators/:creatorId/assessments/:assessmentId": lazyPage(() => import("@/features/scorecards/AssessmentPage").then((m) => ({ default: m.AssessmentPage }))),
  "/offers/:offerId": lazyPage(() => import("@/features/scorecards/OfferPage").then((m) => ({ default: m.OfferPage }))),
  "/content": lazyPage(() => import("@/features/monitor/MonitorPage").then((m) => ({ default: m.MonitorPage }))),
  "/creators/watchlist": lazyPage(() => import("@/features/monitor/WatchlistPage").then((m) => ({ default: m.WatchlistPage }))),
  "/content/:postId": lazyPage(() => import("@/features/monitor/PostPage").then((m) => ({ default: m.PostPage }))),
  "/creators/discovery": lazyPage(() => import("@/features/acquisition/DiscoveryPage").then((m) => ({ default: m.DiscoveryPage }))),
  "/creators/pipeline": lazyPage(() => import("@/features/acquisition/PipelinePage").then((m) => ({ default: m.PipelinePage }))),
  "/creators/social-cat": lazyPage(() => import("@/features/creators/SocialCatPage").then((m) => ({ default: m.SocialCatPage }))),
  "/creators/tiktok": lazyPage(() => import("@/features/creators/TikTokPage").then((m) => ({ default: m.TikTokPage }))),
  "/creators/social-cat/recruitment": lazyPage(() => import("@/features/recruitment/RecruitmentPage").then((m) => ({ default: m.RecruitmentPage }))),
  "/creators/tiktok/invitations/new": lazyPage(() => import("@/features/recruitment/InvitationPage").then((m) => ({ default: m.InvitationPage }))),
  "/batches/:batchId": lazyPage(() => import("@/features/recruitment/BatchPage").then((m) => ({ default: m.BatchPage }))),
  "/collaborations/:collaborationId": lazyPage(() => import("@/features/collaboration/CollaborationPage").then((m) => ({ default: m.CollaborationPage }))),
  "/creators/:creatorId/evidence/:evidenceId": lazyPage(() => import("@/features/acquisition/EvidencePage").then((m) => ({ default: m.EvidencePage }))),
  "/approvals/:approvalId": lazyPage(() => import("@/features/approvals/ApprovalPage").then((m) => ({ default: m.ApprovalPage }))),
  "/runs/:runId": lazyPage(() => import("@/features/approvals/RunPage").then((m) => ({ default: m.RunPage }))),
  "/settings/connections": lazyPage(() => import("@/features/settings/ConnectionsPage").then((m) => ({ default: m.ConnectionsPage }))),
  "/settings/team": lazyPage(() => import("@/features/settings/TeamPage").then((m) => ({ default: m.TeamPage }))),
  "/automations": lazyPage(() => import("@/features/settings/AutomationsPage").then((m) => ({ default: m.AutomationsPage }))),
  "/automations/:jobId/schedule": lazyPage(() => import("@/features/settings/SchedulePage").then((m) => ({ default: m.SchedulePage }))),
  "/settings/capabilities": lazyPage(() => import("@/features/settings/CapabilitiesPage").then((m) => ({ default: m.CapabilitiesPage }))),
  "/customers/lifecycle": lazyPage(() => import("@/features/lifecycle/LifecyclePage").then((m) => ({ default: m.LifecyclePage }))),
  "/customers/flows/setup": lazyPage(() => import("@/features/lifecycle/SetupFlowPage").then((m) => ({ default: m.SetupFlowPage }))),
  "/customers/flows/early-access": lazyPage(() => import("@/features/lifecycle/EmailFlowPage").then((m) => ({ default: () => <m.EmailFlowPage flow="early-access" /> }))),
  "/customers/flows/abandoned-checkout": lazyPage(() => import("@/features/lifecycle/EmailFlowPage").then((m) => ({ default: () => <m.EmailFlowPage flow="abandoned-checkout" /> }))),
  "/customers/flows/review-request": lazyPage(() => import("@/features/lifecycle/EmailFlowPage").then((m) => ({ default: () => <m.EmailFlowPage flow="review-request" /> }))),
  "/customers/consent": lazyPage(() => import("@/features/lifecycle/ConsentPage").then((m) => ({ default: m.ConsentPage }))),
  "/customers/activation": lazyPage(() => import("@/features/lifecycle/ActivationPage").then((m) => ({ default: m.ActivationPage }))),
  "/design-system/states": lazyPage(() => import("@/features/states/StateGalleryPage").then((m) => ({ default: m.StateGalleryPage }))),
  "/operations": lazyPage(() => import("@/features/operations/OperationsPage").then((m) => ({ default: m.OperationsPage }))),
  "/orders/:orderId": lazyPage(() => import("@/features/operations/OrderPage").then((m) => ({ default: m.OrderPage }))),
  "/shipments/:shipmentId/exceptions/:exceptionId": lazyPage(() => import("@/features/operations/ShippingExceptionPage").then((m) => ({ default: m.ShippingExceptionPage }))),
  "/returns/:returnId": lazyPage(() => import("@/features/operations/ReturnPage").then((m) => ({ default: m.ReturnPage }))),
  "/inventory": lazyPage(() => import("@/features/inventory/InventoryPage").then((m) => ({ default: m.InventoryPage }))),
  "/finance": lazyPage(() => import("@/features/finance/FinanceDashboardPage").then((m) => ({ default: m.FinanceDashboardPage }))),
  "/analytics/finance": lazyPage(() => import("@/features/finance/FinanceAnalyticsPage").then((m) => ({ default: m.FinanceAnalyticsPage }))),
  "/finance/close/:period": lazyPage(() => import("@/features/finance/CloseReconciliationPage").then((m) => ({ default: m.CloseReconciliationPage }))),
  "/finance/commissions": lazyPage(() => import("@/features/finance/CommissionLedgerPage").then((m) => ({ default: m.CommissionLedgerPage }))),
  "/finance/settlements/:settlementId": lazyPage(() => import("@/features/finance/SettlementPage").then((m) => ({ default: m.SettlementPage }))),
  "/finance/payables/:payableId": lazyPage(() => import("@/features/finance/PayablePage").then((m) => ({ default: m.PayablePage }))),
  "/support/cases/:caseId": lazyPage(() => import("@/features/support/SupportPage").then((m) => ({ default: m.SupportPage }))),
  "/analytics/fulfillment": lazyPage(() => import("@/features/operations/FulfillmentAnalyticsPage").then((m) => ({ default: m.FulfillmentAnalyticsPage }))),
};

/** Section pages with demo entry points. Neither is a Figma source; both fall back to the section index. */
export const sectionPageLoaders: Record<string, LazyPage> = {
  approvals: lazyPage(() => import("@/features/approvals/DemoScenarios").then((m) => ({ default: m.ApprovalsIndex }))),
  runs: lazyPage(() => import("@/features/approvals/DemoScenarios").then((m) => ({ default: m.RunsIndex }))),
};
