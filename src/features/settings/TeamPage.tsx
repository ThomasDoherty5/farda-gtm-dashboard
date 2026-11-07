import { NativeControlsPage } from "./NativeOperationsControls";
import { useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { Divider, DetailRows, Halves, Notice, Page, PageHeader, Panel, Small, Split, Steps } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import type { TeamData } from "@/fixtures/settings";

/** Team and permissions (Figma source 7:1085, owner THO-305). Read only: roles are managed in the source tools, and viewing them grants nothing. */
export function TeamPage() {
  const {adapter}=useScope();
  return adapter.kind === "demo" ? <DemoTeamPage/> : <NativeControlsPage section="team"/>;
}
function DemoTeamPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, TeamData>("teamPermissions", {});
  const [dialog, setDialog] = useState<"roles" | "owners" | null>(null);
  const demo = adapter.kind === "demo";

  return (
    <Page labelledBy="team-title" source="7:1085">
      <PageHeader titleWidth={1070} id="team-title" title="Team & permissions" subtitle="A named owner and a clear approval boundary for every action.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 202 }} disabledReason={query.data?.data ? null : "Available once roles have loaded."} onClick={() => setDialog("roles")}>View source roles</Button>
      </PageHeader>
      <Notice kind="source" badge="Source" title="Permissions follow the source tools">
        Roles are managed in the connected tools. A workspace owner must confirm access changes before restricted actions are available.
      </Notice>
      <ReadState res={query.data} subject="Team permissions" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading roles…" />}
      {query.isError && <ViewError error={query.error} subject="Team and permissions" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (query.data.data ? <Body res={query.data as ReadResponse<TeamData>} data={query.data.data} demo={demo} dialog={dialog} setDialog={setDialog} /> : <EmptyState state="Empty" title="No roles yet"><p>The source responded, but no role is registered.</p></EmptyState>)}
    </Page>
  );
}

function Body({ data, demo, dialog, setDialog }: { res: ReadResponse<TeamData>; data: TeamData; demo: boolean; dialog: "roles" | "owners" | null; setDialog: (d: "roles" | "owners" | null) => void }) {
  return (
    <>
      <Split>
        <Panel title="Who can do what" note="Default to the least authority needed for the task" headingId="matrix-title" testId="role-matrix">
          <DataTable
            variant="ledger"
            caption="Who can do what, by application role"
            columns={[{ label: "Capability", width: "53.608%" }, { label: "Founder", width: "15.464%" }, { label: "Operator", width: "18.041%" }, { label: "Viewer" }]}
            rows={data.matrix.map((m) => [m.capability, m.founder, m.operator, m.viewer])}
            minWidth={620}
          />
        </Panel>
        <Panel title="Owner coverage" note="Each role has a named source owner and backup" headingId="owners-title" testId="owner-coverage">
          <DetailRows rows={data.owners} />
          <Divider />
          <div><Badge tone="warning" width={182}>{data.gaps} ownership gaps</Badge></div>
          <div><Button aria-haspopup="dialog" style={{ minWidth: 222 }} onClick={() => setDialog("owners")}>Open owner register</Button></div>
        </Panel>
      </Split>

      <Halves>
        <Panel title="Approval is tied to exact content" note="An edited draft needs a fresh approval" headingId="approval-title">
          <Steps steps={data.steps} />
        </Panel>
        <Panel title="Launch date is not set" note="Historical dates must not silently become the plan" headingId="launch-title">
          <DetailRows rows={data.launch} wide />
          <Divider />
          <Small>A launch date proposal changes dependent dates only after the founder decision is recorded in the source.</Small>
          <div><LinkButton variant="secondary" to="/launch?view=control" style={{ minWidth: 224 }}>Open launch control</LinkButton></div>
        </Panel>
      </Halves>
      {demo && <Small>Demo · roles and owners are synthetic examples. No provider role was read and no permission can be granted here.</Small>}

      <Dialog open={dialog === "roles"} title="Source roles" badge={demo ? "Demo" : undefined} onClose={() => setDialog(null)}>
        <p>Application roles are what this workspace lets someone do. Provider roles are what each source tool lets them do. The two are separate, and viewing a role grants nothing.</p>
        <DataTable caption="Provider roles by source" columns={[{ label: "Source" }, { label: "Provider role" }]} rows={data.sourceRoles.map((r) => [r.source, r.providerRole])} minWidth={0} />
        <p>Provider roles are not read in this demo, so each is shown as not read, not as a role.</p>
        <LinkButton variant="secondary" to="/settings/capabilities">Inspect action capabilities</LinkButton>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
      <Dialog open={dialog === "owners"} title="Owner register" badge={demo ? "Demo" : undefined} onClose={() => setDialog(null)}>
        <p>{data.gaps} roles have no named owner and backup: {data.owners.filter(([, v]) => v === "Needs assignment").map(([k]) => k).join(" and ")}. The register itself lives in the source tool, and no verified link to it is available here.</p>
        <p>Assigning an owner is a change in the source and needs a workspace owner's confirmation. Nothing is assigned from this dialog.</p>
        <Button variant="secondary" onClick={() => setDialog(null)}>Close</Button>
      </Dialog>
    </>
  );
}
