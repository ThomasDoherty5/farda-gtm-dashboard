import { useState } from "react";
import { Link } from "react-router-dom";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import type { LaunchSnapshotData } from "@/fixtures/analytics";
import { Card, KpiCard, KpiGrid, MetricText, PageHeader, PeriodDialog, ViewShell, count, usd, useIsDemo } from "./parts";
import styles from "./Analytics.module.css";

const two = (n: number) => String(n).padStart(2, "0");

/** Launch snapshot (Figma source 3:6, owner THO-293). L stays unset until the founder approves a date. */
export function LaunchSnapshotPage() {
  const query = useView<Record<string, never>, LaunchSnapshotData>("launchSnapshot", {});
  const [dialog, setDialog] = useState(false);
  return (
    <section aria-labelledby="launch-snapshot-title" data-figma-source="3:6" className={styles.page}>
      <PageHeader id="launch-snapshot-title" title="Your launch, in focus." subtitle="One view of creators, operations, and the decisions that move Farda forward.">
        <Button variant="secondary" style={{ minWidth: 172 }} aria-haspopup="dialog" onClick={() => setDialog(true)}>Last 30 days</Button>
        <LinkButton to="/analytics/attribution" style={{ minWidth: 166 }}>View report</LinkButton>
      </PageHeader>
      <ViewShell query={query} subject="The launch snapshot" emptyTitle="No launch snapshot yet" emptyBody="The source responded, but there is no launch snapshot to show.">
        {(data) => <Body data={data} />}
      </ViewShell>
      <PeriodDialog open={dialog} onClose={() => setDialog(false)} period="Last 30 days of the demo snapshot" />
    </section>
  );
}

