import { createHmac } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { freshnessOf, observed, operand, ratio, sumOperands, type FreshnessState, type Measure, type Operand } from "./metrics.ts";
import {
  AnalyticsError, FRESHNESS_LIMIT_MS, adPlatformsSnapshotSchema, orderChannels, ordersSnapshotSchema, sessionsSnapshotSchema, supportSnapshotSchema, timezoneSchema,
  type AdFeed, type AdPlatformsSnapshot, type AnalyticsSourceKey, type AnalyticsSources, type OrderChannel, type OrderFeed, type OrderRow, type OrdersSnapshot,
  type ReportingWindow,
} from "./sources.ts";

/** THO-293 views this module serves from trusted sources. */
export const analyticsViewKeys = ["overviewSummary", "attribution", "paidMedia", "customerJourney"] as const;
export type AnalyticsViewKey = typeof analyticsViewKeys[number];
/** THO-293 views with no server projection yet. They answer a typed INTEGRATION_PENDING, never demo data. */
export const pendingAnalyticsViewKeys = ["launchSnapshot", "launchControl", "launchReconciliation", "campaignFunnel", "metricDictionary"] as const;
export const isAnalyticsViewKey = (key: unknown): key is AnalyticsViewKey => (analyticsViewKeys as readonly unknown[]).includes(key);
export const isPendingAnalyticsViewKey = (key: unknown): key is typeof pendingAnalyticsViewKeys[number] => (pendingAnalyticsViewKeys as readonly unknown[]).includes(key);

/* ---------- Filters and period (D-11) ---------- */

const PRESET_DAYS = { last7Days: 7, last30Days: 30, last90Days: 90 } as const;
const presetSchema = z.enum(["last7Days", "last30Days", "last90Days"]);
const plainFilters = z.object({ preset: presetSchema.optional() }).strict();
export const analyticsFilters = {
  overviewSummary: plainFilters, attribution: plainFilters, customerJourney: plainFilters,
  paidMedia: z.object({ preset: presetSchema.optional(), rights: z.enum(["all", "cleared", "expiring", "notGranted", "unknown"]).default("all"),
    platform: z.enum(["all", "meta", "tiktok"]).default("all") }).strict(),
} satisfies Record<AnalyticsViewKey, z.ZodTypeAny>;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}, "A real calendar date is required.");
/** An explicit ISO date range (inclusive) on event time. Instants, observation-time periods and reversed ranges are refused. */
export const analyticsPeriodSchema = z.object({ startAt: isoDay, endAt: isoDay, timezone: timezoneSchema, basis: z.literal("eventTime") }).strict()
  .refine(p => p.startAt <= p.endAt, "Reversed period.").nullable();
const MAX_WINDOW_DAYS = 366;

