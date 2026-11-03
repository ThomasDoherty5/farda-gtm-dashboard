import { Link, useLocation, useParams } from "react-router-dom";
import { FIGMA_FILE_KEY, sourceScreens } from "./manifest.generated";
import type { SourceScreen } from "./types";

const figmaUrl = (node: string) => `https://www.figma.com/design/${FIGMA_FILE_KEY}?node-id=${node.replace(":", "-")}`;
const linearUrl = (issue: string) => `https://linear.app/thomas-doherty/issue/${issue}`;

function matchesQuery(s: SourceScreen, search: URLSearchParams) {
  return Object.entries(s.query).every(([k, v]) => search.get(k) === v);
}

/** Honest placeholder for a manifest route that has not been implemented from Figma yet. */
export function RoutePlaceholder({ path }: { path: string }) {
  const { search } = useLocation();
  const params = useParams();
  const q = new URLSearchParams(search);
  const sources = sourceScreens.filter((s) => s.path === path);
  const selected = sources.filter((s) => matchesQuery(s, q));
  const shown = selected.length ? selected : sources;
  return (
    <section aria-labelledby="ph-title">
      <h1 id="ph-title" style={{ font: "var(--text-h1)" }}>{shown[0]?.screen ?? path}</h1>
      <p>Not built yet. This route is reserved for the Figma source below and has no data or actions.</p>
      {Object.keys(params).length > 0 && <p>Route parameters: {Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ")}</p>}
      <SourceTable sources={sources} highlight={new Set(selected.map((s) => s.sourceNodeId))} />
    </section>
  );
}

/** Index page for a top-level section with no exact manifest route. */
export function SectionIndex({ seg }: { seg: string }) {
  const sources = sourceScreens.filter((s) => s.path.split("/")[1] === seg);
  return (
    <section aria-labelledby="sec-title">
      <h1 id="sec-title" style={{ font: "var(--text-h1)" }}>{seg}</h1>
      <p>Screens in this section. None are built yet except where linked.</p>
      <SourceTable sources={sources} highlight={new Set()} linkPaths />
    </section>
  );
}

function SourceTable({ sources, highlight, linkPaths = false }: { sources: SourceScreen[]; highlight: Set<string>; linkPaths?: boolean }) {
  return (
    <div style={{ overflowX: "auto" }} role="region" aria-label="Figma sources for this route" tabIndex={0}>
      <table>
        <caption className="visually-hidden">Figma sources for this route</caption>
        <thead><tr><th scope="col">Screen</th><th scope="col">Owner</th><th scope="col">Figma source</th><th scope="col">Route</th><th scope="col">Scope</th></tr></thead>
        <tbody>
          {sources.map((s) => {
            const href = s.path + (Object.keys(s.query).length ? `?${new URLSearchParams(s.query)}` : "");
            return (
              <tr key={s.sourceNodeId} aria-current={highlight.has(s.sourceNodeId) ? "true" : undefined}>
                <td>{s.screen}{s.variant ? ` (${s.variant})` : ""}</td>
                <td><a href={linearUrl(s.owner)}>{s.owner}</a></td>
                <td><a href={figmaUrl(s.sourceNodeId)}>{s.sourceNodeId}</a></td>
                <td>{linkPaths && !s.path.includes(":") ? <Link to={href}>{href}</Link> : <code>{href}</code>}</td>
                <td>{s.scope}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
