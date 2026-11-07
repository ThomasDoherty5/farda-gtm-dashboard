import { useScope } from "@/adapter/scope";
import { NativeInventoryPage } from "./NativeInventoryPage";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { AdapterError } from "@/adapter/errors";
import { useAction } from "@/adapter/useAction";
import { useView } from "@/adapter/useView";
import { Alert } from "@/components/Alert";
import { ReadState } from "@/components/ReadState";
import { Badge } from "@/components/Badge";
import { Button } from "@/components/Button";
import { Dialog } from "@/components/Dialog";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { SelectField, TextField } from "@/components/Field";
import { Kpi, KpiRow } from "@/components/Kpi";
import { FactList, FlatTable, Meter, Notice, Page, PageHeader, Panel, TwoColumns } from "@/components/Panels";
import { ViewError } from "@/components/ViewError";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { ActionError, blockedReason, SourceDialog } from "@/features/approvals/shared";
import { OpsTabs } from "@/features/operations/OpsTabs";
import { figure, minutesAgoLabel, reasonText } from "@/features/operations/format";
import { DEMO_NOW } from "@/fixtures/overview";
import { availableOf, isLate, STAGES, type InventoryOverview, type Movement, type StockRow } from "@/fixtures/inventory";
import { HOMES, homeLabel, type Home } from "@/fixtures/operations";
import styles from "./Inventory.module.css";

const HOME_OPTIONS = [{ value: "all", label: "All homes" }, ...HOMES.map((h) => ({ value: h, label: homeLabel(h) }))];
const parseHome = (raw: string | null): Home | "all" => (HOMES.includes(raw as Home) ? (raw as Home) : "all");
const STAGE_COPY = { requested: "awaiting dispatch", dispatched: "awaiting receipt", received: "received" } as const;
const STAGE_BADGE = { requested: "Requested", dispatched: "In transit", received: "Received" } as const;

type Health = { label: string; tone: "success" | "warning" };
/** Health comes from the movement ledger and the threshold. A count that disagrees with Shopify needs review, whatever the level. */
export function healthOf(row: StockRow): Health {
  const observed = row.shopifyObserved;
  if (observed.state === "known" && observed.value !== row.onHand) return { label: "Needs review", tone: "warning" };
  return availableOf(row) < row.threshold ? { label: "Low stock", tone: "warning" } : { label: "Healthy", tone: "success" };
}

const unitsLabel = (m: Movement) => `${m.effect.delta > 0 ? "+" : "−"}${Math.abs(m.effect.delta)} ${m.effect.field === "available" ? "available" : "on hand"}`;

/**
 * Stock per home and transfer (Figma source 7:129, owner THO-302). Physical on-hand is derived from movements; Shopify's count is a
 * separate snapshot, and a disagreement is surfaced, not averaged away. All stock changes happen at the source: the one in-app intent
 * asks for a transfer and moves nothing.
 */
export function InventoryPage() {
  return useScope().scope.environment === "demo" ? <DemoInventoryPage /> : <NativeInventoryPage />;
}

function DemoInventoryPage() {
  const [search, setSearch] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const home = parseHome(search.get("home"));
  const [source, setSource] = useState<string | null>(null);
  const query = useView<{ scenario?: string }, InventoryOverview>("inventoryOverview", scenario ? { scenario } : {});
  const res = query.data;
  const data = res?.data ?? null;
  const setHome = (v: string) => {
    const next = new URLSearchParams(search);
    if (v === "all") next.delete("home");
    else next.set("home", v);
    setSearch(next);
  };
  return (
    <Page aria-labelledby="stock-title" data-figma-source="7:129">
      <PageHeader id="stock-title" title="Stock by home" subtitle="One inventory truth. Every reservation and movement accounted for.">
        {res && data && <TransferRequestButton res={res} data={data} />}
        <FilterButton name="Home" bare title="Choose a home" options={HOME_OPTIONS} value={home} onChange={setHome} width={160} />
        <Button aria-haspopup="dialog" style={{ minWidth: 190 }} onClick={() => setSource("Open inventory")}>Open inventory</Button>
      </PageHeader>
      <OpsTabs current="stock" />
      {/* A partial or stale read is said in words, not only by a badge. */}
      <ReadState res={query.data} subject="Inventory" only={["partial"]} />
      {query.isPending && <SkeletonCard label="Loading stock…" />}
      {query.isError && <ViewError error={query.error} subject="Stock" hasPriorData={Boolean(res)} onRetry={() => void query.refetch()} />}
      {res && !data && <EmptyState state="Empty" title="No stock yet"><p>The inventory mirror responded, but holds no locations.</p></EmptyState>}
      {res && data && <Body res={res} data={data} home={home} onSource={setSource} />}
      <SourceDialog open={source !== null} title={source ?? ""} url={null} onClose={() => setSource(null)} />
    </Page>
  );
}

