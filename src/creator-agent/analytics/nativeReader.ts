import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { digest } from "../config.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { analyticsPrincipalSchema, analyticsScopeSchema, nativeAnalyticsBindingSchema, nativeAnalyticsRequestSchema, nativeAnalyticsSnapshotSchema, type NativeAnalyticsBinding, type NativeAnalyticsSnapshot } from "./contract.ts";
import { ANALYTICS_ACCESS_MAX_AGE_MS, NativeAnalyticsError, type NativeAnalyticsSource } from "./nativeSource.ts";
import { projectNativeAnalytics } from "./nativeProjection.ts";
import { localDay } from "./reader.ts";
import type { NativeAnalyticsView } from "./views.ts";
import type { OperationsScope } from "../operations.ts";

export { NativeAnalyticsError } from "./nativeSource.ts";
export type NativeAnalyticsReaderOptions = { scope: OperationsScope; referenceKey: string; source?: NativeAnalyticsSource; now?: () => number; timeoutMs?: number };
export type NativeAnalyticsReadResult = { data: NativeAnalyticsView; version: string; dataState: "ready" | "partial" | "stale"; coverage: { expectedCount: number; observedCount: number; missingCount: number; complete: boolean; reasonCodes: string[] }; page: { nextCursor: string | null; hasMore: boolean }; assertCurrent(): void;
  /** Internal composition address. Never included in the adapter response. */
  sourceContext: { cohortRef: string | null; portfolio?: { reviewKey: string; reviewHash: string; validUntil: string; sourceCurrent: boolean } } };
const fail = (code: string, status = 503): never => { throw new NativeAnalyticsError(code, status); };
const freeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const denial = (error: unknown): 401 | 403 | null => error && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403) ? error.status : null;
const samePeriod = (a: NativeAnalyticsSnapshot["period"], b: NativeAnalyticsSnapshot["period"]) => a === null || b === null ? a === b : a.timezone === b.timezone && a.basis === b.basis && Date.parse(a.startAt) === Date.parse(b.startAt) && Date.parse(a.endAt) === Date.parse(b.endAt);

