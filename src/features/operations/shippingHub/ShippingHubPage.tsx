import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import type { ReadResponse } from "@/adapter/contract";
import { scopeKey, useScope } from "@/adapter/scope";
import { useView } from "@/adapter/useView";
import { Badge } from "@/components/Badge";
import { Button, LinkButton } from "@/components/Button";
import { Checkbox } from "@/components/Checkbox";
import { Drawer } from "@/components/Drawer";
import { EmptyState, SkeletonCard } from "@/components/EmptyState";
import { SelectField } from "@/components/Field";
import { Kpi, KpiRow } from "@/components/Kpi";
import { Page, PageHeader, Panel } from "@/components/PageKit";
import { ReadState } from "@/components/ReadState";
import { SearchField } from "@/components/Search";
import { SectionTabs } from "@/components/SectionTabs";
import { ViewError } from "@/components/ViewError";
import { FilterButton } from "@/features/acquisition/FilterButton";
import { SourceDialog } from "@/features/approvals/shared";
import { useLayout } from "../useLayout";
import { filterShipments, hubCounts, isLate, originLabel, pipelineLabels, reviewSelection, selectShipment } from "./selectors";
import { HUB_DEFAULT_FILTERS, type HubFilters, type HubShipment, type SelectedShipment, type ShippingHubData } from "./types";
import styles from "./ShippingHub.module.css";

const money = (minor: number | null, currency = "USD") => minor === null ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
const date = (value: string | null, time = false) => value ? new Date(value).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) }) : "Unknown";
const time = (value: string | null) => value ? new Date(value).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false }) : "Unknown";
const titleCase = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const safeTracking = (url: string | null) => { try { return url && new URL(url).protocol === "https:" ? url : null; } catch { return null; } };
function Strip({ title, tone = "violet", children }: { title: string; tone?: string; children: ReactNode }) {
  return <div className={styles.strip} data-tone={tone}><p>{title}</p><div>{children}</div></div>;
}
function Pair({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.pair}><dt>{title}</dt><dd>{children}</dd></div>;
}

/** One source read; demo and live scopes never share rows or local selections. */
export function ShippingHubPage() {
  const scope = useScope();
  return <ScopedHub key={JSON.stringify(scopeKey(scope))} />;
}

function ScopedHub() {
  const { adapter } = useScope();
  const [search] = useSearchParams();
  const scenario = search.get("scenario") ?? undefined;
  const query = useView<{ scenario?: string }, ShippingHubData>("shippingHub", scenario ? { scenario } : {});
  return <Page labelledBy="shipping-title" source="135:70">
    {query.isPending && <><h1 id="shipping-title">Shipping hub</h1><SkeletonCard label="Loading shipments…" /></>}
    {query.isError && <><h1 id="shipping-title">Shipping hub</h1><ViewError error={query.error} subject="Shipping hub" hasPriorData={Boolean(query.data)} onRetry={() => void query.refetch()} /></>}
    {query.data?.data && <HubBody data={query.data.data} res={query.data} demo={adapter.kind === "demo"} refreshing={query.isFetching} refresh={() => void query.refetch()} />}
    {query.data && !query.data.data && <><h1 id="shipping-title">Shipping hub</h1><EmptyState state="Empty" title="No shipment records"><p>The source returned no records for this scope.</p></EmptyState></>}
  </Page>;
}

