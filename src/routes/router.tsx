import { Navigate, type RouteObject } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { EvidencePage } from "@/features/acquisition/EvidencePage";
import { DiscoveryPage } from "@/features/acquisition/DiscoveryPage";
import { PipelinePage } from "@/features/acquisition/PipelinePage";
import { SocialCatPage } from "@/features/creators/SocialCatPage";
import { TikTokPage } from "@/features/creators/TikTokPage";
import { ApprovalPage } from "@/features/approvals/ApprovalPage";
import { ApprovalsIndex, RunsIndex } from "@/features/approvals/DemoScenarios";
import { RunPage } from "@/features/approvals/RunPage";
import { OverviewPage } from "@/features/overview/OverviewPage";
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
