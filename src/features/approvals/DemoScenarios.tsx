import { Link } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import { demoScenarios } from "@/fixtures/approvals";
import { SectionIndex } from "@/routes/RoutePlaceholder";

/** Keeps stacked links far enough apart for the WCAG 2.2 target-size rule. */
const ROW = { padding: "var(--space-4) 0" };

/** Entry points to the labeled demo records. The real queues aren't in the source manifest; live falls back to the index. */
export function ApprovalsIndex() {
  const { adapter } = useScope();
  if (adapter.kind !== "demo") return <SectionIndex seg="approvals" />;
  return (
    <section aria-labelledby="approvals-title">
      <h1 id="approvals-title" style={{ font: "var(--text-h1)", marginTop: 0 }}>Approvals</h1>
      <p>Demo scenarios. Every record is synthetic, and nothing here reaches a provider.</p>
      <ul>{demoScenarios.approvals.map(([id, label]) => <li key={id} style={ROW}><Link to={`/approvals/${id}`}>{label}</Link></li>)}</ul>
    </section>
  );
}

export function RunsIndex() {
  const { adapter } = useScope();
  if (adapter.kind !== "demo") return <SectionIndex seg="runs" />;
  return (
    <section aria-labelledby="runs-title">
      <h1 id="runs-title" style={{ font: "var(--text-h1)", marginTop: 0 }}>Runs</h1>
      <p>Demo scenarios. Every record is synthetic, and nothing here reaches a provider.</p>
      <ul>{demoScenarios.runs.map(([id, tab, label]) => <li key={id} style={ROW}><Link to={`/runs/${id}?tab=${tab}`}>{label}</Link></li>)}</ul>
    </section>
  );
}