function Body({ res, data, home, onSource }: { res: ReadResponse<InventoryOverview>; data: InventoryOverview; home: Home | "all"; onSource: (title: string) => void }) {
  const rows = data.rows.filter((r) => home === "all" || r.home === home);
  const movements = data.movements.filter((m) => home === "all" || m.home === home);
  const onHand = rows.reduce((n, r) => n + r.onHand, 0);
  const reserved = rows.reduce((n, r) => n + r.reserved, 0);
  const atRisk = rows.filter((r) => healthOf(r).tone === "warning");
  const lowOnly = rows.filter((r) => availableOf(r) < r.threshold);
  const stale = res.dataState === "stale";
  const t = data.transfer;
  const showTransfer = home === "all" || t.from === home || t.to === home;
  const conflicts = rows.filter((r) => r.shopifyObserved.state === "known" && r.shopifyObserved.value !== r.onHand);
  const excluded = movements.filter((m) => !m.complete);
  const sync = data.syncedMinutesAgo === null ? "No successful sync recorded" : `Synced ${minutesAgoLabel(data.syncedMinutesAgo)}`;

  return (
    <>
      <Notice tone={stale ? "warning" : "violet"} label={stale ? "Behind" : "Source"} title="Inventory mirrors Shopify locations and the Sheets movement log" role={stale ? "status" : undefined} testId="source-freshness">
        {`Demo quantities · ${sync} · ${stale ? "The mirror is behind, so balances may be out of date. " : ""}All stock changes happen at the source.`}
      </Notice>
      {conflicts.map((r) => (
        <Alert key={r.home} state="warning" title={`${homeLabel(r.home)}: Shopify and the movement ledger disagree`} testId="stock-conflict">
          <p>Shopify observed {figure(r.shopifyObserved, String)}; the movements give {r.onHand} on hand. The ledger balance is shown. Review both in the source before moving stock.</p>
        </Alert>
      ))}
      {isLate(data.transfer, DEMO_NOW) && (
        <Alert state="warning" title={`Transfer ${data.transfer.key} is late`} testId="transfer-late">
          <p>It was expected by {data.transfer.expectedBy} and {homeLabel(data.transfer.to)} has not confirmed receipt. On hand at the destination is unchanged, and the {data.transfer.expectedUnits} units are not counted until the source records the receipt.</p>
        </Alert>
      )}
      {data.pendingRequests.length > 0 && (
        <Alert state="info" title={`${data.pendingRequests.length} transfer request${data.pendingRequests.length === 1 ? "" : "s"} waiting for approval`} testId="pending-requests">
          {data.pendingRequests.map((r) => <p key={r.key}>{r.units} units · {homeLabel(r.from)} → {homeLabel(r.to)}. {r.state}</p>)}
        </Alert>
      )}
      <KpiRow>
        <Kpi label="On hand" context={`Across ${rows.length} home${rows.length === 1 ? "" : "s"} · one SKU`} testId="metric-On hand">{onHand}</Kpi>
        <Kpi label="Reserved" context="Approved samples + open orders" testId="metric-Reserved">{reserved}</Kpi>
        <Kpi label="Available" context="On hand less active reservations" testId="metric-Available">{onHand - reserved}</Kpi>
        <Kpi label="At risk" context={atRisk.length ? `${atRisk.map((r) => homeLabel(r.home)).join(", ")} ${lowOnly.length === atRisk.length ? `below ${lowOnly[0]!.threshold}-unit threshold` : "needs attention"}` : "No home below its threshold"} testId="metric-At risk">{atRisk.length} home{atRisk.length === 1 ? "" : "s"}</Kpi>
      </KpiRow>
      <Panel title="Inventory by location" subtitle="Stock is counted once per home × SKU" testId="stock-table-panel">
        <FlatTable
          caption="Inventory by location"
          columns={[{ label: "Location / SKU", width: 400 }, { label: "On hand", width: 136 }, { label: "Reserved", width: 136 }, { label: "Available", width: 136 }, { label: "Health", width: 200 }, { label: "Source", width: 240 }]}
          testId="stock-table"
          rows={rows.map((r) => {
            const h = healthOf(r);
            return {
              key: r.home,
              cells: [`${homeLabel(r.home)} / ${r.sku}`, r.onHand, r.reserved, availableOf(r), <Badge key="h" tone={h.tone} width={116}>{h.label}</Badge>, <Button key="s" variant="secondary" aria-haspopup="dialog" aria-label={`Open source for ${homeLabel(r.home)}`} style={{ minWidth: 160 }} onClick={() => onSource(`Open the ${homeLabel(r.home)} source`)}>Open source</Button>],
            };
          })}
        />
      </Panel>
      <TwoColumns>
        <Panel title="Every movement leaves a trace" subtitle="Incomplete rows are excluded from balance calculations" testId="movement-log">
          {movements.length ? (
            <FlatTable
              caption="Movement log"
              columns={[{ label: "Movement key", width: 260 }, { label: "Type", width: 230 }, { label: "Home", width: 130 }, { label: "Units", width: 156 }]}
              rows={movements.map((m) => ({ key: m.key, cells: [m.key, m.type, homeLabel(m.home), m.complete ? unitsLabel(m) : `Not counted · ${m.missing ?? "incomplete"}`] }))}
            />
          ) : (
            <p className={styles.note}>No movements for this home.</p>
          )}
          {excluded.length > 0 && <p className={styles.warn} role="status">{excluded.length} movement{excluded.length === 1 ? " is" : "s are"} excluded from the balances above until its receipt is recorded.</p>}
          <p className={styles.note}>Reservation release, cancellation and damaged return are distinct movement types.</p>
        </Panel>
        {showTransfer && (
          <Panel title={`Transfer · ${homeLabel(t.from)} → ${homeLabel(t.to)}`} subtitle={`Home transfer · ${STAGE_COPY[t.stage]}`} testId="transfer-panel">
            <span><Badge tone="violet" width={124}>{STAGE_BADGE[t.stage]}</Badge></span>
            <FactList label="Transfer" rows={[["Transfer key", t.key], ["Expected units", t.expectedUnits], ["Received units", t.receivedUnits.state === "known" ? String(t.receivedUnits.value) : "Not confirmed"]]} />
            <Meter percent={(100 * (STAGES.indexOf(t.stage) + 1)) / STAGES.length} label={`Transfer progress: ${STAGE_BADGE[t.stage]}, step ${STAGES.indexOf(t.stage) + 1} of ${STAGES.length}`} />
            <p className={styles.steps}>Requested → Dispatched → Received<br />If counts differ, hold the adjustment and review in the source.</p>
            {t.receivedUnits.state !== "known" && <span className="visually-hidden">{reasonText(t.receivedUnits)}</span>}
            <Button variant="secondary" aria-haspopup="dialog" style={{ minWidth: 230, alignSelf: "flex-start" }} onClick={() => onSource("Open the source transfer")}>Open source transfer</Button>
          </Panel>
        )}
      </TwoColumns>
    </>
  );
}

