import { Navigate, type RouteObject } from "react-router-dom";
import { Shell } from "@/components/Shell";
import { sourceScreens } from "./manifest.generated";
import { navSections } from "./nav";
import { implementedPages, pageOr, sectionPageLoaders } from "./pages";
import { RoutePlaceholder, SectionIndex } from "./RoutePlaceholder";

export function buildRoutes(): RouteObject[] {
  const paths = [...new Set(sourceScreens.map((s) => s.path))];
  const children: RouteObject[] = [
    { index: true, element: <Navigate to="/overview" replace /> },
    ...paths.map((path) => ({ path, element: pageOr(implementedPages[path], <RoutePlaceholder path={path} />) })),
    ...navSections.filter((s) => !paths.includes(s.path)).map((s) => ({ path: s.path, element: pageOr(sectionPageLoaders[s.seg], <SectionIndex seg={s.seg} />) })),
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
