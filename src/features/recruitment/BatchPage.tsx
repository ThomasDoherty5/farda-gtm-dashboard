import { useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useScope } from "@/adapter/scope";
import type { ActionResponse, ReadResponse } from "@/adapter/contract";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { parseScorecardSelection } from "@/creator-agent/scorecardPreview";
import { ScorecardPreviewPage } from "./ScorecardPreview";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { DataTable } from "@/components/DataTable";
import { Dialog } from "@/components/Dialog";
import { EmptyState } from "@/components/EmptyState";
import { Kpi, KpiRow } from "@/components/Kpi";
import { formatMoney } from "@/components/MetricValue";
import { SectionTabs } from "@/components/SectionTabs";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { ActionError, blockedReason } from "@/features/approvals/shared";
import { PageTitle, Pending, StaleNotice } from "@/features/creators/creatorsShared";
import { discoveryDemo } from "@/fixtures/discovery";
import { BATCH_LABEL, isUnsent, type BatchData, type BatchItem, type ItemState } from "@/fixtures/batch";
import { OWNERS } from "@/fixtures/creators";
import { BareTitle, ContextBox, acquisition, creators, styles } from "./recruitmentShared";

const SOURCES = [{ value: "tiktok", label: "TikTok" }, { value: "all", label: "All sources" }];
const DEALS = [{ value: "affiliate", label: "Affiliate" }, { value: "all", label: "All commission-only offers" }];
const OWNER_OPTIONS = [{ value: "all", label: "Owner / deadline" }, ...OWNERS.map((o) => ({ value: o, label: o }))];
const allowed = (options: { value: string }[], raw: string | null, fallback: string) => (options.some((o) => o.value === raw) ? (raw as string) : fallback);
const usd = (minorUnits: number) => formatMoney({ minorUnits, currency: "USD" });

const COUNTED: { state: ItemState; label: string; word: string; tone: "violet" | "neutral" | "warning" | "danger"; bar: string }[] = [
  { state: "confirmed", label: "Confirmed", word: "confirmed", tone: "violet", bar: "sConfirmed" },
  { state: "queued", label: "Queued", word: "queued", tone: "neutral", bar: "sQueued" },
  { state: "running", label: "Running", word: "running", tone: "neutral", bar: "sRunning" },
  { state: "reconcile", label: "Reconcile", word: "reconciliation", tone: "warning", bar: "sReconcile" },
  { state: "login", label: "Login", word: "login blocked", tone: "danger", bar: "sLogin" },
];
const OUTCOME: Record<ItemState, string> = { confirmed: "Confirmed receipt", queued: "Queued", running: "Running", reconcile: "Needs reconciliation", login: "Login blocked", paused: "Paused, unsent", canceled: "Canceled, unsent" };

export const countByState = (items: BatchItem[]) => items.reduce<Record<ItemState, number>>((a, i) => ({ ...a, [i.state]: a[i.state] + 1 }), { confirmed: 0, queued: 0, running: 0, reconcile: 0, login: 0, paused: 0, canceled: 0 });
/** One example row per state, in the order the states are listed. */
export const exampleRows = (items: BatchItem[]) => COUNTED.map((c) => c.state).concat(["paused", "canceled"]).flatMap((s) => items.find((i) => i.state === s) ?? []);

type Tab = "detail" | "exceptions" | "capacity" | "samples";
const parseTab = (raw: string | null): Tab => (raw === "exceptions" || raw === "capacity" || raw === "samples" ? raw : "detail");

/** Bulk batch detail (Figma source 66:821, owner THO-298). Pause and cancel touch unsent items only, through the adapter; nothing is dispatched. */
export function BatchPage() {
  const { batchId } = useParams();
  const [search] = useSearchParams();
  if (batchId !== "scorecard-preview") return <ExecutionBatchPage />;
  const selection = parseScorecardSelection(search);
  if (!selection) return <EmptyState state="Empty" title="Invalid assessment selection"><p>Select up to 25 different saved creators from daily sourcing.</p><LinkButton to="/creators/discovery">Daily sourcing</LinkButton></EmptyState>;
  return <ScorecardPreviewPage selection={selection} />;
}

