import { createHmac } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import type { OperationsScope } from "../operations.ts";
import { freshnessOf, observed, operand, ratio, sumOperands, worstFreshness, type FreshnessState, type Measure, type Operand } from "./metrics.ts";
import {
  AnalyticsError, CLOCK_SKEW_MS, FRESHNESS_LIMIT_MS, adPlatformsSnapshotSchema, orderChannels, ordersSnapshotSchema, sessionsSnapshotSchema, supportSnapshotSchema, timezoneSchema,
  type AdFeed, type AdPlatformsSnapshot, type AnalyticsSourceKey, type AnalyticsSources, type AttributionWindow, type OrderChannel, type OrderFeed, type OrderRow,
  type OrdersSnapshot, type ReportingWindow,
} from "./sources.ts";

/** THO-293 views this module serves from trusted sources. */
export const analyticsViewKeys = ["overviewSummary", "attribution", "paidMedia", "customerJourney"] as const;
export type AnalyticsViewKey = typeof analyticsViewKeys[number];
export const isAnalyticsViewKey = (key: unknown): key is AnalyticsViewKey => (analyticsViewKeys as readonly unknown[]).includes(key);

/* ---------- Filters and period (D-11) ---------- */

const PRESET_DAYS = { last7Days: 7, last30Days: 30, last90Days: 90 } as const;
const presetSchema = z.enum(["last7Days", "last30Days", "last90Days"]);
const plainFilters = z.object({ preset: presetSchema.optional() }).strict();
export const analyticsFilters = {
  overviewSummary: plainFilters, attribution: plainFilters, customerJourney: plainFilters,
  paidMedia: z.object({ preset: presetSchema.optional(), rights: z.enum(["all", "cleared", "expiring", "expired", "notGranted", "unknown"]).default("all"),
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
/** One source's state for this read. Unconfigured, unavailable and invalid are states, never an error for the whole view. */
export type SourceState = "current" | "noChange" | "partial" | "stale" | "error" | "neverSynced" | "unconfigured" | "unavailable" | "invalid";
export type SourceStatus = { source: AnalyticsSourceKey; state: SourceState; reasonCode: string | null };
export type AnalyticsReadResult = { data: Record<string, unknown>; version: string; dataState: "ready" | "partial" | "stale";
  sourceFreshness: SourceFreshnessEntry[]; coverage: { expectedCount: number; observedCount: number; missingCount: number; complete: boolean; reasonCodes: string[] } };

const REPORTING_CURRENCY = "USD";
const CHANNEL_VIEW: Record<OrderChannel, { key: "shopify" | "tiktok"; label: string }> = { shopify: { key: "shopify", label: "Shopify" }, tiktokShop: { key: "tiktok", label: "TikTok Shop" } };
const PLATFORM_LABEL = { meta: "Meta", tiktok: "TikTok" } as const;
const SOURCE_PREFIX: Record<AnalyticsSourceKey, string> = { orders: "ORDERS", adPlatforms: "AD_PLATFORM", sessions: "SESSIONS", support: "SUPPORT" };
const TICKET_LABEL = { setup: "Setup", delivery: "Delivery", returns: "Returns", product: "Product", billing: "Billing", account: "Account", other: "Other" } as const;
/** Display text built here from structured durations, never passed through from a source. */
export const windowLabel = (w: AttributionWindow) => [w.clickDays ? `${w.clickDays}-day click` : null, w.viewDays ? `${w.viewDays}-day view` : null].filter(Boolean).join(", ");

type Options = { scope: OperationsScope; secret: string; sources?: AnalyticsSources; now?: () => number; timezone?: string };
type Parser<T> = { safeParse: (value: unknown) => { success: true; data: T } | { success: false } };
type Observation<T> = { kind: "unconfigured" } | { kind: "unavailable" } | { kind: "invalid"; reason: string } | { kind: "observed"; snapshot: T };
type Verdict = { freshnessState: FreshnessState; staleReasonCode: string | null };

/** Read-only projections. Nothing here writes a provider, exports a file, approves or dispatches anything. */
export function createAnalyticsReader(options: Options) {
  const { scope, secret } = options, sources = options.sources ?? {}, clock = options.now ?? Date.now;
  const timezone = timezoneSchema.parse(options.timezone ?? "UTC");
  if (secret.length < 32) throw new Error("Analytics reference key must be private and at least 32 characters.");
  /** Provider feed, campaign and asset IDs are replaced by scoped one-way aliases before they leave the server. */
  const alias = (kind: string, value: string) => `${kind}-` + createHmac("sha256", secret).update(JSON.stringify(["analytics.v1", scope, kind, value])).digest("hex").slice(0, 24);
  const sourceRef = (source: string, provenance: string): SourceRef => ({ source, accountId: scope.accountId, sourceId: null, canonicalId: null, url: null, identityState: "resolved", provenanceRef: provenance });

  /**
   * Reads one source. Absent, failing, malformed, mis-scoped-period or future-dated answers become that source's state, so the
   * other sources still render. A source answering for another workspace or refusing this scope is a security failure (403).
   */
  async function observe<T extends { scope: unknown; window: ReportingWindow }>(key: AnalyticsSourceKey, schema: Parser<T>, window: ReportingWindow): Promise<Observation<T>> {
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
    if (!parsed.success) return { kind: "invalid", reason: "SOURCE_RESPONSE_INVALID" };
    const snapshot = parsed.data;
    if (digest(snapshot.scope) !== digest(scope)) throw new AnalyticsError("SOURCE_SCOPE_DENIED", 403, "The source answered for a different scope.");
    if (digest(snapshot.window) !== digest(window)) return { kind: "invalid", reason: "SOURCE_PERIOD_MISMATCH" };
    return { kind: "observed", snapshot };
  }
  /**
   * The instant every time rule of this read is judged at: freshness and staleness (D-13), the 2-minute skew allowance, future-dated
   * observations and rows, and asset rights expiry. It is read after every source await, so a limit or a rights date that passes while
   * a source is answering is applied. The request time only chose the window; a clock that steps back cannot make a read fresher.
   */
  function projectionTime(requestedAt: number) {
    const at = clock();
    if (!Number.isFinite(at)) throw new AnalyticsError("SOURCE_TIME_UNVERIFIED", 503, "The service clock could not be verified.");
    return Math.max(at, requestedAt);
  }
  /** An observation stamped later than the projection time (beyond the skew allowance) is unverified, not current. */
  function atProjection<T extends object>(o: Observation<T>, at: number): Observation<T> {
    if (o.kind !== "observed") return o;
    const snapshot = o.snapshot as { feeds?: { observedAt: string }[]; feed?: { observedAt: string } };
    const feeds = snapshot.feeds ?? (snapshot.feed ? [snapshot.feed] : []);
    return feeds.some(f => Date.parse(f.observedAt) > at + CLOCK_SKEW_MS) ? { kind: "invalid", reason: "SOURCE_TIME_UNVERIFIED" } : o;
  }
  const reasonOf = (key: AnalyticsSourceKey, o: Observation<unknown>) =>
    o.kind === "observed" ? null : `${SOURCE_PREFIX[key]}_SOURCE_${o.kind === "unconfigured" ? "UNCONFIGURED" : o.kind === "unavailable" ? "UNAVAILABLE" : "INVALID"}`;

  function freshnessEntry(key: AnalyticsSourceKey, label: string, feed: { feedRef: string; observedAt: string; lastSuccessAt: string | null; syncState: "ok" | "noChange" | "error"; coverage: "complete" | "partial" } | null,
    now: number, extra: { verdict?: Verdict; mirror?: boolean } = {}): SourceFreshnessEntry {
    const verdict = extra.verdict ?? freshnessOf(key, feed, now, FRESHNESS_LIMIT_MS[key]);
    return { sourceRef: sourceRef(label, feed ? alias("feed", feed.feedRef) : `${label}:not-connected`), lastSourceSuccessAt: feed?.lastSuccessAt ?? null,
      observedAt: feed?.observedAt ?? null, mirroredAt: extra.mirror ? feed?.lastSuccessAt ?? null : null, ...verdict };
  }
  const notConnected = (key: AnalyticsSourceKey, o: Observation<unknown>, now: number) => freshnessEntry(key, key, null, now, { verdict:
    o.kind === "unconfigured" ? { freshnessState: "neverSynced", staleReasonCode: "SOURCE_UNCONFIGURED" }
    : o.kind === "unavailable" ? { freshnessState: "error", staleReasonCode: "SOURCE_UNAVAILABLE" }
    : { freshnessState: "error", staleReasonCode: o.kind === "invalid" ? o.reason : "SOURCE_RESPONSE_INVALID" } });
  function statusOf(key: AnalyticsSourceKey, o: Observation<unknown>, entries: SourceFreshnessEntry[]): SourceStatus {
    if (o.kind !== "observed") return { source: key, state: o.kind, reasonCode: entries[0]?.staleReasonCode ?? null };
    const stale = entries.some(e => e.staleReasonCode === "SOURCE_STALE");
    return { source: key, state: stale ? "stale" : worstFreshness(entries.map(e => e.freshnessState)), reasonCode: entries.find(e => e.staleReasonCode)?.staleReasonCode ?? null };
  }

  /* ---------- Orders ---------- */

  type ChannelFacts = { channel: OrderChannel; feed: OrderFeed | null; rows: OrderRow[]; known: boolean; reason: string | null; usd: boolean; freshness: SourceFreshnessEntry[] };
  function orderFacts(observation: Observation<OrdersSnapshot>, window: ReportingWindow, now: number) {
    const reasons = new Set<string>();
    if (observation.kind !== "observed") {
      const reason = reasonOf("orders", observation)!;
      reasons.add(reason);
      const entry = notConnected("orders", observation, now);
      return { channels: [] as ChannelFacts[], reasons, freshness: [entry], primary: [entry], reason, status: statusOf("orders", observation, [entry]) };
    }
    const channels = orderChannels.map((channel): ChannelFacts => {
      const native = observation.snapshot.feeds.find(f => f.channel === channel && f.origin === "native") ?? null;
      const mirror = observation.snapshot.feeds.find(f => f.channel === channel && f.origin === "mirror") ?? null;
      // The native source is authoritative. A mirror is used only when no native feed exists, and is otherwise compared, never added.
      const feed = native ?? mirror;
      const freshness: SourceFreshnessEntry[] = [];
      const unknown = (reason: string, f: OrderFeed | null, verdict?: Verdict): ChannelFacts => {
        reasons.add(reason);
        freshness.unshift(freshnessEntry("orders", f ? `orders.${channel}.${f.origin}` : `orders.${channel}`, f, now, { verdict, mirror: f?.origin === "mirror" }));
        return { channel, feed: f, rows: [], known: false, reason, usd: true, freshness };
      };
      if (!feed) return unknown("ORDER_FEED_MISSING", null, { freshnessState: "neverSynced", staleReasonCode: "SOURCE_FEED_MISSING" });
      // A row outside the period, or placed after now (beyond the clock tolerance), makes this feed's figures unverified, not the whole read.
      const timeIssue = feed.orders.some(r => Date.parse(r.placedAt) > now + CLOCK_SKEW_MS) ? "ORDER_TIME_UNVERIFIED"
        : feed.orders.some(r => { const d = localDay(Date.parse(r.placedAt), window.timezone); return d < window.start || d > window.end; }) ? "ORDER_OUTSIDE_PERIOD" : null;
      if (native && mirror) {
        freshness.push(freshnessEntry("orders", `orders.${channel}.mirror`, mirror, now, { mirror: true }));
        if (native.lastSuccessAt && mirror.lastSuccessAt) {
          const key = (o: OrderRow) => JSON.stringify([o.valid, o.netReceiptsMinor, o.currency, o.recordOwner]);
          const left = new Map(native.orders.map(o => [o.orderRef, key(o)])), right = new Map(mirror.orders.map(o => [o.orderRef, key(o)]));
          let mismatches = 0;
          for (const [ref, value] of left) if (right.get(ref) !== value) mismatches++;
          for (const ref of right.keys()) if (!left.has(ref)) mismatches++;
          if (mismatches) reasons.add("NATIVE_MIRROR_MISMATCH");
        }
      }
      if (timeIssue) return unknown(timeIssue, feed, { freshnessState: "error", staleReasonCode: timeIssue });
      if (feed.lastSuccessAt === null) return unknown("ORDER_FEED_NEVER_SYNCED", feed);
      freshness.unshift(freshnessEntry("orders", `orders.${channel}.${feed.origin}`, feed, now, { mirror: feed.origin === "mirror" }));
      if (feed.origin === "mirror") reasons.add("ORDERS_FROM_MIRROR");
      // A row owned by the other channel is that channel's order, copied here by an integration. It is counted only by its owner.
      const owned = feed.orders.filter(o => o.recordOwner === channel);
      if (owned.length !== feed.orders.length) reasons.add("CROSS_CHANNEL_COPY_DROPPED");
      return { channel, feed, rows: owned, known: true, reason: null, usd: true, freshness };
    });
    // Count each order once across channels by canonical identity. Without identity, the read cannot claim to be complete.
    const known = channels.filter(c => c.known);
    if (known.length > 1) {
      const seen = new Set<string>();
      for (const c of known) c.rows = c.rows.filter(r => {
        if (r.canonicalOrderId === null) { reasons.add("ORDER_IDENTITY_UNRESOLVED"); return true; }
        if (seen.has(r.canonicalOrderId)) { reasons.add("ORDER_IDENTITY_CONFLICT"); return false; }
        seen.add(r.canonicalOrderId); return true;
      });
    }
    for (const c of known) {
      c.rows = c.rows.filter(o => o.valid);
      c.usd = c.rows.every(o => o.currency === REPORTING_CURRENCY);
      if (!c.usd) reasons.add("CURRENCY_NOT_REPORTING_CURRENCY");
    }
    const primary = channels.map(c => c.freshness[0]!);
    return { channels, reasons, freshness: channels.flatMap(c => c.freshness), primary, reason: null, status: statusOf("orders", observation, primary) };
  }
  type Orders = ReturnType<typeof orderFacts>;
  const channelCount = (c: ChannelFacts): Operand => c.known ? operand(`${CHANNEL_VIEW[c.channel].label} valid orders`, c.rows.length) : operand(`${CHANNEL_VIEW[c.channel].label} valid orders`, null, c.reason);
  const channelNet = (c: ChannelFacts, rows = c.rows): Operand => !c.known ? operand(`${CHANNEL_VIEW[c.channel].label} net receipts`, null, c.reason)
    : !c.usd ? operand(`${CHANNEL_VIEW[c.channel].label} net receipts`, null, "CURRENCY_NOT_REPORTING_CURRENCY")
    : sumOperands(`${CHANNEL_VIEW[c.channel].label} net receipts`, rows.map(o => operand("order", o.netReceiptsMinor)));
  function orderTotals(o: Orders) {
    const unknownAll = (label: string) => operand(label, null, o.reason ?? "UNKNOWN_INPUT");
    if (!o.channels.length) return { orders: unknownAll("Valid orders"), net: unknownAll("Net receipts"), newRetained: unknownAll("Distinct new retained customers"),
      retainedUnits: unknownAll("Retained units"), discountCode: unknownAll("Discount-code orders"), creatorCode: unknownAll("Creator-code orders"),
      creatorCodeNet: unknownAll("Creator-code net receipts"), zeroNet: unknownAll("Valid orders with $0 net"), priorRefunds: unknownAll("Prior-period refunds"), unevaluated: null as number | null };
    const rows = o.channels.flatMap(c => c.rows), allKnown = o.channels.every(c => c.known), allUsd = o.channels.every(c => c.usd);
    const firstReason = o.channels.find(c => !c.known)?.reason ?? null;
    const unevaluated = allKnown ? rows.filter(r => r.attribution === null).length : null;
    const code = rows.filter(r => r.attribution === "code"), creator = code.filter(r => r.codeOwner === "creator");
    const ownerUnverified = code.some(r => r.codeOwner === "unknown");
    const when = (label: string, value: () => number | null, reason: string) => !allKnown ? operand(label, null, firstReason) : operand(label, value(), reason);
    const flagged = rows.filter(r => r.newRetainedCustomer === true);
    const refundParts = o.channels.map(c => c.feed?.priorPeriodRefunds ?? null);
    return {
      orders: sumOperands("Valid orders", o.channels.map(c => channelCount(c))),
      net: sumOperands("Net receipts", o.channels.map(c => channelNet(c))),
      // Distinct customers, not flagged orders. Without a customer reference on every flagged order, the count is unknown.
      newRetained: !allKnown ? operand("Distinct new retained customers", null, firstReason)
        : rows.some(r => r.newRetainedCustomer === null) ? operand("Distinct new retained customers", null, "RETENTION_NOT_EVALUATED")
        : flagged.some(r => r.customerRef === null) ? operand("Distinct new retained customers", null, "CUSTOMER_IDENTITY_UNAVAILABLE")
        : operand("Distinct new retained customers", new Set(flagged.map(r => r.customerRef)).size),
      retainedUnits: when("Retained units", () => rows.some(r => r.unitsRetained === null) ? null : rows.reduce((n, r) => n + (r.unitsRetained ?? 0), 0), "RETAINED_UNITS_NOT_REPORTED"),
      discountCode: when("Discount-code orders", () => unevaluated ? null : code.length, "ATTRIBUTION_NOT_EVALUATED"),
      creatorCode: !allKnown ? operand("Creator-code orders", null, firstReason) : unevaluated ? operand("Creator-code orders", null, "ATTRIBUTION_NOT_EVALUATED")
        : ownerUnverified ? operand("Creator-code orders", null, "CODE_OWNER_UNVERIFIED") : operand("Creator-code orders", creator.length),
      creatorCodeNet: !allKnown ? operand("Creator-code net receipts", null, firstReason) : unevaluated ? operand("Creator-code net receipts", null, "ATTRIBUTION_NOT_EVALUATED")
        : ownerUnverified ? operand("Creator-code net receipts", null, "CODE_OWNER_UNVERIFIED") : !allUsd ? operand("Creator-code net receipts", null, "CURRENCY_NOT_REPORTING_CURRENCY")
        : sumOperands("Creator-code net receipts", creator.map(r => operand("order", r.netReceiptsMinor))),
      zeroNet: when("Valid orders with $0 net", () => rows.filter(r => r.netReceiptsMinor === 0).length, "UNKNOWN_INPUT"),
      priorRefunds: !allKnown ? operand("Prior-period refunds", null, firstReason) : refundParts.some(p => p === null) ? operand("Prior-period refunds", null, "PRIOR_PERIOD_REFUNDS_NOT_REPORTED")
        : refundParts.some(p => p!.currency !== REPORTING_CURRENCY) ? operand("Prior-period refunds", null, "CURRENCY_NOT_REPORTING_CURRENCY")
        : sumOperands("Prior-period refunds", refundParts.map(p => operand("feed", p!.amountMinor))),
      unevaluated,
    };
  }

  /* ---------- Ad platforms ---------- */

  type PlatformFacts = { platform: "meta" | "tiktok"; feed: AdFeed | null; known: boolean; reason: string | null; spend: Operand; gmvMaxSpend: Operand; purchaseValue: Operand;
    impressions: number; clicks: number; attributionWindow: AttributionWindow | null };
  function adFacts(observation: Observation<AdPlatformsSnapshot>, now: number) {
    const reasons = new Set<string>();
    if (observation.kind !== "observed") {
      const reason = reasonOf("adPlatforms", observation)!;
      reasons.add(reason);
      const entry = notConnected("adPlatforms", observation, now);
      return { platforms: [] as PlatformFacts[], reasons, reason, freshness: [entry], status: statusOf("adPlatforms", observation, [entry]) };
    }
    const freshness: SourceFreshnessEntry[] = [];
    const platforms = (["meta", "tiktok"] as const).map((platform): PlatformFacts => {
      const feed = observation.snapshot.feeds.find(f => f.platform === platform) ?? null;
      const label = `${PLATFORM_LABEL[platform]} spend`;
      if (!feed) {
        reasons.add("AD_PLATFORM_FEED_MISSING");
        freshness.push(freshnessEntry("adPlatforms", `adPlatforms.${platform}`, null, now, { verdict: { freshnessState: "neverSynced", staleReasonCode: "SOURCE_FEED_MISSING" } }));
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
      const windows = new Map(standard.map(c => [JSON.stringify(c.attributionWindow), c.attributionWindow]));
      return { platform, feed, known: !reason, reason,
        spend: sum(label, standard, c => c.spendMinor, "SPEND_NOT_REPORTED"),
        gmvMaxSpend: sum(`${PLATFORM_LABEL[platform]} GMV Max spend`, gmvMax, c => c.spendMinor, "SPEND_NOT_REPORTED"),
        purchaseValue: sum(`${PLATFORM_LABEL[platform]} platform-reported purchase value`, standard, c => c.platformPurchaseValueMinor, "PURCHASE_VALUE_NOT_REPORTED"),
        impressions: standard.reduce((n, c) => n + c.impressions, 0), clicks: standard.reduce((n, c) => n + c.clicks, 0),
        attributionWindow: windows.size === 1 ? [...windows.values()][0] ?? null : null };
    });
    return { platforms, reasons, reason: null as string | null, freshness, status: statusOf("adPlatforms", observation, freshness) };
  }
  type Ads = ReturnType<typeof adFacts>;
  function mediaSpend(a: Ads): Operand {
    if (!a.platforms.length) return operand("Paid media spend", null, a.reason);
    return sumOperands("Paid media spend", a.platforms.flatMap(p => [p.spend, p.gmvMaxSpend]));
  }
  const windowRef = (p: PlatformFacts | undefined) => p?.attributionWindow && p.feed ? { label: windowLabel(p.attributionWindow), sourceRef: alias("feed", p.feed.feedRef) } : null;

  /* ---------- Shared envelope pieces ---------- */

  /** Notes are disclosed but do not make the read partial (for example, GMV Max is reported separately by design). */
  const NOTES = new Set(["GMV_MAX_NOT_INCREMENTAL", "ORDERS_FROM_MIRROR", "COST_EVIDENCE_NOT_CONNECTED", "CROSS_CHANNEL_COPY_DROPPED"]);
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

  /** Measures shared by the overview and attribution reads. */
  function headlineMeasures(o: Orders, a: Ads, t: ReturnType<typeof orderTotals>, window: ReportingWindow) {
    const ordersCtx = ctxOf(window, o.freshness), allCtx = ctxOf(window, [...o.freshness, ...a.freshness]), adsCtx = ctxOf(window, a.freshness);
    const media = mediaSpend(a);
    // Creator commissions, samples and other acquisition costs are owned by finance and payables (not read here), so total marketing spend stays unknown.
    const marketing = media.value === null ? operand("Total marketing spend", null, media.reasonCode) : operand("Total marketing spend", null, "CREATOR_COST_SOURCE_UNCONFIGURED");
    const measures: Measure[] = [
      observed("netReceipts", "Net receipts", "usdMinor", t.net, ordersCtx),
      observed("validOrders", "Valid orders", "count", t.orders, ordersCtx),
      ratio("aov", "AOV", "usdMinor", t.net, t.orders, ordersCtx),
      observed("zeroNetValidOrders", "Valid orders with $0 net (in the AOV denominator)", "count", t.zeroNet, ordersCtx),
      observed("priorPeriodRefundCorrections", "Refunds of earlier-period orders (corrections, not in net receipts)", "usdMinor", t.priorRefunds, ordersCtx),
      observed("paidMediaSpend", "Paid media spend (Meta and TikTok, including GMV Max)", "usdMinor", media, adsCtx),
      ratio("mer", "MER", "multiple", t.net, marketing, allCtx),
      ratio("blendedCac", "Blended CAC", "usdMinor", operand("Included acquisition cost", null, marketing.reasonCode), t.newRetained, allCtx),
      observed("newRetainedCustomers", "Distinct new retained customers", "count", t.newRetained, ordersCtx),
      observed("discountCodeOrders", "Discount-code orders (creator and sitewide)", "count", t.discountCode, ordersCtx),
      observed("creatorCodeOrders", "Creator-code orders", "count", t.creatorCode, ordersCtx),
      observed("creatorCodeNetReceipts", "Creator-code net receipts", "usdMinor", t.creatorCodeNet, ordersCtx),
      observed("contribution", "Contribution before marketing", "usdMinor", operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), ordersCtx),
      ...a.platforms.map(p => ratio(`platformRoas.${p.platform}`, `${PLATFORM_LABEL[p.platform]} platform ROAS (platform-reported, not MER)`, "multiple", p.purchaseValue, p.spend,
        ctxOf(window, a.freshness.filter(e => e.sourceRef.source === `adPlatforms.${p.platform}`)))),
      ...a.platforms.filter(p => p.feed?.campaigns.some(c => c.kind === "gmvMax")).map(p => observed(`gmvMaxSpend.${p.platform}`, `${PLATFORM_LABEL[p.platform]} GMV Max spend (not incremental)`, "usdMinor", p.gmvMaxSpend, adsCtx)),
    ];
    return measures;
  }

  /* ---------- Views ---------- */

  async function overview(window: ReportingWindow, requestedAt: number) {
    const observations = await Promise.all([observe("orders", ordersSnapshotSchema, window), observe("adPlatforms", adPlatformsSnapshotSchema, window)]);
    const now = projectionTime(requestedAt), ordersObs = atProjection(observations[0], now), adsObs = atProjection(observations[1], now);
    const o = orderFacts(ordersObs, window, now), a = adFacts(adsObs, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const days = daysOf(window), known = o.channels.filter(c => c.known && c.usd);
    const perDay = (c: ChannelFacts | undefined, day: string) => !c || !c.known || !c.usd ? null
      : c.rows.filter(r => localDay(Date.parse(r.placedAt), window.timezone) === day).reduce((n, r) => n + r.netReceiptsMinor, 0);
    const shopify = o.channels.find(c => c.channel === "shopify"), tiktok = o.channels.find(c => c.channel === "tiktokShop");
    const reasons = new Set([...o.reasons, ...a.reasons]);
    if (t.unevaluated) reasons.add("ATTRIBUTION_NOT_EVALUATED");
    const data = {
      datasetKey: "overview-observed", periodLabel: periodLabel(window), window, sources: [o.status, a.status],
      orders: pv(t.orders, t.orders.value, o.freshness, "orders", nowIso),
      netReceipts: pv(t.net, money(t.net), o.freshness, "orders", nowIso),
      contribution: pv(operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), null, o.freshness, "orders", nowIso),
      marketingSpend: null, newRetainedCustomers: t.newRetained.value,
      channels: known.map(c => ({ ...CHANNEL_VIEW[c.channel], netReceipts: money(channelNet(c))!, orders: c.rows.length })),
      daily: days.map(day => ({ date: day, shopify: perDay(shopify, day), tiktok: perDay(tiktok, day) })),
      cohortLabel: "All valid orders in the period · creator orders use creator-marked discount codes only",
      monitorLabel: "Monitor separate", lastCheckedLabel: "Content monitor is read on its own page",
      activity: [], posts: [],
      attributedOrders: pv(t.creatorCode, t.creatorCode.value, o.freshness, "orders", nowIso),
      attributedNetSales: pv(t.creatorCodeNet, money(t.creatorCodeNet), o.freshness, "orders", nowIso),
      measures: headlineMeasures(o, a, t, window),
    };
    return { data, ...settle([...o.primary, ...a.freshness], reasons, 4), sourceFreshness: [...o.freshness, ...a.freshness] };
  }

  async function attribution(window: ReportingWindow, requestedAt: number) {
    const observations = await Promise.all([observe("orders", ordersSnapshotSchema, window), observe("adPlatforms", adPlatformsSnapshotSchema, window)]);
    const now = projectionTime(requestedAt), ordersObs = atProjection(observations[0], now), adsObs = atProjection(observations[1], now);
    const o = orderFacts(ordersObs, window, now), a = adFacts(adsObs, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const allKnown = o.channels.length > 0 && o.channels.every(c => c.known && c.usd);
    const days = daysOf(window), weeks: { label: string; note: string | null; shopify: Money; tiktok: Money }[] = [];
    if (allKnown) for (let i = 0; i < days.length; i += 7) {
      const span = new Set(days.slice(i, i + 7));
      const sum = (c: OrderChannel) => o.channels.find(x => x.channel === c)!.rows.filter(r => span.has(localDay(Date.parse(r.placedAt), window.timezone))).reduce((n, r) => n + r.netReceiptsMinor, 0);
      weeks.push({ label: `Wk ${i / 7 + 1}`, note: span.size < 7 ? "*" : null, shopify: { minorUnits: sum("shopify"), currency: "USD" }, tiktok: { minorUnits: sum("tiktokShop"), currency: "USD" } });
    }
    const rows = o.channels.flatMap(c => c.rows);
    const buckets = (["code", "utm", "platform", "unattributed"] as const).map(key => ({ key,
      label: { code: "Discount code (creator and sitewide)", utm: "UTM", platform: "Platform-reported", unattributed: "Unattributed" }[key], orders: rows.filter(r => r.attribution === key).length }));
    const tiktok = a.platforms.find(p => p.platform === "tiktok");
    const measures = headlineMeasures(o, a, t, window);
    const tiktokRoas = measures.find(m => m.key === "platformRoas.tiktok");
    const feedRefs = o.freshness.map(e => e.sourceRef.provenanceRef).sort().join("+");
    const scopeOf = (suffix: string) => ({ source: "source" as const, sourceRef: `${feedRefs}/${suffix}`, cohortId: `valid-orders:${window.start}/${window.end}`, currency: "USD", period: window });
    const reasons = new Set([...o.reasons, ...a.reasons]);
    if (t.unevaluated) reasons.add("ATTRIBUTION_NOT_EVALUATED");
    reasons.add("COST_EVIDENCE_NOT_CONNECTED");
    const data = {
      datasetKey: "attribution-observed", periodLabel: periodLabel(window), sources: [o.status, a.status],
      ...(allKnown ? { reportScope: scopeOf("report"), receiptScope: scopeOf("receipts") } : {}),
      ...(allKnown && t.newRetained.value !== null ? { retainedCustomerScope: scopeOf("retained-customers") } : {}),
      netReceipts: pv(t.net, money(t.net), o.freshness, "orders", nowIso), orders: pv(t.orders, t.orders.value, o.freshness, "orders", nowIso),
      retainedUnits: t.retainedUnits.value,
      contribution: pv(operand("Contribution", null, "LANDED_COST_SOURCE_UNCONFIGURED"), null, o.freshness, "orders", nowIso),
      marketingSpend: null, newRetainedCustomers: t.newRetained.value,
      tiktokRoasWindow: windowRef(tiktok),
      tiktokPlatformRoas: tiktokRoas && tiktokRoas.state === "known"
        ? pv(operand("TikTok platform ROAS", 1), tiktokRoas.value, a.freshness, "adPlatforms.tiktok", nowIso)
        : { ...pv(operand("TikTok platform ROAS", null, tiktokRoas?.reasonCode ?? a.reason), null, a.freshness, "adPlatforms.tiktok", nowIso), state: tiktokRoas?.state === "notApplicable" ? "notApplicable" as const : "unknown" as const },
      channels: allKnown ? o.channels.map(c => ({ ...CHANNEL_VIEW[c.channel], netReceipts: money(channelNet(c))!, orders: c.rows.length })) : [],
      weeks, attribution: allKnown ? buckets : [], creators: [],
      provenance: provenanceOf("Order sources (native first; a mirror is compared, never added; one count per canonical order)", window, o.freshness, nowIso,
        allKnown ? `${rows.length} valid orders, ${periodLabel(window)}${t.unevaluated ? `; ${t.unevaluated} not yet attributed` : ""}` : "Order coverage incomplete"),
      measures,
    };
    return { data, ...settle([...o.primary, ...a.freshness], reasons, 4), sourceFreshness: [...o.freshness, ...a.freshness] };
  }

  async function paidMedia(window: ReportingWindow, requestedAt: number, filters: z.infer<typeof analyticsFilters.paidMedia>) {
    const observation = await observe("adPlatforms", adPlatformsSnapshotSchema, window);
    // Rights expiry ("today") and freshness are judged after the await, so rights that lapse while the platform answers show expired.
    const now = projectionTime(requestedAt), adsObs = atProjection(observation, now);
    const a = adFacts(adsObs, now), nowIso = new Date(now).toISOString(), today = localDay(now, window.timezone);
    const assets = a.platforms.filter(p => p.known && p.feed).flatMap(p => p.feed!.assets.map(asset => {
      const id = alias("asset", asset.assetRef);
      const days = asset.expiresOn ? Math.round((Date.parse(asset.expiresOn) - Date.parse(today)) / DAY_MS) : null;
      // Rights that have lapsed are expired, never "expiring in 0 days".
      const rights = asset.rights === "expired" || asset.rights === "expiring" && days !== null && days < 0 ? "expired" as const : asset.rights;
      return { id, platform: p.platform, label: `${asset.label ?? `Asset ${id.slice(-6)}`} · ${PLATFORM_LABEL[p.platform]}`, clicks: asset.clicks, impressions: asset.impressions,
        rights, expiresInDays: rights === "expiring" && days !== null ? days : null };
    }));
    const shown = assets.filter(x => (filters.rights === "all" || x.rights === filters.rights) && (filters.platform === "all" || x.platform === filters.platform));
    const measures: Measure[] = a.platforms.flatMap(p => {
      const ctx = ctxOf(window, a.freshness.filter(e => e.sourceRef.source === `adPlatforms.${p.platform}`));
      return [ratio(`platformRoas.${p.platform}`, `${PLATFORM_LABEL[p.platform]} platform ROAS (platform-reported, not MER)`, "multiple", p.purchaseValue, p.spend, ctx),
        ratio(`ctr.${p.platform}`, `${PLATFORM_LABEL[p.platform]} click-through rate`, "percent", operand("Clicks", p.known ? p.clicks : null, p.reason), operand("Impressions", p.known ? p.impressions : null, p.reason), ctx, 100),
        ...(p.feed?.campaigns.some(c => c.kind === "gmvMax") ? [observed(`gmvMaxSpend.${p.platform}`, `${PLATFORM_LABEL[p.platform]} GMV Max spend (not incremental)`, "usdMinor", p.gmvMaxSpend, ctx)] : [])];
    });
    measures.push(observed("paidMediaSpend", "Paid media spend (Meta and TikTok, including GMV Max)", "usdMinor", mediaSpend(a), ctxOf(window, a.freshness)));
    const data = {
      datasetKey: "paid-media-observed", periodLabel: periodLabel(window), sources: [a.status],
      channels: a.platforms.filter(p => p.known).map(p => ({ key: p.platform, label: PLATFORM_LABEL[p.platform], spend: money(p.spend), impressions: p.impressions, clicks: p.clicks,
        platformPurchaseValue: money(p.purchaseValue), attributionWindow: windowRef(p) })),
      // Creator commissions and sample costs are payables, not ad spend. They are not read here and never folded into media.
      creatorSampleEconomics: null,
      assets: shown, assetTotal: assets.length,
      provenance: provenanceOf("Ad platform feeds (standard campaigns; GMV Max reported separately)", window, a.freshness, nowIso, `${a.platforms.filter(p => p.known).length} of 2 platforms`),
      measures,
    };
    return { data, ...settle(a.freshness, new Set(a.reasons), 2), sourceFreshness: a.freshness };
  }

  async function customerJourney(window: ReportingWindow, requestedAt: number) {
    const observations = await Promise.all([observe("orders", ordersSnapshotSchema, window),
      observe("sessions", sessionsSnapshotSchema, window), observe("support", supportSnapshotSchema, window)]);
    const now = projectionTime(requestedAt), ordersObs = atProjection(observations[0], now);
    const sessionsObs = atProjection(observations[1], now), supportObs = atProjection(observations[2], now);
    const o = orderFacts(ordersObs, window, now), t = orderTotals(o), nowIso = new Date(now).toISOString();
    const reasons = new Set(o.reasons);
    const shopify = o.channels.find(c => c.channel === "shopify"), tiktok = o.channels.find(c => c.channel === "tiktokShop");
    const website = shopify ? channelCount(shopify) : operand("Shopify valid orders", null, o.reason), websiteNet = shopify ? channelNet(shopify) : operand("Shopify net receipts", null, o.reason);
    const s = sessionsObs.kind === "observed" ? sessionsObs.snapshot.feed : null, sup = supportObs.kind === "observed" ? supportObs.snapshot.feed : null;
    const sessionEntry = s ? freshnessEntry("sessions", "sessions.shopify", s, now) : notConnected("sessions", sessionsObs, now);
    const supportEntry = sup ? freshnessEntry("support", "support", sup, now) : notConnected("support", supportObs, now);
    const sessionMissing = reasonOf("sessions", sessionsObs), supportMissing = reasonOf("support", supportObs);
    if (sessionMissing) reasons.add(sessionMissing);
    if (supportMissing) reasons.add(supportMissing);
    const synced = <T>(feed: { lastSuccessAt: string | null } | null, value: T | null) => feed && feed.lastSuccessAt !== null ? value : null;
    const sessionReason = sessionMissing ?? (s?.lastSuccessAt === null ? "SOURCE_NEVER_SYNCED" : "SESSIONS_NOT_REPORTED");
    const supportReason = supportMissing ?? (sup?.lastSuccessAt === null ? "SOURCE_NEVER_SYNCED" : "NOT_REPORTED");
    const sessions = operand("Website sessions", synced(s, s?.sessions ?? null), sessionReason);
    const delivered = operand(`Delivered units, last ${sup?.deliveredWindowDays ?? 14} days`, synced(sup, sup?.deliveredUnits ?? null), supportReason);
    const rawTickets = synced(sup, sup?.tickets ?? null), returns = synced(sup, sup?.returns ?? null), resolution = synced(sup, sup?.resolution ?? null);
    const tickets = rawTickets ? rawTickets.map(x => ({ category: TICKET_LABEL[x.category], count: x.count })) : null;
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
      sources: [o.status, statusOf("sessions", sessionsObs, [sessionEntry]), statusOf("support", supportObs, [supportEntry])],
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
      provenance: provenanceOf("Order, storefront-session and support sources; each metric keeps its own cohort", window, freshness, nowIso, `${[o.channels.length ? 1 : 0, s ? 1 : 0, sup ? 1 : 0].reduce((n, x) => n + x, 0)} of 3 sources`),
      measures,
    };
    return { data, ...settle(primary, reasons, 4), sourceFreshness: freshness };
  }

  async function read(viewKey: AnalyticsViewKey, rawFilters: unknown, period: unknown): Promise<AnalyticsReadResult> {
    if (!isAnalyticsViewKey(viewKey)) throw new AnalyticsError("VALIDATION_FAILED", 400, "Unknown analytics view.");
    const parsed = analyticsFilters[viewKey].safeParse(rawFilters);
    if (!parsed.success) throw new AnalyticsError("VALIDATION_FAILED", 400, "Unknown or invalid filter for this view.");
    // The request time chooses the reporting window only. Each view reads the clock again after its source awaits (projectionTime).
    const requestedAt = clock();
    const window = resolveWindow(period, parsed.data.preset, requestedAt, timezone);
    const result = viewKey === "overviewSummary" ? await overview(window, requestedAt) : viewKey === "attribution" ? await attribution(window, requestedAt)
      : viewKey === "paidMedia" ? await paidMedia(window, requestedAt, analyticsFilters.paidMedia.parse(parsed.data)) : await customerJourney(window, requestedAt);
    return { ...result, version: "an1-" + digest([viewKey, result.data, result.sourceFreshness, result.coverage]) };
  }
  return { read };
}