export function createNativeAnalyticsReader(options: NativeAnalyticsReaderOptions) {
  const scope = freeze(analyticsScopeSchema.parse(structuredClone(options.scope))), source = options.source, timeoutMs = options.timeoutMs ?? 10_000;
  if (options.referenceKey.length < 32) return fail("ANALYTICS_REFERENCE_KEY_INVALID", 500);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) return fail("ANALYTICS_TIMEOUT_INVALID", 500);
  const now = () => { const value = (options.now ?? Date.now)(); if (!Number.isSafeInteger(value)) return fail("ANALYTICS_INVALID_CLOCK", 500); return value; };
  const alias = (kind: string, value: string) => `analytics-${kind}-${createHmac("sha256", options.referenceKey).update(JSON.stringify(["analytics-native.v1", scope, kind, value])).digest("hex")}`;
  const cursorMac = (value: string) => createHmac("sha256", options.referenceKey).update(`analytics-cursor.v1:${value}`).digest("hex");
  const cursorSchema = z.object({ offset: z.number().int().min(1).max(1000), claim: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
  function validate(snapshot: NativeAnalyticsSnapshot, binding: NativeAnalyticsBinding, at: number) {
    if (digest(snapshot.binding) !== digest(binding)) return fail("ANALYTICS_BINDING_MISMATCH", 403);
    if (Date.parse(snapshot.observedAt) > at || Date.parse(snapshot.validUntil) <= at || at - Date.parse(snapshot.observedAt) >= ANALYTICS_ACCESS_MAX_AGE_MS) return fail("ANALYTICS_PUBLICATION_EXPIRED", 409);
    if (binding.request.period && !samePeriod(binding.request.period, snapshot.period)) return fail("ANALYTICS_BINDING_MISMATCH", 409);
    if (snapshot.window) {
      const period = snapshot.period;
      if (!period || period.timezone !== snapshot.window.timezone || localDay(Date.parse(period.startAt), period.timezone) !== snapshot.window.start || localDay(Date.parse(period.endAt) - 1, period.timezone) !== snapshot.window.end) return fail("ANALYTICS_SOURCE_INVALID");
      if ((Date.parse(snapshot.window.end) - Date.parse(snapshot.window.start)) / 86_400_000 + 1 > 366 || Date.parse(period.endAt) > Date.parse(snapshot.observedAt)) return fail("ANALYTICS_SOURCE_INVALID");
      const midnight = (value: string) => new Intl.DateTimeFormat("en-GB", { timeZone: period.timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(value)) === "00:00:00" && Date.parse(value) % 1000 === 0;
      if (!midnight(period.startAt) || !midnight(period.endAt)) return fail("ANALYTICS_SOURCE_INVALID");
    }
    const historicalRefs = snapshot.viewKey === "campaignFunnel" ? new Set(snapshot.facts.channels.flatMap(row => [row.historical.replies.proofRef, row.historical.agreements.proofRef]).filter((ref): ref is string => ref !== null)) : new Set<string>();
    for (const owner of snapshot.owners) {
      if (digest(owner.scope) !== digest(scope) || owner.principalRef !== binding.principal.principalRef || owner.requestDigest !== digest(binding.request)) return fail("ANALYTICS_BINDING_MISMATCH", 403);
      if (Date.parse(owner.observedAt) > Date.parse(snapshot.observedAt) || Date.parse(owner.validUntil) <= at) return fail("ANALYTICS_PUBLICATION_EXPIRED", 409);
      if (snapshot.viewKey !== "launchReconciliation" && !historicalRefs.has(owner.proofRef) && (!samePeriod(owner.period, snapshot.period) || owner.cohortRef !== snapshot.cohortRef)) return fail("ANALYTICS_BINDING_MISMATCH", 409);
      if (owner.owner === "commerceOrders" && owner.maxAgeMs > 15 * 60_000) return fail("ANALYTICS_SOURCE_INVALID");
    }
    const visit = (value: unknown, historical = false): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { for (const item of value) visit(item, historical); return; }
      const record = value as Record<string, unknown>;
      if (typeof record.proofRef === "string" && !snapshot.owners.some(owner => owner.proofRef === record.proofRef)) return fail("ANALYTICS_SOURCE_INVALID");
      if (snapshot.viewKey === "campaignFunnel" && "value" in record && record.value !== null && typeof record.proofRef === "string") {
        const basis = historical ? snapshot.facts.historicalBasis : { period: snapshot.period, cohortRef: snapshot.cohortRef };
        const owner = snapshot.owners.find(value => value.proofRef === record.proofRef)!;
        if (!basis || !samePeriod(owner.period, basis.period) || owner.cohortRef !== basis.cohortRef || historical && "definitionVersion" in basis && owner.definitionVersion !== basis.definitionVersion) return fail("ANALYTICS_BINDING_MISMATCH", 409);
      }
      for (const [key, item] of Object.entries(record)) {
        if (["observedAt", "eventAt", "requestedAt", "effectiveAt", "asOf", "anchorEventAt", "placedAt", "lastSuccessAt"].includes(key) && typeof item === "string" && Date.parse(item) > Date.parse(snapshot.observedAt)) return fail("ANALYTICS_SOURCE_INVALID");
        visit(item, historical || key === "historical");
      }
    };
    visit(snapshot.facts);
    if (snapshot.viewKey === "overviewSummary") {
      const facts = snapshot.facts;
      if (facts.portfolio && snapshot.owners.find(owner => owner.proofRef === facts.portfolio!.proofRef)?.owner !== "creatorPortfolio") return fail("ANALYTICS_SOURCE_INVALID");
      if (facts.postsTotal.value !== null && facts.postsTotal.value < facts.posts.length || new Set(facts.posts.map(post => post.postRef)).size !== facts.posts.length || new Set(facts.activity.map(row => row.activityRef)).size !== facts.activity.length) return fail("ANALYTICS_SOURCE_INVALID");
    }
    if (snapshot.viewKey === "attribution" && new Set(snapshot.facts.creators.map(row => row.creatorRef)).size !== snapshot.facts.creators.length) return fail("ANALYTICS_SOURCE_INVALID");
    if ("orders" in snapshot.facts && snapshot.facts.orders) {
      const input = snapshot.facts.orders, owner = snapshot.owners.find(value => value.proofRef === input.proofRef);
      if (!snapshot.window || !snapshot.period || !owner || owner.owner !== "commerceOrders" || digest(input.snapshot.scope) !== digest(scope) || digest(input.snapshot.window) !== digest(snapshot.window)) return fail("ANALYTICS_BINDING_MISMATCH", 403);
      for (const feed of input.snapshot.feeds) {
        if (owner.coverage === "complete" && feed.coverage !== "complete" || owner.sourceAsOf !== null && (feed.lastSuccessAt === null || Date.parse(owner.sourceAsOf) > Date.parse(feed.lastSuccessAt))) return fail("ANALYTICS_SOURCE_INVALID");
        if (feed.orders.some(row => Date.parse(row.placedAt) < Date.parse(snapshot.period!.startAt) || Date.parse(row.placedAt) >= Date.parse(snapshot.period!.endAt))) return fail("ANALYTICS_SOURCE_INVALID");
        for (const row of feed.orders) if (row.attributionEvidence) {
          if (row.attributionEvidence.sourceVersion !== owner.sourceVersion) return fail("ANALYTICS_BINDING_MISMATCH", 403);
          if (Date.parse(row.attributionEvidence.observedAt) > Date.parse(owner.observedAt)) return fail("ANALYTICS_SOURCE_INVALID");
        }
      }
    }
    if ("ads" in snapshot.facts && snapshot.facts.ads) {
      const input = snapshot.facts.ads, owner = snapshot.owners.find(value => value.proofRef === input.proofRef);
      if (!snapshot.window || !owner || owner.owner !== "adReporting" || digest(input.snapshot.scope) !== digest(scope) || digest(input.snapshot.window) !== digest(snapshot.window)) return fail("ANALYTICS_BINDING_MISMATCH", 403);
      for (const feed of input.snapshot.feeds) {
        if (owner.coverage === "complete" && feed.coverage !== "complete" || owner.sourceAsOf !== null && (feed.lastSuccessAt === null || Date.parse(owner.sourceAsOf) > Date.parse(feed.lastSuccessAt))) return fail("ANALYTICS_SOURCE_INVALID");
        for (const asset of feed.assets) if (asset.rightsGrant) {
          const grant = asset.rightsGrant;
          if (grant.accountRef !== owner.accountRef || grant.sourceVersion !== owner.sourceVersion) return fail("ANALYTICS_BINDING_MISMATCH", 403);
          if (Date.parse(grant.observedAt) > Date.parse(owner.observedAt)) return fail("ANALYTICS_SOURCE_INVALID");
        }
      }
    }
    if (snapshot.viewKey === "campaignFunnel") {
      const f = snapshot.facts, request = binding.request;
      if (request.viewKey !== "campaignFunnel") return fail("ANALYTICS_BINDING_MISMATCH", 403);
      const canonical = request.filters.campaignId === alias("campaign", f.campaignRef) && request.filters.cohort === alias("cohort", f.cohortRef);
      if ((!canonical && digest(request.filters) !== digest(f.selection)) || f.cohortRef !== snapshot.cohortRef) return fail("ANALYTICS_BINDING_MISMATCH", 403);
      if (new Set(f.channels.map(row => row.channel)).size !== f.channels.length) return fail("ANALYTICS_SOURCE_INVALID");
      for (const row of f.channels) {
        const steps = Object.values(row.steps).map(value => value.value);
        for (let index = 1; index < steps.length; index++) { const earlier = steps.slice(0, index).filter((value): value is number => value !== null); if (steps[index] !== null && earlier.some(value => steps[index]! > value)) return fail("ANALYTICS_SOURCE_INVALID"); }
        if (row.giftCap.value !== null && row.reserved.value !== null && row.steps.shipped.value !== null && row.reserved.value + row.steps.shipped.value > row.giftCap.value) return fail("ANALYTICS_SOURCE_INVALID");
      }
    }
    if (snapshot.viewKey === "launchReconciliation") for (const row of snapshot.facts.matrix) for (const cell of row.cells) {
      if (cell.value.proofRef === null) continue;
      const owner = snapshot.owners.find(value => value.proofRef === cell.value.proofRef)!;
      if (owner.cohortRef !== cell.cohortRef || !samePeriod(owner.period, cell.period) || owner.definitionVersion !== cell.definitionVersion || owner.sourceVersion !== cell.inputVersion) return fail("ANALYTICS_BINDING_MISMATCH", 409);
      if (cell.value.value !== null && (row.unit === "count" || row.unit === "minorUnits") && !Number.isSafeInteger(cell.value.value)) return fail("ANALYTICS_SOURCE_INVALID");
    }
  }
  function fence(snapshot: NativeAnalyticsSnapshot, binding: NativeAnalyticsBinding, signal?: AbortSignal) {
    if (signal?.aborted) return fail("ANALYTICS_REQUEST_CANCELLED", 499);
    validate(snapshot, binding, now());
    if (!source || typeof source.assertCurrent !== "function") return fail("ANALYTICS_SOURCE_FENCE_UNAVAILABLE");
    try { assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, now())); }
    catch (error) { if (error instanceof NativeAnalyticsError) throw new NativeAnalyticsError(error.code, error.status); const status = denial(error); if (status) return fail("ANALYTICS_SOURCE_DENIED", status); return fail("ANALYTICS_SOURCE_CHANGED", 409); }
  }
  async function read(input: unknown, principalInput: unknown, signal?: AbortSignal): Promise<NativeAnalyticsReadResult> {
    const parsed = nativeAnalyticsRequestSchema.safeParse(input), principal = analyticsPrincipalSchema.safeParse(principalInput);
    if (!parsed.success) return fail("ANALYTICS_REQUEST_INVALID", 400);
    if (!principal.success) return fail("ANALYTICS_UNAUTHENTICATED", 403);
    if (parsed.data.period) {
      const period = parsed.data.period, start = localDay(Date.parse(period.startAt), period.timezone), end = localDay(Date.parse(period.endAt) - 1, period.timezone);
      if (Date.parse(period.endAt) > now() || (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1 > 366) return fail("ANALYTICS_REQUEST_INVALID", 400);
    }
    if (!source) return fail("ANALYTICS_SOURCE_UNCONFIGURED");
    const binding = freeze(nativeAnalyticsBindingSchema.parse({ scope, principal: principal.data, request: parsed.data }));
    const controller = new AbortController();
    let raw: unknown;
    try { raw = await boundedSourceRead(() => source.read(binding, controller.signal), signal, timeoutMs); }
    catch (error) {
      if (error instanceof NativeAnalyticsError) throw new NativeAnalyticsError(error.code, error.status);
      const status = denial(error); if (status) return fail("ANALYTICS_SOURCE_DENIED", status);
      if (error && typeof error === "object" && "code" in error && error.code === "REQUEST_CANCELLED") return fail("ANALYTICS_REQUEST_CANCELLED", 499);
      if (error && typeof error === "object" && "code" in error && error.code === "SOURCE_READ_TIMEOUT") return fail("ANALYTICS_SOURCE_TIMEOUT", 504);
      return fail("ANALYTICS_SOURCE_UNAVAILABLE");
    } finally { controller.abort(); }
    if (raw === null) return fail("ANALYTICS_SOURCE_UNAVAILABLE");
    const snapshotResult = nativeAnalyticsSnapshotSchema.safeParse(raw);
    if (!snapshotResult.success) return fail("ANALYTICS_SOURCE_INVALID");
    const snapshot = freeze(structuredClone(snapshotResult.data));
    let publicationDeadline = Infinity;
    const assertCurrent = () => { fence(snapshot, binding, signal); if (now() >= publicationDeadline) return fail("ANALYTICS_PUBLICATION_EXPIRED", 409); };
    assertCurrent();
    const projectedAt = now();
    const detailDeadlines: number[] = [];
    if ("ads" in snapshot.facts && snapshot.facts.ads) {
      const input = snapshot.facts.ads, owner = snapshot.owners.find(value => value.proofRef === input.proofRef);
      if (owner) for (const feed of input.snapshot.feeds) for (const asset of feed.assets) if (asset.rightsGrant) {
        const deadline = Date.parse(asset.rightsGrant.observedAt) + owner.maxAgeMs;
        if (deadline > projectedAt) detailDeadlines.push(deadline);
      }
    }
    if ("orders" in snapshot.facts && snapshot.facts.orders) {
      const input = snapshot.facts.orders, owner = snapshot.owners.find(value => value.proofRef === input.proofRef);
      if (owner) for (const feed of input.snapshot.feeds) for (const row of feed.orders) if (row.attributionEvidence) {
        const deadline = Date.parse(row.attributionEvidence.observedAt) + Math.min(owner.maxAgeMs, 15 * 60_000);
        if (deadline > projectedAt) detailDeadlines.push(deadline);
      }
    }
    publicationDeadline = Math.min(Date.parse(snapshot.validUntil), Date.parse(snapshot.observedAt) + ANALYTICS_ACCESS_MAX_AGE_MS, ...snapshot.owners.map(owner => Date.parse(owner.validUntil)), ...snapshot.owners.flatMap(owner => owner.sourceAsOf !== null && Date.parse(owner.sourceAsOf) + owner.maxAgeMs > projectedAt ? [Date.parse(owner.sourceAsOf) + owner.maxAgeMs] : []), ...detailDeadlines);
    if ("ads" in snapshot.facts && snapshot.facts.ads && snapshot.window) {
      const timezone = snapshot.window.timezone, today = localDay(projectedAt, timezone);
      // expiresOn is inclusive in the source reporting timezone. Search only
      // inside this already-bounded read lease, so DST never assumes a 24h day.
      if (snapshot.facts.ads.snapshot.feeds.some(feed => feed.assets.some(asset => asset.expiresOn === today)) && localDay(publicationDeadline, timezone) > today) {
        let before = projectedAt, after = publicationDeadline;
        while (after - before > 1) {
          const middle = Math.floor((before + after) / 2);
          if (localDay(middle, timezone) > today) after = middle; else before = middle;
        }
        publicationDeadline = after;
      }
    }
    const data = projectNativeAnalytics(snapshot, alias, projectedAt);
    data.provenance.validUntil = new Date(publicationDeadline).toISOString();
    let nextCursor: string | null = null;
    if (data.viewKey === "paidMedia" && binding.request.viewKey === "paidMedia") {
      const request = binding.request, { cursor, limit } = request.page;
      const claim = digest([scope, binding.principal, { ...request, page: { cursor: null, limit } }, snapshot.period, snapshot.sourceVersion, snapshot.permissionVersion, snapshot.owners.map(owner => [owner.proofRef, owner.sourceVersion, owner.permissionVersion, owner.definitionVersion])]);
      let offset = 0;
      if (cursor) {
        const [encoded, signature, extra] = cursor.split(".");
        if (!encoded || !signature || extra || !/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(cursorMac(encoded), "hex"))) return fail("ANALYTICS_CURSOR_INVALID", 400);
        let decoded: unknown;
        try { decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { return fail("ANALYTICS_CURSOR_INVALID", 400); }
        const parsedCursor = cursorSchema.safeParse(decoded);
        if (!parsedCursor.success) return fail("ANALYTICS_CURSOR_INVALID", 400);
        if (parsedCursor.data.claim !== claim) return fail("ANALYTICS_CURSOR_STALE", 409);
        offset = parsedCursor.data.offset;
        if (offset >= data.assets.length) return fail("ANALYTICS_CURSOR_STALE", 409);
      }
      const end = offset + limit;
      if (end < data.assets.length) { const encoded = Buffer.from(JSON.stringify({ offset: end, claim })).toString("base64url"); nextCursor = `${encoded}.${cursorMac(encoded)}`; }
      data.assets = data.assets.slice(offset, end); data.pagination = { returned: data.assets.length, nextCursor };
    }
    let factCount = 0, resolvedFacts = 0;
    const tally = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(tally); return; }
      const record = value as Record<string, unknown>;
      if ("value" in record && "state" in record && "provisional" in record) { factCount++; if (record.state !== "unknown" && record.provisional === false) resolvedFacts++; return; }
      Object.values(record).forEach(tally);
    };
    tally(data);
    if (resolvedFacts < factCount && data.coverage.state === "complete") data.coverage = { state: "partial", reasonCodes: ["INPUT_UNKNOWN"] };
    const stale = data.freshness.state !== "current", complete = !stale && data.coverage.state === "complete";
    const observedSources = data.sources.filter(owner => owner.coverage === "complete" && (!owner.sync || ["changed", "unchanged"].includes(owner.sync.state)) && owner.sourceAsOf !== null && now() - Date.parse(owner.sourceAsOf) < owner.maxAgeMs).length;
    const expectedCount = data.sources.length + factCount, observedCount = observedSources + resolvedFacts;
    const result: NativeAnalyticsReadResult = { data, version: `analytics-v1-${digest([binding, snapshot])}`, dataState: stale ? "stale" : complete ? "ready" : "partial", coverage: { expectedCount, observedCount, missingCount: expectedCount - observedCount, complete, reasonCodes: [...data.coverage.reasonCodes, ...(stale ? ["SOURCE_STALE"] : [])] }, page: { nextCursor, hasMore: nextCursor !== null }, assertCurrent, sourceContext: { cohortRef: snapshot.cohortRef } };
    if (snapshot.viewKey === "overviewSummary" && snapshot.facts.portfolio) {
      const p = snapshot.facts.portfolio, owner = snapshot.owners.find(row => row.proofRef === p.proofRef)!;
      result.sourceContext.portfolio = { reviewKey: p.reviewKey, reviewHash: p.reviewHash, validUntil: owner.validUntil,
        sourceCurrent: owner.coverage === "complete" && owner.sourceAsOf !== null && now() - Date.parse(owner.sourceAsOf) < owner.maxAgeMs && (!owner.sync || ["changed", "unchanged"].includes(owner.sync.state)) };
    }
    assertCurrent();
    return result;
  }
  return { read, publicRef: alias };
}
