import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { WatchlistFilters } from "@/adapter/demoMonitor";
import { useView } from "@/adapter/useView";
import { Badge, type BadgeTone } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Card, ChoiceButton, HandoffDialog, KpiCard, KpiGrid, ViewShell } from "@/features/analytics/parts";
import { DEMO_POST_ID, type MonitoringState, type WatchRow, type WatchlistData } from "@/fixtures/monitor";
import a from "@/features/analytics/Analytics.module.css";
import m from "./Monitor.module.css";

const SOURCES = [{ value: "all", label: "All intake sources" }, { value: "social-cat", label: "Social Cat intake" }, { value: "tiktok-affiliate", label: "TikTok intake" }];
const STATES = [{ value: "all", label: "All monitoring states" }, { value: "active", label: "Active" }, { value: "identity-review", label: "Identity review" }, { value: "excluded", label: "Excluded" }];
const COHORTS = [{ value: "launch-a", label: "Launch cohort A" }, { value: "only-launch-a", label: "Launch cohort A only" }];
const allowed = (options: { value: string }[], raw: string | null, fallback: string) => (options.some((o) => o.value === raw) ? (raw as string) : fallback);
const BADGE: Record<MonitoringState, { tone: BadgeTone; label: string }> = { active: { tone: "success", label: "Active" }, "identity-review": { tone: "warning", label: "Identity review" }, excluded: { tone: "neutral", label: "Excluded" } };
const HISTORY = [
  { at: "Oct 29, 10:04 AM", event: "@studio.rae joined the TikTok affiliate program", decision: "Matched to creator CR-010; enrolled as Active" },
  { at: "Oct 28, 4:12 PM", event: "@move.with.ana joined the TikTok affiliate program", decision: "Two candidate profiles; quarantined as Identity review" },
  { at: "Oct 26, 9:30 AM", event: "@calm.with.jo opted out", decision: "Suppressed; tracking ended" },
];

