import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import type { SavedBindings } from "@/creator-agent/operationsView";
import { SavedBindingPanel } from "./SavedOperations";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Divider, DetailRows, Gates, Notice, Page, PageHeader, Panel, Row, Small, Split, kit } from "@/components/PageKit";
import { ReadState } from "@/components/ReadState";
import { ViewError } from "@/components/ViewError";
import type { ConnectionRow, ConnectionsData } from "@/fixtures/settings";
import { AutomationNav, CadenceNotice } from "./shared";

const ACTION_LABEL = { openSource: "Open source", openSetup: "Open setup", viewDecision: "View decision" } as const;
const DIALOG_TITLE = { openSource: "Source", openSetup: "Setup", viewDecision: "Decision" } as const;

/** Connections and source health (Figma source 7:876, owner THO-305). Reads health; nothing here authenticates, enables or changes a provider. */
export function ConnectionsPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, ConnectionsData | SavedBindings>("connectionsOverview", {});
  const [outcome, setOutcome] = useState<"ok" | "failed" | null>(null);
  const [checking, setChecking] = useState(false);
  const demo = adapter.kind === "demo";
  const data = query.data?.data;

  /** Check connections (CTRL-002): refresh the health observations. It never reports a healthy result the source didn't return. */
  const check = async () => {
    setOutcome(null);
    setChecking(true);
    const result = await query.refetch();
    setChecking(false);
    setOutcome(result.isError ? "failed" : "ok");
  };

  return (
    <Page labelledBy="connections-title" source="7:876">
      <PageHeader titleWidth={860} id="connections-title" title="Connections & source health" subtitle="Know what is connected, who owns the data, and what needs attention.">
        <LinkButton variant="secondary" to="/automations?tab=zaps" style={{ minWidth: 176 }}>View Zapier</LinkButton>
        <Button style={{ minWidth: 212 }} loading={checking} disabledReason={query.data ? null : "Available once the connection list has loaded."} onClick={() => void check()}>Check connections</Button>
      </PageHeader>
      <AutomationNav current="connections" width={132} />
      <CadenceNotice title="Action-specific access">
        Validate daily discovery and direct lifestyle review separately from hourly monitoring. Browser execution needs native action permission and platform authorization; missing API support never overrides denied authority.
      </CadenceNotice>
      <Notice kind="source" badge="Source" title="Browser execution + Zapier coordination">
        Browser tasks act inside the source tool. Zapier routes approvals, events and mirrors. Platform capabilities require validation before enabling unattended actions.
      </Notice>
      {outcome === "ok" && <p role="status" className={kit.status} data-testid="check-status">Checked. {demo ? "Demo observations are unchanged and no provider was contacted." : "Refreshed the saved ledger observations. No provider check was started."}</p>}
      {/* A partial or stale read is said in words, not only by a badge. */}
      <ReadState res={query.data} subject="Connections" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading connections…" />}
      {query.isError && <ViewError error={query.error} subject="Connections" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data && "kind" in data ? <SavedBindingPanel data={data} page="connections" /> : data && demo ? <Body res={query.data as ReadResponse<ConnectionsData>} data={data} demo={demo} /> : <EmptyState state="Empty" title="Connection observations unavailable"><p>The account-scoped connection ledger has no displayable response.</p></EmptyState>)}
    </Page>
  );
}

function Body({ res, data, demo }: { res: ReadResponse<ConnectionsData>; data: ConnectionsData; demo: boolean }) {
  const [search, setSearch] = useSearchParams();
  const selected = data.systems.find((s) => s.id === search.get("connection")) ?? null;
  const open = (id: string | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set("connection", id);
    else next.delete("connection");
    setSearch(next, { replace: id === null });
  };
  const stale = res.dataState === "stale";

  return (
    <>
      <Split>
        <Panel title="Source systems" note="Credentials and browser session secrets stay in the owning tools" headingId="systems-title" testId="source-systems">
          <DataTable
            variant="ledger"
            caption="Source systems and their health"
            columns={[{ label: "System / ownership", width: "39.948%" }, { label: "State", width: "20.103%" }, { label: "Last success", width: "19.845%" }, { label: "Action" }]}
            rows={data.systems.map((s) => [
              s.system,
              <span key="s" data-state-kind={s.kind}><Badge tone={s.state.tone} width={128}>{s.state.label}</Badge></span>,
              s.lastSuccess.label,
              <Button key="a" variant="secondary" aria-haspopup="dialog" style={{ minWidth: 138 }} onClick={() => open(s.id)}>{ACTION_LABEL[s.action]}</Button>,
            ])}
            minWidth={640}
          />
        </Panel>
        <Panel title="Trust the freshness" note="Source event time ≠ mirror sync time" headingId="freshness-title" testId="freshness">
          <DetailRows rows={data.freshness.map((f) => [f.label, f.value] as const)} />
          <Divider />
          <div><Badge tone={data.attention.tone} width={190}>{stale ? "Stale · attention required" : data.attention.label}</Badge></div>
          <p style={{ margin: 0 }}>{data.freshnessNote}</p>
          <div><LinkButton variant="secondary" to="/automations?from=connections" style={{ minWidth: 238 }}>Open sync run history</LinkButton></div>
        </Panel>
      </Split>

      <Panel title="Browser execution capabilities" note="User-requested target · capability checks are still pending" headingId="browser-title" testId="browser-capabilities">
        <DataTable
          variant="ledger"
          caption="Browser execution capabilities"
          columns={[{ label: "Source tool", width: "18.429%" }, { label: "Target workflow", width: "34.455%" }, { label: "Browser status", width: "20.833%" }, { label: "Fallback" }]}
          rows={data.browser.map((b) => [b.tool, b.workflow, <span key="s" data-state-kind={b.kind}><Badge tone={b.status.tone} width={186}>{b.status.label}</Badge></span>, b.fallback])}
          minWidth={720}
        />
        <Small>Login or MFA pauses a task for the user. A session expiring during a send produces an uncertain outcome until the source confirms what happened. Never retry a send blindly.</Small>
      </Panel>

      <Panel title="Verify the route before enabling execution." note="Documented capabilities, provider permission and actual account access are separate checks." headingId="route-title" large testId="route-readiness">
        <Gates gates={data.gates} />
        <Row><LinkButton to="/settings/capabilities" style={{ minWidth: 200 }}>Channel access</LinkButton></Row>
      </Panel>

      {demo && <Small>{data.observedLabel}</Small>}

      <Dialog open={selected !== null} title={selected ? `${DIALOG_TITLE[selected.action]} · ${selected.system}` : ""} badge={demo ? "Demo" : undefined} onClose={() => open(null)}>
        {selected && <SetupBody row={selected} />}
        <Button variant="secondary" onClick={() => open(null)}>Close</Button>
      </Dialog>
    </>
  );
}

/** Setup, source and decision details for one connection. The demo has no verified URL or authorization handoff, so none is offered. */
function SetupBody({ row }: { row: ConnectionRow }) {
  return (
    <>
      <p>{row.detail}</p>
      <DetailRows rows={[["State", row.state.label], ["Last success", row.lastSuccess.label], ["Owner", row.owner]]} />
      <p>No verified {row.action === "openSource" ? "source link" : "authorization handoff"} is available from the server, so none is shown. Nothing is connected, enabled or changed from here.</p>
    </>
  );
}
