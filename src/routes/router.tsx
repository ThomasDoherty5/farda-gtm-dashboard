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
import { ActivationPage } from "@/features/lifecycle/ActivationPage";
import { ConsentPage } from "@/features/lifecycle/ConsentPage";
import { EmailFlowPage } from "@/features/lifecycle/EmailFlowPage";
import { LifecyclePage } from "@/features/lifecycle/LifecyclePage";
import { SetupFlowPage } from "@/features/lifecycle/SetupFlowPage";
import { StateGalleryPage } from "@/features/states/StateGalleryPage";
import { OverviewPage } from "@/features/overview/OverviewPage";
import { AutomationsPage } from "@/features/settings/AutomationsPage";
import { CapabilitiesPage } from "@/features/settings/CapabilitiesPage";
import { ConnectionsPage } from "@/features/settings/ConnectionsPage";
import { SchedulePage } from "@/features/settings/SchedulePage";
import { TeamPage } from "@/features/settings/TeamPage";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";
import { RoutePlaceholder, SectionIndex } from "./RoutePlaceholder";

/** Screens implemented so far. Every other manifest path renders a labeled placeholder. */
const implemented: Record<string, JSX.Element> = {
  "/overview": <OverviewPage />,
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
  "/settings/connections": <ConnectionsPage />,
  "/settings/team": <TeamPage />,
  "/automations": <AutomationsPage />,
  "/automations/:jobId/schedule": <SchedulePage />,
  "/settings/capabilities": <CapabilitiesPage />,
  "/customers/lifecycle": <LifecyclePage />,
  "/customers/flows/setup": <SetupFlowPage />,
  "/customers/flows/early-access": <EmailFlowPage flow="early-access" />,
  "/customers/flows/abandoned-checkout": <EmailFlowPage flow="abandoned-checkout" />,
  "/customers/flows/review-request": <EmailFlowPage flow="review-request" />,
  "/customers/consent": <ConsentPage />,
  "/customers/activation": <ActivationPage />,
  "/design-system/states": <StateGalleryPage />,
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