function ExecutionBatchPage() {
  const { batchId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const tab = parseTab(search.get("tab"));
  const filters = { source: allowed(SOURCES, search.get("source"), "tiktok"), deal: allowed(DEALS, search.get("deal"), "affiliate"), owner: allowed(OWNER_OPTIONS, search.get("owner"), "all") };
  const query = useView<typeof filters & { batchId: string }, BatchData>("batchDetail", { batchId, ...filters }, null, { keepPrevious: true });
  const setParam = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(search);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setSearch(next);
  };
  return (
    <section aria-labelledby="batch-title" data-figma-source="66:821" className={acquisition.page}>
      {!query.isPending && !query.data?.data && <BareTitle id="batch-title" title="Scale the work. Keep control." />}
      <Pending query={query} subject="the batch">
        {query.data && (query.data.data && query.data.dataState !== "empty" ? (
          <Body res={query.data as ReadResponse<BatchData>} data={query.data.data} tab={tab} onParam={setParam} />
        ) : (
          <EmptyState state="Empty" title="This batch has no items"><p>The source responded, but no approved recipient is in this batch.</p></EmptyState>
        ))}
      </Pending>
    </section>
  );
}

type Dialogs = null | { kind: "pause" } | { kind: "cancel"; ids: string[] | null } | { kind: "receipt" | "live" | "takeover" | "item-receipt" | "held"; item?: BatchItem };