function Body({ data }: { data: LaunchSnapshotData }) {
  const demo = useIsDemo();
  const set = data.launchDate.state === "known" && data.launchDate.value;
  const peak = Math.max(1, ...data.momentum.flatMap((w) => [w.inConversation, w.ready]));
  return (
    <>
      <div className={styles.statusRow}>
        <Badge tone="violet" width={106}>{data.stage}</Badge>
        <p className={styles.label} data-testid="launch-date">{set ? `L is ${data.launchDate.value}` : "L is not set"}</p>
        <p aria-hidden="true" style={{ color: "var(--color-muted)" }}>·</p>
        <p className={styles.small}>{demo ? "Demo · sample figures, not connected" : "Figures as of the snapshot"}</p>
        <span style={{ flex: "0 1 434px" }} />
        <p className={styles.small}>{data.snapshotLabel}</p>
      </div>
      <KpiGrid>
        <KpiCard label="Creator conversations" context={`${data.readyForNextStep} ready for a next step`} testId="metric-conversations"><MetricText value={data.conversations} format={count} /></KpiCard>
        <KpiCard label="First-wave samples" context="Target allocation · not shipped" testId="metric-samples"><MetricText value={data.firstWaveSamples} format={count} /></KpiCard>
        <KpiCard label="Launch budget ceiling" context="Authoritative plan · committed spend pending" testId="metric-budget">{usd(data.budgetCeiling)}</KpiCard>
        <KpiCard label="Decisions to unblock" context={data.decisionsToUnblock.join(" · ")} warn testId="metric-decisions">{two(data.decisionsToUnblock.length)}</KpiCard>
      </KpiGrid>
      <div className={`${styles.split} ${styles.stretch}`} style={{ gridTemplateColumns: "832fr 444fr", gap: 20 }}>
        <Card labelledBy="momentum-title" className={styles.gap18}>
          <div className={styles.legend} style={{ gap: 16 }}>
            <h2 id="momentum-title" className={styles.cardH2} style={{ margin: 0 }}>Creator momentum</h2>
            <span style={{ flex: "0 1 260px" }} />
            <Badge width={110}>Illustrative</Badge>
          </div>
          <p style={{ margin: 0 }}>From first conversation to content ready</p>
          <div className={styles.momentum} role="region" tabIndex={0} aria-label={`Creator momentum, an illustrative weekly index. ${data.momentum.map((w) => `${w.label}: ${w.inConversation} in conversation, ${w.ready} ready`).join("; ")}.`}>
            {data.momentum.map((w) => (
              <div key={w.label} className={styles.week}>
                <div className={styles.weekBars}>
                  <span style={{ height: `${(w.inConversation / peak) * 184}px` }} />
                  <span style={{ height: `${(w.ready / peak) * 184}px` }} />
                </div>
                <span className={styles.small}>{w.label}</span>
              </div>
            ))}
          </div>
          <div className={styles.legend} style={{ alignItems: "flex-start" }}>
            <Badge width={144}>In conversation</Badge>
            <Badge tone="violet" width={164}>Ready for next step</Badge>
            <span style={{ flex: "0 1 104px" }} />
            <Link to="/creators/social-cat?view=dashboard" className={styles.linkText}>Open creator workspace →</Link>
          </div>
        </Card>
        <Card labelledBy="next-move-title" className={styles.cardDark}>
          <h2 id="next-move-title" className={styles.cardH2} style={{ margin: 0 }}>Make the next move.</h2>
          <p style={{ font: "var(--text-body)" }}>Launch date is waiting on the production-spec sample and factory visit.</p>
          <div className={styles.btnRow}><Badge tone="violet" width={258}>{data.targetWindow}</Badge></div>
          <dl className={styles.gateList} style={{ marginTop: 20 }}>
            {data.relativeGates.map((g) => (
              <div key={g.offset} className={styles.gateLine}><dt>{g.offset}</dt><dd>{g.label}</dd></div>
            ))}
          </dl>
          <LinkButton variant="secondary" to="/launch?view=control" style={{ marginTop: 20, width: "100%" }}>Open launch control</LinkButton>
        </Card>
      </div>
      <div className={styles.split} style={{ gridTemplateColumns: "636fr 640fr", gap: 20 }}>
        <Card labelledBy="decisions-title">
          <div className={styles.legend} style={{ gap: 16 }}>
            <h2 id="decisions-title" className={styles.cardH2} style={{ margin: 0 }}>Decisions waiting</h2>
            <span style={{ flex: "0 1 204px" }} />
            <Badge tone="warning" width={108}>{data.approvals.length} pending</Badge>
          </div>
          <p className={styles.small}>Every creator message gets a human decision, in the app or in Slack.</p>
          <ul className={styles.approvals}>
            {data.approvals.map((a) => (
              <li key={a.handle} className={styles.approval}>
                <span className={styles.monogram} aria-hidden="true">{a.initial}</span>
                <span className={styles.approvalCopy}><Link to="/approvals" className={styles.label} style={{ color: "var(--color-ink)", textDecoration: "none" }}>{a.handle}</Link><span>{a.context}</span></span>
                <span className={styles.small}>{a.age}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card labelledBy="owners-title">
          <h2 id="owners-title" className={styles.cardH2} style={{ margin: 0 }}>Connected, with a clear owner.</h2>
          <p className={styles.small}>Every metric links back to the tool that owns its data.</p>
          {data.sources.map((s) => (
            <dl key={s.label} className={styles.sourceRow}>
              <dt>{s.label}</dt><dd>{s.source}</dd><dd><Badge width={182}>{s.badge}</Badge></dd>
            </dl>
          ))}
          <p className={styles.violetSmall}>{data.agentNote}</p>
        </Card>
      </div>
      <footer className={styles.footer} style={{ justifyContent: "flex-start", gap: 16 }}>
        <p>{demo ? "Demo · sample figures and creator handles" : "Source figures and creator handles"}</p>
        <span style={{ flex: "0 1 320px" }} />
        <p>Mirrored data is edited in its source tool.{demo ? " Source freshness isn't connected in the demo." : " Freshness is shown per source."}</p>
      </footer>
    </>
  );
}
