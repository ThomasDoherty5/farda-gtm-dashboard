import { useState } from "react";
import type { ActionResponse } from "@/adapter/contract";
import type { RepairPayload } from "@/adapter/demoReconciliation";
import { useAction } from "@/adapter/useAction";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { Notice, Page, PageHeader, Panel } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { dateTime } from "@/features/approvals/shared";
import type { ReconciliationData } from "@/fixtures/reconciliation";
import { AutomationNav } from "./shared";

/** Nightly reconciliation and conflict repair (FE13-05, `?tab=reconciliation`). A repair is requested here and applied by the source owner after approval. */
export function ReconciliationPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, ReconciliationData>("nightlyReconciliation", {});
  const action = useAction<RepairPayload>();
  const [ack, setAck] = useState<{ conflictId: string; response: ActionResponse } | null>(null);
  const data = query.data?.data ?? null;
  const blocked = query.data ? blockedReason(query.data, "requestConflictRepair") : "Available once the reconciliation has loaded.";
  const demo = adapter.kind === "demo";
  const request = (conflictId: string) =>
    action.mutate(
      { operation: "requestApproval", actionKind: "requestConflictRepair", entityRefs: [], expectedVersion: data!.version, approvalRef: null, manifestRef: null, payload: { conflictId } },
      { onSuccess: (response) => setAck({ conflictId, response }) },
    );
  const compared = data?.pairs.reduce((a, p) => a + p.compared, 0) ?? 0;
  const matched = data?.pairs.reduce((a, p) => a + p.matched, 0) ?? 0;
  const conflicts = data?.pairs.reduce((a, p) => a + p.conflicts, 0) ?? 0;
  return (
    <Page labelledBy="reconciliation-title" source="none">
      <PageHeader id="reconciliation-title" title="Where two systems disagree." subtitle="Nightly reconciliation · every conflict, its proposed repair and the audit trail." />
      <AutomationNav current="reconciliation" width={152} />
      <Notice kind="plain" title={demo ? "Demo · no system is read or written" : "Repairs are requests"}>
        A repair is requested here, approved by a person and applied by the owner of the source. This page never edits either system, and the audit trail only grows.
      </Notice>
      {query.isPending && <SkeletonCard label="Loading the reconciliation…" />}
      {query.isError && <ViewError error={query.error} subject="The reconciliation" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && !data && <EmptyState state="Empty" title="No reconciliation has run"><p>The source responded, but no nightly run is recorded. That is not a clean result.</p></EmptyState>}
      {data && (
        <>
          <Panel headingGap={6} title="Last nightly run" note={`${data.run.schedule}`} headingId="run-title" testId="recon-run">
            <p data-testid="recon-summary">
              <Badge tone={data.run.state === "completed" ? "success" : "warning"}>{data.run.state === "completed" ? "Completed" : data.run.state === "partial" ? "Partial" : "Failed"}</Badge>{" "}
              {dateTime(data.run.startedAt)} to {dateTime(data.run.finishedAt)} · {compared} compared · {matched} matched · {conflicts} {conflicts === 1 ? "conflict" : "conflicts"}
            </p>
            <DataTable
              caption="Pairs compared"
              columns={[{ label: "Pair" }, { label: "Compared" }, { label: "Matched" }, { label: "Conflicts" }]}
              rows={data.pairs.map((p) => [p.label, String(p.compared), String(p.matched), String(p.conflicts)])}
              testId="recon-pairs"
              minWidth={560}
            />
          </Panel>
          <Panel headingGap={6} title="Conflicts" note="Each names which side is authoritative. A repair never overwrites it." headingId="conflicts-title" testId="recon-conflicts">
            {action.error && <ActionError error={action.error} />}
            {ack && (
              <p role="status" data-testid="repair-ack">
                Repair requested for {ack.conflictId}. It is waiting for approval from {ack.response.nextAction?.ownerRef ?? "the approver"}; nothing was changed in either system.
              </p>
            )}
            <DataTable
              caption="Conflicts"
              columns={[{ label: "Record" }, { label: "Field" }, { label: "Systems disagree" }, { label: "Proposed repair" }, { label: "State" }]}
              rows={data.conflicts.map((c) => [
                `${c.record} (${c.id})`,
                c.field,
                `${c.left.source}: ${c.left.value} · ${c.right.source}: ${c.right.value}`,
                `${c.authority}. ${c.proposal}`,
                c.state === "open" ? (
                  <Button key="r" variant="secondary" loading={action.isPending && action.variables?.payload.conflictId === c.id} disabledReason={blocked ?? undefined} aria-label={`Request repair for ${c.id}`} onClick={() => request(c.id)}>Request repair</Button>
                ) : (
                  <Badge key="s" tone="warning">Repair requested</Badge>
                ),
              ])}
              testId="conflict-table"
              minWidth={900}
            />
          </Panel>
          <Panel headingGap={6} title="Audit trail" note="Append-only. Earlier entries are never edited or removed." headingId="audit-title" testId="recon-audit">
            <DataTable
              caption="Audit trail"
              columns={[{ label: "When" }, { label: "Who" }, { label: "What" }, { label: "Subject" }, { label: "Detail" }]}
              rows={data.audit.map((a) => [dateTime(a.at), a.actor, a.action, a.subject, a.detail])}
              testId="audit-table"
              minWidth={760}
            />
          </Panel>
        </>
      )}
    </Page>
  );
}