function TransferRequestButton({ res, data }: { res: ReadResponse<InventoryOverview>; data: InventoryOverview }) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [units, setUnits] = useState("");
  const [reason, setReason] = useState("");
  const action = useAction<{ from: string; to: string; units: number; reason: string }>();
  const blocked = blockedReason(res, "requestStockTransfer") === null ? null : "Blocked while the inventory mirror is behind its source.";
  const errors = action.error instanceof AdapterError ? (action.error.body.fieldErrors ?? {}) : {};
  const homes = [{ value: "", label: "Choose a home" }, ...HOMES.map((h) => ({ value: h, label: `${homeLabel(h)} · ${availableOf(data.rows.find((r) => r.home === h)!)} available` }))];
  const submit = () =>
    action.mutate(
      { operation: "requestApproval", actionKind: "requestStockTransfer", entityRefs: [], expectedVersion: data.version, approvalRef: null, manifestRef: null, payload: { from, to, units: units.trim() === "" ? Number.NaN : Number(units), reason } },
      { onSuccess: () => { setOpen(false); setFrom(""); setTo(""); setUnits(""); setReason(""); } },
    );
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" disabledReason={blocked} style={{ minWidth: 176 }} onClick={() => { action.reset(); setOpen(true); }}>Request transfer</Button>
      <Dialog open={open} title="Request a stock transfer" badge="Demo" onClose={() => setOpen(false)}>
        <p>This asks for a transfer of {data.sku} and moves nothing. On-hand changes only when the source records the movement and its receipt.</p>
        <form className={styles.form} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <SelectField label="From" value={from} onChange={setFrom} options={homes} error={errors.from ?? null} />
          <SelectField label="To" value={to} onChange={setTo} options={homes} error={errors.to ?? null} />
          <TextField label="Units" helpText="Whole units. Reserved units can't be transferred." value={units} onChange={setUnits} error={errors.units ?? null} />
          <TextField label="Reason" helpText="Operational reason only." value={reason} onChange={setReason} error={errors.reason ?? null} />
          {action.error && <ActionError error={action.error} />}
          <Button type="submit" loading={action.isPending}>Request transfer</Button>
          <Button variant="secondary" type="button" onClick={() => setOpen(false)}>Cancel</Button>
        </form>
      </Dialog>
    </>
  );
}
