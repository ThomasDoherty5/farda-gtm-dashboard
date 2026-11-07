import { createHash, createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { creatorPlatformFilterSchema, savedCreatorPlatformSchema, type CreatorPlatformKey, type PlatformMetric, type PlatformRow } from "./creatorPlatformViews.ts";
import { sealCollaborationRef } from "./creatorPlatformReferences.ts";
import { projectFunnel } from "./funnelProjection.ts";
import { FunnelError, type FunnelRepository } from "./funnelStore.ts";
import type { FunnelEvent, LivePipeline } from "./funnelContract.ts";
import { openOperationsToken, sealOperationsToken } from "./operationsTokens.ts";
import type { OperationsScope } from "./operations.ts";
export { creatorPlatformFilterSchema, creatorPlatformKeys } from "./creatorPlatformViews.ts";

type Input = { viewKey: CreatorPlatformKey; filters: unknown; db: DatabaseSync; funnel: FunnelRepository; scope: OperationsScope;
  secret: string; role: "reader" | "reviewer"; limit: number; cursor: string | null; now?: () => number };
const cursorSchema = z.object({ context: z.string(), asOf: z.string().datetime(), watermark: z.number().int().nonnegative().safe(),
  offset: z.number().int().positive(), expires: z.number().int().positive() }).strict();
const unique = <T,>(values: T[]) => [...new Set(values)];
const iso = (raw: string | null | undefined) => raw && Number.isFinite(Date.parse(raw)) ? new Date(raw).toISOString() : null;
const publicOwners = new Set(["Founder", "Operations", "Operator", "Creator", "Reviewer", "Finance", "Support", "Creator operations"]);
const safeStrings = new Set(["Source access incomplete", "Unmapped native state", "Order attribution disputed",
  "Review original video", "Review qualification", "Review offer approval", "Check dispatch queue", "Check native response",
  "Verify accepted terms", "Verify tracking", "Review agreed content", "Inspect attribution", "Inspect source record",
  "Keep suppression; a new opportunity requires fresh approval", "declined", "expired", "optOut"]);
const sourcePlatform = (source: string) => {
  const key = source.trim().toLowerCase().replace(/[ _]/g, "-");
  if (key === "social-cat") return "Social Cat";
  if (key === "tiktok" || key === "tiktok-shop") return "TikTok";
  return null;
};
const acquisitionPlatform = (view: CreatorPlatformKey) => view.startsWith("socialCat") ? "Social Cat" : "TikTok";
const purpose = "creator-platform-list.v1";
export function nativePost(event: FunnelEvent) {
  const source = event.sourceAccount.source.toLowerCase().replace(/[ _]/g, "-");
  return event.evidenceRef.access === "verified" &&
    ((event.network === "instagram" && ["instagram", "instagram-insights", "meta"].includes(source)) ||
      (event.network === "tiktok" && ["tiktok", "tiktok-shop", "tiktok-insights"].includes(source)));
}

function makeAlias(secret: string, scope: OperationsScope) {
  const key = createHmac("sha256", secret).update(JSON.stringify(["creator-platform-alias.v1", scope.workspaceId, scope.accountId, scope.environment])).digest();
  return (kind: string, raw: string) => kind + "-" + createHmac("sha256", key).update(JSON.stringify([kind, raw])).digest("hex").slice(0, 20);
}
type Alias = ReturnType<typeof makeAlias>;
function labelOwner(raw: string | null, alias: Alias) { return raw === null ? null : publicOwners.has(raw) ? raw : alias("owner", raw); }
function labelWindow(raw: string | null | undefined, alias: Alias) {
  if (!raw) return null;
  return /^(?:\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?(?:\s*(?:\/|to|–|—)\s*\d{4}-\d{2}-\d{2}(?:T[\d:.+-]+Z?)?)?|\d{1,3}\s*(?:d|days?))$/i.test(raw)
    ? raw : alias("window", raw);
}
function rowView(row: LivePipeline["queue"][number], facts: FunnelEvent[], alias: Alias, input: Input): PlatformRow {
  const latest = facts.at(-1)!;
  const collabs = unique(facts.flatMap(e => e.collaborationRef?.identityState === "resolved" && e.collaborationRef.canonicalId ? [e.collaborationRef.canonicalId] : []));
  const delivery = new Map<string, FunnelEvent>();
  const production = new Set<FunnelEvent["eventType"]>(["briefAccepted", "productionBlocked", "productionSubmitted", "contentAccepted", "publicationPlanned", "scheduled", "published", "removed"]);
  for (const e of facts) {
    const id = e.details.deliverableId ?? e.details.postId;
    if (id && production.has(e.eventType)) delivery.set(JSON.stringify([e.collaborationRef?.canonicalId, e.network, id]), e);
  }
  const dated = [...facts].reverse().find(e => e.details.dueAt !== undefined);
  return {
    id: alias("opportunity", row.id), creator: alias("creator", row.creator), account: alias("account", JSON.stringify([row.source, row.account])),
    opportunity: row.route, stage: row.stage, owner: labelOwner(row.owner, alias), dueAt: iso(dated?.details.dueAt), ageDays: row.ageDays,
    observedAt: new Date(Math.max(...facts.map(e => Date.parse(e.observedAt)))).toISOString(),
    blockers: row.blockers.map(reason => safeStrings.has(reason) ? reason : alias("blocker", reason)),
    nextAction: !facts.some(e => e.details.nextAction) || safeStrings.has(row.nextAction) ? row.nextAction : "Inspect the saved " + row.stage + " evidence",
    networks: unique(facts.map(e => e.network)), checkouts: unique(facts.map(e => e.checkout)),
    payouts: unique(facts.flatMap(e => e.evidenceRef.access === "verified" && e.details.payoutOwner ? [e.details.payoutOwner] : [])),
    collaborations: collabs.map(id => sealCollaborationRef(input.scope, input.secret, id)),
    deliveries: [...delivery].map(([id, e]) => ({ id: alias("deliverable", id), state: e.eventType, observedAt: new Date(e.observedAt).toISOString() })),
    evidence: [...facts].reverse().slice(0, 12).map(e => ({ state: e.eventType, observedAt: new Date(e.observedAt).toISOString() })),
    historyTotal: facts.length, terms: facts.some(e => e.eventType === "terms" && e.evidenceRef.access === "verified") ? "accepted" : "no saved acceptance",
    historicalPayable: facts.some(e => e.eventType === "legacyPayable"), policyVersion: alias("policy", latest.policyOfferApprovalVersions.policy),
    qualification: facts.some(e => e.eventType === "qualified") ? "Qualification observed" : facts.some(e => e.eventType === "directReviewed") ? "Direct review observed" : "Unknown",
  };
}

function latestPosts(events: FunnelEvent[]) {
  // Native post identity spans network, publishing account and post. Two opportunities can refer to one post.
  const posts = new Map<string, { event: FunnelEvent; conflict: boolean }>();
  for (const event of events.filter(e => e.eventType === "postMetrics")) {
    const key = JSON.stringify([event.network, event.sourceAccount.sourceId ?? event.sourceAccount.accountId, event.details.postId]);
    const previous = posts.get(key);
    const delta = previous ? Date.parse(event.observedAt) - Date.parse(previous.event.observedAt) : 1;
    if (delta > 0) { posts.set(key, { event, conflict:false }); continue; }
    if (delta === 0 && previous) {
      const signature = (e:FunnelEvent) => JSON.stringify([e.details.views,e.details.engagements,e.evidenceRef.access,e.evidenceRef.window,e.evidenceRef.definition,e.evidenceRef.unit,nativePost(e)]);
      if (signature(event) !== signature(previous.event)) previous.conflict = true;
    }
  }
  return [...posts].map(([key,item]) => ({key,...item})).sort((a,b) => Date.parse(b.event.observedAt)-Date.parse(a.event.observedAt) || a.key.localeCompare(b.key));
}

function metrics(events: FunnelEvent[], posts: ReturnType<typeof latestPosts>, scope: LivePipeline, asOf: string, alias: Alias): PlatformMetric[] {
  const samples = posts.map(post => post.event);
  const windows = unique(samples.map(e => e.evidenceRef.window));
  const comparable = samples.length > 0 && posts.every(p => !p.conflict) && samples.every(nativePost) && windows.length === 1 && !!windows[0] &&
    unique(samples.map(e => JSON.stringify([e.evidenceRef.definition, e.evidenceRef.unit]))).length === 1;
  const views = comparable && samples.every(e => e.details.views != null) ? samples.reduce((n,e) => n + e.details.views!,0) : null;
  const engagements = comparable && samples.every(e => e.details.engagements != null) ? samples.reduce((n,e) => n + e.details.engagements!,0) : null;
  const window = windows.length === 1 ? labelWindow(windows[0], alias) : null;
  const postReason = !samples.length ? "No saved native post observations." : "Coverage, definitions or observation windows are incomplete.";
  const output: PlatformMetric[] = [
    { label: "Views", value: views !== null && Number.isSafeInteger(views) ? views : null, unit: "views", denominator: samples.length, window, reason: views === null || !Number.isSafeInteger(views) ? postReason : null },
    { label: "Engagement rate", value: views !== null && Number.isSafeInteger(views) && views > 0 && engagements !== null && Number.isSafeInteger(engagements) ? engagements / views * 100 : null, unit: "%", denominator: views !== null && Number.isSafeInteger(views) ? views : null,
      window, reason: views === null || engagements === null || !Number.isSafeInteger(views) || !Number.isSafeInteger(engagements) ? postReason : views === 0 ? "Zero observed views." : null },
  ];
  // The canonical funnel owns maturity, order corrections, duplicate attribution and refunds. Absence of an order receipt cannot establish a zero.
  const financial = events.filter(e => ["retainedOrder", "refund"].includes(e.eventType) && e.maturationAt && Date.parse(e.maturationAt) <= Date.parse(asOf));
  const moneyWindows = unique(financial.map(e => e.details.attributionWindow ?? null));
  const versions = unique(financial.map(e => e.details.attributionVersion ?? null));
  const valid = financial.length > 0 && financial.every(e => e.evidenceRef.access === "verified") && moneyWindows.length === 1 && moneyWindows[0] && versions.length === 1 && versions[0];
  for (const label of ["Attributed orders", "Attributed net sales"] as const) {
    const metric = scope.outcomes.find(outcome => outcome.name === label)!;
    const value = valid && metric.value !== null && Number.isSafeInteger(metric.value) ? metric.value : null;
    output.push({ label, value, unit: metric.unit, denominator: metric.denominator, window: moneyWindows.length === 1 ? labelWindow(moneyWindows[0], alias) : null,
      reason: value === null ? "Verified mature order receipts with a comparable attribution version and window are required." : null });
  }
  return output;
}

export function readCreatorPlatformView(input: Input) {
  const filters = creatorPlatformFilterSchema.parse(input.filters);
  z.number().int().min(1).max(100).parse(input.limit);
  const savedScope = input.db.prepare("SELECT workspace_id, account_id FROM agent_scope WHERE id=1").get();
  if (input.scope.environment !== "sandbox" || savedScope?.workspace_id !== input.scope.workspaceId || savedScope.account_id !== input.scope.accountId)
    throw new FunnelError("CREATOR_PLATFORM_SCOPE_MISMATCH", 403);
  const context = createHash("sha256").update(JSON.stringify([input.role,input.viewKey,filters,input.limit])).digest("hex");
  const now = (input.now ?? Date.now)();
  let page: z.infer<typeof cursorSchema> | null = null;
  if (input.cursor !== null) {
    try { page = cursorSchema.parse(openOperationsToken(input.scope,input.secret,purpose,input.cursor)); }
    catch { throw new FunnelError("CREATOR_PLATFORM_CURSOR_INVALID",400); }
    if (page.context !== context || page.expires <= now) throw new FunnelError("CREATOR_PLATFORM_CURSOR_INVALID",400);
  }
  const snapshot = input.funnel.snapshot({ ...(filters.start ? {start:filters.start+"T00:00:00Z"} : {}),
    ...(filters.end ? {end:filters.end+"T00:00:00Z"} : {}), ...(page ? {asOf:page.asOf} : {}) }, page?.watermark);
  const asOf = snapshot.projection.asOf;
  const platform = acquisitionPlatform(input.viewKey), alias = makeAlias(input.secret,input.scope);
  const eventMap = new Map(snapshot.events.map(event => [event.eventId,event]));
  const records = snapshot.projection.queue.filter(row => sourcePlatform(row.source) === platform).map(row => {
    const facts = row.facts.map(fact => eventMap.get(fact.eventId)!);
    return { row, facts };
  }).filter(({ row, facts }) =>
    (!filters.owner || filters.owner === "all" || labelOwner(row.owner,alias) === filters.owner) &&
    (!filters.network || filters.network === "all" || facts.some(e => e.network === filters.network)) &&
    (!filters.q?.trim() || [alias("opportunity",row.id),alias("creator",row.creator),labelOwner(row.owner,alias),row.stage]
      .some(value => value?.toLowerCase().includes(filters.q!.trim().toLowerCase()))));
  const events = records.flatMap(item => item.facts);
  const metricEvents = filters.network && filters.network !== "all" ? events.filter(e => e.network === filters.network) : events;
  const ids = new Set(records.map(item => item.row.id));
  const totals = projectFunnel(snapshot.events,{},asOf,ids);
  const money = projectFunnel(snapshot.events,{},asOf,ids,filters.network === "all" ? undefined : filters.network);
  const start = page?.offset ?? 0;
  if (start > records.length || (page && start === records.length)) throw new FunnelError("CREATOR_PLATFORM_CURSOR_INVALID",400);
  const visible = records.slice(start, start + input.limit);
  const next = start + visible.length;
  const nextCursor = next < records.length ? sealOperationsToken(input.scope,input.secret,purpose,{
    context, asOf, watermark:snapshot.watermark, offset:next, expires:page?.expires ?? now + 15*60_000,
  }) : null;
  const posts = latestPosts(metricEvents);
  const lanes = new Map<string,{checkout:string;payout:string;opportunities:number}>();
  for (const { facts } of records) {
    const routes = unique(facts.map(e=>e.checkout));
    const owners = unique(facts.flatMap(e=>e.evidenceRef.access==="verified" && e.details.payoutOwner ? [e.details.payoutOwner] : []));
    const checkout = routes.length===1 ? routes[0]! : "multiple observed routes", payout = owners.length ? owners.sort().join(", ") : "unknown";
    const key=JSON.stringify([checkout,payout]);
    const entry=lanes.get(key) ?? {checkout,payout,opportunities:0}; entry.opportunities++; lanes.set(key,entry);
  }
  const data = savedCreatorPlatformSchema.parse({
    kind:"saved-creator-platform", viewKey:input.viewKey, platform, asOf, cohortStart:filters.start ?? null, cohortEnd:filters.end ?? null,
    providerCoverage:"unknown", total:records.length, offset:start, records:visible.map(({row,facts})=>rowView(row,facts,alias,input)),
    stages:Object.entries(totals.queueCounts).map(([state,count])=>({state,count})),
    achievements:totals.milestones.map(m=>({state:m.key,count:m.reached})),
    metrics:metrics(metricEvents,posts,money,asOf,alias), observedEvents:events.length, observedCreators:unique(records.map(r=>r.row.creator)).length,
    sourceOutages:events.filter(e=>e.eventType==="sourceOutage").length, unknownStates:events.filter(e=>e.eventType==="unknownState").length,
    latestObservation:events.length ? new Date(Math.max(...events.map(e=>Date.parse(e.observedAt)))).toISOString() : null,
    postSampleTotal:posts.length,
    postSamples:posts.slice(0,12).map(({key,event,conflict}) => {
      const verified = nativePost(event) && !conflict;
      return {post:alias("post",key),network:event.network,observedAt:new Date(event.observedAt).toISOString(),views:verified ? event.details.views ?? null : null,
        engagements:verified ? event.details.engagements ?? null : null,window:labelWindow(event.evidenceRef.window,alias),sourceVerified:verified};
    }), checkoutLanes:[...lanes.values()],
    sourceWindows:unique(metricEvents.flatMap(e=>labelWindow(e.evidenceRef.window,alias) ?? [])), sourceNetworks:unique(metricEvents.map(e=>e.network)),
  });
  return {data,observedAt:asOf,total:data.total,returned:next,pageCount:data.records.length,nextCursor};
}