/** Creator watchlist (Figma source 25:166, owner THO-299, CTRL-058 to CTRL-062, CTRL-210 to CTRL-212). Enrollment never implies qualification or outreach. */
export function WatchlistPage() {
  const [search, setSearch] = useSearchParams();
  const filters = { source: allowed(SOURCES, search.get("source"), "all"), state: allowed(STATES, search.get("state"), "all"), cohort: allowed(COHORTS, search.get("cohort"), "launch-a") };
  const query = useView<WatchlistFilters, WatchlistData>("watchlist", { source: filters.source as WatchlistFilters["source"], state: filters.state as WatchlistFilters["state"], cohort: filters.cohort === "only-launch-a" ? "launch-a" : "all" }, null, { keepPrevious: true });
  const set = (key: string, value: string, fallback: string) => setSearch((prev) => { const next = new URLSearchParams(prev); if (value === fallback) next.delete(key); else next.set(key, value); return next; });
  const [dialog, setDialog] = useState<{ kind: "matches" | "history" | "mapping" } | { kind: "row"; row: WatchRow } | null>(null);
  const data = query.data?.data ?? null;
  const pending = data?.totals.identityReview ?? null;
  return (
    <section aria-labelledby="watchlist-title" data-figma-source="25:166" className={a.page}>
      <div className={a.titleRow}>
        <div className={a.heading}>
          <h1 id="watchlist-title">Know who the agent is watching.</h1>
          <p>New applications and affiliate signups become deduplicated tracking profiles.</p>
        </div>
        <LinkButton variant="secondary" to="/content" style={{ minWidth: 160 }}>View monitor</LinkButton>
        <Button style={{ minWidth: 184 }} aria-haspopup="dialog" disabledReason={pending === null ? "Waiting for the watchlist" : null} onClick={() => setDialog({ kind: "matches" })}>{pending === null ? "Review matches" : `Review ${pending} matches`}</Button>
      </div>
      <section className={m.policyCard} aria-label="Current acquisition policy" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 20, background: "var(--color-violetSoft)", border: "1px solid var(--color-border)", borderRadius: 24 }}>
        <p className={a.label} style={{ margin: 0 }}>Watchlist intake and acquisition are distinct</p>
        <p className={a.small}>New profiles begin Identity pending. Enrollment does not imply qualification, accepted terms or outreach approval. Daily discovery can propose candidates for review.</p>
        <div className={a.actions} style={{ gap: 10 }}>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 209 }}>Full acquisition funnel</LinkButton>
        </div>
      </section>
      <div className={m.ctx}>
        <Badge tone="violet" width={200}>Demo watchlist</Badge>
        <p className={a.small}>{data ? `${data.totals.tracked} profiles across linked accounts · illustrative records · ${data.scheduleLabel}` : query.isError ? "The watchlist could not be read." : "Loading the watchlist…"}</p>
      </div>
      <ViewShell query={query} subject="The watchlist" emptyTitle="Nothing is on the watchlist yet" emptyBody="The source responded, but no profiles are tracked. That is not zero profiles.">
        {(d) => (
          <>
            <KpiGrid>
              <KpiCard label="Tracked profiles" context={`${d.totals.socialCat} Social Cat intake / ${d.totals.tiktok} TikTok intake`} testId="metric-tracked">{d.totals.tracked}</KpiCard>
              <KpiCard label="Active monitoring" context="Validated profile links and eligibility" testId="metric-active">{d.totals.active}</KpiCard>
              <KpiCard label="Identity review" context="Resolve account matches before tracking" warn testId="metric-identity">{d.totals.identityReview}</KpiCard>
              <KpiCard label="Excluded" context="Suppression and ended tracking respected" testId="metric-excluded">{d.totals.excluded}</KpiCard>
            </KpiGrid>
            <div className={m.filtersRow} style={{ gap: 16, alignItems: "center" }}>
              <ChoiceButton legend="Intake source" title="Filter by intake source" options={SOURCES} value={filters.source} onChange={(v) => set("source", v, "all")} width={200} buttonLabel={(c) => c.label} />
              <ChoiceButton legend="Monitoring state" title="Filter by monitoring state" options={STATES} value={filters.state} onChange={(v) => set("state", v, "all")} width={220} buttonLabel={(c) => c.label} />
              <ChoiceButton legend="Cohort" title="Choose a named cohort" options={COHORTS} value={filters.cohort} onChange={(v) => set("cohort", v, "launch-a")} width={200} buttonLabel={(c) => c.label} />
              <p className={a.small}>{d.cohortCreators} reporting creators are a subset of the active watchlist.</p>
            </div>
            <Card labelledBy="registry-title">
              <h2 id="registry-title" className={a.cardH2} style={{ margin: 0 }}>The sheet is the tracking registry</h2>
              <p className={a.small}>One stable profile key per platform account. Linked accounts share a creator ID; profile count is not unique people.</p>
              {filters.source !== "all" || filters.state !== "all" || filters.cohort === "only-launch-a" ? <p className={m.status} role="status">Showing {d.rows.length} of {d.totals.tracked} profiles. The demo loads sample rows only; the totals above are the whole watchlist.</p> : null}
              {d.rows.length === 0 ? <p className={a.label} role="status">No profiles match these filters. That isn't zero profiles; the watchlist tracks {d.totals.tracked}.</p> : (
                <div className={a.tableWrap} role="region" aria-label="Creator watchlist" tabIndex={0}>
                  <table className={a.table}>
                    <caption className="visually-hidden">Creator watchlist</caption>
                    <colgroup>{[300, 250, 170, 150, 378].map((w) => <col key={w} style={{ width: `${(100 * w) / 1248}%` }} />)}</colgroup>
                    <thead><tr>{["CREATOR / PROFILE", "SIGNUP SOURCE", "MONITORING", "LAST CHECK", "NEXT STEP"].map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
                    <tbody>
                      {d.rows.map((r) => (
                        <tr key={r.id}>
                          <th scope="row">{r.handle} · {r.network}{r.cohort === "launch-a" && <span className="visually-hidden"> (Launch cohort A)</span>}</th>
                          <td>{r.signup}</td>
                          <td><Badge tone={BADGE[r.state].tone} width={144}>{BADGE[r.state].label}</Badge></td>
                          <td>{r.lastCheck}</td>
                          <td>{r.next.kind === "post" ? <Link className={m.linkBtn} to={`/content/${DEMO_POST_ID}`}>{r.next.label}</Link> : <button type="button" className={m.linkBtn} aria-haspopup="dialog" onClick={() => setDialog({ kind: "row", row: r })}>{r.next.label}</button>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <div className={a.split} style={{ gridTemplateColumns: "636fr 636fr" }}>
              <Card labelledBy="intake-title" className={a.card20}>
                <h2 id="intake-title" className={a.cardH2} style={{ margin: 0 }}>Every signup enters a clear queue</h2>
                {["1  Discover a new application or affiliate signup.", "2  Upsert the source ID; preserve the original signup event.", "3  Match handle, profile URL, creator and collaboration.", "4  Activate eligible profiles; queue ambiguous matches."].map((l) => <p key={l} className={a.small} style={{ whiteSpace: "pre-wrap" }}>{l}</p>)}
                <div className={a.btnRow}><Button variant="secondary" style={{ minWidth: 240 }} aria-haspopup="dialog" onClick={() => setDialog({ kind: "history" })}>Open intake history</Button></div>
              </Card>
              <Card labelledBy="fields-title" className={a.card20}>
                <h2 id="fields-title" className={a.cardH2} style={{ margin: 0 }}>What the agent needs to know</h2>
                <p className={a.small}>Creator ID · source signup ID · intake platform · posting network · profile URL · campaign · collaboration · tracking status · last checked · next due · exclusion reason.</p>
                <hr className={a.divider} />
                <p className={a.small}>Restricted account access stays in the connected browser session. Messages remain in their source; this sheet stores only status, evidence links and timestamps.</p>
                <div className={a.btnRow}><Button variant="secondary" style={{ minWidth: 240 }} aria-haspopup="dialog" onClick={() => setDialog({ kind: "mapping" })}>View sheet mapping</Button></div>
              </Card>
            </div>
            <p className={m.footer}>Proposed registry · Google Sheets tracking source / Notion collaboration and approval records / source platforms retain the original conversations.</p>
            <Dialogs dialog={dialog} close={() => setDialog(null)} data={d} />
          </>
        )}
      </ViewShell>
    </section>
  );
}

function Dialogs({ dialog, close, data }: { dialog: { kind: "matches" | "history" | "mapping" } | { kind: "row"; row: WatchRow } | null; close: () => void; data: WatchlistData }) {
  const row = dialog?.kind === "row" ? dialog.row : null;
  const review = data.rows.filter((r) => r.state === "identity-review");
  const open = (k: string) => dialog?.kind === k;
  const rowDialog = row && {
    message: { title: "New message", rows: [{ label: "Profile", value: `${row.handle} · ${row.network}` }, { label: "Source conversation", value: "No verified conversation link in this build" }, { label: "Newly observed", value: "One new reply, not shown here" }], note: "Reading a message doesn't authorize outbound. Replies stay in the approval queue." },
    deliverable: { title: "Verify deliverable", rows: [{ label: "Profile", value: `${row.handle} · ${row.network}` }, { label: "Evidence", value: "No verified post link in this build" }], note: "Verification happens against the source post. This opens nothing and confirms nothing." },
    identity: { title: "Match the correct profile", rows: [{ label: "Profile", value: `${row.handle} · ${row.network}` }, { label: "Competing evidence", value: row.note }, { label: "Status", value: "Quarantined. Nothing is merged." }], note: "Selecting or merging needs a separate, versioned, authorized contract. An uncertain match stays quarantined." },
    reconnect: { title: "Reconnect source session", rows: [{ label: "Profile", value: `${row.handle} · ${row.network}` }, { label: "Last check", value: row.lastCheck }, { label: "Sign-in", value: "Happens in the connected browser session, never in this app" }], note: "Reconnecting doesn't resend messages or repeat completed source writes." },
    exclusion: { title: "Exclusion reason", rows: [{ label: "Profile", value: `${row.handle} · ${row.network}` }, { label: "Reason", value: row.note }, { label: "Effective", value: row.lastCheck }, { label: "Owner", value: "Privacy and suppression policy" }], note: "Opening this doesn't remove the exclusion." },
    post: { title: "Post performance", rows: [], note: "" },
    suggestion: { title: "", rows: [], note: "" },
    delivery: { title: "", rows: [], note: "" },
  }[row.next.kind as "message"];
  return (
    <>
      <HandoffDialog open={open("matches")} onClose={close} title={`Identity matches · ${data.totals.identityReview} pending`}
        rows={[...review.map((r) => ({ label: `${r.handle} · ${r.network}`, value: r.note })), { label: "Other pending matches", value: `${Math.max(0, data.totals.identityReview - review.length)} more; the demo loads sample rows only` }]}>
        <p>Ambiguous matches are quarantined, and reviewing them doesn't merge any identity.</p>
      </HandoffDialog>
      <HandoffDialog open={open("history")} onClose={close} title="Intake history" rows={HISTORY.map((h) => ({ label: `${h.at} · ${h.event}`, value: h.decision }))}>
        <p>Synthetic history, scoped to one source and account. The original identity evidence is kept with each decision.</p>
      </HandoffDialog>
      <HandoffDialog open={open("mapping")} onClose={close} title="Sheet mapping"
        rows={[{ label: "Registry", value: "Google Sheets tracking source (proposed)" }, { label: "Collaboration and approval", value: "Notion" }, { label: "Conversations", value: "Remain in the source platforms" }, { label: "Stored here", value: "Status, evidence links and timestamps only" }]}>
        <p>Read-only. Editing a mapping is a separate authorized action.</p>
      </HandoffDialog>
      <HandoffDialog open={row !== null && Boolean(rowDialog?.title)} onClose={close} title={rowDialog?.title ?? ""} rows={rowDialog?.rows ?? []}>
        <p>{rowDialog?.note}</p>
      </HandoffDialog>
    </>
  );
}