const DAY_MS = 86_400_000;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const dayFormats = new Map<string, Intl.DateTimeFormat>();
/** The calendar day of an instant in a reporting timezone (YYYY-MM-DD). */
export function localDay(instant: number, timezone: string) {
  let format = dayFormats.get(timezone);
  if (!format) dayFormats.set(timezone, format = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return format.format(new Date(instant));
}
export function daysOf(window: ReportingWindow): string[] {
  const days: string[] = [];
  for (let d = window.start; d <= window.end; d = addDays(d, 1)) days.push(d);
  return days;
}
const shortDay = (day: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
export const periodLabel = (w: ReportingWindow) => w.start.slice(0, 4) === w.end.slice(0, 4)
  ? `${shortDay(w.start)} – ${shortDay(w.end)}, ${w.end.slice(0, 4)}` : `${shortDay(w.start)}, ${w.start.slice(0, 4)} – ${shortDay(w.end)}, ${w.end.slice(0, 4)}`;

export function resolveWindow(period: unknown, preset: keyof typeof PRESET_DAYS | undefined, now: number, timezone: string): ReportingWindow {
  const parsed = analyticsPeriodSchema.safeParse(period);
  if (!parsed.success) throw new AnalyticsError("VALIDATION_FAILED", 400, "The period must be an event-time ISO date range or null.");
  if (!Number.isFinite(now)) throw new AnalyticsError("SOURCE_TIME_UNVERIFIED", 503, "The service clock could not be verified.");
  const p = parsed.data;
  if (p && preset) throw new AnalyticsError("VALIDATION_FAILED", 400, "Send a period or a preset, not both.");
  if (p) {
    const today = localDay(now, p.timezone);
    if (p.endAt > today) throw new AnalyticsError("VALIDATION_FAILED", 400, "The period cannot end in the future.");
    if ((Date.parse(p.endAt) - Date.parse(p.startAt)) / DAY_MS + 1 > MAX_WINDOW_DAYS) throw new AnalyticsError("VALIDATION_FAILED", 400, "The period is longer than 366 days.");
    return { start: p.startAt, end: p.endAt, timezone: p.timezone };
  }
  const end = localDay(now, timezone);
  return { start: addDays(end, -(PRESET_DAYS[preset ?? "last30Days"] - 1)), end, timezone };
}

/* ---------- Public shapes ---------- */

type SourceRef = { source: string; accountId: string; sourceId: null; canonicalId: null; url: null; identityState: "resolved"; provenanceRef: string };
type PV<T> = { state: "known" | "unknown" | "notApplicable"; value: T | null; reasonCode: string | null; evidenceRefs: string[]; sourceRef: SourceRef | null;
  occurredAt: null; sourceUpdatedAt: string | null; observedAt: string };
type Money = { minorUnits: number; currency: "USD" };
export type SourceFreshnessEntry = { sourceRef: SourceRef; lastSourceSuccessAt: string | null; observedAt: string | null; mirroredAt: string | null;
  staleReasonCode: string | null; freshnessState: FreshnessState };
export type AnalyticsReadResult = { data: Record<string, unknown>; version: string; dataState: "ready" | "partial" | "stale";
  sourceFreshness: SourceFreshnessEntry[]; coverage: { expectedCount: number; observedCount: number; missingCount: number; complete: boolean; reasonCodes: string[] } };

const REPORTING_CURRENCY = "USD";
const CHANNEL_VIEW: Record<OrderChannel, { key: "shopify" | "tiktok"; label: string }> = { shopify: { key: "shopify", label: "Shopify" }, tiktokShop: { key: "tiktok", label: "TikTok Shop" } };
const PLATFORM_LABEL = { meta: "Meta", tiktok: "TikTok" } as const;

type Options = { scope: OperationsScope; secret: string; sources?: AnalyticsSources; now?: () => number; timezone?: string };
type Parser<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };
type Observation<T> = { kind: "unconfigured" } | { kind: "unavailable" } | { kind: "observed"; snapshot: T };

/** Read-only projections. Nothing here writes a provider, exports a file, approves or dispatches anything. */
export function createAnalyticsReader(options: Options) {
  const { scope, secret } = options, sources = options.sources ?? {}, clock = options.now ?? Date.now;
  const timezone = timezoneSchema.parse(options.timezone ?? "UTC");
  if (secret.length < 32) throw new Error("Analytics reference key must be private and at least 32 characters.");
  /** Provider feed, campaign and asset IDs are replaced by scoped one-way aliases before they leave the server. */
  const alias = (kind: string, value: string) => `${kind}-` + createHmac("sha256", secret).update(JSON.stringify(["analytics.v1", scope, kind, value])).digest("hex").slice(0, 24);
  const sourceRef = (source: string, provenance: string): SourceRef => ({ source, accountId: scope.accountId, sourceId: null, canonicalId: null, url: null, identityState: "resolved", provenanceRef: provenance });

  async function observe<T extends { scope: unknown; window: ReportingWindow }>(key: AnalyticsSourceKey, schema: Parser<T>, window: ReportingWindow, now: number): Promise<Observation<T>> {
    const reader = sources[key];
    if (!reader) return { kind: "unconfigured" };
    let raw: unknown;
    try { raw = await reader({ scope: { ...scope }, window: { ...window } }); }
    catch (error) {
      if (error instanceof AnalyticsError && (error.status === 401 || error.status === 403)) throw new AnalyticsError("SOURCE_SCOPE_DENIED", 403, "The source refused this scope.");
      return { kind: "unavailable" };
    }
    if (raw === null || raw === undefined) return { kind: "unavailable" };
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AnalyticsError("ANALYTICS_SOURCE_INVALID", 502, `The ${key} source returned a record that could not be verified. Nothing is shown as zero.`);
    const snapshot = parsed.data;
    if (digest(snapshot.scope) !== digest(scope)) throw new AnalyticsError("SOURCE_SCOPE_DENIED", 403, "The source answered for a different scope.");
    if (digest(snapshot.window) !== digest(window)) throw new AnalyticsError("ANALYTICS_SOURCE_INVALID", 502, `The ${key} source answered for a different period.`);
    const feeds = "feeds" in snapshot ? snapshot.feeds as { observedAt: string }[] : [(snapshot as unknown as { feed: { observedAt: string } }).feed];
    if (feeds.some(f => Date.parse(f.observedAt) > now)) throw new AnalyticsError("ANALYTICS_SOURCE_INVALID", 502, `The ${key} source reported an observation in the future.`);
    return { kind: "observed", snapshot };
  }

  function freshnessEntry(key: AnalyticsSourceKey, label: string, feed: { feedRef: string; observedAt: string; lastSuccessAt: string | null; syncState: "ok" | "noChange" | "error"; coverage: "complete" | "partial" } | null,
    now: number, extra: { unavailable?: boolean; missing?: boolean; mirror?: boolean } = {}): SourceFreshnessEntry {
    const verdict = extra.missing ? { freshnessState: "neverSynced" as const, staleReasonCode: "SOURCE_FEED_MISSING" } : freshnessOf(key, feed, now, FRESHNESS_LIMIT_MS[key], extra.unavailable);
    return { sourceRef: sourceRef(label, feed ? alias("feed", feed.feedRef) : `${label}:not-connected`), lastSourceSuccessAt: feed?.lastSuccessAt ?? null,
      observedAt: feed?.observedAt ?? null, mirroredAt: extra.mirror ? feed?.lastSuccessAt ?? null : null, ...verdict };
  }
  const notConnected = (key: AnalyticsSourceKey, observation: Observation<unknown>, now: number) =>
    freshnessEntry(key, key, null, now, { unavailable: observation.kind === "unavailable" });

  /* ---------- Orders ---------- */

  type ChannelFacts = { channel: OrderChannel; feed: OrderFeed | null; rows: OrderRow[]; known: boolean; reason: string | null; usd: boolean; mismatches: number; freshness: SourceFreshnessEntry[] };
  function orderFacts(observation: Observation<OrdersSnapshot>, window: ReportingWindow, now: number) {
    const reasons = new Set<string>();
    if (observation.kind !== "observed") {
      reasons.add(observation.kind === "unconfigured" ? "ORDERS_SOURCE_UNCONFIGURED" : "ORDERS_SOURCE_UNAVAILABLE");
      const entry = notConnected("orders", observation, now);
      return { channels: [] as ChannelFacts[], reasons, freshness: [entry], primary: [entry], reason: [...reasons][0]! };
    }
    const channels = orderChannels.map((channel): ChannelFacts => {
      const native = observation.snapshot.feeds.find(f => f.channel === channel && f.origin === "native") ?? null;
      const mirror = observation.snapshot.feeds.find(f => f.channel === channel && f.origin === "mirror") ?? null;
      // The native source is authoritative. A mirror is used only when no native feed exists, and is otherwise compared, never added.
      const feed = native ?? mirror;
      const freshness: SourceFreshnessEntry[] = [];
      if (!feed) {
        reasons.add("ORDER_FEED_MISSING");
        freshness.push(freshnessEntry("orders", `orders.${channel}`, null, now, { missing: true }));
        return { channel, feed: null, rows: [], known: false, reason: "ORDER_FEED_MISSING", usd: true, mismatches: 0, freshness };
      }
      for (const row of feed.orders) {
        const day = localDay(Date.parse(row.placedAt), window.timezone);
        if (day < window.start || day > window.end) throw new AnalyticsError("ANALYTICS_SOURCE_INVALID", 502, "The orders source returned an order outside the requested period.");
      }
      freshness.push(freshnessEntry("orders", `orders.${channel}.${feed.origin}`, feed, now, { mirror: feed.origin === "mirror" }));
      if (feed.origin === "mirror") reasons.add("ORDERS_FROM_MIRROR");
      let mismatches = 0;
      if (native && mirror) {
        freshness.push(freshnessEntry("orders", `orders.${channel}.mirror`, mirror, now, { mirror: true }));
        if (native.lastSuccessAt && mirror.lastSuccessAt) {
          const key = (o: OrderRow) => JSON.stringify([o.valid, o.netReceiptsMinor, o.currency]);
          const left = new Map(native.orders.map(o => [o.orderRef, key(o)])), right = new Map(mirror.orders.map(o => [o.orderRef, key(o)]));
          for (const [ref, value] of left) if (right.get(ref) !== value) mismatches++;
          for (const ref of right.keys()) if (!left.has(ref)) mismatches++;
          if (mismatches) reasons.add("NATIVE_MIRROR_MISMATCH");
        }
      }
      if (feed.lastSuccessAt === null) {
        reasons.add("ORDER_FEED_NEVER_SYNCED");
        return { channel, feed, rows: [], known: false, reason: "ORDER_FEED_NEVER_SYNCED", usd: true, mismatches, freshness };
      }
      const rows = feed.orders.filter(o => o.valid);
      const usd = rows.every(o => o.currency === REPORTING_CURRENCY);
      if (!usd) reasons.add("CURRENCY_NOT_REPORTING_CURRENCY");
      return { channel, feed, rows, known: true, reason: null, usd, mismatches, freshness };
    });
    return { channels, reasons, freshness: channels.flatMap(c => c.freshness), primary: channels.map(c => c.freshness[0]!), reason: null };
  }
  type Orders = ReturnType<typeof orderFacts>;
  const channelCount = (c: ChannelFacts): Operand => c.known ? operand(`${CHANNEL_VIEW[c.channel].label} valid orders`, c.rows.length) : operand(`${CHANNEL_VIEW[c.channel].label} valid orders`, null, c.reason);
  const channelNet = (c: ChannelFacts, rows = c.rows): Operand => !c.known ? operand(`${CHANNEL_VIEW[c.channel].label} net receipts`, null, c.reason)
    : !c.usd ? operand(`${CHANNEL_VIEW[c.channel].label} net receipts`, null, "CURRENCY_NOT_REPORTING_CURRENCY")
    : sumOperands(`${CHANNEL_VIEW[c.channel].label} net receipts`, rows.map(o => operand("order", o.netReceiptsMinor)));
  function orderTotals(o: Orders) {
    const missing = (label: string) => operand(label, null, o.reason ?? "UNKNOWN_INPUT");
    if (!o.channels.length) return { orders: missing("Valid orders"), net: missing("Net receipts"), newRetained: missing("New retained customers"),
      retainedUnits: missing("Retained units"), attributed: missing("Creator-code orders"), attributedNet: missing("Creator-code net receipts"), unevaluated: null as number | null };
    const rows = o.channels.flatMap(c => c.rows), allKnown = o.channels.every(c => c.known);
    const firstReason = o.channels.find(c => !c.known)?.reason ?? null;
    const unevaluated = allKnown ? rows.filter(r => r.attribution === null).length : null;
    const code = rows.filter(r => r.attribution === "code");
    const ifKnown = (label: string, value: () => number | null, reason: string) => !allKnown ? operand(label, null, firstReason) : operand(label, value(), reason);
    return {
      orders: sumOperands("Valid orders", o.channels.map(c => channelCount(c))),
      net: sumOperands("Net receipts", o.channels.map(c => channelNet(c))),
      newRetained: ifKnown("New retained customers", () => rows.some(r => r.newRetainedCustomer === null) ? null : rows.filter(r => r.newRetainedCustomer).length, "RETENTION_NOT_EVALUATED"),
      retainedUnits: ifKnown("Retained units", () => rows.some(r => r.unitsRetained === null) ? null : rows.reduce((n, r) => n + (r.unitsRetained ?? 0), 0), "RETAINED_UNITS_NOT_REPORTED"),
      attributed: ifKnown("Creator-code orders", () => unevaluated ? null : code.length, "ATTRIBUTION_NOT_EVALUATED"),
      attributedNet: !allKnown ? operand("Creator-code net receipts", null, firstReason) : unevaluated ? operand("Creator-code net receipts", null, "ATTRIBUTION_NOT_EVALUATED")
        : !o.channels.every(c => c.usd) ? operand("Creator-code net receipts", null, "CURRENCY_NOT_REPORTING_CURRENCY") : sumOperands("Creator-code net receipts", code.map(r => operand("order", r.netReceiptsMinor))),
      unevaluated,
    };
  }

  /* ---------- Ad platforms ---------- */

  type PlatformFacts = { platform: "meta" | "tiktok"; feed: AdFeed | null; known: boolean; reason: string | null; spend: Operand; gmvMaxSpend: Operand; purchaseValue: Operand;
    impressions: number; clicks: number; attributionWindow: string | null };
  function adFacts(observation: Observation<AdPlatformsSnapshot>, now: number) {
    const reasons = new Set<string>();
    if (observation.kind !== "observed") {
      const reason = observation.kind === "unconfigured" ? "AD_PLATFORM_SOURCE_UNCONFIGURED" : "AD_PLATFORM_SOURCE_UNAVAILABLE";
      reasons.add(reason);
      const entry = notConnected("adPlatforms", observation, now);
      return { platforms: [] as PlatformFacts[], reasons, reason, freshness: [entry] };
    }
    const freshness: SourceFreshnessEntry[] = [];
    const platforms = (["meta", "tiktok"] as const).map((platform): PlatformFacts => {
      const feed = observation.snapshot.feeds.find(f => f.platform === platform) ?? null;
      const label = `${PLATFORM_LABEL[platform]} spend`;
      if (!feed) {
        reasons.add("AD_PLATFORM_FEED_MISSING"); freshness.push(freshnessEntry("adPlatforms", `adPlatforms.${platform}`, null, now, { missing: true }));
        const missing = operand(label, null, "AD_PLATFORM_FEED_MISSING");
        return { platform, feed, known: false, reason: "AD_PLATFORM_FEED_MISSING", spend: missing, gmvMaxSpend: missing, purchaseValue: missing, impressions: 0, clicks: 0, attributionWindow: null };
      }
      freshness.push(freshnessEntry("adPlatforms", `adPlatforms.${platform}`, feed, now));
      const reason = feed.lastSuccessAt === null ? "AD_PLATFORM_FEED_NEVER_SYNCED" : feed.currency !== REPORTING_CURRENCY ? "CURRENCY_NOT_REPORTING_CURRENCY" : null;
      if (reason) reasons.add(reason);
      const standard = feed.campaigns.filter(c => c.kind === "standard"), gmvMax = feed.campaigns.filter(c => c.kind === "gmvMax");
      if (gmvMax.length) reasons.add("GMV_MAX_NOT_INCREMENTAL");
      const sum = (label: string, list: typeof standard, pick: (c: typeof standard[number]) => number | null, nullReason: string) =>
        reason ? operand(label, null, reason) : sumOperands(label, list.map(c => operand(label, pick(c), nullReason)));
      const windows = [...new Set(standard.map(c => c.attributionWindow))];
      return { platform, feed, known: !reason, reason,
        spend: sum(label, standard, c => c.spendMinor, "SPEND_NOT_REPORTED"),
        gmvMaxSpend: sum(`${PLATFORM_LABEL[platform]} GMV Max spend`, gmvMax, c => c.spendMinor, "SPEND_NOT_REPORTED"),
        purchaseValue: sum(`${PLATFORM_LABEL[platform]} platform-reported purchase value`, standard, c => c.platformPurchaseValueMinor, "PURCHASE_VALUE_NOT_REPORTED"),
        impressions: standard.reduce((n, c) => n + c.impressions, 0), clicks: standard.reduce((n, c) => n + c.clicks, 0),
        attributionWindow: windows.length === 1 ? windows[0] ?? null : null };
    });
    return { platforms, reasons, reason: null as string | null, freshness };
  }
  type Ads = ReturnType<typeof adFacts>;
  function mediaSpend(a: Ads): Operand {
    if (!a.platforms.length) return operand("Paid media spend", null, a.reason);
    return sumOperands("Paid media spend", a.platforms.flatMap(p => [p.spend, p.gmvMaxSpend]));
  }

  /* ---------- Shared envelope pieces ---------- */

  /** Notes are disclosed but do not make the read partial (for example, GMV Max is reported separately by design). */
  const NOTES = new Set(["GMV_MAX_NOT_INCREMENTAL", "ORDERS_FROM_MIRROR", "COST_EVIDENCE_NOT_CONNECTED"]);
  function settle(primary: SourceFreshnessEntry[], reasons: Set<string>, expected: number) {
    // A compared mirror is listed with its own freshness, but only the feeds the figures come from decide the read's state.
    for (const f of primary) if (f.staleReasonCode) reasons.add(f.staleReasonCode);
    const blocking = [...reasons].filter(r => !NOTES.has(r));
    const observedCount = Math.min(expected, primary.filter(f => f.lastSourceSuccessAt !== null).length);
    const stale = primary.some(f => f.staleReasonCode === "SOURCE_STALE");
    const complete = blocking.length === 0 && primary.every(f => f.freshnessState === "current" || f.freshnessState === "noChange");
    return { dataState: stale ? "stale" as const : complete ? "ready" as const : "partial" as const,
      coverage: { expectedCount: expected, observedCount, missingCount: expected - observedCount, complete, reasonCodes: [...reasons].sort() } };
  }
  const ctxOf = (window: ReportingWindow, entries: SourceFreshnessEntry[]) => ({ window, provenance: entries.map(e => e.sourceRef.provenanceRef), freshness: entries.map(e => e.freshnessState) });
  function pv<T>(input: Operand, value: T | null, entries: SourceFreshnessEntry[], source: string, nowIso: string): PV<T> {
    const refs = entries.map(e => e.sourceRef.provenanceRef).sort();
    const updated = entries.map(e => e.lastSourceSuccessAt).filter((v): v is string => v !== null).sort()[0] ?? null;
    const base = { evidenceRefs: refs, sourceRef: sourceRef(source, refs.join("+") || `${source}:not-connected`), occurredAt: null, sourceUpdatedAt: updated, observedAt: nowIso };
    return value === null || input.value === null ? { ...base, state: "unknown", value: null, reasonCode: input.reasonCode ?? "UNKNOWN_INPUT" } : { ...base, state: "known", value, reasonCode: null };
  }
  const money = (o: Operand): Money | null => o.value === null ? null : { minorUnits: o.value, currency: "USD" };
  const provenanceOf = (label: string, window: ReportingWindow, entries: SourceFreshnessEntry[], nowIso: string, coverage: string) =>
    ({ source: label, observedAt: nowIso, timezone: window.timezone, coverage, stale: entries.some(e => e.staleReasonCode === "SOURCE_STALE") });
  function requireSource(observation: Observation<unknown>, noun: string) {
    if (observation.kind === "unconfigured") throw new AnalyticsError("ANALYTICS_SOURCE_UNCONFIGURED", 503, `The ${noun} source is not connected for this sandbox scope. No demo or zero figures are shown.`);
    if (observation.kind === "unavailable") throw new AnalyticsError("ANALYTICS_SOURCE_UNAVAILABLE", 503, `The ${noun} source could not be read. Try again shortly.`, true);
  }

  /** Measures shared by the overview and attribution reads. */
  function headlineMeasures(o: Orders, a: Ads, t: ReturnType<typeof orderTotals>, window: ReportingWindow, now: number) {
    const ordersCtx = ctxOf(window, o.freshness), allCtx = ctxOf(window, [...o.freshness, ...a.freshness]), adsCtx = ctxOf(window, a.freshness);
    const media = mediaSpend(a);
    // Creator commissions, samples and other acquisition costs are owned by finance and payables (not read here), so total marketing spend stays unknown.
    const marketing = media.value === null ? operand("Total marketing spend", null, media.reasonCode) : operand("Total marketing spend", null, "CREATOR_COST_SOURCE_UNCONFIGURED");
    const measures: Measure[] = [
      observed("netReceipts", "Net receipts", "usdMinor", t.net, ordersCtx),
      observed("validOrders", "Valid orders", "count", t.orders, ordersCtx),
      ratio("aov", "AOV", "usdMinor", t.net, t.orders, ordersCtx),
      observed("paidMediaSpend", "Paid media spend (Meta and TikTok, including GMV Max)", "usdMinor", media, adsCtx),
      ratio("mer", "MER", "multiple", t.net, marketing, allCtx),
      ratio("blendedCac", "Blended CAC", "usdMinor", operand("Included acquisition cost", null, marketing.reasonCode), t.newRetained, allCtx),
      observed("creatorCodeOrders", "Creator-code orders", "count", t.attributed, ordersCtx),
      observed("creatorCodeNetReceipts", "Creator-code net receipts", "usdMinor", t.attributedNet, ordersCtx),
      observed("contribution", "Contribution before marketing", "usdMinor", operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), ordersCtx),
      ...a.platforms.map(p => ratio(`platformRoas.${p.platform}`, `${PLATFORM_LABEL[p.platform]} platform ROAS (platform-reported, not MER)`, "multiple", p.purchaseValue, p.spend,
        ctxOf(window, a.freshness.filter(e => e.sourceRef.source === `adPlatforms.${p.platform}`)))),
      ...a.platforms.filter(p => p.feed?.campaigns.some(c => c.kind === "gmvMax")).map(p => observed(`gmvMaxSpend.${p.platform}`, `${PLATFORM_LABEL[p.platform]} GMV Max spend (not incremental)`, "usdMinor", p.gmvMaxSpend, adsCtx)),
    ];
    void now;
    return measures;
  }

  /* ---------- Views ---------- */

  async function overview(window: ReportingWindow, now: number) {
    const [ordersObs, adsObs] = await Promise.all([observe("orders", ordersSnapshotSchema, window, now), observe("adPlatforms", adPlatformsSnapshotSchema, window, now)]);
    requireSource(ordersObs, "orders");
    const o = orderFacts(ordersObs, window, now), a = adFacts(adsObs, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const days = daysOf(window), known = o.channels.filter(c => c.known && c.usd);
    const perDay = (c: ChannelFacts | undefined, day: string) => !c || !c.known || !c.usd ? null
      : c.rows.filter(r => localDay(Date.parse(r.placedAt), window.timezone) === day).reduce((n, r) => n + r.netReceiptsMinor, 0);
    const shopify = o.channels.find(c => c.channel === "shopify"), tiktok = o.channels.find(c => c.channel === "tiktokShop");
    const reasons = new Set([...o.reasons, ...a.reasons]);
    if (t.unevaluated) reasons.add("ATTRIBUTION_NOT_EVALUATED");
    const data = {
      datasetKey: "overview-observed", periodLabel: periodLabel(window), window,
      orders: pv(t.orders, t.orders.value, o.freshness, "orders", nowIso),
      netReceipts: pv(t.net, money(t.net), o.freshness, "orders", nowIso),
      contribution: pv(operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), null, o.freshness, "orders", nowIso),
      marketingSpend: null, newRetainedCustomers: t.newRetained.value,
      channels: known.map(c => ({ ...CHANNEL_VIEW[c.channel], netReceipts: money(channelNet(c))!, orders: c.rows.length })),
      daily: days.map(day => ({ date: day, shopify: perDay(shopify, day), tiktok: perDay(tiktok, day) })),
      cohortLabel: "All valid orders in the period · creator attribution by discount code",
      monitorLabel: "Monitor separate", lastCheckedLabel: "Content monitor is read on its own page",
      activity: [], posts: [],
      attributedOrders: pv(t.attributed, t.attributed.value, o.freshness, "orders", nowIso),
      attributedNetSales: pv(t.attributedNet, money(t.attributedNet), o.freshness, "orders", nowIso),
      measures: headlineMeasures(o, a, t, window, now),
    };
    const freshness = [...o.freshness, ...a.freshness];
    return { data, ...settle([...o.primary, ...a.freshness], reasons, 4), sourceFreshness: freshness };
  }

  async function attribution(window: ReportingWindow, now: number) {
    const [ordersObs, adsObs] = await Promise.all([observe("orders", ordersSnapshotSchema, window, now), observe("adPlatforms", adPlatformsSnapshotSchema, window, now)]);
    requireSource(ordersObs, "orders");
    const o = orderFacts(ordersObs, window, now), a = adFacts(adsObs, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const allKnown = o.channels.every(c => c.known && c.usd);
    const days = daysOf(window), weeks: { label: string; note: string | null; shopify: Money; tiktok: Money }[] = [];
    if (allKnown) for (let i = 0; i < days.length; i += 7) {
      const span = new Set(days.slice(i, i + 7));
      const sum = (c: OrderChannel) => o.channels.find(x => x.channel === c)!.rows.filter(r => span.has(localDay(Date.parse(r.placedAt), window.timezone))).reduce((n, r) => n + r.netReceiptsMinor, 0);
      weeks.push({ label: `Wk ${i / 7 + 1}`, note: span.size < 7 ? "*" : null, shopify: { minorUnits: sum("shopify"), currency: "USD" }, tiktok: { minorUnits: sum("tiktokShop"), currency: "USD" } });
    }
    const rows = o.channels.flatMap(c => c.rows);
    const buckets = (["code", "utm", "platform", "unattributed"] as const).map(key => ({ key,
      label: { code: "Discount code", utm: "UTM", platform: "Platform-reported", unattributed: "Unattributed" }[key], orders: rows.filter(r => r.attribution === key).length }));
    const tiktok = a.platforms.find(p => p.platform === "tiktok");
    const roas = headlineMeasures(o, a, t, window, now);
    const tiktokRoas = roas.find(m => m.key === "platformRoas.tiktok");
    const feedRefs = o.freshness.map(e => e.sourceRef.provenanceRef).sort().join("+");
    const scopeOf = (suffix: string) => ({ source: "source" as const, sourceRef: `${feedRefs}/${suffix}`, cohortId: `valid-orders:${window.start}/${window.end}`, currency: "USD", period: window });
    const reasons = new Set([...o.reasons, ...a.reasons]);
    if (t.unevaluated) reasons.add("ATTRIBUTION_NOT_EVALUATED");
    reasons.add("COST_EVIDENCE_NOT_CONNECTED");
    const data = {
      datasetKey: "attribution-observed", periodLabel: periodLabel(window),
      ...(allKnown ? { reportScope: scopeOf("report"), receiptScope: scopeOf("receipts") } : {}),
      ...(allKnown && t.newRetained.value !== null ? { retainedCustomerScope: scopeOf("retained-customers") } : {}),
      netReceipts: pv(t.net, money(t.net), o.freshness, "orders", nowIso), orders: pv(t.orders, t.orders.value, o.freshness, "orders", nowIso),
      retainedUnits: t.retainedUnits.value,
      contribution: pv(operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), null, o.freshness, "orders", nowIso),
      marketingSpend: null, newRetainedCustomers: t.newRetained.value,
      tiktokRoasWindow: tiktok?.attributionWindow && tiktok.feed ? { label: tiktok.attributionWindow, sourceRef: alias("feed", tiktok.feed.feedRef) } : null,
      tiktokPlatformRoas: tiktokRoas && tiktokRoas.state === "known"
        ? pv(operand("TikTok platform ROAS", 1), tiktokRoas.value, a.freshness, "adPlatforms.tiktok", nowIso)
        : { ...pv(operand("TikTok platform ROAS", null, tiktokRoas?.reasonCode ?? a.reason), null, a.freshness, "adPlatforms.tiktok", nowIso), state: tiktokRoas?.state === "notApplicable" ? "notApplicable" as const : "unknown" as const },
      channels: allKnown ? o.channels.map(c => ({ ...CHANNEL_VIEW[c.channel], netReceipts: money(channelNet(c))!, orders: c.rows.length })) : [],
      weeks, attribution: allKnown ? buckets : [], creators: [],
      provenance: provenanceOf("Order sources (native first; a mirror is compared, never added)", window, o.freshness, nowIso,
        allKnown ? `${rows.length} valid orders, ${periodLabel(window)}${t.unevaluated ? `; ${t.unevaluated} not yet attributed` : ""}` : "Order coverage incomplete"),
      measures: roas,
    };
    const freshness = [...o.freshness, ...a.freshness];
    return { data, ...settle([...o.primary, ...a.freshness], reasons, 4), sourceFreshness: freshness };
  }

  async function paidMedia(window: ReportingWindow, now: number, filters: z.infer<typeof analyticsFilters.paidMedia>) {
    const adsObs = await observe("adPlatforms", adPlatformsSnapshotSchema, window, now);
    requireSource(adsObs, "ad platform");
    const a = adFacts(adsObs, now), nowIso = new Date(now).toISOString(), today = localDay(now, window.timezone);
    const assets = a.platforms.filter(p => p.known && p.feed).flatMap(p => p.feed!.assets.map(asset => ({
      id: alias("asset", asset.assetRef), platform: p.platform, label: `${asset.label} · ${PLATFORM_LABEL[p.platform]}`, clicks: asset.clicks, impressions: asset.impressions,
      rights: asset.rights, expiresInDays: asset.rights === "expiring" && asset.expiresOn ? Math.max(0, Math.round((Date.parse(asset.expiresOn) - Date.parse(today)) / DAY_MS)) : null })));
    const shown = assets.filter(x => (filters.rights === "all" || x.rights === filters.rights) && (filters.platform === "all" || x.platform === filters.platform));
    const measures: Measure[] = a.platforms.flatMap(p => {
      const ctx = ctxOf(window, a.freshness.filter(e => e.sourceRef.source === `adPlatforms.${p.platform}`));
      return [ratio(`platformRoas.${p.platform}`, `${PLATFORM_LABEL[p.platform]} platform ROAS (platform-reported, not MER)`, "multiple", p.purchaseValue, p.spend, ctx),
        ratio(`ctr.${p.platform}`, `${PLATFORM_LABEL[p.platform]} click-through rate`, "percent", operand("Clicks", p.known ? p.clicks : null, p.reason), operand("Impressions", p.known ? p.impressions : null, p.reason), ctx, 100),
        ...(p.feed?.campaigns.some(c => c.kind === "gmvMax") ? [observed(`gmvMaxSpend.${p.platform}`, `${PLATFORM_LABEL[p.platform]} GMV Max spend (not incremental)`, "usdMinor", p.gmvMaxSpend, ctx)] : [])];
    });
    measures.push(observed("paidMediaSpend", "Paid media spend (Meta and TikTok, including GMV Max)", "usdMinor", mediaSpend(a), ctxOf(window, a.freshness)));
    const data = {
      datasetKey: "paid-media-observed", periodLabel: periodLabel(window),
      channels: a.platforms.filter(p => p.known).map(p => ({ key: p.platform, label: PLATFORM_LABEL[p.platform], spend: money(p.spend), impressions: p.impressions, clicks: p.clicks,
        platformPurchaseValue: money(p.purchaseValue), attributionWindow: p.attributionWindow && p.feed ? { label: p.attributionWindow, sourceRef: alias("feed", p.feed.feedRef) } : null })),
      // Creator commissions and sample costs are payables, not ad spend. They are not read here and never folded into media.
      creatorSampleEconomics: null,
      assets: shown, assetTotal: assets.length,
      provenance: provenanceOf("Ad platform feeds (standard campaigns; GMV Max reported separately)", window, a.freshness, nowIso, `${a.platforms.filter(p => p.known).length} of 2 platforms`),
      measures,
    };
    return { data, ...settle(a.freshness, new Set(a.reasons), 2), sourceFreshness: a.freshness };
  }

  async function customerJourney(window: ReportingWindow, now: number) {
    const [ordersObs, sessionsObs, supportObs] = await Promise.all([observe("orders", ordersSnapshotSchema, window, now),
      observe("sessions", sessionsSnapshotSchema, window, now), observe("support", supportSnapshotSchema, window, now)]);
    requireSource(ordersObs, "orders");
    const o = orderFacts(ordersObs, window, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const reasons = new Set(o.reasons);
    const shopify = o.channels.find(c => c.channel === "shopify"), tiktok = o.channels.find(c => c.channel === "tiktokShop");
    const website = shopify ? channelCount(shopify) : operand("Shopify valid orders", null, o.reason), websiteNet = shopify ? channelNet(shopify) : operand("Shopify net receipts", null, o.reason);
    const s = sessionsObs.kind === "observed" ? sessionsObs.snapshot.feed : null, sup = supportObs.kind === "observed" ? supportObs.snapshot.feed : null;
    const sessionEntry = s ? freshnessEntry("sessions", "sessions.shopify", s, now) : notConnected("sessions", sessionsObs, now);
    const supportEntry = sup ? freshnessEntry("support", "support", sup, now) : notConnected("support", supportObs, now);
    if (!s) reasons.add(sessionsObs.kind === "unconfigured" ? "SESSIONS_SOURCE_UNCONFIGURED" : "SESSIONS_SOURCE_UNAVAILABLE");
    if (!sup) reasons.add(supportObs.kind === "unconfigured" ? "SUPPORT_SOURCE_UNCONFIGURED" : "SUPPORT_SOURCE_UNAVAILABLE");
    const synced = <T>(feed: { lastSuccessAt: string | null } | null, value: T | null) => feed && feed.lastSuccessAt !== null ? value : null;
    const sessionReason = !s ? (sessionsObs.kind === "unconfigured" ? "SESSIONS_SOURCE_UNCONFIGURED" : "SESSIONS_SOURCE_UNAVAILABLE") : s.lastSuccessAt === null ? "SOURCE_NEVER_SYNCED" : "SESSIONS_NOT_REPORTED";
    const supportReason = !sup ? (supportObs.kind === "unconfigured" ? "SUPPORT_SOURCE_UNCONFIGURED" : "SUPPORT_SOURCE_UNAVAILABLE") : sup.lastSuccessAt === null ? "SOURCE_NEVER_SYNCED" : "NOT_REPORTED";
    const sessions = operand("Website sessions", synced(s, s?.sessions ?? null), sessionReason);
    const delivered = operand(`Delivered units, last ${sup?.deliveredWindowDays ?? 14} days`, synced(sup, sup?.deliveredUnits ?? null), supportReason);
    const tickets = synced(sup, sup?.tickets ?? null), returns = synced(sup, sup?.returns ?? null), resolution = synced(sup, sup?.resolution ?? null);
    const stars = synced(sup, sup?.reviews.stars ?? null), rated = operand("Rated reviews", synced(sup, sup?.reviews.ratedCount ?? null), supportReason);
    const ticketTotal = operand("Support tickets", tickets ? tickets.reduce((n, x) => n + x.count, 0) : null, supportReason);
    const ordersCtx = ctxOf(window, o.freshness), sessionsCtx = ctxOf(window, [...o.freshness.filter(e => e.sourceRef.source.startsWith("orders.shopify")), sessionEntry]);
    const supportCtx = { ...ctxOf(window, [supportEntry]), window: { ...window, start: addDays(window.end, -((sup?.deliveredWindowDays ?? 14) - 1)) } };
    const measures: Measure[] = [
      ratio("storeConversion", "Store conversion (Shopify orders ÷ Shopify sessions)", "percent", website, sessions, sessionsCtx, 100),
      ratio("globalAov", "Global AOV", "usdMinor", t.net, t.orders, ordersCtx),
      ratio("supportLoad", "Support tickets per 100 delivered units", "percent", ticketTotal, delivered, supportCtx, 100),
      ratio("returnRate", "Returns per delivered unit", "percent", operand("Returned units", returns?.returned ?? null, supportReason), delivered, supportCtx, 100),
      ratio("averageRating", "Average rating (all time)", "stars", operand("Rating points", stars ? stars.reduce((n, x) => n + x.star * x.count, 0) : null, supportReason), rated, ctxOf(window, [supportEntry])),
    ];
    const aov = measures.find(m => m.key === "globalAov")!;
    const freshness = [...o.freshness, sessionEntry, supportEntry], primary = [...o.primary, sessionEntry, supportEntry];
    const data = {
      datasetKey: "customer-journey-observed", commercePeriod: periodLabel(window),
      sessions: pv(sessions, sessions.value, [sessionEntry], "sessions.shopify", nowIso),
      productViewed: synced(s, s?.productViewed ?? null), checkoutStarted: synced(s, s?.checkoutStarted ?? null),
      websiteOrders: website.value, tiktokOrders: tiktok ? channelCount(tiktok).value : null, websiteNetReceipts: money(websiteNet),
      globalAov: aov.state === "known" ? { minorUnits: Math.round(aov.value!), currency: "USD" } : null, globalOrders: t.orders.value,
      deliveredUnits: pv(delivered, delivered.value, [supportEntry], "support", nowIso),
      tickets, resolution: resolution ? { byFin: resolution.byAutomation, byPeople: resolution.byPeople, open: resolution.open } : null, returns,
      reviews: { ratedCount: pv(rated, rated.value, [supportEntry], "support", nowIso), stars: stars ?? [] },
      cohorts: [
        { metric: "Store conversion", grain: "Shopify sessions", window: periodLabel(window), denominator: "Shopify storefront sessions from one selected source", inclusion: "Valid Shopify orders; TikTok Shop excluded", version: "server-v1" },
        { metric: "Support load", grain: "Delivered units", window: `Last ${sup?.deliveredWindowDays ?? 14} days`, denominator: "Delivered customer units", inclusion: "Tickets from the same delivered-unit cohort", version: "server-v1" },
        { metric: "Return rate", grain: "Delivered units", window: `Last ${sup?.deliveredWindowDays ?? 14} days`, denominator: "Delivered customer units", inclusion: "Returns opened for those units", version: "server-v1" },
        { metric: "Average rating", grain: "Rated reviews", window: "All time", denominator: "Rated reviews", inclusion: "Verified reviews from the support source", version: "server-v1" },
      ],
      provenance: provenanceOf("Order, storefront-session and support sources; each metric keeps its own cohort", window, freshness, nowIso, `${[s, sup].filter(Boolean).length + 1} of 3 sources`),
      measures,
    };
    return { data, ...settle(primary, reasons, 4), sourceFreshness: freshness };
  }

  async function read(viewKey: AnalyticsViewKey, rawFilters: unknown, period: unknown): Promise<AnalyticsReadResult> {
    if (!isAnalyticsViewKey(viewKey)) throw new AnalyticsError("VALIDATION_FAILED", 400, "Unknown analytics view.");
    const parsed = analyticsFilters[viewKey].safeParse(rawFilters);
    if (!parsed.success) throw new AnalyticsError("VALIDATION_FAILED", 400, "Unknown or invalid filter for this view.");
    const now = clock();
    const window = resolveWindow(period, parsed.data.preset, now, timezone);
    const result = viewKey === "overviewSummary" ? await overview(window, now) : viewKey === "attribution" ? await attribution(window, now)
      : viewKey === "paidMedia" ? await paidMedia(window, now, analyticsFilters.paidMedia.parse(parsed.data)) : await customerJourney(window, now);
    return { ...result, version: "an1-" + digest([viewKey, result.data, result.sourceFreshness, result.coverage]) };
  }
  return { read };
}