function Body({ res, data, tab, onParam }: { res: ReadResponse<BatchData>; data: BatchData; tab: Tab; onParam: (key: string, value: string, fallback: string) => void }) {
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [ack, setAck] = useState<{ title: string; response: ActionResponse } | null>(null);
  const action = useAction<{ batchId: string; itemIds?: string[] }>();
  const { filters } = data;
  const counts = countByState(data.items);
  const approved = data.items.length;
  const unsent = counts.queued + counts.paused;
  const { batch } = discoveryDemo;
  const held = data.held.map((h) => ({ ...h, count: filters.owner === "all" ? OWNERS.reduce((a, o) => a + h.byOwner[o], 0) : h.byOwner[filters.owner] }));
  const heldTotal = held.reduce((a, h) => a + h.count, 0);
  const maxHeld = Math.max(...data.held.map((h) => OWNERS.reduce((a, o) => a + h.byOwner[o], 0)));
  const noSample = batch.eligible - batch.sampleUnits;
  const pauseBlocked = blockedReason(res, "pauseBatch");
  const cancelBlocked = blockedReason(res, "cancelUnsent");
  const rows = exampleRows(data.items);
  const closeDialog = () => setDialog(null);
  const eligibleFor = (ids: string[] | null) => data.items.filter((i) => isUnsent(i.state) && (!ids || ids.includes(i.id)));
  const excludedFor = (ids: string[] | null) => data.items.filter((i) => !isUnsent(i.state) && (!ids || ids.includes(i.id)));

  const run = (kind: "pause" | "cancel", ids: string[] | null) => {
    action.mutate(
      { operation: "controlRun", actionKind: kind === "pause" ? "pauseBatch" : "cancelUnsent", entityRefs: [], expectedVersion: data.version, approvalRef: null, manifestRef: null, payload: { batchId: data.batchId, ...(ids ? { itemIds: ids } : {}) } },
      { onSuccess: (response) => { setAck({ title: kind === "pause" ? "New work is paused" : "Unsent items canceled", response }); closeDialog(); } },
    );
  };

  return (
    <>
      <PageTitle id="batch-title" title="Scale the work. Keep control." subtitle={`${BATCH_LABEL} · synthetic finite TikTok batch · no live dispatch`}>
        <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 198 }} disabledReason={pauseBlocked} reasonFor={pauseBlocked ? "pause-note" : undefined} onClick={() => { action.reset(); setDialog({ kind: "pause" }); }}>Pause new work</Button>
        <Button aria-haspopup="dialog" style={{ minWidth: 200 }} onClick={() => setDialog({ kind: "receipt" })}>Review batch receipt</Button>
      </PageTitle>
      <SectionTabs label="Batch views" gap={8} tabs={[
        { label: "Operations queue", to: "/automations", width: 144 },
        { label: "Batch detail", to: `/batches/${data.batchId}`, width: 116, current: tab === "detail" },
        { label: "Exceptions", to: `/batches/${data.batchId}?tab=exceptions`, width: 102, current: tab === "exceptions" },
        { label: "Capacity", to: `/batches/${data.batchId}?tab=capacity`, width: 100, current: tab === "capacity" },
        { label: "Sample requests", to: `/batches/${data.batchId}?tab=samples`, width: 136, current: tab === "samples" },
      ]} />
      <StaleNotice res={res} />
      {pauseBlocked && <p id="pause-note" className={acquisition.small}>{pauseBlocked}</p>}
      {ack && (
        <p className={styles.status} role="status" data-testid="action-ack">
          {ack.title}. {ack.response.reasonCodes.includes("SENT_OR_RUNNING_EXCLUDED") ? "Confirmed, running and reconciling items were left as they are. " : ""}
          {ack.response.reasonCodes.includes("IN_FLIGHT_DRAINS") ? "Running items finish safely, and nothing already sent is touched. " : ""}
          Version {ack.response.payloadVersion}; the table below is the server's current state.
        </p>
      )}

      {tab === "detail" && <DetailTab data={data} counts={counts} approved={approved} unsent={unsent} held={held} heldTotal={heldTotal} maxHeld={maxHeld} noSample={noSample} rows={rows} cancelBlocked={cancelBlocked} onParam={onParam} onDialog={(d) => { action.reset(); setDialog(d); }} />}
      {tab === "exceptions" && <ExceptionsTab data={data} counts={counts} />}
      {tab === "capacity" && <CapacityTab data={data} />}
      {tab === "samples" && <SamplesTab res={res} data={data} />}

      <Dialog open={dialog?.kind === "pause"} title="Pause new work" onClose={closeDialog}>
        <p>This stops {counts.queued} queued {counts.queued === 1 ? "item" : "items"} from being sent. Running items finish safely, and confirmed sends are never touched. Nothing is canceled.</p>
        {action.error && <ActionError error={action.error} />}
        <Button loading={action.isPending} onClick={() => run("pause", null)}>Pause new work</Button>
        <Button variant="secondary" onClick={closeDialog}>Keep running</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "cancel"} title="Cancel unsent items" onClose={closeDialog}>
        {dialog?.kind === "cancel" && (
          <>
            <p>{eligibleFor(dialog.ids).length} unsent {eligibleFor(dialog.ids).length === 1 ? "item" : "items"} will be canceled: {eligibleFor(dialog.ids).map((i) => i.id).join(", ") || "none"}.</p>
            {excludedFor(dialog.ids).length > 0 && <p>{excludedFor(dialog.ids).length} {excludedFor(dialog.ids).length === 1 ? "item stays" : "items stay"} as {excludedFor(dialog.ids).length === 1 ? "it is" : "they are"}: confirmed sends cannot be canceled, and running, reconciling and login-blocked items follow their own recovery path.</p>}
            {action.error && <ActionError error={action.error} />}
            <Button loading={action.isPending} disabledReason={eligibleFor(dialog.ids).length === 0 ? "None of these items is unsent." : null} onClick={() => run("cancel", dialog.ids)}>Cancel unsent</Button>
            <Button variant="secondary" onClick={closeDialog}>Keep them</Button>
          </>
        )}
      </Dialog>
      <Dialog open={dialog?.kind === "receipt"} title="Batch receipt" badge="Demo" onClose={closeDialog}>
        <dl className={styles.reviewList}>
          <div><dt>Batch</dt><dd>{BATCH_LABEL} · {data.version}</dd></div>
          <div><dt>Confirmed</dt><dd>{counts.confirmed} of {approved} approved items have a source receipt</dd></div>
          <div><dt>Not confirmed</dt><dd>{approved - counts.confirmed} items have no receipt yet</dd></div>
        </dl>
        <p>Only a source receipt means sent. Queued, running and reconciling items are not counted as sent, and this example reflects no live job.</p>
        <Button variant="secondary" onClick={closeDialog}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "held"} title="Held prospects" onClose={closeDialog}>
        <p>Each held prospect has one primary reason and an owner. Reviewing them releases nothing: a held row moves only after its own gate is met and a fresh approval covers the change.</p>
        <dl className={styles.reviewList} data-testid="held-review">
          {held.map((h) => <div key={h.key}><dt>{h.label}</dt><dd>{h.count} · {OWNERS.filter((o) => data.held.find((x) => x.key === h.key)!.byOwner[o] > 0 && (filters.owner === "all" || filters.owner === o)).map((o) => `${o} ${data.held.find((x) => x.key === h.key)!.byOwner[o]}`).join(", ") || "no owner"}</dd></div>)}
        </dl>
        <Button variant="secondary" onClick={closeDialog}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "item-receipt"} title="Source receipt" badge="Demo" onClose={closeDialog}>
        <p>{dialog?.kind === "item-receipt" ? `${dialog.item?.id} · ${dialog.item?.handle}` : ""} has a confirmed source receipt in this example. The receipt reference below is synthetic.</p>
        <dl className={styles.reviewList}><div><dt>Receipt</dt><dd>demo-source-receipt-a</dd></div></dl>
        <LinkButton variant="secondary" to="/runs/demo-run-batch">Open the run</LinkButton>
        <Button variant="secondary" onClick={closeDialog}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "live"} title="Live step" badge="Demo" onClose={closeDialog}>
        <p>This is example text, not a running job: no worker is attached and no step is executing. A real run shows the actual attempt, actor and source evidence here.</p>
        <LinkButton to="/runs/demo-run-batch">Open the run detail</LinkButton>
        <Button variant="secondary" onClick={closeDialog}>Close</Button>
      </Dialog>
      <Dialog open={dialog?.kind === "takeover"} title="Request takeover" badge="Demo" onClose={closeDialog}>
        <p>Login, MFA and changed pages need an authorized person to take over in the source. No browser session exists in this demo, so nothing is requested and no credential is asked for.</p>
        <LinkButton variant="secondary" to="/settings/connections">View connection readiness</LinkButton>
        <Button variant="secondary" onClick={closeDialog}>Close</Button>
      </Dialog>
    </>
  );
}

