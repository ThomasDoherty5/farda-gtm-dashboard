import type { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { approvalScopeSchema, principalSchema, type ApprovalPrincipal, type ApprovalScope } from "../approvals/contract.ts";
import { digest } from "../config.ts";
import { boundedSourceRead } from "../actions/readBoundary.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { trafficAggregateBindingSchema, trafficBindingSchema, trafficCapabilitySchema, trafficClickAggregateSchema, trafficFiltersSchema, trafficImportPrincipalSchema, trafficImportRequestSchema, trafficOrderAggregateSchema, trafficReportEnvelopeSchema,
  type TrafficAggregateBinding, type TrafficAuthority, type TrafficBinding, type TrafficCapability, type TrafficClickAggregate, type TrafficImportPrincipal, type TrafficOrderAggregate, type TrafficReportEnvelope, type TrafficSegment } from "./contract.ts";
import { SiteTrafficRepository, trafficDefinitionKey } from "./repository.ts";
import { parseTrafficReport } from "./parser.ts";
import { projectSiteTraffic, publicTrafficSegment, selectTrafficRows, trafficCoverageThrough } from "./projection.ts";
import { SiteTrafficError, TRAFFIC_SOURCE_MAX_LEASE_MS, type CreatorClickSource, type MatchingCommerceSource, type SiteTrafficSource } from "./source.ts";
import type { NativeSiteTrafficView, TrafficImportReceipt } from "./views.ts";

export { SiteTrafficError } from "./source.ts";
export type SiteTrafficServiceOptions = { db: DatabaseSync; scope: ApprovalScope; referenceKey: string; source?: SiteTrafficSource; orders?: MatchingCommerceSource; clicks?: CreatorClickSource; now?: () => number; timeoutMs?: number };
export type TrafficImportOptions = { assertCallerCurrent: () => void; signal?: AbortSignal };
export type SiteTrafficReadResult = { data: NativeSiteTrafficView; version: string; assertCurrent(): void };
export type SiteTrafficImportResult = { receipt: TrafficImportReceipt; assertCurrent(): void };
const freeze = <T>(value: T): T => { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const fail = (code: string, status = 409): never => { throw new SiteTrafficError(code, status); };
const denialStatus = (error: unknown): 401 | 403 | null => error && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403) ? error.status : null;

