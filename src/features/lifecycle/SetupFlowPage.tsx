import { useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ContextLine, Divider, DetailRows, Page, PageHeader, Small, kit } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { InfoDialog } from "@/features/settings/shared";
import type { EmailFlowData } from "@/fixtures/lifecycle";
import { FlowSteps } from "./shared";
import styles from "./Lifecycle.module.css";

/**
 * Setup help email flow (Figma source 5:404, owner THO-304). A read-only description of a paused flow: nothing here
 * configures, enables or sends anything, and each customer communication stays in the owning provider.
 */
export function SetupFlowPage() {
  const { adapter } = useScope();
  const query = useView<{ flow: string }, EmailFlowData>("emailFlow", { flow: "setup" });
  const [providerOpen, setProviderOpen] = useState(false);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;

  return (
    <Page labelledBy="setup-title" source="5:404">
      <PageHeader id="setup-title" title={data?.title ?? "Setup help, with a clean exit."} subtitle={data?.subtitle ?? "A single eligible message after delivery, followed by anonymous activation measurement."}>
        <LinkButton variant="secondary" to="/customers/lifecycle" style={{ minWidth: 184 }}>Back to lifecycle</LinkButton>
        <Button aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setProviderOpen(true)}>Open provider</Button>
      </PageHeader>
      {query.isPending && <SkeletonCard label="Loading the setup flow…" />}
      {query.isError && <ViewError error={query.error} subject="The setup flow" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data ? <Body res={query.data as ReadResponse<EmailFlowData>} data={data} demo={demo} /> : <EmptyState state="Empty" title="No setup flow yet"><p>The source responded, but this flow is not configured.</p></EmptyState>)}
      <InfoDialog open={providerOpen} title="Open provider" demo={demo} onClose={() => setProviderOpen(false)}>
        <p>No email provider is selected, so there is no provider to open and no verified link to offer. The setup flow stays paused, and nothing is configured or sent from here.</p>
      </InfoDialog>
    </Page>
  );
}

function Body({ data, demo }: { res: ReadResponse<EmailFlowData>; data: EmailFlowData; demo: boolean }) {
  return (
    <>
      <ContextLine badge={data.context.badge}>{data.context.text}</ContextLine>
      <div className={styles.split832}>
        <section className={`${kit.card} ${styles.stepsCard}`} aria-labelledby="steps-title" data-testid="flow-steps">
          <h2 id="steps-title" className={kit.heading2}>Delivery → eligibility → message → exit</h2>
          <FlowSteps steps={data.steps} />
        </section>
        <section className={kit.card} aria-labelledby="never-title" data-testid="eligibility">
          <h2 id="never-title" className={kit.heading2}>Never send when…</h2>
          <ul className={styles.bullets}>{data.neverSendWhen.map((n) => <li key={n}>{n}</li>)}</ul>
          <Divider />
          <h2 className={kit.heading2}>What happens next</h2>
          <DetailRows rows={data.nextOutcomes} labelWidth={165} />
          <Small>{data.eligibilityNote}</Small>
        </section>
      </div>
      <section className={kit.card} aria-labelledby="changes-title" data-testid="changes">
        <h2 id="changes-title" className={kit.heading2}>A change is visible and reversible</h2>
        <DataTable
          variant="ledger"
          caption="Changes to the flow"
          columns={[{ label: "ACTION", width: "19.231%" }, { label: "REQUIRED REVIEW", width: "36.859%" }, { label: "VISIBLE RESULT" }]}
          rows={data.changes.map((c) => [c.action, c.review, c.result])}
          minWidth={720}
        />
      </section>
      <Small>{data.footnote}</Small>
      {demo && <Small>Demo · this is a sample configuration of a paused flow.</Small>}
    </>
  );
}