type DetailProps = {
  data: BatchData;
  counts: Record<ItemState, number>;
  approved: number;
  unsent: number;
  held: { key: string; label: string; count: number }[];
  heldTotal: number;
  maxHeld: number;
  noSample: number;
  rows: BatchItem[];
  cancelBlocked: string | null;
  onParam: (key: string, value: string, fallback: string) => void;
  onDialog: (d: Exclude<Dialogs, null>) => void;
};

function DetailTab({ data, counts, approved, unsent, held, heldTotal, maxHeld, noSample, rows, cancelBlocked, onParam, onDialog }: DetailProps) {
  const { filters } = data;
  const { batch } = discoveryDemo;
  const heldCount = batch.selected - batch.eligible;
  const parts = COUNTED.filter((c) => counts[c.state] > 0);
  const sentence = [`${counts.confirmed} confirmed`, ...COUNTED.slice(1).map((c) => `${counts[c.state]} ${c.word}`)].join(" + ");
  return (
    <>
      <ContextBox title="Illustrative batch · historical basis" text={<>This finite execution example assumes valid evidence, terms and approval. Production acquisition must bind the current commission-only policy and published checkout model; no actual creators are approved or queued <br className="wide-break" />here.</>}>
        <div className={creators.contextActions}>
          <LinkButton variant="secondary" to="/creators/discovery" style={{ minWidth: 170 }}>Daily sourcing</LinkButton>
          <LinkButton variant="secondary" to="/creators/pipeline" style={{ minWidth: 208.5 }}>Full acquisition funnel</LinkButton>
        </div>
      </ContextBox>
      <ContextBox title="Approval binds this exact finite set" text={`${batch.selected} selected prospects → ${approved} approved for this batch + ${heldCount} held. The named creators, ${batch.rateLabel} example, products and sample allocations are fixed. Changing terms or adding creators requires a new approval.`} />
      <KpiRow>
        <Kpi label="Selected prospects" context={`${batch.eligible} eligible · ${heldCount} held by exclusive primary reason`} testId="metric-Selected prospects">{batch.selected}</Kpi>
        <Kpi label="Finite dispatch limit" context="Exact approval-bound recipients, never an open-ended loop" testId="metric-Finite dispatch limit">{approved}</Kpi>
        <Kpi label="Sample allocation" context={`${batch.sampleUnits} new × ${usd(batch.sampleUnitCost.minorUnits)} illustrative landed cost; ${noSample} need no new sample`} testId="metric-Sample allocation">{batch.sampleUnits} / {usd(batch.sampleUnits * batch.sampleUnitCost.minorUnits)}</Kpi>
        <Kpi label="Fixed-fee commitment" context="Earned commissions are forecast liabilities, not a hard cap" testId="metric-Fixed-fee commitment">$0</Kpi>
      </KpiRow>

      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-status-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="batch-status-title" className={acquisition.h2}>{counts.confirmed} confirmed. Every other item has a next step.</h2>
          <p className={acquisition.small} data-testid="status-sentence">{approved} approved items = {sentence}{counts.paused > 0 ? ` + ${counts.paused} paused` : ""}{counts.canceled > 0 ? ` + ${counts.canceled} canceled` : ""}.</p>
        </div>
        <ul className={styles.statusBar} aria-label={`${approved} approved items by state`} data-testid="status-bar">
          {parts.map((c) => <li key={c.state} className={`${styles.seg} ${styles[c.bar]}`} style={{ flex: `${counts[c.state]} 1 0` }} aria-hidden="true">{c.state === "confirmed" ? `${counts[c.state]} confirmed` : counts[c.state]}</li>)}
          {counts.paused > 0 && <li className={`${styles.seg} ${styles.sMuted}`} style={{ flex: `${counts.paused} 1 0` }} aria-hidden="true">{counts.paused}</li>}
          {counts.canceled > 0 && <li className={`${styles.seg} ${styles.sMuted}`} style={{ flex: `${counts.canceled} 1 0` }} aria-hidden="true">{counts.canceled}</li>}
        </ul>
        <div className={creators.row}>
          <Badge tone="violet" width={190}>Confirmed · {counts.confirmed}</Badge>
          <Badge width={160}>Queued · {counts.queued}</Badge>
          <Badge width={160}>Running · {counts.running}</Badge>
          <Badge tone="warning" width={180}>Reconcile · {counts.reconcile}</Badge>
          <Badge tone="danger" width={150}>Login · {counts.login}</Badge>
          {counts.paused > 0 && <Badge width={150}>Paused · {counts.paused}</Badge>}
          {counts.canceled > 0 && <Badge width={150}>Canceled · {counts.canceled}</Badge>}
        </div>
        <div className={styles.itemsScroll} role="region" aria-label="Batch items, one example for each state" tabIndex={0} data-testid="items-region">
          <table className={styles.items} data-testid="items">
            <caption className="visually-hidden">Batch items: one example for each state, of {approved} approved</caption>
            <thead>
              <tr>{["Item / recipient", "Bound terms", "Evidence", "Next action / deadline", "Outcome", "Control"].map((h, i) => <th key={h} scope="col" style={{ width: [244, 230, 164, 236, 184, 190][i] }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <th scope="row" style={{ font: "var(--text-body)" }}>{item.id} · {item.handle}</th>
                  <td>{item.terms}</td>
                  <td>{item.evidence}</td>
                  <td>{item.state === "paused" ? "Held while new work is paused" : item.state === "canceled" ? "No further dispatch" : item.next}</td>
                  <td>{OUTCOME[item.state]}</td>
                  <td className="control">
                    {item.state === "confirmed" && <Button variant="ghost" aria-haspopup="dialog" style={{ minWidth: 166, paddingInline: 8 }} onClick={() => onDialog({ kind: "item-receipt", item })}>View receipt</Button>}
                    {(item.state === "queued" || item.state === "paused") && <Button variant="ghost" aria-haspopup="dialog" style={{ minWidth: 166, paddingInline: 8 }} onClick={() => onDialog({ kind: "cancel", ids: [item.id] })}>Cancel unsent</Button>}
                    {item.state === "running" && <Button variant="ghost" aria-haspopup="dialog" style={{ minWidth: 166, paddingInline: 8 }} onClick={() => onDialog({ kind: "live" })}>Inspect live step</Button>}
                    {item.state === "reconcile" && <LinkButton variant="secondary" to="/runs/demo-run-uncertain?tab=recovery" style={{ minWidth: 166, paddingInline: 8 }}>Reconcile outcome</LinkButton>}
                    {item.state === "login" && <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 166, paddingInline: 8 }} onClick={() => onDialog({ kind: "takeover" })}>Request takeover</Button>}
                    {item.state === "canceled" && "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={acquisition.small}>Confirmed sends cannot be canceled. Pause stops new work; in-flight actions drain safely. Uncertain writes are never blindly replayed. Source receipts remain authoritative.</p>
      </section>

      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-held-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="batch-held-title" className={acquisition.h2}>Keep held prospects visible.</h2>
          <p className={acquisition.small}>{heldTotal} held {heldTotal === 1 ? "prospect has" : "prospects have"} one exclusive primary reason; the queue can be filtered by source, deal, model, evidence, owner and deadline.</p>
        </div>
        <ul className={styles.bars} data-testid="held-bars">
          {held.map((h) => (
            <li key={h.key} className={styles.bar}>
              <span className={styles.name}>{h.label}</span>
              <span className={styles.track} aria-hidden="true"><span className={styles.fill} style={{ display: "block", width: `${(100 * h.count) / maxHeld}%` }} /></span>
              <span className={styles.count}>{h.count}</span>
            </li>
          ))}
        </ul>
        <div className={creators.row}>
          <FilterButton name="Source" title="Choose the acquisition source" options={SOURCES} value={filters.source} onChange={(v) => onParam("source", v, "tiktok")} width={170} />
          <FilterButton name="Deal" title="Choose the commission-only offer class" options={DEALS} value={filters.deal} onChange={(v) => onParam("deal", v, "affiliate")} width={170} />
          <span className={styles.readonly} role="status" aria-label={`Model: ${data.model.label}, read-only`} data-testid="model-status">Model: {data.model.label}</span>
          <FilterButton name="Owner" title="Choose an owner" options={OWNER_OPTIONS} value={filters.owner} onChange={(v) => onParam("owner", v, "all")} width={210} bare />
          <Button variant="ghost" aria-haspopup="dialog" style={{ minWidth: 202 }} onClick={() => onDialog({ kind: "held" })}>Review held rows</Button>
        </div>
      </section>

      <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-guard-title">
        <div className={acquisition.sectionTitle}>
          <h2 id="batch-guard-title" className={acquisition.h2}>Recheck before each write.</h2>
          <p className={acquisition.small}>Approval is necessary; current source state, access, stock, capacity and locks still decide whether an item can execute.</p>
        </div>
        <ul className={creators.settle}>
          <li><Badge tone="violet" width={140}>Demo only</Badge><p className={creators.settleName}>Native quota snapshot</p><p className={acquisition.small}>{data.capacity.nativeInvitations} invitations available at approval · actual unit/tier/reset must be read live</p></li>
          <li><Badge tone="success" width={140}>Bounded</Badge><p className={creators.settleName}>Dispatch + sample guard</p><p className={acquisition.small}>Max {approved} recipients; max {data.capacity.sampleUnits} new samples / {usd(data.capacity.sampleCostMinor)}; no fixed-fee commitment</p></li>
          <li><Badge tone="warning" width={140}>Forecast + alerts</Badge><p className={creators.settleName}>Commission liability</p><p className={acquisition.small}>A runner dispatch cap is not a hard cap on already-earned commission</p></li>
          <li><Badge width={140}>Reconcile first</Badge><p className={creators.settleName}>Retries and locks</p><p className={acquisition.small}>Check the source result before retrying. Paused items keep their progress; wait when the provider asks.</p></li>
        </ul>
        <div className={styles.buttons}>
          <LinkButton to="/approvals/demo-approval-history" style={{ minWidth: 270 }}>Inspect approval manifest</LinkButton>
          <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 226 }} disabledReason={cancelBlocked ?? (unsent === 0 ? "There is no unsent work to cancel." : null)} reasonFor={cancelBlocked || unsent === 0 ? "cancel-note" : undefined} onClick={() => onDialog({ kind: "cancel", ids: null })}>Cancel unsent items</Button>
          <LinkButton variant="ghost" to={`/batches/${data.batchId}?tab=capacity`} style={{ minWidth: 258 }}>Open capacity and access</LinkButton>
        </div>
        {(cancelBlocked || unsent === 0) && <p id="cancel-note" className={acquisition.small}>{cancelBlocked ?? "There is no unsent work to cancel."}</p>}
      </section>
      <p className={acquisition.small}>Synthetic workspace · source access unverified · no outreach, offer, billing or schedule is live.</p>
    </>
  );
}