export function createSiteTrafficService(options: SiteTrafficServiceOptions) {
  const scope = approvalScopeSchema.parse(structuredClone(options.scope)), source = options.source, ordersOwner = options.orders, clicksOwner = options.clicks;
  const repository = new SiteTrafficRepository(options.db, scope, options.referenceKey);
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new SiteTrafficError("TRAFFIC_TIMEOUT_INVALID", 500);
  const now = () => { const stamp = (options.now ?? Date.now)(); if (!Number.isSafeInteger(stamp)) return fail("INVALID_CLOCK", 500); return stamp; };
  const alias = (kind: string, value: string) => "traffic-" + kind + "-" + createHmac("sha256", options.referenceKey).update(JSON.stringify([scope, kind, value])).digest("hex");
  function authority(authority: TrafficAuthority, binding: TrafficBinding): void {
    const stamp = now(), observed = Date.parse(authority.observedAt), until = Date.parse(authority.validUntil);
    if (digest(authority.binding) !== digest(binding)) return fail("TRAFFIC_SOURCE_BINDING_DENIED", 403);
    if (observed > stamp || until <= stamp || until <= observed || until - observed > TRAFFIC_SOURCE_MAX_LEASE_MS || stamp - observed > TRAFFIC_SOURCE_MAX_LEASE_MS) return fail("TRAFFIC_SOURCE_STALE");
  }
  function assertSource(snapshot: TrafficCapability | TrafficReportEnvelope, binding: TrafficBinding): void {
    authority(snapshot.authority, binding);
    if (!source || typeof source.assertCurrent !== "function") return fail("TRAFFIC_SOURCE_FENCE_UNAVAILABLE", 503);
    try { assertSynchronousVoid(() => source.assertCurrent(snapshot, binding, now())); }
    catch (error) { if (error instanceof SiteTrafficError) throw new SiteTrafficError(error.code, error.status); const denied = denialStatus(error); if (denied) return fail("TRAFFIC_SOURCE_DENIED", denied); return fail("TRAFFIC_SOURCE_CHANGED"); }
  }
  async function bounded<T>(read: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    try { return await boundedSourceRead(() => read(controller.signal), signal, timeoutMs); }
    catch (error) {
      if (error instanceof SiteTrafficError) throw new SiteTrafficError(error.code, error.status);
      const denied = denialStatus(error); if (denied) return fail("TRAFFIC_SOURCE_DENIED", denied);
      if (error && typeof error === "object" && "code" in error && error.code === "REQUEST_CANCELLED") return fail("REQUEST_CANCELLED", 499);
      if (error && typeof error === "object" && "code" in error && error.code === "SOURCE_READ_TIMEOUT") return fail("SOURCE_READ_TIMEOUT", 504);
      return fail("TRAFFIC_SOURCE_UNAVAILABLE", 503);
    } finally { controller.abort(); }
  }
  async function capability(binding: TrafficBinding, signal?: AbortSignal): Promise<TrafficCapability> {
    if (!source) return fail("TRAFFIC_SOURCE_UNCONFIGURED", 503);
    const raw = await bounded(abort => source.readCapability(binding, abort), signal), parsed = trafficCapabilitySchema.safeParse(raw);
    if (!parsed.success) return fail("TRAFFIC_CAPABILITY_INVALID", 503);
    const result = freeze(structuredClone(parsed.data)); assertSource(result, binding);
    return result;
  }
  async function optionalAggregate(read: (signal: AbortSignal) => Promise<unknown>, signal?: AbortSignal): Promise<unknown | null> {
    try { return await bounded(read, signal); }
    catch (error) { if (error instanceof SiteTrafficError && [503, 504].includes(error.status)) return null; throw error; }
  }
  async function importSource(input: unknown, principalInput: TrafficImportPrincipal, caller: TrafficImportOptions): Promise<SiteTrafficImportResult> {
    const parsed = trafficImportRequestSchema.safeParse(input), machine = trafficImportPrincipalSchema.safeParse(principalInput);
    if (!parsed.success) return fail("TRAFFIC_IMPORT_REQUEST_INVALID", 422);
    if (!machine.success || !caller || typeof caller.assertCallerCurrent !== "function") return fail("TRAFFIC_IMPORT_CALLER_DENIED", 403);
    const request = freeze(parsed.data), principal = freeze(machine.data), binding = freeze(trafficBindingSchema.parse({ scope, principal, request: { operation: "import", input: request } }));
    const assertCaller = () => { if (caller.signal?.aborted) return fail("REQUEST_CANCELLED", 499); assertSynchronousVoid(caller.assertCallerCurrent); };
    assertCaller();
    const cap = await capability(binding, caller.signal);
    const assertGrant = () => { assertCaller(); assertSource(cap, binding); if (!cap.canImport || cap.state !== "ready") return fail("TRAFFIC_IMPORT_DENIED", 403); };
    assertGrant();
    const prior = repository.lookup(request, principal);
    if (prior) {
      // Pure original-receipt recovery under current permission. A changed source definition never rebases this key.
      const assertCurrent = () => { assertGrant(); if (digest(repository.lookup(request, principal)) !== digest(prior)) return fail("TRAFFIC_RECEIPT_CHANGED"); };
      assertCurrent(); return { receipt: structuredClone(prior), assertCurrent };
    }
    if (!cap.definition || cap.definition.version !== request.expectedDefinitionVersion) return fail("TRAFFIC_DEFINITION_CHANGED");
    const raw = await bounded(abort => source!.readReport(binding, abort), caller.signal);
    assertGrant();
    const envelope = trafficReportEnvelopeSchema.safeParse(raw);
    if (!envelope.success) return fail("TRAFFIC_REPORT_INVALID", 422);
    const reportSource = freeze(structuredClone(envelope.data)); assertSource(reportSource, binding);
    if (reportSource.importRef !== request.importRef || reportSource.authority.sourceVersion !== cap.authority.sourceVersion || reportSource.authority.permissionVersion !== cap.authority.permissionVersion || digest(reportSource.authority.provenance) !== digest(cap.authority.provenance)) return fail("TRAFFIC_REPORT_BINDING_CHANGED");
    const report = freeze(parseTrafficReport(reportSource.body));
    if (digest(report.definition) !== digest(cap.definition)) return fail("TRAFFIC_DEFINITION_CHANGED");
    if (report.partitions.some(partition => Date.parse(partition.sourceAsOf) > Date.parse(reportSource.authority.observedAt) || Date.parse(partition.sourceAsOf) > now())) return fail("TRAFFIC_REPORT_FUTURE", 422);
    const assertImport = () => { assertGrant(); assertSource(reportSource, binding); };
    const receipt = repository.import(request, principal, report, reportSource.authority.provenance, new Date(now()).toISOString(), assertImport);
    const assertCurrent = () => { assertImport(); if (digest(repository.lookup(request, principal)) !== digest(receipt)) return fail("TRAFFIC_RECEIPT_CHANGED"); };
    assertCurrent(); return { receipt: structuredClone(receipt), assertCurrent };
  }
  async function read(input: unknown, principalInput: ApprovalPrincipal, signal?: AbortSignal): Promise<SiteTrafficReadResult> {
    const filters = trafficFiltersSchema.safeParse(input), principal = principalSchema.safeParse(principalInput);
    if (!filters.success) return fail("TRAFFIC_FILTERS_INVALID", 422);
    if (!principal.success) return fail("TRAFFIC_PRINCIPAL_DENIED", 403);
    const binding = freeze(trafficBindingSchema.parse({ scope, principal: principal.data, request: { operation: "read", filters: filters.data } }));
    if (!source) {
      const assertCurrent = () => { if (signal?.aborted) return fail("REQUEST_CANCELLED", 499); now(); };
      const data = projectSiteTraffic({ capability: null, window: null, segment: null, partitions: [], orders: null, clicks: null, latest: null, firstActual: null, alias, now: now() });
      assertCurrent(); return { data, version: "traffic-v1-" + digest(data), assertCurrent };
    }
    const cap = await capability(binding, signal), definition = cap.definition;
    if (definition) repository.assertDefinition(definition);
    const window = cap.state === "ready" ? cap.currentWindow : null;
    if (window && filters.data.period && digest(filters.data.period) !== digest({ startDay: window.startDay, endDayExclusive: window.endDayExclusive, timezone: window.timezone })) return fail("TRAFFIC_WINDOW_CHANGED");
    const segment: TrafficSegment | null = definition ? filters.data.segment.kind === "all" ? definition.segments.find(value => value.kind === "all") ?? null : definition.segments.find(value => publicTrafficSegment(value, alias).segmentRef === (filters.data.segment.kind === "utm" ? filters.data.segment.segmentRef : "")) ?? null : null;
    if (definition && !segment) return fail("TRAFFIC_SEGMENT_CHANGED");
    const definitionKey = definition ? trafficDefinitionKey(definition, cap.authority.provenance) : null;
    const readStored = () => definitionKey && window ? repository.read(definitionKey, window.startDay, window.endDayExclusive) : [];
    const partitions = freeze(readStored()), localHash = digest(partitions), fences: Array<() => void> = [];
    const assertCurrent = () => {
      if (signal?.aborted) return fail("REQUEST_CANCELLED", 499);
      assertSource(cap, binding);
      if (definition) repository.assertDefinition(definition);
      if (digest(readStored()) !== localHash) return fail("TRAFFIC_IMPORT_CHANGED");
      for (const fence of fences) fence();
    };
    let orders: TrafficOrderAggregate | null = null, clicks: TrafficClickAggregate | null = null;
    let orderReason: "ORDERS_UNAVAILABLE" | "ORDER_COHORT_MISMATCH" = "ORDERS_UNAVAILABLE", clickReason: "CLICKS_UNAVAILABLE" | "CLICK_WINDOW_MISMATCH" = "CLICKS_UNAVAILABLE";
    if (definition && window && segment) {
      const request = freeze(trafficAggregateBindingSchema.parse({ binding, definitionRef: definition.definitionRef, definitionVersion: definition.version, sourceAccountRef: definition.sourceAccountRef, window, segment,
        coverageThrough: trafficCoverageThrough(window, partitions, selectTrafficRows(partitions, segment)) }));
      const assertAggregate = <T extends { authority: TrafficAuthority }>(value: T, owner: { assertCurrent(snapshot: T, binding: TrafficAggregateBinding, now: number): void }) => {
        authority(value.authority, binding);
        if (typeof owner.assertCurrent !== "function") return fail("TRAFFIC_SOURCE_FENCE_UNAVAILABLE", 503);
        try { assertSynchronousVoid(() => owner.assertCurrent(value, request, now())); } catch (error) { if (error instanceof SiteTrafficError) throw new SiteTrafficError(error.code, error.status); const denied = denialStatus(error); if (denied) return fail("TRAFFIC_SOURCE_DENIED", denied); return fail("TRAFFIC_SOURCE_CHANGED"); }
      };
      if (ordersOwner && request.coverageThrough) {
        const raw = await optionalAggregate(abort => ordersOwner.readAggregate(request, abort), signal); assertCurrent();
        const parsed = trafficOrderAggregateSchema.safeParse(raw);
        if (parsed.success) {
          const value = freeze(structuredClone(parsed.data)); assertAggregate(value, ordersOwner);
          fences.push(() => assertAggregate(value, ordersOwner));
          if (digest(value.request) === digest(request) && Date.parse(value.coverageThrough) === Date.parse(request.coverageThrough) && (value.coverage !== "complete" || Date.parse(value.coverageThrough) === Date.parse(window.endAt)) && value.authority.provenance.evidenceStage === cap.authority.provenance.evidenceStage) orders = value;
          else orderReason = "ORDER_COHORT_MISMATCH";
        } else if (raw !== null) orderReason = "ORDER_COHORT_MISMATCH";
      }
      if (clicksOwner) {
        const raw = await optionalAggregate(abort => clicksOwner.readAggregate(request, abort), signal); assertCurrent();
        const parsed = trafficClickAggregateSchema.safeParse(raw);
        if (parsed.success) {
          const value = freeze(structuredClone(parsed.data)); assertAggregate(value, clicksOwner);
          fences.push(() => assertAggregate(value, clicksOwner));
          if (digest(value.request) === digest(request) && Date.parse(value.sourceAsOf) <= Date.parse(value.authority.observedAt) && Date.parse(value.sourceAsOf) <= now() && value.authority.provenance.evidenceStage === cap.authority.provenance.evidenceStage) clicks = value;
          else clickReason = "CLICK_WINDOW_MISMATCH";
        } else if (raw !== null) clickReason = "CLICK_WINDOW_MISMATCH";
      }
    }
    const latest = definitionKey ? repository.latest(definitionKey) : null, firstActual = definition ? repository.firstActual(definition.sourceAccountRef) : null;
    const evidenceHash = digest([latest, firstActual]);
    fences.push(() => { if (digest([definitionKey ? repository.latest(definitionKey) : null, definition ? repository.firstActual(definition.sourceAccountRef) : null]) !== evidenceHash) return fail("TRAFFIC_IMPORT_CHANGED"); });
    const data = projectSiteTraffic({ capability: cap, window, segment, partitions, orders, clicks, orderReason, clickReason, latest, firstActual, alias, now: now() });
    const deadlines = [Date.parse(cap.authority.validUntil), ...(orders ? [Date.parse(orders.authority.validUntil)] : []), ...(clicks ? [Date.parse(clicks.authority.validUntil)] : [])];
    if (data.freshness.state === "current" && data.freshness.sourceAsOf && definition) deadlines.push(Date.parse(data.freshness.sourceAsOf) + definition.freshnessMaxAgeMs);
    const deadline = Math.min(...deadlines);
    fences.push(() => { if (now() >= deadline) return fail("TRAFFIC_PUBLICATION_EXPIRED"); });
    data.provenance.validUntil = new Date(deadline).toISOString();
    assertCurrent(); return { data: freeze(data), version: "traffic-v1-" + digest(data), assertCurrent };
  }
  return { read, importSource };
}
export type SiteTrafficService = ReturnType<typeof createSiteTrafficService>;
