import { useId, useState } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { ContextLine, Divider, DetailRows, Page, PageHeader, Panel, Small, kit } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { InfoDialog } from "@/features/settings/shared";
import { toneForHorizon, type ActivationData } from "@/fixtures/lifecycle";
import { formatCount, percent } from "./metrics";
import styles from "./Lifecycle.module.css";

/**
 * Activation and retention (Figma source 11:852, owner THO-304). Anonymous counts only. Pairing doesn't prove ingestion or any health
 * outcome, and every share is derived from the counts; a share of zero units is unknown, not 0%.
 */
export function ActivationPage() {
  const { adapter } = useScope();
  const query = useView<Record<string, never>, ActivationData>("activationRetention", {});
  const [dialog, setDialog] = useState<"contract" | "cohort" | null>(null);
  const demo = adapter.kind === "demo";
  const data = query.data?.data ?? null;

  return (
    <Page labelledBy="activation-title" source="11:852">
      <PageHeader id="activation-title" title="Measure setup, then sustained use." subtitle="Anonymous daily counts connect delivery to pairing and first-week activation.">
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 184 }} onClick={() => setDialog("contract")}>View source contract</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 160 }} onClick={() => setDialog("cohort")}>Demo cohort</Button>
      </PageHeader>
      <ReadState res={query.data} subject="Activation and retention" only={["stale", "partial"]} />
      {query.isPending && <SkeletonCard label="Loading activation…" />}
      {query.isError && <ViewError error={query.error} subject="Activation and retention" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}
      {query.data && (data ? <Body res={query.data as ReadResponse<ActivationData>} data={data} demo={demo} /> : <EmptyState state="Empty" title="No activation data yet"><p>The source responded, but no cohort has ever been exported. That isn't zero activation.</p></EmptyState>)}
      <InfoDialog open={dialog === "contract"} title="Source contract" demo={demo} onClose={() => setDialog(null)}>
        <p>Live export is blocked: the engineering export specification and the health-data review are still pending, so there is no verified contract or link to open.</p>
      </InfoDialog>
      <InfoDialog open={dialog === "cohort"} title="Cohort" demo={demo} onClose={() => setDialog(null)}>
        <p>The demo cohort is the only one available. It is 100 synthetic delivered units, not a measured Farda cohort. Choosing a live cohort needs a verified export.</p>
      </InfoDialog>
    </Page>
  );
}

function Funnel({ label, units, detail, share }: { label: string; units: number; detail?: string | null; share: number }) {
  const id = useId();
  return (
    <div className={styles.funnel}>
      <p id={id}>{label}   {formatCount(units)} units{detail ? ` · ${detail}` : ""}</p>
      <div className={styles.track} role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 10) / 10}>
        <div className={styles.fill} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function Body({ data, demo }: { res: ReadResponse<ActivationData>; data: ActivationData; demo: boolean }) {
  const { delivered, paired, weekOne, pairingFailureEvents } = data.cohort;
  const pairedShare = percent(paired, delivered);
  const activeShare = percent(weekOne, paired);
  const bar = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);
  return (
    <>
      <ContextLine badge={data.context.badge} width={180}>{data.context.text}</ContextLine>
      <div className={styles.split832}>
        <section className={kit.card} aria-labelledby="cohort-title" data-testid="cohort" style={{ gap: "var(--space-24)" }}>
          <h2 id="cohort-title" className={kit.heading2}>First-week cohort</h2>
          <Small>Illustrative cohort of {formatCount(delivered)} delivered customer units</Small>
          <Funnel label="Delivered" units={delivered} share={bar(delivered, delivered)} />
          <Funnel label="Paired" units={paired} detail={pairedShare ? `${pairedShare} of delivered` : "share unknown"} share={bar(paired, delivered)} />
          <Funnel label="Active in week one" units={weekOne} detail={activeShare ? `${activeShare} of paired` : "share unknown"} share={bar(weekOne, delivered)} />
          <Small>Week-one active = at least one app session during the first 7 days. No person-level activity or health details enter this workspace.</Small>
        </section>
        <section className={`${kit.card} ${styles.summary}`} aria-labelledby="summary-title" data-testid="summary">
          <p id="summary-title" className={styles.summaryLabel}>Pairing → week-one active</p>
          <p className={styles.summaryValue} data-testid="metric-Pairing → week-one active">{activeShare ?? "Unknown"}</p>
          <Small>{formatCount(weekOne)} active / {formatCount(paired)} paired</Small>
          <Divider />
          <DetailRows rows={[["Delivered → paired", pairedShare ?? "Unknown"], ["Pairing failures", `${pairingFailureEvents} sample events`]]} gap={20} labelWidth={165} />
          <Small>Failure events are not subtracted from the cohort automatically; their source grain must be defined.</Small>
        </section>
      </div>

      <Panel title="Beyond week one" note={data.retentionNote} headingId="retention-title" large headingGap={20} testId="retention">
        <ul className={styles.horizons}>
          {data.horizons.map((h) => (
            <li key={h.day} className={`${styles.horizon} ${h.state === "Defined" ? styles.defined : ""}`}>
              <h3>Day {h.day}</h3>
              <p>{h.label}</p>
              <Badge tone={toneForHorizon(h.state)} width={200}>{h.state}</Badge>
            </li>
          ))}
        </ul>
        <Small>{data.reactivationNote}</Small>
      </Panel>
      <Small>{data.footnote}</Small>
      {demo && <Small>Demo · illustrative counts, not a measured result.</Small>}
    </>
  );
}
