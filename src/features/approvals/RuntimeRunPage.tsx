import type { ReadResponse } from "@/adapter/contract";
import type { SafeRuntimeRun } from "@/creator-agent/jobs/runtimeViews";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Details, dateTime } from "./shared";
import styles from "./Approvals.module.css";
import native from "./NativeApproval.module.css";

const known = (value: number | null) => value === null ? "Unknown" : value.toLocaleString("en-US");
const outcomes = { none: "No confirmed result", observationRecorded: "Observation recorded", proposalRecorded: "Local proposal recorded", nativeReceiptRecorded: "Native receipt recorded" };
/** Source 5:13 structure, adapted to actual registered reads/proposals and their distinct execution evidence. */
export function RuntimeRunPage({ res, tab, refresh }: { res: ReadResponse<SafeRuntimeRun>; tab: "approval" | "recovery"; refresh: () => void }) {
  const data = res.data!, usage = data.usage, stale = res.dataState === "stale";
  const waiting = data.takeovers.filter(row => !row.resolved);
  const uncertain = data.executionCertainty === "uncertain" || data.counts.reconcile > 0;
  const cost = usage.observedCostMinor === null || usage.currency === null ? "Unknown" : usage.currency === "USD" ?
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(usage.observedCostMinor / 100) :
    `${usage.observedCostMinor.toLocaleString("en-US")} ${usage.currency} minor units · currency scale unverified`;
  return <section className={`${styles.page} ${native.page}`} aria-labelledby="runtime-run-title" data-figma-source={tab === "approval" ? "5:13" : "5:156"}>
    <div className={styles.titleRow}><div className={styles.heading}><h1 id="runtime-run-title">{tab === "recovery" ? "Resume from verified evidence." : "Registered source run"}</h1>
      <p>The intended window, source observations and confirmed results stay separate.</p></div>
      <Button variant="secondary" onClick={refresh}>Refresh run evidence</Button><LinkButton to="/settings/capabilities">Review source access</LinkButton></div>
    <nav className={styles.actionsRow} aria-label="Run evidence tabs"><LinkButton variant={tab === "approval" ? "primary" : "ghost"} aria-current={tab === "approval" ? "page" : undefined} to="?tab=approval">Run evidence</LinkButton>
      <LinkButton variant={tab === "recovery" ? "primary" : "ghost"} aria-current={tab === "recovery" ? "page" : undefined} to="?tab=recovery">Recovery</LinkButton></nav>
    <div className={styles.historical} role="status"><Badge tone={waiting.length || data.state === "held" ? "warning" : "violet"}>{stale ? "Stale evidence" : data.state}</Badge>
      <p>{data.mode} · {data.family} · registration version {data.registrationVersion}. A local observation or proposal does not mean a creator was contacted or an ad was published.</p></div>
    {(uncertain || waiting.length > 0) && <div className={styles.alertBox} role="alert"><h2 className={styles.h2}>{uncertain ? "The original action may already be applied." : "Source access needs verification."}</h2>
      <p>{uncertain ? "Keep the original run and attempt. Reconcile its owning source before permitting another action; a timeout or missing response does not prove absence." :
        "The source reader has stopped for a named owner. Its saved checkpoint remains; a login, MFA or page change cannot be cleared by refreshing this view."}</p></div>}
    {tab === "recovery" && <section className={`${styles.card} ${styles.checklistCard}`} aria-labelledby="runtime-recovery-title"><h2 id="runtime-recovery-title" className={styles.h2}>Resolve the source state</h2>
      {[
        ["Verify the same registered window", `Registration version ${data.registrationVersion}; intended ${dateTime(data.intendedAt)}.`],
        ["Compare saved evidence and checkpoint", "Use the item results below. An observation, local proposal and native action receipt confirm different facts."],
        ["Retain the original attempt", uncertain ? "The original outcome is unconfirmed. No new-key retry or changed route is authorized." : "Reuse completed evidence. Resume only unfinished work after current source checks."],
        ["Use the named source owner", "The owner supplies the exact takeover resolution and current permission receipt to the registered worker. This view cannot grant it."],
      ].map(([title, note], index) => <div className={styles.step} key={title}><span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
        <div className={styles.stepBody}><p className={styles.label}>{title}</p><p className={styles.small}>{note}</p></div><span className={styles.small}>Required</span></div>)}
    </section>}
    <div className={styles.runColumns}>
      <section className={styles.card} aria-labelledby="runtime-results-title"><h2 id="runtime-results-title" className={styles.h2}>From source window to recorded results</h2>
        <p className={styles.small}>Items retain their checkpoint and original attempt. A completed page may still have more source membership to read.</p>
        <DataTable caption="Registered work items" columns={[{ label: "Item" }, { label: "State" }, { label: "Steps / attempts" }, { label: "Checkpoint" }, { label: "Result" }]}
          rows={data.items.map((item, index) => [`Item ${index + 1}`, item.state, `${item.steps} / ${item.attempts}`, `${item.checkpointVersion}${item.hasCursor ? " · cursor retained" : ""}`, outcomes[item.result]])} />
        {!data.items.length && <p>No items in this verified source page. Check the window coverage before treating this as a complete scan.</p>}
        <Details rows={[["Items", known(data.counts.total)], ["Completed items", known(data.counts.completed)], ["Held items", known(data.counts.held)],
          ["Unknown outcomes", known(data.counts.reconcile)], ["Reused work", known(data.counts.reused)]]} />
      </section>
      <aside className={styles.sideColumn}>
        <section className={`${styles.card} ${styles.payload}`} aria-labelledby="runtime-window-title"><h2 id="runtime-window-title" className={styles.h2}>One intended window</h2>
          <Details rows={[["Intended at", dateTime(data.intendedAt)], ["Observed at", dateTime(data.observedAt)], ["Arrival delay", `${known(data.delayMs)} ms`],
            ["Window membership", data.sourceCoverage === "partial" ? "Partial · total unknown" : "Complete for this source page"],
            ["More membership", data.hasContinuation ? "Continuation remains" : "No continuation returned"], ["Source evidence", data.sourceFresh && !stale ? "Current" : "Needs refresh"]]} />
          <p className={styles.small}>Window {dateTime(data.windowStart)} – {dateTime(data.windowEnd)}. This is separate from future or missed schedule windows.</p></section>
        <section className={styles.card} aria-labelledby="runtime-next-title"><h2 id="runtime-next-title" className={styles.h2}>Owned next step</h2><p>{data.nextAction}</p>
          {waiting.map((takeover, index) => <div key={index}><Badge tone="warning">{takeover.kind}</Badge><p className={native.ref}>Owner {takeover.ownerAlias} · takeover version {takeover.version}</p></div>)}
          {data.blockers.length > 0 && <ul className={native.list}>{data.blockers.map((code, index) => <li key={index}>{code}</li>)}</ul>}
          <Button variant="secondary" disabledReason="A source owner must supply the current authority receipt to the registered worker. Refreshing evidence does not resume or dispatch work.">Resume source work</Button>
        </section>
      </aside>
    </div>
    <section className={styles.card} aria-labelledby="runtime-usage-title"><h2 id="runtime-usage-title" className={styles.h2}>Measured usage and unknown costs</h2>
      <Details columns={2} rows={[["Direct API invocations", known(usage.invocations.directApi)], ["MCP invocations", known(usage.invocations.mcp)],
        ["Model invocations", known(usage.invocations.model)], ["Browser invocations", known(usage.invocations.browser)], ["Pending invocations", known(usage.pendingInvocations)],
        ["Measured transport time", `${usage.measuredRuntimeMs.toLocaleString("en-US")} ms`], ["Ordinary Zapier tasks", known(usage.ordinaryZapTasks)], ["MCP billed tasks", known(usage.mcpTasks)],
        ["Model tokens", known(usage.modelTokens)], ["Observed billed cost", `${cost}${usage.costCoverage === "partial" ? " · partial receipt coverage" : ""}`], ["Total runtime cost", "Unknown"]]} />
      <p className={styles.small}>Invocation counts cover instrumented calls. They do not prove billed tasks, total model use or the final bill. Missing billing receipts stay unknown.</p>
    </section>
  </section>;
}
