import {
  FUNNEL_VERSION,
  stages,
  type FunnelEvent as Event,
  type FunnelFilters,
  type FunnelType,
  type LivePipeline,
  expenseBuckets,
} from "./funnelContract.ts";
const day = 86_400_000;
const millis = (date: string) => Date.parse(date);
const uniq = <T>(items: T[]) => [...new Set(items)];
function groups<T>(items: T[], key: (item: T) => string) {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const list = result.get(id) ?? [];
    list.push(item);
    result.set(id, list);
  }
  return result;
}
const eventOrder = (a: Event, b: Event) =>
  millis(a.occurredAt ?? a.observedAt) - millis(b.occurredAt ?? b.observedAt) ||
  millis(a.observedAt) - millis(b.observedAt) ||
  a.eventId.localeCompare(b.eventId);
const knownTime = (events: Event[]) => Math.min(...events.flatMap((e) => (e.occurredAt ? [millis(e.occurredAt)] : [])));
const median = (values: number[]) => {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return (v[Math.floor((v.length - 1) / 2)]! + v[Math.floor(v.length / 2)]!) / 2;
};
const creator = (e: Event) =>
  e.creatorRef.canonicalId ??
  JSON.stringify([e.creatorRef.source, e.creatorRef.accountId, e.creatorRef.sourceId ?? e.ingestIdentity.fingerprint]);
const has = (events: Event[], type: FunnelType) => events.some((e) => e.eventType === type);
const countOp = (opps: Event[][], type: FunnelType) => opps.filter((es) => has(es, type)).length;
const last = (es: Event[]) => es.at(-1)!;
const postKey = (e: Event) => JSON.stringify([e.network, e.sourceAccount.accountId, e.details.postId]);
const orderKey = (e: Event) => e.details.orderId!;
const reversed = (events: Event[]) => [...events].reverse();
const terminal = ["optOut", "declined", "expired"] as const;
const stageTask: Record<string, string> = {
  discovered: "Review original video",
  directReviewed: "Review qualification",
  qualified: "Review offer approval",
  approval: "Check dispatch queue",
  confirmedSent: "Check native response",
  matched: "Verify accepted terms",
  terms: "Verify tracking",
  tracking: "Review agreed content",
  published: "Inspect attribution",
  retainedOrder: "Review retained outcomes",
  unknown: "Reconcile source evidence",
};
const currencyValue = (records: Event[], fn: (e: Event) => number | null | undefined) => {
  const amounts = records.map(fn);
  if (!records.length || uniq(records.map((e) => e.details.currency)).length !== 1 || amounts.some((v) => v == null))
    return null;
  return amounts.reduce<number>((n, v) => n + v!, 0);
};
function included(e: Event, f: FunnelFilters) {
  return (
    (!f.route || e.route === f.route) &&
    (!f.checkout || e.checkout === f.checkout) &&
    (!f.network || e.network === f.network) &&
    (!f.cohort || e.campaignCohortRef.canonicalId === f.cohort || e.campaignCohortRef.sourceId === f.cohort) &&
    (!f.policy || e.policyOfferApprovalVersions.policy === f.policy) &&
    (!f.offer || e.policyOfferApprovalVersions.offer === f.offer) &&
    (!f.opportunity || e.opportunityId === f.opportunity) &&
    (!f.start || millis(e.cohortStart) >= millis(f.start)) &&
    (!f.end || millis(e.cohortStart) < millis(f.end))
  );
}
const activeOrders = (es: Event[]) =>
  [
    ...groups(
      es.filter((e) => e.eventType === "retainedOrder" || e.eventType === "refund"),
      orderKey,
    ).values(),
  ].map(last);