/** The Exceptions and Capacity tabs have no Figma source in this frame. They list only what the batch data already holds. */
function ExceptionsTab({ data, counts }: { data: BatchData; counts: Record<ItemState, number> }) {
  const rows = data.items.filter((i) => i.state === "reconcile" || i.state === "login");
  return (
    <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-exc-title">
      <div className={acquisition.sectionTitle}>
        <h2 id="batch-exc-title" className={acquisition.h2}>Exceptions need a person.</h2>
        <p className={acquisition.small}>{counts.reconcile} to reconcile and {counts.login} login blocked, with their original item IDs. This tab has no Figma source yet; it lists the batch's own records and changes nothing.</p>
      </div>
      <DataTable caption="Batch exceptions" columns={[{ label: "Item" }, { label: "Reason" }, { label: "Next step" }, { label: "Recovery" }]} rows={rows.map((i) => [`${i.id} · ${i.handle}`, OUTCOME[i.state], i.next, i.state === "reconcile" ? <LinkButton key={i.id} variant="secondary" to="/runs/demo-run-uncertain?tab=recovery">Reconcile outcome</LinkButton> : <LinkButton key={i.id} variant="secondary" to="/settings/connections">View connection readiness</LinkButton>])} testId="exceptions-table" minWidth={720} />
      <LinkButton variant="secondary" to={`/batches/${data.batchId}`} style={{ alignSelf: "flex-start" }}>Back to batch detail</LinkButton>
    </section>
  );
}