function HubBody({ data, res, demo, refresh, refreshing }: { data: ShippingHubData; res: ReadResponse<ShippingHubData>; demo: boolean; refresh: () => void; refreshing: boolean }) {
  const [search, setSearch] = useSearchParams();
  const mobile = useLayout() === "mobile";
  const [clock, setClock] = useState(() => new Date().toISOString());
  useEffect(() => { if (demo) return; const timer = setInterval(() => setClock(new Date().toISOString()), 15000); return () => clearInterval(timer); }, [demo]);
  const now = demo ? data.observedAt : clock;
  const sourceHold = res.dataState === "stale" || res.dataState === "unavailable" || res.sourceFreshness.some(f => f.freshnessState === "error" || f.freshnessState === "neverSynced") ? "The source read is stale or unavailable. Refresh before reviewing labels." : Date.parse(data.reviewValidUntil) <= Date.parse(now) ? "The source review window expired. Refresh before reviewing labels." : null;
  const [selected, setSelected] = useState<SelectedShipment[]>([]);
  const initialized = useRef(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [safeguardsOpen, setSafeguardsOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [sourceTitle, setSourceTitle] = useState<string | null>(null);
  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      setSelected(data.initialSelection.flatMap(id => { const s = data.shipments.find(r => r.id === id); return s ? [selectShipment(s)] : []; }));
    }
  }, [data]);
  const filters = Object.fromEntries(Object.entries(HUB_DEFAULT_FILTERS).map(([k, fallback]) => [k, search.get(`ship-${k}`) ?? fallback])) as HubFilters;
  const matching = filterShipments(data.shipments, filters, data.observedAt);
  const count = hubCounts(matching, data.observedAt), total = hubCounts(data.shipments, data.observedAt);
  const baseCount = hubCounts(filterShipments(data.shipments, { ...filters, state: "all" }, data.observedAt), data.observedAt);
  const pageSize = mobile ? 3 : 10;
  const requestedPage = Math.max(1, Number(search.get("ship-page")) || 1);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(matching.length / pageSize)));
  const visible = matching.slice(0, page * pageSize);
  const selectedIds = new Set(selected.map(s => s.id));
  const selection = useMemo(() => reviewSelection(selected, data.shipments, now, sourceHold), [selected, data, now, sourceHold]);
  const detail = data.shipments.find(s => s.id === detailId);
  const staleFeeds = data.shipments.filter(s => s.freshness.some(f => f.field === "tracking" && f.state !== "current")).length;
  const readyReview = reviewSelection(matching.filter(s => s.pipeline === "ready").map(selectShipment), matching, now, sourceHold).eligible.length;
  const change = (key: keyof HubFilters, value: string) => { const next = new URLSearchParams(search); if (value === HUB_DEFAULT_FILTERS[key]) next.delete(`ship-${key}`); else next.set(`ship-${key}`, value); next.delete("ship-page"); setSearch(next); };
  const href = (key: keyof HubFilters, value: string) => { const p = new URLSearchParams(search); p.set("view", "hub"); if (value === HUB_DEFAULT_FILTERS[key]) p.delete(`ship-${key}`); else p.set(`ship-${key}`, value); p.delete("ship-page"); return `/operations?${p}`; };
  const toggle = (s: HubShipment, checked: boolean) => setSelected(previous => checked ? [...previous.filter(p => p.id !== s.id), selectShipment(s)] : previous.filter(p => p.id !== s.id));
  const recipientTabs = [{ label: `All · ${total.total}`, to: href("recipient", "all"), current: filters.recipient === "all", width: mobile ? 80 : 130 }, { label: mobile ? "Customers" : `Customers · ${total.customers}`, to: href("recipient", "customer"), current: filters.recipient === "customer", width: mobile ? 120 : 150 }, { label: mobile ? "Creators" : `Creators · ${total.creators}`, to: href("recipient", "creator"), current: filters.recipient === "creator", width: mobile ? 118 : 150 }];
  const options = (key: "location" | "carrier" | "owner") => [{ value: "all", label: key === "location" ? "All homes" : "all" }, ...[...new Set(data.shipments.map(s => s[key]).filter((s): s is string => s !== null))].map(value => ({ value, label: value }))];
  const facets = [
    { key: "purpose", name: "Purpose", options: [{ value: "all", label: "all" }, ...["sale", "sample", "replacement", "reward"].map(value => ({ value, label: titleCase(value) }))] },
    { key: "location", name: "Home", options: options("location") }, { key: "carrier", name: "Carrier", options: options("carrier") }, { key: "owner", name: "Owner", options: options("owner") },
    { key: "date", name: "Date", options: [{ value: "all", label: "all" }, { value: "week", label: "Last 7 days" }, { value: "late", label: "Past carrier ETA" }] },
  ] as const;
  const pipelineTabs = ([['all', 'All'], ['ready', 'Ready'], ['label', 'Labels'], ['transit', 'In transit'], ['delivered', 'Delivered'], ['exceptions', 'Exceptions'], ['returns', 'Returns']] as const).map(([key, label]) => ({ label: `${label} · ${key === "all" ? baseCount.total : baseCount[key]}`, to: href("state", key), current: filters.state === key, width: ({ all: 108, ready: 145, label: 145, transit: 170, delivered: 170, exceptions: 180, returns: 150 })[key] }));
  const openRow = (s: HubShipment) => setDetailId(s.id);
  return <div className={styles.hub}>
    {mobile ? <><h1 id="shipping-title" className={styles.title}>Shipping hub</h1><Badge tone="violet" width={200} testId={demo ? "shipping-demo-banner" : undefined}>{demo ? "DEMO · " : ""}{total.total} shipments</Badge><p className={styles.small}>{total.customers} customers · {total.creators} creators<br />Snapshot {time(data.observedAt)} PT · {staleFeeds} feed{staleFeeds === 1 ? "" : "s"} stale</p></> :
      <div className={styles.header}><PageHeader id="shipping-title" title="Shipping hub" subtitle="Customer orders, creator samples and replacements — one dispatch queue." titleWidth={880}><Badge tone="violet" width={176}>{demo ? "DEMO · " : ""}{total.total} shipments</Badge><Button className={styles.reviewButton} onClick={() => setReviewOpen(true)} disabledReason={!selected.length ? "Select one or more shipments to review." : null} reasonFor="selection-help">Review {selected.length} selected</Button></PageHeader></div>}
    {!mobile && <SectionTabs label="Operations sections" gap={8} tabs={[{ label: "Overview", to: "/operations", width: 160 }, { label: "Orders", to: "/operations?view=orders", width: 160 }, { label: "Shipping hub", to: "/operations?view=hub", current: true, width: 160 }, { label: "Stock", to: "/inventory", width: 160 }, { label: "Support", to: "/support/cases/TEST-ISS-021", width: 160 }]} />}
    <ReadState res={res} subject="Shipping hub" only={["partial", "stale"]} />
    {!mobile && <Strip title={`${demo ? "Demo data · " : ""}source snapshot ${date(data.observedAt, true)} PT`}>{data.sourceLabel} · {res.coverage.observedCount ?? "Unknown"} of {res.coverage.expectedCount ?? "unknown"} records mapped · {staleFeeds} tracking feed{staleFeeds === 1 ? "" : "s"} stale. Exceptions overlap pipeline states; they are not extra shipments.</Strip>}
    {!mobile && <KpiRow><Kpi label="Recipients" context={`${count.customers} customers · ${count.creators} creators`} testId="hub-recipients">{count.total}</Kpi><Kpi label="Ready to ship" context={`${readyReview} reviewable · ${count.ready - readyReview} held`} testId="hub-ready">{count.ready}</Kpi><Kpi label="Late" context="Carrier ETA passed" testId="hub-late">{count.late}</Kpi><Kpi label="Needs action" context={`${count.exceptions} exceptions · ${count.returns} return${count.returns === 1 ? "" : "s"}`} testId="hub-needs-action">{count.needsAction}</Kpi></KpiRow>}
    <div className={styles.filters}>
      <div className={styles.filterTop}><SectionTabs label="Shipment recipients" tabs={recipientTabs} gap={mobile ? 4 : 12} /><SearchField label="Search shipments" value={filters.query} onChange={v => change("query", v)} placeholder={mobile ? "Search reference or tracking" : "Search reference, tracking or creator"} width={mobile ? "100%" : 550} />{!mobile && <FilterButton name="Home" bare title="Choose dispatch location" value={filters.location} options={options("location")} onChange={v => change("location", v)} width={160} />}</div>
      {mobile ? <div className={styles.mobileActions}><Button variant="secondary" onClick={() => setFiltersOpen(true)}>Filter shipments</Button><Button variant="secondary" onClick={() => setFiltersOpen(true)}>{filters.state === "all" ? "All states" : titleCase(filters.state)} · {count.total}</Button></div> : <div className={styles.filterBottom}>{facets.filter(f => f.key !== "location").map(f => <FilterButton key={f.key} name={f.name} title={`Filter ${f.name.toLowerCase()}`} value={filters[f.key]} options={[...f.options]} onChange={v => change(f.key, v)} width={170} />)}<p className={styles.small}>Sort: exceptions → oldest ready</p></div>}
    </div>
    {mobile ? <Strip title={`${count.exceptions} exceptions · ${count.returns} return${count.returns === 1 ? "" : "s"}`} tone="warning">Prioritized first. Exceptions overlap shipment states.</Strip> : <SectionTabs label="Shipment pipeline" tabs={pipelineTabs} gap={8} />}
    {matching.length === 0 ? <EmptyState state="Empty" title="No matching shipments"><p>The loaded records contain no matches. Clear filters to see the full source read.</p><Button variant="secondary" onClick={() => { const next = new URLSearchParams(search); for (const k of Object.keys(HUB_DEFAULT_FILTERS)) next.delete(`ship-${k}`); setSearch(next); }}>Clear shipping filters</Button></EmptyState> : mobile ? <ul className={styles.cards}>{visible.map(s => <li key={s.id} className={styles.card}>
      <div className={styles.cardHeading}><Checkbox label={<span className="visually-hidden">Select {s.id}</span>} checked={selectedIds.has(s.id)} onChange={v => toggle(s, v)} /><h2>{titleCase(s.recipient.type)} · {s.recipient.display}</h2></div>
      <p className={styles.small}>{originLabel(s)} · {titleCase(s.purpose)}</p><p className={styles.state}>{pipelineLabels[s.pipeline].toUpperCase()}<br />{statusNote(s)}</p><p className={styles.small}>{s.sku} × {s.quantity} · Home {s.location} · {s.owner}</p><p className={styles.small}>{carrierLines(s, data.observedAt).join(" · ")}</p><p className={styles.small}>{costLines(s, data.observedAt).join(" · ")}</p><Button variant="secondary" onClick={() => openRow(s)}>{s.exception ? s.pipeline === "ready" ? "Resolve address hold" : "Review exception" : s.pipeline === "ready" ? "Review label" : "View shipment"}</Button>
    </li>)}</ul> : <div className={styles.tableScroll}><table className={styles.table} aria-label="Shared shipment queue"><colgroup>{[36,164,128,140,178,184,158,308].map((w, i) => <col key={i} style={{ width: `${100 * w / 1296}%` }} />)}</colgroup><thead><tr><th><Checkbox label={<span className="visually-hidden">Select visible shipments</span>} checked={visible.length > 0 && visible.every(s => selectedIds.has(s.id))} mixed={visible.some(s => selectedIds.has(s.id)) && !visible.every(s => selectedIds.has(s.id))} onChange={checked => setSelected(prior => [...prior.filter(p => !visible.some(s => s.id === p.id)), ...(checked ? visible.map(selectShipment) : [])])} /></th>{["Recipient / origin", "Product / home", "Readiness", "Shipment state", "Carrier / timing", "Cost / freshness", "Next action"].map(h => <th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{visible.map(s => <tr key={s.id} data-tone={s.exception ? s.pipeline === "ready" ? "warning" : "danger" : undefined} data-testid={`shipment-${s.id}`}>
      <td><Checkbox label={<span className="visually-hidden">Select {s.id}</span>} checked={selectedIds.has(s.id)} onChange={v => toggle(s, v)} /></td><th scope="row"><Lines lines={[`${titleCase(s.recipient.type)} · ${s.recipient.display}`, originLabel(s), titleCase(s.purpose)]} /></th><td><Lines lines={[`${s.sku} × ${s.quantity}`, `Home ${s.location} · ${s.owner}`]} /></td><td><Lines lines={[s.readiness === "dispatched" ? s.pipeline === "delivered" ? "Delivered" : "Dispatched" : s.pipeline === "returns" ? "Return in transit" : s.reservationRef ? "Stock reserved" : "Reservation missing", readinessNote(s)]} /></td><td><Lines lines={[pipelineLabels[s.pipeline].toUpperCase(), statusNote(s)]} /></td><td><Lines lines={carrierLines(s, data.observedAt)} /></td><td><Lines lines={costLines(s, data.observedAt)} /></td><td><Button variant="ghost" className={styles.rowAction} onClick={() => openRow(s)}>{s.nextAction}</Button><p>{s.pipeline === "label" ? "Record dispatch intent" : s.pipeline === "delivered" && s.postingClock ? `Posting due ${date(s.postingClock.dueAt)}` : s.pipeline === "returns" ? "No automatic restock" : s.exception ? s.pipeline === "ready" ? "Label review blocked" : "No automatic refund" : "Approval still required"}</p></td>
    </tr>)}</tbody></table></div>}
    <div className={styles.pagination}><p className={styles.small} role="status">Showing {visible.length} of {matching.length}{demo ? " demo" : ""} shipments{matching.length !== data.shipments.length ? ` · ${data.shipments.length} loaded overall` : ""}{res.coverage.complete === false ? " · incomplete source coverage" : ""}. {!mobile && `Pipeline totals: ${count.ready} ready + ${count.label} label + ${count.transit} in transit + ${count.delivered} delivered + ${count.returns} return = ${count.total}.`}</p>
    {visible.length < matching.length && <Button className={styles.moreButton} variant="ghost" onClick={() => { const p = new URLSearchParams(search); p.set("ship-page", String(page + 1)); setSearch(p); }}>Load more shipments</Button>}</div>
    {!mobile && <Strip title={`${selected.length} selected · ${selection.eligible.length} reviewable · ${selection.blocked} blocked`} tone={selection.stale ? "warning" : "violet"}><span id="selection-help">{selection.stale ? "A selected record changed. Reselect the changed rows after reviewing the refreshed evidence." : sourceHold ?? "Review does not purchase postage. Each row retains its own stock, address, approval and cost bounds."}</span></Strip>}
    {mobile && <><span id="selection-help" className="visually-hidden">Select shipments to review. Review never buys postage.</span><Button onClick={() => setReviewOpen(true)} disabledReason={!selected.length ? "Select shipments to review." : null} reasonFor="selection-help">Review selected labels</Button></>}
    {!mobile && <div className={styles.bottom}><Panel title="Stock by dispatch home" headingId="hub-stock" note={`Available = physical on hand − reserved.${demo ? " Demo OC6 units." : ""}`}><div className={styles.stack}>{data.stock.map(s => <p key={`${s.location}-${s.sku}`}>{s.location} · {s.onHand ?? "Unknown"} on hand − {s.reserved ?? "unknown"} reserved = {s.onHand === null || s.reserved === null ? "unknown" : s.onHand - s.reserved} available</p>)}</div><LinkButton variant="secondary" to="/inventory">Open stock workspace</LinkButton></Panel><Panel title="Review before dispatch" headingId="hub-guard"><p className={styles.bodyMuted}>Label proposals carry service, quantity and cost bounds. Slack approval is recorded in Linear before execution. This view never buys postage.</p><Button variant="secondary" onClick={() => setSafeguardsOpen(true)}>View blocked states</Button></Panel></div>}
    {!mobile && <div className={styles.refreshRow}><Button variant="ghost" loading={refreshing} onClick={refresh}>Refresh source read</Button><p className={styles.small}>{demo ? "Synthetic data; refresh contacts no provider." : "Last verified source observations; refresh does not execute a shipping action."}</p></div>}
    <div className={styles.drawerScope}><Drawer open={Boolean(detail)} title={detail?.recipient.type === "creator" ? "Creator shipment" : detail?.exception ? "Shipping exception" : "Shipment details"} onClose={() => setDetailId(null)}>{detail && <ShipmentDetail row={detail} now={data.observedAt} refresh={refresh} refreshing={refreshing} openSource={setSourceTitle} review={() => { if (!selectedIds.has(detail.id)) toggle(detail, true); setDetailId(null); setReviewOpen(true); }} />}</Drawer></div>
    <div className={styles.reviewScope}><Drawer open={reviewOpen} title="Review label proposals" onClose={() => { setReviewOpen(false); setDraftOpen(false); }}><Badge tone="warning" width={232}>{demo ? "SIMULATED · no purchase" : "Review only · no purchase"}</Badge><h3 className={styles.heading}>{selected.length} selected · {selection.eligible.length} reviewable · {selection.blocked} blocked</h3>{selection.items.map(item => <Strip key={item.id} title={`${item.row ? originLabel(item.row) : item.id} · ${item.reasons.length ? "blocked" : "reviewable"}`} tone={item.reasons.length ? "warning" : "success"}>{item.reasons.length ? item.reasons.join(" ") : `${item.row!.quantity} ${item.row!.sku} · ${item.row!.location} · verified address reference · ${item.row!.quote!.service} · ${money(item.row!.quote!.cost.minorUnits, item.row!.quote!.cost.currency)} quote · ${money(item.row!.quote!.maxCost.minorUnits, item.row!.quote!.maxCost.currency)} maximum · expires ${date(item.row!.quote!.expiresAt, true)} PT.`}</Strip>)}<dl><Pair title={`Quoted subtotal for ${selection.eligible.length} eligible label${selection.eligible.length === 1 ? "" : "s"}`}>{selection.quotedMinorUnits === null ? "No single-currency subtotal is available." : `${money(selection.quotedMinorUnits, selection.currency!)} · maximum ${money(selection.maximumMinorUnits, selection.currency!)}. Not a postage receipt.`}</Pair></dl><Strip title="Purchase is blocked">The app can prepare a draft. A named authorized Slack decision must be durably recorded in Linear before the exact action can execute. Label execution integration is pending.</Strip><Button onClick={() => setDraftOpen(true)} disabledReason={!selection.eligible.length || selection.stale ? "A current, reviewable selection is required." : null}>Preview approval draft</Button><Button variant="secondary" disabledReason="No verified label execution contract is connected.">Purchase unavailable</Button>{draftOpen && !selection.stale && !sourceHold && <section aria-label="Approval draft preview" className={styles.draft}><h3 className={styles.heading}>Draft preview · not submitted</h3>{selection.eligible.map(({ row }) => <dl key={row!.id}><Pair title="Exact action version">{row!.id} · {row!.version}</Pair><Pair title="Bounded parcel">{row!.sku} × {row!.quantity} · {row!.package!.weightGrams} g · {row!.package!.lengthCm} × {row!.package!.widthCm} × {row!.package!.heightCm} cm</Pair><Pair title="Authorization evidence">Slack: {row!.approval?.slackDecisionRef ?? "pending"} · Linear: {row!.approval?.linearReceiptRef ?? "pending"}</Pair></dl>)}<p className={styles.small}>Address, package, service, allocation or price changes invalidate this draft. No approval request was sent.</p></section>}<p className={styles.small}>Uncertain provider outcome? Reconcile before retrying. Print/reprint reuses an existing label.</p></Drawer></div>
    <Drawer open={filtersOpen} title="Filter shipments" onClose={() => setFiltersOpen(false)}><SelectField label="Recipient" value={filters.recipient} onChange={v => change("recipient", v)} options={[{ value: "all", label: "All recipients" }, { value: "customer", label: "Customers" }, { value: "creator", label: "Creators" }]} />{facets.map(f => <SelectField key={f.key} label={f.name} value={filters[f.key]} onChange={v => change(f.key, v)} options={[...f.options]} />)}<SelectField label="Pipeline" value={filters.state} onChange={v => change("state", v)} options={[{ value: "all", label: "All states" }, ...Object.entries(pipelineLabels).map(([value, label]) => ({ value, label })), { value: "exceptions", label: "Exceptions (overlaps pipeline)" }]} /><Button onClick={() => setFiltersOpen(false)}>Show {matching.length} shipments</Button>{mobile && <Button variant="secondary" loading={refreshing} onClick={refresh}>Refresh source read</Button>}</Drawer>
    <Drawer open={safeguardsOpen} title="Shipping safeguards" onClose={() => setSafeguardsOpen(false)}>{safeguards.map(([title, message]) => <Strip key={title} title={title}>{message}</Strip>)}</Drawer>
    <SourceDialog open={sourceTitle !== null} title={sourceTitle ?? "Source record"} url={null} onClose={() => setSourceTitle(null)} />
  </div>;
}

function Lines({ lines }: { lines: string[] }) { return <>{lines.map((line, i) => <p key={i}>{line}</p>)}</>; }
function readinessNote(s: HubShipment) { return s.pipeline === "label" ? "Ready for handoff" : s.readiness === "dispatched" ? s.pipeline === "delivered" ? "No stock hold" : "Reservation consumed" : s.readiness === "return-hold" ? "Replacement held" : s.addressVerified ? "Address verified" : "Address unverified"; }
function statusNote(s: HubShipment) { return s.label.state === "uncertain" ? "Unknown label outcome" : s.exception ? s.exception.kind === "address-pending" ? "Address hold" : s.exception.kind === "carrier-delay" ? "Carrier exception" : titleCase(s.exception.kind.replaceAll("-", " ")) : s.pipeline === "label" ? "Not carrier accepted" : s.pipeline === "delivered" ? "Delivery verified" : s.pipeline === "returns" ? "Inspection pending" : s.pipeline === "ready" ? "Reviewable" : "Carrier accepted"; }
function carrierLines(s: HubShipment, now: string) { return [s.trackingRef ? `${s.carrier ?? "Unknown carrier"} · …${s.trackingRef}` : s.quote?.service ?? "Not booked", s.deliveredAt ? `Delivered ${date(s.deliveredAt)}` : s.eta ? `${s.pipeline === "returns" ? "Return " : ""}ETA ${date(s.eta)}${isLate(s, now) ? " · late" : ""}` : s.pipeline === "ready" && s.shipBy ? `Ship-by ${date(s.shipBy)}` : "ETA not available", ...(s.pipeline === "label" ? [] : [s.deliveredAt ? "Carrier event" : s.etaSource ?? "Source unknown"])]; }
function costLines(s: HubShipment, now: string) {
  const f = s.freshness.find(x => x.field === "tracking");
  if (s.quote) return [`${money(s.quote.cost.minorUnits, s.quote.cost.currency)} quote`, Date.parse(s.quote.expiresAt) <= Date.parse(now) ? `Expired ${date(s.quote.expiresAt, true)} PT` : `Valid until ${time(s.quote.expiresAt)} PT`, `Observed ${time(s.quote.observedAt)} PT`];
  if (!s.label.cost) return ["Quote unavailable", `Ledger ${time(s.freshness.find(x => x.field === "inventory")?.observedAt ?? null)} PT`];
  const price = `${money(s.label.cost.minorUnits, s.label.cost.currency)} ${s.pipeline === "returns" ? "return label" : "actual"}`;
  if (f?.state === "stale") return [price, s.lastEventAt ? `Last event ${Math.max(0, Math.round((Date.parse(now) - Date.parse(s.lastEventAt)) / 3600000))}h ago` : "No carrier event", "STALE"];
  return [price, s.pipeline === "label" ? `Label event ${time(s.lastEventAt)} PT` : `Observed ${time(f?.observedAt ?? null)} PT`];
}

function ShipmentDetail({ row: s, now, refresh, refreshing, openSource, review }: { row: HubShipment; now: string; refresh: () => void; refreshing: boolean; openSource: (title: string) => void; review: () => void }) {
  return <div className={styles.detail}>
    <Badge tone={s.exception ? "danger" : s.pipeline === "delivered" ? "success" : "violet"} width={180}>{s.exception ? "Needs attention" : pipelineLabels[s.pipeline]}</Badge><h3 className={styles.detailTitle}>{s.recipient.type === "creator" ? s.recipient.display : originLabel(s)}</h3>
    <dl className={styles.stack}><Pair title="Origin">{originLabel(s)} · {titleCase(s.purpose)}{s.origin.kind === "allocation" ? " · no commerce order" : ""}</Pair><Pair title="Recipient and dispatch">{titleCase(s.recipient.type)} {s.recipient.display} · Home {s.location} / {s.owner}</Pair><Pair title={`Parcel ${s.parcelIndex} of ${s.parcelCount}`}>{s.sku} × {s.quantity} · {s.parcelId} · {s.remainingUnits} units remaining across this origin</Pair><Pair title="Stock reservation">{s.reservationRef ?? "No current reservation"} · {readinessNote(s)}</Pair><Pair title="Measured package">{s.package ? `${s.package.weightGrams} g · ${s.package.lengthCm} × ${s.package.widthCm} × ${s.package.heightCm} cm · measured ${date(s.package.measuredAt, true)}` : "Weight/dimensions unknown; label review held"}</Pair></dl>
    {s.exception && <Strip title={s.label.state === "uncertain" ? "Unknown label outcome" : "Shipment needs attention"} tone="danger">{s.exception.message}</Strip>}
    <dl className={styles.stack}><Pair title="Latest verified carrier state">{s.carrierState.replaceAll("-", " ")} · {carrierLines(s, now).join(" · ")}</Pair><Pair title="Postage">{costLines(s, now).join(" · ")}</Pair><Pair title="Label receipt">{s.label.transactionRef ?? "No transaction receipt"} · {s.label.receiptRef ?? "No authoritative receipt"}</Pair></dl>
    {s.origin.kind === "replacement" && <dl><Pair title="Replacement parent">{s.origin.parentOriginRef} · {s.origin.parentShipmentId}. This parcel retains a separate reservation and action approval.</Pair></dl>}
    {s.recipient.type === "creator" && <><h3 className={styles.heading}>Creator handoff</h3>{s.postingClock ? <dl className={styles.stack}><Pair title="Accepted brief">{s.postingClock.brief} · terms {s.postingClock.acceptedTermsVersion}</Pair><Pair title="Posting deadline · read-only">{date(s.postingClock.dueAt, true)} · {s.postingClock.timezone}<br />Source: {s.postingClock.recordRef} · observed {date(s.postingClock.observedAt, true)}</Pair></dl> : <p className={styles.small}>Posting deadline not started or not verified. Only authoritative delivery under accepted terms can start the posting clock.</p>}<p className={styles.small}>A label, reprint or unrelated replacement cannot restart the posting clock.</p><Button variant="secondary" onClick={() => openSource("Open accepted creator collaboration")}>Open collaboration</Button></>}
    {s.timeline.length > 0 && <><h3 className={styles.heading}>Shipment timeline</h3><ol className={styles.timeline}>{[...new Map(s.timeline.map(e => [e.id, e])).values()].map(e => <li key={e.id}>{date(e.occurredAt, true)} · {e.title}<span className={styles.small}>Evidence {e.evidenceRef}</span></li>)}</ol></>}
    {s.label.state === "uncertain" ? <Button variant="secondary" onClick={() => openSource("Reconcile existing label transaction")}>Reconcile label outcome</Button> : s.pipeline === "ready" ? <Button onClick={review}>Review label proposal</Button> : s.pipeline === "label" ? <><Button variant="secondary" onClick={() => openSource("Open existing purchased label")}>Print / reprint existing label</Button><Button variant="secondary" disabledReason="Dispatch intent needs a verified fulfillment action contract.">Record dispatch intent</Button></> : <Button loading={refreshing} onClick={refresh}>Refresh source evidence</Button>}
    {safeTracking(s.trackingUrl) ? <a className={styles.external} href={safeTracking(s.trackingUrl)!} target="_blank" rel="noreferrer">Open native tracking</a> : <Button variant="ghost" onClick={() => openSource("Open native tracking")}>Open native tracking</Button>}
    {s.recipient.type === "customer" && <Button variant="secondary" onClick={() => openSource(s.pipeline === "returns" ? "Open return case" : "Open customer support case draft")}>{s.pipeline === "returns" ? "Open return case" : "Open support case draft"}</Button>}
    <Strip title="Address access restricted">Open the protected source only with the required role. No address or health details are mirrored here.</Strip>
  </div>;
}

const safeguards = [
  ["Unknown label purchase", "A timed-out request may already have charged. Reconcile the transaction and request key before retrying."],
  ["Unavailable stock / unapproved sample", "No valid reservation or accepted allocation means label review remains blocked."],
  ["Stale quote / changed parcel", "Changed package, address, service or price needs a fresh quote and exact approval."],
  ["Source outage / permission denied", "Retain labeled last-known observations only while authorized. Unknown data is never delivery or zero cost."],
  ["Partial delivery / replacement", "Track every parcel independently. Only the accepted sample parcel affects its posting clock."],
  ["Return and void are different", "A label void does not move on-hand stock. Release only verified unshipped reservations; restock physically returned goods after inspection."],
] as const;
