import { allocateCosts } from "../../features/analytics/economicCosts.ts";
import { digest } from "../config.ts";
import { daysOf, localDay } from "./reader.ts";
import type { AnalyticsInputFact, AnalyticsOwnerProof, AnalyticsReason, NativeAnalyticsSnapshot } from "./contract.ts";
import { nativeAnalyticsViewSchema, type AnalyticsFact, type NativeAnalyticsView, type NativePaidMedia } from "./views.ts";
import { NativeAnalyticsError } from "./nativeSource.ts";
import type { OrderRow } from "./sources.ts";

type Alias = (kind: string, raw: string) => string;
type Money = { minorUnits: number; currency: "USD" };
const fail = (): never => { throw new NativeAnalyticsError("ANALYTICS_SOURCE_INVALID", 503); };
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Pure projection of a frozen, authority-checked source packet. No provider call, persistence or traffic ingestion. */
export function projectNativeAnalytics(snapshot: NativeAnalyticsSnapshot, alias: Alias, at: number): NativeAnalyticsView {
  const observedAt = new Date(at).toISOString();
  const proof = (ref: string, owner?: AnalyticsOwnerProof["owner"]) => {
    const result = snapshot.owners.find(value => value.proofRef === ref);
    if (!result || owner && result.owner !== owner) return fail();
    return result;
  };
  const stale = (owner: AnalyticsOwnerProof) => owner.sourceAsOf === null || at - Date.parse(owner.sourceAsOf) >= owner.maxAgeMs;
  function unknown<T>(reason: AnalyticsReason = "SOURCE_MISSING", owner?: AnalyticsOwnerProof): AnalyticsFact<T> {
    return { state: reason === "NOT_APPLICABLE" ? "notApplicable" : "unknown", value: null, reasonCodes: [reason], evidenceRefs: [], sourceAsOf: owner?.sourceAsOf ?? null, observedAt, provisional: false };
  }
  function known<T>(value: T, owner: AnalyticsOwnerProof, refs: string[] = [owner.proofRef]): AnalyticsFact<T> {
    const reasons: AnalyticsReason[] = [...(owner.coverage === "complete" ? [] : ["COVERAGE_PARTIAL" as const]), ...(stale(owner) ? ["SOURCE_STALE" as const] : [])];
    if ((value === 0 || value !== null && typeof value === "object" && "minorUnits" in value && value.minorUnits === 0) && reasons.length) return unknown(reasons[0], owner);
    return { state: "known", value, reasonCodes: reasons, evidenceRefs: refs.map(ref => alias("evidence", ref)), sourceAsOf: owner.sourceAsOf, observedAt, provisional: reasons.length > 0 };
  }
  function fact<T>(input: AnalyticsInputFact<T>, owner?: AnalyticsOwnerProof["owner"]): AnalyticsFact<T> {
    if (input.value === null) return unknown(input.reason ?? "INPUT_UNKNOWN");
    return known(input.value, proof(input.proofRef!, owner), input.evidenceRefs);
  }
  const numeric = (input: AnalyticsFact<Money>): AnalyticsFact<number> => ({ ...input, value: input.value?.minorUnits ?? null });
  const monetary = (input: AnalyticsFact<number>): AnalyticsFact<Money> => ({ ...input, value: input.value === null ? null : { minorUnits: input.value, currency: "USD" } });
  const sum = (values: AnalyticsFact<number>[], owner: AnalyticsOwnerProof): AnalyticsFact<number> => {
    if (!values.length || values.some(value => value.value === null)) return unknown("INPUT_UNKNOWN", owner);
    const total = values.reduce((n, value) => n + value.value!, 0);
    if (!Number.isSafeInteger(total)) return fail();
    const base = known(total, owner);
    return { ...base, provisional: base.provisional || values.some(value => value.provisional), reasonCodes: [...new Set([...base.reasonCodes, ...values.flatMap(value => value.reasonCodes)])] };
  };
  function measure(metricId: string, unit: "count" | "minorUnits" | "percent" | "multiple", numerator: AnalyticsFact<number>, denominator: AnalyticsFact<number> | null, scale = 1) {
    let result = numerator;
    if (denominator) {
      if (numerator.value === null || denominator.value === null) result = unknown("INPUT_UNKNOWN");
      else if (numerator.provisional || denominator.provisional) result = unknown(numerator.reasonCodes[0] ?? denominator.reasonCodes[0] ?? "COVERAGE_PARTIAL");
      else if (denominator.value === 0) result = { ...unknown<number>("ZERO_DENOMINATOR"), state: "notApplicable" };
      else {
        const value = numerator.value / denominator.value * scale;
        if (!Number.isFinite(value)) return fail();
        result = { ...numerator, value: unit === "minorUnits" ? Math.round(value) : value, evidenceRefs: [...new Set([...numerator.evidenceRefs, ...denominator.evidenceRefs])], reasonCodes: [] };
      }
    }
    return { metricId, formulaVersion: "headline-metrics.v1" as const, unit, numerator, denominator, result };
  }
  const owners = snapshot.owners;
  const coverage = owners.every(owner => owner.coverage === "complete") ? "complete" as const : owners.every(owner => owner.coverage === "missing") ? "missing" as const : "partial" as const;
  const current = owners.every(owner => !stale(owner));
  const lease = Math.min(Date.parse(snapshot.validUntil), Date.parse(snapshot.observedAt) + 15 * 60_000, ...owners.map(owner => Date.parse(owner.validUntil)));
  const header = { datasetKey: "analytics-native" as const, viewKey: snapshot.viewKey, provenance: { evidenceStage: snapshot.evidenceStage, synthetic: snapshot.synthetic, sourceVersion: alias("version", snapshot.sourceVersion), observedAt: snapshot.observedAt, validUntil: new Date(lease).toISOString() }, period: snapshot.period, cohortRef: snapshot.cohortRef ? alias("cohort", snapshot.cohortRef) : null,
    sources: owners.map(owner => ({ proofRef: alias("evidence", owner.proofRef), owner: owner.owner, accountRef: alias("account", owner.accountRef), sourceVersion: alias("version", owner.sourceVersion), definitionVersion: alias("definition", owner.definitionVersion), cohortRef: owner.cohortRef ? alias("cohort", owner.cohortRef) : null, period: owner.period, observedAt: owner.observedAt, sourceAsOf: owner.sourceAsOf, validUntil: owner.validUntil, coverage: owner.coverage, maxAgeMs: owner.maxAgeMs })),
    coverage: { state: coverage, reasonCodes: coverage === "complete" ? [] : ["COVERAGE_PARTIAL" as const] }, freshness: { state: current ? "current" as const : owners.every(owner => owner.sourceAsOf === null) ? "unknown" as const : "stale" as const, sourceAsOf: owners.every(owner => owner.sourceAsOf !== null) ? owners.map(owner => owner.sourceAsOf!).sort((a, b) => Date.parse(a) - Date.parse(b))[0]! : null },
  };
  function economics(input: Extract<NativeAnalyticsSnapshot, { viewKey: "attribution" }>["facts"]["economics"]) {
    if (!input) return { spend: unknown<Money>("COST_INCOMPLETE"), customers: unknown<number>(), contribution: unknown<Money>("COST_INCOMPLETE"), evidence: null };
    const owner = proof(input.proofRef, "economicCosts");
    const bound = snapshot.cohortRef !== null && owner.cohortRef === snapshot.cohortRef && input.cohortRef === snapshot.cohortRef && digest(input.period) === digest(snapshot.period) && digest(owner.period) === digest(snapshot.period);
    if (!bound) return { spend: unknown<Money>("COHORT_MISMATCH"), customers: unknown<number>("COHORT_MISMATCH"), contribution: unknown<Money>("COHORT_MISMATCH"), evidence: null };
    const window = snapshot.window;
    const allocation = window ? allocateCosts(input.costs.map(cost => ({ key: cost.key, label: cost.key, basis: cost.basis, minorUnits: cost.minorUnits, alsoInCash: cost.alsoInCash, cohortId: input.cohortRef, obligationId: cost.obligationRef, evidenceId: cost.evidenceRef, cashId: cost.cashRef, currency: input.currency, period: window })), { cohortId: input.cohortRef, currency: input.currency, period: window, coverage: owner.coverage === "missing" ? "unknown" : owner.coverage }) : null;
    let spend = allocation?.totalMinor != null ? known<Money>({ minorUnits: allocation.totalMinor, currency: "USD" }, owner) : unknown<Money>("COST_INCOMPLETE", owner);
    if (allocation?.state === "provisional" && spend.state === "known") spend = { ...spend, provisional: true, reasonCodes: [...spend.reasonCodes, "ESTIMATED_COST"] };
    let customers = fact(input.newRetainedCustomers, "retainedCustomers");
    if (input.retention !== "mature" && customers.state === "known") customers = { ...customers, provisional: true, reasonCodes: [...customers.reasonCodes, "RETENTION_IMMATURE"] };
    let contribution = fact(input.contribution, "economicCosts");
    if (input.landedCost !== "complete" && contribution.state === "known") contribution = { ...contribution, provisional: true, reasonCodes: [...contribution.reasonCodes, "COST_INCOMPLETE"] };
    const evidence = { allocationVersion: input.allocationVersion, cohortRef: alias("cohort", input.cohortRef), period: input.period, currency: input.currency, coverage: owner.coverage, retention: input.retention, landedCost: input.landedCost, refundRevision: input.refundRevision ? alias("revision", input.refundRevision) : null,
      costs: input.costs.map(cost => ({ ...cost, obligationRef: alias("obligation", cost.obligationRef), evidenceRef: alias("evidence", cost.evidenceRef), cashRef: cost.cashRef ? alias("cash", cost.cashRef) : null })) };
    return { spend, customers, contribution, evidence };
  }
  function commerce(input: Extract<NativeAnalyticsSnapshot, { viewKey: "overviewSummary" }>["facts"]["orders"]) {
    const owner = input ? proof(input.proofRef, "commerceOrders") : null;
    let conflict = false;
    const seen = new Set<string>();
    const channels = (["shopify", "tiktokShop"] as const).map(channel => {
      const feeds = input?.snapshot.feeds.filter(feed => feed.channel === channel) ?? [];
      const feed = feeds.find(value => value.origin === "native") ?? feeds.find(value => value.origin === "mirror");
      const native = feeds.find(value => value.origin === "native"), mirror = feeds.find(value => value.origin === "mirror");
      const material = (rows: OrderRow[]) => rows.map(row => [row.canonicalOrderId ?? row.orderRef, row.recordOwner, row.valid, row.currency, row.netReceiptsMinor]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
      const mismatch = native && mirror && digest(material(native.orders)) !== digest(material(mirror.orders));
      const rows = feed?.orders.filter(row => row.recordOwner === channel && row.valid) ?? [];
      for (const row of rows) { if (row.canonicalOrderId === null || seen.has(row.canonicalOrderId)) conflict = true; else seen.add(row.canonicalOrderId); }
      const usable = owner && feed && feed.syncState !== "error" && feed.lastSuccessAt !== null;
      const effective = owner && feed ? { ...owner, coverage: mismatch || feed.coverage === "partial" ? "partial" as const : owner.coverage, sourceAsOf: feed.lastSuccessAt, maxAgeMs: Math.min(owner.maxAgeMs, 15 * 60_000) } : owner;
      const countRows = (selected: OrderRow[]) => usable && effective ? known(selected.length, effective) : unknown<number>();
      const netRows = (selected: OrderRow[]) => !usable || !effective ? unknown<Money>() : selected.some(row => row.currency !== "USD") ? unknown<Money>("CURRENCY_UNSUPPORTED", effective) : monetary(sum([known(selected.reduce((n, row) => n + row.netReceiptsMinor, 0), effective)], effective));
      return { channel, rows, countRows, netRows, orders: countRows(rows), netReceipts: netRows(rows) };
    });
    if (conflict) for (const channel of channels) { channel.orders = unknown("IDENTITY_UNRESOLVED", owner ?? undefined); channel.netReceipts = unknown("IDENTITY_UNRESOLVED", owner ?? undefined); }
    const rows = channels.flatMap(channel => channel.rows);
    const combine = (values: AnalyticsFact<number>[]) => owner && !conflict ? sum(values, owner) : unknown<number>(conflict ? "IDENTITY_UNRESOLVED" : "SOURCE_MISSING");
    const countWhere = (predicate: (row: OrderRow) => boolean) => combine(channels.map(channel => channel.countRows(channel.rows.filter(predicate))));
    return { owner, channels, rows, conflict, countWhere, orders: combine(channels.map(channel => channel.orders)), net: monetary(combine(channels.map(channel => numeric(channel.netReceipts)))),
      creatorOrders: countWhere(row => row.attribution === "code" && row.codeOwner === "creator"), creatorNet: monetary(combine(channels.map(channel => numeric(channel.netRows(channel.rows.filter(row => row.attribution === "code" && row.codeOwner === "creator")))))) };
  }
  function commerceProjection(s: Extract<NativeAnalyticsSnapshot, { viewKey: "overviewSummary" | "attribution" }>) {
    const c = commerce(s.facts.orders), e = economics(s.facts.economics);
    const measures = [measure("aov", "minorUnits", numeric(c.net), c.orders), measure("blendedCac", "minorUnits", numeric(e.spend), e.customers), measure("mer", "multiple", numeric(c.net), numeric(e.spend)), measure("contributionPerOrder", "minorUnits", numeric(e.contribution), c.orders)];
    const channels = c.channels.map(({ channel, orders, netReceipts }) => ({ channel, orders, netReceipts }));
    measures.push(measure("contributionMargin", "percent", numeric(e.contribution), numeric(c.net), 100));
    for (const channel of channels) measures.push(measure(`shareNetReceipts.${channel.channel}`, "percent", numeric(channel.netReceipts), numeric(c.net), 100), measure(`shareOrders.${channel.channel}`, "percent", channel.orders, c.orders, 100));
    const common = { orders: c.orders, netReceipts: c.net, contribution: e.contribution, marketingSpend: e.spend, newRetainedCustomers: e.customers, channels, measures };
    const byDays = (days: Set<string>) => c.channels.map(channel => ({ channel: channel.channel, orders: c.conflict ? unknown<number>("IDENTITY_UNRESOLVED") : channel.countRows(channel.rows.filter(row => days.has(localDay(Date.parse(row.placedAt), s.window!.timezone)))), netReceipts: c.conflict ? unknown<Money>("IDENTITY_UNRESOLVED") : channel.netRows(channel.rows.filter(row => days.has(localDay(Date.parse(row.placedAt), s.window!.timezone)))) }));
    const days = s.window ? daysOf(s.window) : [];
    if (s.viewKey === "overviewSummary") {
      const posts = s.facts.posts.map(row => ({ postRef: alias("post", row.postRef), views: fact(row.views, "creatorActivity"), likes: fact(row.likes, "creatorActivity"), comments: fact(row.comments, "creatorActivity"), shares: fact(row.shares, "creatorActivity") }));
      const postsTotal = fact(s.facts.postsTotal, "creatorActivity"), postOwner = s.facts.postsTotal.proofRef ? proof(s.facts.postsTotal.proofRef, "creatorActivity") : null;
      const completePosts = postOwner && postsTotal.state === "known" && !postsTotal.provisional && postsTotal.value === posts.length;
      const postSum = (values: AnalyticsFact<number>[], inputs: AnalyticsInputFact<number>[]) => !completePosts || !postOwner || inputs.some(input => input.value !== null && input.proofRef !== s.facts.postsTotal.proofRef) ? unknown<number>("COVERAGE_PARTIAL") : values.length ? sum(values, postOwner) : known(0, postOwner);
      const views = postSum(posts.map(post => post.views), s.facts.posts.map(post => post.views)), engagements = postSum(posts.flatMap(post => [post.likes, post.comments, post.shares]), s.facts.posts.flatMap(post => [post.likes, post.comments, post.shares]));
      measures.push(measure("creatorViews", "count", views, null), measure("creatorEngagementRate", "percent", engagements, views, 100));
      return { ...header, ...common, attributedOrders: c.creatorOrders, attributedNetSales: c.creatorNet, daily: days.map(day => ({ day, channels: byDays(new Set([day])) })),
        activity: s.facts.activity.map(row => { proof(row.proofRef, "creatorActivity"); return { activityRef: alias("activity", row.activityRef), creatorRef: row.creatorRef ? alias("creator", row.creatorRef) : null, kind: row.kind, eventAt: row.eventAt, evidenceRefs: row.evidenceRefs.map(ref => alias("evidence", ref)) }; }), posts, postsTotal };
    }
    const weeks = [];
    for (let index = 0; index < days.length; index += 7) { const span = days.slice(index, index + 7); weeks.push({ startDay: span[0]!, endDayExclusive: nextDay(span.at(-1)!), channels: byDays(new Set(span)) }); }
    const methods = ["creatorCode", "sitewideCode", "unknownCode", "utm", "platform", "unattributed"] as const;
    const attribution = methods.map(method => ({ method, orders: c.rows.some(row => row.attribution === null) ? unknown<number>("INPUT_UNKNOWN") : c.countWhere(row => method === "creatorCode" ? row.attribution === "code" && row.codeOwner === "creator" : method === "sitewideCode" ? row.attribution === "code" && row.codeOwner === "sitewide" : method === "unknownCode" ? row.attribution === "code" && row.codeOwner === "unknown" : row.attribution === method) }));
    for (const row of attribution) measures.push(measure(`shareAttribution.${row.method}`, "percent", row.orders, c.orders, 100));
    const platformReports = (["meta", "tiktok"] as const).map(platform => {
      const input = s.facts.ads, owner = input ? proof(input.proofRef, "adReporting") : null;
      const feed = input?.snapshot.feeds.find(row => row.platform === platform), campaigns = feed?.campaigns.filter(row => row.kind === "standard") ?? [];
      const windows = campaigns.map(row => row.attributionWindow);
      const attributionWindow = windows.length && windows.every(window => window && digest(window) === digest(windows[0])) ? windows[0]! : null;
      const effective = owner && feed ? { ...owner, sourceAsOf: feed.lastSuccessAt, coverage: feed.coverage === "partial" ? "partial" as const : owner.coverage } : null;
      const total = (key: "spendMinor" | "platformPurchaseValueMinor") => !effective || !feed || feed.syncState === "error" || !campaigns.length || campaigns.some(row => row[key] === null) ? unknown<number>() : feed.currency !== "USD" ? unknown<number>("CURRENCY_UNSUPPORTED") : sum(campaigns.map(row => known(row[key]!, effective)), effective);
      measures.push(measure(`platformRoas.${platform}`, "multiple", attributionWindow ? total("platformPurchaseValueMinor") : unknown<number>("ATTRIBUTION_WINDOW_UNKNOWN"), total("spendMinor")));
      return { platform, attributionWindow };
    });
    return { ...header, ...common, platformReports, retainedUnits: !c.owner || c.conflict || c.rows.some(row => row.unitsRetained === null) ? unknown<number>() : sum(c.channels.map(channel => channel.orders.value === null ? unknown<number>() : known(channel.rows.reduce((n, row) => n + row.unitsRetained!, 0), c.owner!)), c.owner), weeks,
      attribution, economicEvidence: e.evidence,
      creators: s.facts.creators.map(row => ({ creatorRef: alias("creator", row.creatorRef), roi: fact(row.roi, "economicCosts") })) };
  }
  let body: unknown;
  if (snapshot.viewKey === "overviewSummary" || snapshot.viewKey === "attribution") body = commerceProjection(snapshot);
  else if (snapshot.viewKey === "paidMedia") {
    const ads = snapshot.facts.ads, owner = ads ? proof(ads.proofRef, "adReporting") : null, filters = snapshot.binding.request.viewKey === "paidMedia" ? snapshot.binding.request.filters : fail();
    const assets: NativePaidMedia["assets"] = [];
    const channels = (["meta", "tiktok"] as const).filter(platform => filters.platform === "all" || filters.platform === platform).map(platform => {
      const feed = ads?.snapshot.feeds.find(value => value.platform === platform);
      const effective = owner && feed ? { ...owner, sourceAsOf: feed.lastSuccessAt, coverage: feed.coverage === "partial" ? "partial" as const : owner.coverage } : null;
      const n = (value: number | null) => !effective || !feed || feed.syncState === "error" || value === null ? unknown<number>() : known(value, effective);
      const amount = (value: number | null) => feed?.currency !== "USD" ? unknown<Money>("CURRENCY_UNSUPPORTED") : monetary(n(value));
      const campaigns = feed?.campaigns ?? [], standard = campaigns.filter(row => row.kind === "standard");
      const sumField = (rows: typeof campaigns, field: "spendMinor" | "impressions" | "clicks" | "platformPurchaseValueMinor") => rows.some(row => row[field] === null) ? null : rows.reduce((sum, row) => sum + row[field]!, 0);
      const spend = amount(sumField(campaigns, "spendMinor")), impressions = n(sumField(standard, "impressions")), clicks = n(sumField(standard, "clicks"));
      const standardSpend = amount(sumField(standard, "spendMinor"));
      const windows = standard.map(row => row.attributionWindow);
      const attributionWindow = windows.length && windows.every(window => window && digest(window) === digest(windows[0])) ? windows[0]! : null;
      const platformPurchaseValue = amount(sumField(standard, "platformPurchaseValueMinor"));
      const roasNumerator = attributionWindow ? numeric(platformPurchaseValue) : unknown<number>("ATTRIBUTION_WINDOW_UNKNOWN");
      const measures = [measure(`ctr.${platform}`, "percent", clicks, impressions, 100), measure(`cpc.${platform}`, "minorUnits", numeric(standardSpend), clicks), measure(`cpm.${platform}`, "minorUnits", numeric(standardSpend), impressions, 1000), measure(`platformRoas.${platform}`, "multiple", roasNumerator, numeric(amount(sumField(standard, "spendMinor"))))];
      for (const asset of feed?.assets ?? []) {
        const expired = asset.expiresOn !== null && snapshot.window !== null && asset.expiresOn < localDay(at, snapshot.window.timezone);
        const expiring = asset.expiresOn !== null && snapshot.window !== null && Date.parse(asset.expiresOn + "T00:00:00Z") - Date.parse(localDay(at, snapshot.window.timezone) + "T00:00:00Z") <= 30 * 86_400_000;
        const rights = asset.rights === "notGranted" ? asset.rights : expired ? "expired" : asset.rights === "cleared" && (!effective || effective.coverage !== "complete" || stale(effective)) ? "unknown" : asset.rights === "cleared" && expiring ? "expiring" : asset.rights;
        if (filters.rights !== "all" && filters.rights !== rights) continue;
        const assetRef = alias("asset", asset.assetRef);
        assets.push({ assetRef, platform, label: asset.label ?? `Asset ${assetRef.slice(-8)}`, clicks: n(asset.clicks), impressions: n(asset.impressions), ctr: measure("assetCtr", "percent", n(asset.clicks), n(asset.impressions), 100).result, rights, expiresOn: asset.expiresOn });
      }
      return { platform, spend, impressions, clicks, platformPurchaseValue, attributionWindow, measures };
    });
    const completeAssetSet = owner?.coverage === "complete" && !stale(owner) && (["meta", "tiktok"] as const).filter(platform => filters.platform === "all" || filters.platform === platform).every(platform => ads?.snapshot.feeds.some(feed => feed.platform === platform && feed.coverage === "complete" && feed.syncState !== "error"));
    // Rank the complete filtered set before pagination. Unknown rates are never
    // treated as zero or promoted ahead of known rates.
    assets.sort((a, b) => a.ctr.value === null ? b.ctr.value === null ? a.assetRef.localeCompare(b.assetRef) : 1 : b.ctr.value === null ? -1 : b.ctr.value - a.ctr.value || a.assetRef.localeCompare(b.assetRef));
    const combine = (values: AnalyticsFact<number>[]) => owner ? sum(values, owner) : unknown<number>();
    const spend = monetary(combine(channels.map(channel => numeric(channel.spend)))), impressions = combine(channels.map(channel => channel.impressions)), clicks = combine(channels.map(channel => channel.clicks));
    const standardSpend = combine(channels.map(channel => channel.measures.find(value => value.metricId === `cpc.${channel.platform}`)!.numerator));
    for (const channel of channels) channel.measures.push(measure(`shareSpend.${channel.platform}`, "percent", numeric(channel.spend), numeric(spend), 100));
    const totals = { spend, impressions, clicks, measures: [measure("ctr", "percent", clicks, impressions, 100), measure("cpc", "minorUnits", standardSpend, clicks), measure("cpm", "minorUnits", standardSpend, impressions, 1000)] };
    body = { ...header, channels, totals, assets, assetTotal: owner && completeAssetSet ? known(assets.length, owner) : unknown<number>("COVERAGE_PARTIAL"), creatorSampleEconomics: fact(snapshot.facts.creatorSampleEconomics, "economicCosts"), selection: filters, pagination: { returned: assets.length, nextCursor: null } };
  } else if (snapshot.viewKey === "launchSnapshot") {
    const f = snapshot.facts;
    body = { ...header, launchDate: fact(f.launchDate, "launchReadiness"), targetWindow: fact(f.targetWindow, "launchReadiness"), stage: fact(f.stage, "launchReadiness"), conversations: fact(f.conversations, "campaignEvents"), readyForNextStep: fact(f.readyForNextStep, "launchReadiness"), firstWaveSamples: fact(f.firstWaveSamples, "sampleCapacity"), budgetCeiling: fact(f.budgetCeiling, "economicCosts"),
      momentum: f.momentum.map(row => ({ segment: row.segment, inConversation: fact(row.inConversation, "campaignEvents"), ready: fact(row.ready, "launchReadiness") })),
      gates: f.gates.map(row => { const owner = proof(row.proofRef, "launchReadiness"); return { gateId: row.gateId, state: stale(owner) || owner.coverage !== "complete" ? "unknown" : row.state, reasonCodes: stale(owner) ? ["SOURCE_STALE"] : owner.coverage !== "complete" ? ["COVERAGE_PARTIAL"] : row.reasonCodes, evidenceRefs: row.evidenceRefs.map(ref => alias("evidence", ref)), relativeOffsetDays: row.relativeOffsetDays, anchorEventAt: row.anchorEventAt }; }),
      approvals: f.approvals.map(row => { proof(row.proofRef, "launchReadiness"); return { approvalRef: alias("approval", row.approvalRef), manifestVersion: alias("manifest", row.manifestVersion), state: row.state, requestedAt: row.requestedAt, evidenceRefs: row.evidenceRefs.map(ref => alias("evidence", ref)) }; }) };
  } else if (snapshot.viewKey === "campaignFunnel") {
    const f = snapshot.facts, steps = ["contacted", "replied", "agreed", "shipped", "delivered", "posted"] as const;
    const channels = f.channels.map(row => {
      const values = Object.fromEntries(steps.map(key => [key, fact(row.steps[key], "campaignEvents")])) as Record<typeof steps[number], AnalyticsFact<number>>;
      const contactReference = fact(row.contactReference, "campaignEvents"), giftCap = fact(row.giftCap, "sampleCapacity"), reserved = fact(row.reserved, "sampleCapacity");
      const owner = row.giftCap.proofRef ? proof(row.giftCap.proofRef, "sampleCapacity") : null;
      const used = owner ? sum([values.shipped, reserved], owner) : unknown<number>();
      return { channel: row.channel, contactReference, steps: values, giftCap, reserved, historical: { replies: fact(row.historical.replies, "campaignEvents"), agreements: fact(row.historical.agreements, "campaignEvents") }, measures: [measure("contactReferenceUse", "percent", values.contacted, contactReference, 100), measure("capacityUsed", "count", used, null), measure("capacityUse", "percent", used, giftCap, 100)] };
    });
    const aggregate = (values: AnalyticsFact<number>[], kind: AnalyticsOwnerProof["owner"]) => {
      const owner = snapshot.owners.find(value => value.owner === kind && value.cohortRef === snapshot.cohortRef && digest(value.period) === digest(snapshot.period));
      return f.aggregation === "disjointComplete" && owner ? sum(values, owner) : unknown<number>("COVERAGE_PARTIAL");
    };
    const totals = Object.fromEntries(steps.map(key => [key, aggregate(channels.map(row => row.steps[key]), "campaignEvents")])) as Record<typeof steps[number], AnalyticsFact<number>>;
    const reserved = aggregate(channels.map(row => row.reserved), "sampleCapacity"), giftCap = aggregate(channels.map(row => row.giftCap), "sampleCapacity"), notYetMature = fact(f.notYetMature, "campaignEvents"), maturePosted = fact(f.maturePosted, "campaignEvents");
    const difference = (all: AnalyticsFact<number>, part: AnalyticsFact<number>) => {
      if (all.value === null || part.value === null || all.provisional || part.provisional) return unknown<number>("INPUT_UNKNOWN");
      if (part.value > all.value) return fail();
      return { ...all, value: all.value - part.value, evidenceRefs: [...new Set([...all.evidenceRefs, ...part.evidenceRefs])] };
    };
    if (maturePosted.value !== null && !maturePosted.provisional && totals.posted.value !== null && !totals.posted.provisional && maturePosted.value > totals.posted.value) return fail();
    const matureDelivered = difference(totals.delivered, notYetMature), matureNoPost = difference(matureDelivered, maturePosted);
    body = { ...header, campaignRef: alias("campaign", f.campaignRef), cohortRef: alias("cohort", f.cohortRef), selection: f.selection, maturity: f.maturity, progression: f.progression, aggregation: f.aggregation, channels, totals, reserved, giftCap, notYetMature, matureDelivered, maturePosted, matureNoPost,
      measures: [measure("replyConversion", "percent", totals.replied, totals.contacted, 100), measure("maturePostingRate", "percent", maturePosted, matureDelivered, 100)],
      historicalBasis: f.historicalBasis ? { period: f.historicalBasis.period, cohortRef: alias("cohort", f.historicalBasis.cohortRef), definitionVersion: alias("definition", f.historicalBasis.definitionVersion) } : null };
  } else if (snapshot.viewKey === "launchReconciliation") {
    body = { ...header, asOf: snapshot.facts.asOf, matrix: snapshot.facts.matrix.map(row => {
      const cells = row.cells.map(cell => ({ ...cell, cohortRef: alias("cohort", cell.cohortRef), definitionVersion: alias("definition", cell.definitionVersion), inputVersion: alias("version", cell.inputVersion), value: fact(cell.value, "reconciliation") }));
      const first = row.cells[0]!, compatible = row.cells.every(cell => cell.cohortRef === first.cohortRef && digest(cell.period) === digest(first.period) && cell.definitionVersion === row.definitionVersion);
      const available = cells.every(cell => cell.value.state === "known" && !cell.value.provisional);
      const state = !compatible || !available ? "unknown" : cells.every(cell => cell.value.value === cells[0]!.value.value) ? "matches" : "differs";
      return { metricId: row.metricId, definitionVersion: alias("definition", row.definitionVersion), unit: row.unit, currency: row.currency, cells, comparison: { state, reasonCodes: !compatible ? ["DEFINITION_MISMATCH"] : !available ? ["INPUT_UNKNOWN"] : [] } };
    }) };
  } else {
    const f = snapshot.facts, owner = proof(f.proofRef, "metricDefinitions"), e = economics(f.economics);
    const pairs = [["aov", "netReceipts", "validOrders", "minorUnits"], ["blendedCac", "includedAcquisitionCost", "newRetainedCustomers", "minorUnits"], ["mer", "netReceipts", "marketingSpend", "multiple"], ["platformRoas", "platformPurchaseValue", "platformSpend", "multiple"], ["contributionPerOrder", "contribution", "validOrders", "minorUnits"]] as const;
    body = { ...header, definitionVersion: alias("definition", owner.definitionVersion), effectiveAt: f.effectiveAt, formulaVersion: f.formulaVersion, allocationVersion: f.allocationVersion, entries: pairs.map(([metricId, numerator, denominator, unit]) => ({ metricId, numerator, denominator, unit, zeroRule: "notApplicable", missingRule: "unknown", refundTreatment: "originalCohortRevision", scopeRule: "sameCohortWindowCurrencyDefinition" })), economicEvidence: e.evidence };
  }
  const parsed = nativeAnalyticsViewSchema.safeParse(body);
  if (!parsed.success) return fail();
  return parsed.data;
}
