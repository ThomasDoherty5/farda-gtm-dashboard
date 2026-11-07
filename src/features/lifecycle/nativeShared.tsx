import { useId } from "react";
import type { ReadResponse } from "@/adapter/contract";
import { Checkbox } from "@/components/Checkbox";
import { SkeletonCard } from "@/components/EmptyState";
import { ReadState } from "@/components/ReadState";
import { ContextLine, DetailRows, Small } from "@/components/PageKit";
import { ViewError } from "@/components/ViewError";
import { InfoDialog } from "@/features/settings/shared";
import type { FlowCatalog, NativeLifecycleData, ObservedCount } from "@/creator-agent/lifecycle/contract";
import { FlowSteps } from "./shared";
import styles from "./Lifecycle.module.css";

export const flowNames = { setup: "Setup help", "early-access": "Early access", "abandoned-checkout": "Abandoned checkout", "review-request": "Review request" } as const;
export const unknownCount: ObservedCount = { value: null, missingReason: "No matching source observation." };
export const countText = (n: ObservedCount | undefined | null) => n?.value === null || n?.value === undefined ? "Unknown" : n.value.toLocaleString("en-US");
export const countReason = (n: ObservedCount | undefined | null) => n?.missingReason ?? (n ? "Source-observed count" : "No matching source observation.");
export const share = (part: ObservedCount | undefined, whole: ObservedCount | undefined) => part?.value != null && whole?.value != null && whole.value > 0 ? 100 * part.value / whole.value : null;
export const percentage = (value: number | null) => value === null ? "Unknown" : `${Number(value.toFixed(1))}%`;

export function ReadFeedback({ query, subject }: { query: { data?: ReadResponse<unknown>; isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; subject: string }) {
  return <><ReadState res={query.data} subject={subject} only={["stale", "partial"]} />
    {query.isPending && <SkeletonCard label={`Loading ${subject}…`} />}
    {query.isError && query.error && <ViewError error={query.error} subject={subject} hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} />}</>;
}

export function SourceContext({ data }: { data: NativeLifecycleData }) {
  return <ContextLine badge={`Source ${data.sourceState}`} width={180}>
    {data.missingReason ?? `Observed ${data.sourceAsOf ?? data.observedAt}. ${data.coverage} coverage; ${data.freshness} evidence.`}
    {" "}A local draft does not publish, enable or send email.
  </ContextLine>;
}

export function SourceDetails({ data }: { data: NativeLifecycleData }) {
  return <DetailRows rows={[["Source state", data.sourceState], ["Observation", data.sourceAsOf ?? "Unknown"], ["Coverage", data.coverage],
    ["Freshness", data.freshness], ["Source version", data.sourceVersion ?? "Unknown"], ["Missing evidence", data.missingReason ?? "None reported"]]} />;
}

export function ProviderDialog({ open, onClose, data, title = "Provider setup" }: { open: boolean; onClose: () => void; data: NativeLifecycleData | null; title?: string }) {
  return <InfoDialog open={open} title={title} demo={false} onClose={onClose}>
    <p>No verified provider link is available for this view. The owning provider retains contacts, consent, suppression and delivery.</p>
    {data && <SourceDetails data={data} />}
    <p>Current source observations are read-only. This workspace has no provider publish, enable or send command.</p>
  </InfoDialog>;
}

export function CohortDetails({ cohort }: { cohort: NonNullable<FlowCatalog["outcomes"]>["cohort"] | null }) {
  return cohort ? <DetailRows rows={[["Population / unit", `${cohort.definition} · ${cohort.unit}`], ["Window start", cohort.start], ["Window end (exclusive)", cohort.end], ["Timezone", cohort.timezone], ["Evidence", cohort.receipt]]} />
    : <Small>No source-defined population or observation window is available.</Small>;
}

/** These are immutable requirements, not a claim that a live executor has run its checks. */
export function NativeLockedPolicies() {
  const id = useId();
  return <><fieldset className={styles.policies} aria-describedby={id}><legend>Mandatory send policies, locked</legend>
    {["Recheck consent before send", "Stop on opt-out or suppression", "Prevent duplicate enrollment"].map(label => <Checkbox key={label} label={label} checked readOnly describedBy={id} />)}
  </fieldset><p id={id} className={styles.stepKind}>Required, locked policies. Draft requests cannot change these gates. The source execution owner must independently prove their enforcement before any live send.</p></>;
}

export function CatalogSteps({ catalog }: { catalog: FlowCatalog | null }) {
  const evidence = (kind: string) => catalog?.evidence.find(e => e.kind === kind);
  return <FlowSteps steps={[
    { n: "01", title: "Qualify the source event", note: catalog?.entryEvents.map(e => `${e.label} · ${e.trigger} · ${e.version}`).join("; ") ?? "No verified entry event or event schema.", kind: catalog?.purpose ?? "Unknown" },
    { n: "02", title: "Check eligibility and consent", note: catalog?.eligibilityRules.join("; ") || "Eligibility rules are unavailable. Hold enrollment.", kind: "Required" },
    { n: "03", title: "Apply the exact timing rule", note: catalog?.timingRules.map(t => `${t.label} · ${t.timezone} · ${t.approval}`).join("; ") ?? "No verified timing rule. No delay or launch date is assumed.", kind: "Source policy" },
    { n: "04", title: "Use reviewed template evidence", note: catalog?.templates.map(t => `${t.label} · ${t.version} · ${t.approval}`).join("; ") ?? "No template or claim-policy evidence.", kind: "Versioned" },
    { n: "05", title: "Keep publication and activation separate", note: `Publication: ${evidence("publication")?.state ?? "unknown"}. Activation: ${evidence("activation")?.state ?? "unknown"}. A saved draft changes neither.`, kind: "Read-only" },
    { n: "06", title: "Record outcomes and cancellation", note: catalog?.cancellationRules.join("; ") || "Cancellation rules and provider outcomes are unavailable.", kind: "Source-owned" },
  ]} />;
}

export function CountBar({ label, value, denominator, detail }: { label: string; value: ObservedCount; denominator: ObservedCount; detail?: string }) {
  const id = useId(), p = share(value, denominator);
  return <div className={styles.funnel}><p id={id}>{label} · {countText(value)}{detail ? ` · ${detail}` : ""}</p>
    {p === null ? <Small>{value.missingReason ?? (denominator.value === 0 ? "The denominator is zero; a percentage is undefined." : denominator.missingReason ?? "Share unknown.")}</Small>
      : <div className={styles.track} role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(p.toFixed(1))}><div className={styles.fill} style={{ width: `${p}%` }} /></div>}
  </div>;
}