function CapacityTab({ data }: { data: BatchData }) {
  const { capacity } = data;
  return (
    <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-cap-title">
      <div className={acquisition.sectionTitle}>
        <h2 id="batch-cap-title" className={acquisition.h2}>Separate capacities. Never one total.</h2>
        <p className={acquisition.small}>Native quota, collaboration slots, sample units and authorized cost use different units, so they are never added together. This tab has no Figma source yet.</p>
      </div>
      <DataTable
        caption="Batch capacity by unit"
        columns={[{ label: "Capacity" }, { label: "Unit" }, { label: "Value" }, { label: "Basis" }]}
        rows={[
          ["Native invitation quota", "Invitations", capacity.nativeInvitations === null ? "N/A" : String(capacity.nativeInvitations), "Snapshot at approval · read the live unit, tier and reset"],
          ["Collaboration slots", "Slots", "N/A", "Not read from the source"],
          ["Sample units", "Units", String(capacity.sampleUnits), "Approved maximum · stock is checked at each write"],
          ["Authorized cost", "USD", usd(capacity.sampleCostMinor), "Illustrative landed cost of the new samples"],
        ]}
        testId="capacity-table"
        minWidth={720}
      />
      <LinkButton variant="secondary" to="/settings/capabilities" style={{ alignSelf: "flex-start" }}>Open channel access</LinkButton>
    </section>
  );
}

