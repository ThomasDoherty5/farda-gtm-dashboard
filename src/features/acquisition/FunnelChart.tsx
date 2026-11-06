import type { StageRow } from "./pipelineMetrics";
import styles from "./Pipeline.module.css";

/** The funnel drawing. Bars share one vertical scale (`scaleMax`), so a filtered funnel stays comparable with the whole. */
export function Funnel({ rows, scaleMax }: { rows: StageRow[]; scaleMax: number }) {
  const baseline = 272;
  const plot = 220;
  const ticks = [...new Set([0, 1, 2, 3, 4].map(step => Math.round(step * scaleMax / 4)))];
  return (
    <div className={styles.chartScroll} role="region" aria-label={`Opportunity cohort funnel · counts on a shared ${scaleMax} scale`} tabIndex={0}>
      <div className={styles.chart}>
        {ticks.map((t) => {
          const y = baseline - (scaleMax ? (t * plot) / scaleMax : 0);
          return (
            <span key={t} aria-hidden="true">
              <span className={styles.tick} style={{ top: y - 8 }}>{t}</span>
              <span className={styles.grid} style={{ top: y }} />
            </span>
          );
        })}
        <ol className={styles.columns}>
          {rows.map((r, i) => {
            // A known-zero cohort has no positive range; keep its bars at the baseline.
            const height = r.reached === null || scaleMax === 0 ? 0 : (r.reached / scaleMax) * plot;
            const top = baseline - height;
            return (
              <li key={r.key} className={styles.column} style={{ left: 42 + i * 120 }} data-testid={`funnel-${r.key}`}>
                {r.reached !== null && <span className={`${styles.bar} ${i < 3 ? styles.early : styles.later}`} style={{ top, height }} aria-hidden="true" />}
                <p className={styles.count} style={{ top: top - 36 }}>{r.reached === null ? "N/A" : r.reached}</p>
                <p className={styles.stage}>{r.label}</p>
                <p className={styles.conversion}>{i === 0 ? "Cohort" : (r.conversion ?? "N/A")}</p>
                <p className={styles.fact} style={{ top: 370 }}>{i === 0 ? "Cohort start" : `${r.medianDays === null ? "N/A" : `${r.medianDays}d`} median`}</p>
                {i > 0 && <p className={styles.fact} style={{ top: 392 }}>{r.notAdvanced === null ? "N/A" : r.notAdvanced} not advanced</p>}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
