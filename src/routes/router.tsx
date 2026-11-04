import { Navigate, type RouteObject } from "react-router-dom";
import { RouteError, ShellError } from "@/components/RenderError";
import { Shell } from "@/components/Shell";
import { sourceScreens } from "./manifest.generated";
import { extraRoutes } from "./extraRoutes";
import { navSections } from "./nav";
import { implementedPages, pageOr, sectionPageLoaders } from "./pages";
import { RoutePlaceholder, SectionIndex } from "./RoutePlaceholder";

export function buildRoutes(): RouteObject[] {
  const paths = [...new Set(sourceScreens.map((s) => s.path))];
  const children: RouteObject[] = [
    { index: true, element: <Navigate to="/overview" replace /> },
    ...paths.map((path) => ({ path, element: pageOr(implementedPages[path], <RoutePlaceholder path={path} />) })),
    ...navSections.filter((s) => !paths.includes(s.path)).map((s) => ({ path: s.path, element: pageOr(sectionPageLoaders[s.seg], <SectionIndex seg={s.seg} />) })),
    ...extraRoutes,
    { path: "*", element: <NotFound /> },
  ];
  // A pathless layout holds the screens, so a screen that throws is replaced inside the shell's main region and navigation survives.
  // The shell route has its own error element for a failure in the shell itself.
  return [{ path: "/", element: <Shell />, errorElement: <ShellError />, children: [{ errorElement: <RouteError />, children }] }];
}

function NotFound() {
  return (
    <section>
      <h1 style={{ font: "var(--text-h1)" }}>Page not found</h1>
      <p>This address is not in the Figma source manifest.</p>
    </section>
  );
}