/** TikTok sample decisions (FE06-05). A decision is recorded only through the verified API route and counts once TikTok returns a receipt. Where TikTok refuses the account's scope, an owner takes over and nothing is claimed. */
function SamplesTab({ res, data }: { res: ReadResponse<BatchData>; data: BatchData }) {
  const action = useAction<{ batchId: string; sampleId: string; decision: "approve" | "decline" }>();
  const [last, setLast] = useState<{ sampleId: string; response: ActionResponse } | null>(null);
  const blocked = blockedReason(res, "decideTikTokSample");
  // In the demo no request reaches TikTok, so a receipt here is synthetic. It is worded as recorded in the demo until a real source receipt exists.
  const demo = useScope().adapter.kind === "demo";
  const costApproval = discoveryDemo.capacityRows.find((x) => x.source === "Product and shipping")?.evidence ?? "Separate approval";
  const decide = (sampleId: string, decision: "approve" | "decline") =>
    action.mutate(
      { operation: "controlRun", actionKind: "decideTikTokSample", entityRefs: [], expectedVersion: data.version, approvalRef: null, manifestRef: null, payload: { batchId: data.batchId, sampleId, decision } },
      { onSuccess: (response) => setLast({ sampleId, response }) },
    );
  const pending = data.samples.filter((s) => s.state === "pending").length;
  return (
    <section className={`${creators.panel} ${creators.panelWide}`} aria-labelledby="batch-samples-title" data-testid="samples-tab">
      <div className={acquisition.sectionTitle}>
        <h2 id="batch-samples-title" className={acquisition.h2}>Sample requests, decided where TikTok allows it. {demo && <Badge tone="violet">Demo</Badge>}</h2>
        <p className={acquisition.small}>
          {pending} of {data.samples.length} waiting.{" "}
          {demo
            ? "Decisions are recorded in the demo only: no request reaches TikTok and the receipts are synthetic. A real decision counts only when TikTok's API returns a receipt."
            : "A decision counts only when TikTok's API returns a receipt."}{" "}
          If TikTok refuses this account's scope, the request goes to its owner and nothing is recorded as decided. A sample decision never approves its product and shipping cost, which is a {costApproval.toLowerCase()}. This tab has no Figma source yet.
        </p>
      </div>
      {blocked && <p className={acquisition.small} role="status" data-testid="samples-blocked">{blocked}</p>}
      {action.error && <ActionError error={action.error} />}
      {last && last.response.state === "succeeded" && (
        <p className={styles.status} role="status" data-testid="sample-ack">
          {last.response.receiptRefs.length > 0
            ? `${demo ? `Recorded in the demo for ${last.sampleId}. Demo receipt ${last.response.receiptRefs.join(", ")} is synthetic: TikTok was not contacted.` : `Decided in TikTok for ${last.sampleId}. Receipt ${last.response.receiptRefs.join(", ")}.`} Product and shipping cost still need a separate approval.`
            : `TikTok acknowledged ${last.sampleId} but returned no receipt yet, so it is not shown as decided.`}
        </p>
      )}
      {last && last.response.state === "blocked" && (
        <p className={styles.status} role="status" data-testid="sample-handoff">
          TikTok refused this account's authority for {last.sampleId}. Nothing was decided. {last.response.nextAction?.ownerRef ?? "The owner"} has the request and must decide it in TikTok.
        </p>
      )}
      <DataTable
        caption="TikTok sample requests"
        columns={[{ label: "Creator" }, { label: "Product" }, { label: "Units" }, { label: "Cost approval" }, { label: "Status" }, { label: "Decision" }]}
        rows={data.samples.map((s) => [
          s.handle,
          s.product,
          String(s.units),
          costApproval,
          s.state === "pending" ? "Waiting for a decision" : s.state === "approved" ? `Approved in ${demo ? "the demo" : "TikTok"} · ${s.receiptRef}` : s.state === "declined" ? `Declined in ${demo ? "the demo" : "TikTok"} · ${s.receiptRef}` : `Not decided · handed to ${s.ownerRef}`,
          s.state === "pending" ? (
            <span key="d" style={{ display: "inline-flex", gap: 8 }}>
              <Button variant="secondary" loading={action.isPending && action.variables?.payload.sampleId === s.id && action.variables.payload.decision === "approve"} disabledReason={blocked ?? undefined} aria-label={`Approve sample ${s.id}`} onClick={() => decide(s.id, "approve")}>Approve</Button>
              <Button variant="secondary" disabledReason={blocked ?? undefined} aria-label={`Decline sample ${s.id}`} onClick={() => decide(s.id, "decline")}>Decline</Button>
            </span>
          ) : s.state === "handoff" ? <LinkButton key="d" variant="ghost" to="/settings/capabilities">Open channel access</LinkButton> : "Recorded",
        ])}
        testId="sample-requests"
        minWidth={720}
      />
    </section>
  );
}
