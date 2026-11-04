import { Navigate, type RouteObject } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { EvidencePage } from "@/features/acquisition/EvidencePage";
import { DiscoveryPage } from "@/features/acquisition/DiscoveryPage";
import { PipelinePage } from "@/features/acquisition/PipelinePage";
import { CollaborationPage } from "@/features/collaboration/CollaborationPage";
import { BatchPage } from "@/features/recruitment/BatchPage";
import { InvitationPage } from "@/features/recruitment/InvitationPage";
import { RecruitmentPage } from "@/features/recruitment/RecruitmentPage";
import { SocialCatPage } from "@/features/creators/SocialCatPage";
import { TikTokPage } from "@/features/creators/TikTokPage";
import { ApprovalPage } from "@/features/approvals/ApprovalPage";
import { ApprovalsIndex, RunsIndex } from "@/features/approvals/DemoScenarios";
import { RunPage } from "@/features/approvals/RunPage";
import { AttributionPage } from "@/features/analytics/AttributionPage";
import { CampaignFunnelPage } from "@/features/analytics/CampaignFunnelPage";
import { CustomerJourneyPage } from "@/features/analytics/CustomerJourneyPage";
import { LaunchPage } from "@/features/analytics/LaunchPage";
import { PaidMediaPage } from "@/features/analytics/PaidMediaPage";
import { PostPage } from "@/features/monitor/PostPage";
import { WatchlistPage } from "@/features/monitor/WatchlistPage";
import { MonitorPage } from "@/features/monitor/MonitorPage";
import { AssessmentPage } from "@/features/scorecards/AssessmentPage";
import { OfferPage } from "@/features/scorecards/OfferPage";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";
import { RoutePlaceholder, SectionIndex } from "./RoutePlaceholder";

/** Screens implemented so far. Every other manifest path renders a labeled placeholder. */
const implemented: Record<string, JSX.Element> = {
  "/overview": <OverviewPage />,
  "/launch": <LaunchPage />,
  "/analytics/attribution": <AttributionPage />,
  "/analytics/paid-media": <PaidMediaPage />,
  "/campaigns/:campaignId": <CampaignFunnelPage />,
  "/analytics/customer-journey": <CustomerJourneyPage />,
  "/creators/:creatorId/assessments/:assessmentId": <AssessmentPage />,
  "/offers/:offerId": <OfferPage />,
  "/content": <MonitorPage />,
  "/creators/watchlist": <WatchlistPage />,
  "/content/:postId": <PostPage />,
  "/creators/discovery": <DiscoveryPage />,
  "/creators/pipeline": <PipelinePage />,
  "/creators/social-cat": <SocialCatPage />,
  "/creators/tiktok": <TikTokPage />,
  "/creators/social-cat/recruitment": <RecruitmentPage />,
  "/creators/tiktok/invitations/new": <InvitationPage />,
  "/batches/:batchId": <BatchPage />,
  "/collaborations/:collaborationId": <CollaborationPage />,
  "/creators/:creatorId/evidence/:evidenceId": <EvidencePage />,
  "/approvals/:approvalId": <ApprovalPage />,
  "/runs/:runId": <RunPage />,
};

/** Section pages with demo entry points. Neither is a Figma source; both fall back to the section index. */
const sectionPages: Record<string, JSX.Element> = { approvals: <ApprovalsIndex />, runs: <RunsIndex /> };

export function buildRoutes(): RouteObject[] {
  const paths = [...new Set(sourceScreens.map((s) => s.path))];
  const children: RouteObject[] = [
    { index: true, element: <Navigate to="/overview" replace /> },
    ...paths.map((path) => ({ path, element: implemented[path] ?? <RoutePlaceholder path={path} /> })),
    ...navSections.filter((s) => !paths.includes(s.path)).map((s) => ({ path: s.path, element: sectionPages[s.seg] ?? <SectionIndex seg={s.seg} /> })),
    { path: "*", element: <NotFound /> },
  ];
  return [{ path: "/", element: <Shell />, children }];
}

function NotFound() {
  return (
    <section>
      <h1 style={{ font: "var(--text-h1)" }}>Page not found</h1>
      <p>This address is not in the Figma source manifest.</p>
    </section>
  );
}