const retained = (e: Event) => (e.details.retainedMinor ?? 0) > 0;
function measure(
  name: string,
  value: number | null,
  unit: string,
  denominator: number | null = null,
  reason: string | null = null,
) {
  return {
    name,
    value,
    unit,
    denominator,
    reason: value === null ? (reason ?? "No comparable source evidence") : null,
  };
}
function milestoneEvents(es: Event[], key: (typeof stages)[number]): Event[] {
  return key === "retainedOrder" ? activeOrders(es).filter(retained) : es.filter((e) => e.eventType === key);
}
function stageRows(opps: Event[][]): LivePipeline["milestones"] {
  return stages.map((key, i) => {
    let eligible = 0,
      advanced = 0;
    const intervals: number[] = [];
    for (const es of opps) {
      const inbound = es[0]!.route === "inbound";
      if (i === 0 || (inbound && key === "confirmedSent")) continue;
      const previous = key === "matched" && inbound ? "approval" : stages[i - 1]!;
      const earlier = milestoneEvents(es, previous),
        later = milestoneEvents(es, key);
      if (!earlier.length) continue;
      eligible++;
      if (!later.length) continue;
      advanced++;
      const t0 = knownTime(earlier),
        t1 = knownTime(later);
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) intervals.push((t1 - t0) / day);
    }
    return {
      key,
      reached: opps.filter((es) => milestoneEvents(es, key).length).length,
      eligible: i ? eligible : null,
      advanced: i ? advanced : null,
      medianDays: median(intervals),
      knownPairs: intervals.length,
    };
  });
}
function currentRow(es: Event[], asOf: string): LivePipeline["queue"][number] {
  const lastEvent = last(es),
    acquisition = es.find((e) => e.acquisitionRef)?.acquisitionRef ?? es[0]!.sourceAccount,
    currentTerminal = terminal.find((t) => has(es, t));
  const lastStage = [...stages].reverse().find((k) => milestoneEvents(es, k).length);
  const stage = currentTerminal ?? lastStage ?? "unknown";
  const blockerSources = es.flatMap((e) => e.details.blockers);
  const blockers = uniq([
    ...(currentTerminal ? [currentTerminal] : []),
    ...(has(es, "sourceOutage") ? ["Source access incomplete"] : []),
    ...(has(es, "unknownState") ? ["Unmapped native state"] : []),
    ...blockerSources,
  ]);
  const since = currentTerminal
    ? knownTime(es.filter((e) => e.eventType === currentTerminal))
    : lastStage
      ? knownTime(milestoneEvents(es, lastStage))
      : NaN;
  const knownValue = (select: (e: Event) => string | null | undefined) =>
    reversed(es).map(select).find(Boolean) ?? null;
  const facts = es.map((e) => ({
    eventId: e.eventId,
    type: e.eventType,
    occurredAt: e.occurredAt,
    observedAt: e.observedAt,
    evidence: e.evidenceRef.provenanceRef,
    url: e.evidenceRef.url,
    version: e.evidenceRef.version,
    nativeAction: e.nativeActionKind,
    nativeActor: e.nativeActorRole,
    runId: e.details.runId ?? null,
    deliverable: e.details.deliverableId ?? null,
    post: e.details.postId ?? null,
    review: e.details.reviewId ?? null,
    attribution: e.details.attributionVersion ?? null,
    window: e.details.attributionWindow ?? null,
    newCustomer: e.details.newCustomer ?? null,
  }));
  return {
    id: lastEvent.opportunityId,
    creator: creator(es.find((e) => e.creatorRef.canonicalId) ?? lastEvent),
    source: acquisition.source,
    account: acquisition.sourceId ?? acquisition.accountId,
    route: lastEvent.route,
    stage,
    owner: knownValue((e) => e.details.owner),
    ageDays: Number.isFinite(since) ? Math.max(0, (millis(asOf) - since) / day) : null,
    blockers,
    primary: blockers[0] ?? null,
    nextAction: currentTerminal
      ? "Keep suppression; a new opportunity requires fresh approval"
      : (knownValue((e) => e.details.nextAction) ?? stageTask[stage] ?? "Inspect source record"),
    quotaPeriod: knownValue((e) => e.details.quotaPeriod),
    quotaLimit:
      reversed(es)
        .map((e) => e.details.quotaLimit)
        .find((v) => v != null) ?? null,
    facts,
  };
}
function lifecycleMetrics(opps: Event[][], mature: Event[][], asOf: string) {
  const events = opps.flat(),
    matureEvents = mature.flat();
  const agreements = [
    ...groups(
      events.filter((e) => e.eventType === "briefAccepted"),
      (e) => JSON.stringify([e.opportunityId, e.details.deliverableId]),
    ).values(),
  ].map(last);
  const due = agreements.filter(
    (e) => e.details.obligation === "required" && e.details.dueAt && millis(e.details.dueAt) <= millis(asOf),
  );
  const publications = events.filter((e) => e.eventType === "published");
  const publishedDue = due.filter((d) =>
    publications.some(
      (p) => p.opportunityId === d.opportunityId && p.details.deliverableId === d.details.deliverableId,
    ),
  );
  const matureSeeds = mature.filter((es) => has(es, "sampleDelivered"));
  const repeatEligible = mature.filter((es) => has(es, "repeatEligible"));
  const timeTo = (key: "published" | "retainedOrder") => {
    const intervals = matureSeeds.flatMap((es) => {
      const start = knownTime(es.filter((e) => e.eventType === "sampleDelivered"));
      const finish = knownTime(milestoneEvents(es, key));
      return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? [(finish - start) / day] : [];
    });
    return measure(
      key === "published" ? "Sample to first publication" : "Sample to first retained sale",
      median(intervals),
      "median days",
      intervals.length,
    );
  };
  return [
    measure("Due accepted posting obligations", due.length, "deliverables"),
    measure("Published due obligations", publishedDue.length, "deliverables", due.length),
    measure("Posting completion", due.length ? (100 * publishedDue.length) / due.length : null, "%", due.length),
    measure(
      "Unknown posting obligations",
      agreements.filter(
        (e) =>
          !e.details.obligation ||
          e.details.obligation === "unknown" ||
          (e.details.obligation === "required" && !e.details.dueAt),
      ).length,
      "deliverables",
    ),
    measure("Verified native publications", uniq(publications.map(postKey)).length, "posts"),
    measure(
      "Agreed published creatives",
      uniq(
        publications
          .filter(
            (e) =>
              e.details.creativeId &&
              agreements.some(
                (a) => a.opportunityId === e.opportunityId && a.details.deliverableId === e.details.deliverableId,
              ),
          )
          .map((e) => JSON.stringify([e.opportunityId, e.details.creativeId])),
      ).length,
      "creatives",
    ),
    measure(
      "Voluntary publications",
      uniq(publications.filter((p) => p.details.obligation === "voluntary").map(postKey)).length,
      "posts",
    ),
    measure("Seeded mature opportunities", matureSeeds.length, "opportunities"),
    measure(
      "Seeded with no observed publication",
      matureSeeds.filter((es) => !has(es, "published")).length,
      "opportunities",
      matureSeeds.length,
    ),
    measure(
      "Seeded with no observed retained sale",
      matureSeeds.filter((es) => !activeOrders(es).some(retained)).length,
      "opportunities",
      matureSeeds.length,
    ),
    measure(
      "Seeded to verified post",
      matureSeeds.length ? (100 * countOp(matureSeeds, "published")) / matureSeeds.length : null,
      "%",
      matureSeeds.length,
    ),
    timeTo("published"),
    timeTo("retainedOrder"),
    measure(
      "Repeat participation",
      repeatEligible.length ? (100 * countOp(repeatEligible, "repeatParticipation")) / repeatEligible.length : null,
      "%",
      repeatEligible.length,
    ),
    measure(
      "Active sellers",
      uniq(activeOrders(matureEvents).filter(retained).map(creator)).length,
      "creators",
      uniq(matureEvents.map(creator)).length,
    ),
    ...(
      [
        "noSample",
        "sampleRequested",
        "sampleApproved",
        "sampleShipped",
        "sampleDelivered",
        "briefAccepted",
        "productionBlocked",
        "productionSubmitted",
        "contentAccepted",
        "scheduled",
        "removed",
        "review",
        "adAuthorized",
        "settled",
        "legacyPayable",
      ] as const
    ).map((type) => measure(type, countOp(opps, type), "opportunities")),
  ];
}
export function projectFunnel(all: Event[], filters: FunnelFilters, asOf: string): LivePipeline {
  // Apply corrections over all versions before selecting a facet. The ledger is bounded by recorded/observed time in the repository.
  const superseded = new Set(all.map((e) => e.correctsEventId).filter(Boolean));
  const active = all.filter((e) => !superseded.has(e.eventId)).sort(eventOrder);
  const opps = [...groups(active, (e) => e.opportunityId).values()].filter((es) => {
    const acquired = es.find((e) => e.acquisitionRef)?.acquisitionRef ?? es[0]!.sourceAccount;
    return (
      (!filters.source || filters.source === acquired.source) &&
      (!filters.account || filters.account === (acquired.sourceId ?? acquired.accountId)) &&
      es.some((e) => included(e, filters))
    );
  });
  const events = opps.flat().sort(eventOrder);
  const maturity = (es: Event[]) => last(es).maturationAt;
  const mature = opps.filter((es) => maturity(es) && millis(maturity(es)!) <= millis(asOf));
  const queue = opps.map((es) => currentRow(es, asOf)).sort((a, b) => a.id.localeCompare(b.id));
  const queueCounts: Record<string, number> = Object.create(null),
    exclusions: Record<string, number> = Object.create(null);
  for (const row of queue) {
    queueCounts[row.stage] = (queueCounts[row.stage] ?? 0) + 1;
    if (row.primary) exclusions[row.primary] = (exclusions[row.primary] ?? 0) + 1;
  }
  const attempts = events.filter((e) => e.eventType === "attempt"),
    outbound = opps.filter((es) => es[0]!.route === "outbound");
  const dispatchState = (es: Event[]) =>
    has(es, "confirmedSent")
      ? "confirmedSent"
      : last(es.filter((e) => ["uncertain", "queued", "attempt"].includes(e.eventType)))?.eventType;
  const matureEvents = mature.flat(),
    orders = activeOrders(matureEvents),
    retainedOrders = orders.filter(retained);
  const net = currencyValue(orders, (e) => e.details.retainedMinor);
  const salesUnit =
    uniq(orders.map((e) => e.details.currency)).length === 1
      ? (orders[0]?.details.currency ?? "unknown") + " minor units"
      : "currency not comparable";
  const costs = matureEvents.filter((e) => e.eventType === "cost"),
    economics = expenseBuckets.flatMap((bucket) => {
      return (["accrual", "cash"] as const).map((basis) => {
        const rows = costs.filter((e) => e.details.bucket === bucket && e.details.basis === basis);
        const unit =
          bucket === "founderMinutes" ? "minutes" : (rows[0]?.details.currency ?? "unknown") + " minor units";
        const value =
          bucket === "founderMinutes" && rows.length && rows.every((e) => e.details.amountMinor != null)
            ? rows.reduce((n, e) => n + e.details.amountMinor!, 0)
            : currencyValue(rows, (e) => e.details.amountMinor);
        return measure(bucket + " " + basis, value, unit, rows.length);
      });
    });
  const comparableCosts = economics.filter(
    (c) => c.name.endsWith(" accrual") && !c.name.startsWith("founderMinutes") && !c.name.startsWith("refunds"),
  );
  const accrualCost = comparableCosts.every((c) => c.value !== null && c.unit === salesUnit)
    ? comparableCosts.reduce((n, c) => n + c.value!, 0)
    : null;
  const bySeller = [...groups(orders, creator).values()].map((rows) =>
    currencyValue(rows, (e) => e.details.retainedMinor),
  );
  economics.push(
    measure(
      "Contribution after recorded accruals",
      net != null && accrualCost != null ? net - accrualCost : null,
      salesUnit,
      mature.length,
      "Missing or incompatible cost buckets",
    ),
    measure(
      "Largest seller share of retained sales",
      net && bySeller.every((v) => v !== null) ? (100 * Math.max(...bySeller.map((v) => v!))) / net : null,
      "%",
      mature.length,
    ),
  );
  const snapshots = [
    ...groups(
      matureEvents.filter((e) => e.eventType === "postMetrics"),
      postKey,
    ).values(),
  ].map(last);
  const comparable = snapshots.filter((e) => e.details.views != null && e.details.engagements != null);
  const windows = uniq(
    comparable.map((e) => JSON.stringify([e.evidenceRef.definition, e.evidenceRef.window, e.evidenceRef.unit])),
  );
  const comparableWindow = comparable.length > 0 && windows.length === 1 && !!comparable[0]!.evidenceRef.window;
  const views = comparableWindow ? comparable.reduce((n, e) => n + e.details.views!, 0) : null;
  const engagements = comparableWindow ? comparable.reduce((n, e) => n + e.details.engagements!, 0) : null;
  const missingTimes = events.filter((e) => !e.occurredAt).length,
    unresolvedIdentity = events.filter((e) => e.creatorRef.identityState === "unresolved").length;
  const unavailable = events.filter((e) => ["sourceOutage", "unknownState"].includes(e.eventType)).length;
  return {
    datasetKey: "funnel-ledger",
    projectionVersion: FUNNEL_VERSION,
    context: "scoped observations",
    asOf,
    timezone: "UTC",
    coverage: {
      events: events.length,
      opportunities: opps.length,
      creators: uniq(queue.map((row) => row.creator)).length,
      mature: mature.length,
      immature: opps.filter((es) => maturity(es) && millis(maturity(es)!) > millis(asOf)).length,
      unknownMaturity: opps.filter((es) => !maturity(es)).length,
      incomplete: !!(missingTimes || unresolvedIdentity || unavailable),
      missingTimes,
      unresolvedIdentity,
      unavailable,
    },
    milestones: stageRows(opps),
    queue,
    queueCounts,
    exclusions,
    sends: {
      attempts: attempts.length,
      recipients: uniq(attempts.map(creator)).length,
      confirmed: countOp(outbound, "confirmedSent"),
      uncertain: outbound.filter((es) => dispatchState(es) === "uncertain").length,
      queued: outbound.filter((es) => dispatchState(es) === "queued").length,
      replies: countOp(opps, "reply"),
      matched: countOp(opps, "matched"),
    },
    lifecycle: lifecycleMetrics(opps, mature, asOf),
    economics,
    outcomes: [
      measure("Views", views, "views", comparable.length),
      measure(
        "Engagement rate",
        views && engagements != null ? (100 * engagements) / views : null,
        "%",
        comparable.length,
      ),
      measure(
        "Attributed orders",
        orders.length || mature.length ? orders.length : null,
        "observed distinct orders",
        mature.length,
      ),
      measure("Attributed net sales", net, salesUnit, mature.length),
      measure("Retained orders", retainedOrders.length, "observed distinct orders", mature.length),
    ],
  };
}
