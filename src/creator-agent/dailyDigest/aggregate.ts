import {
  digestResultSchema, type DigestAmount, type DigestCount, type DigestCoverage,
  type DigestDataset, type DigestResult, type DigestRow, type DigestWindow,
} from "./contract.ts";

const hour = 3_600_000;
const week = 7 * 24 * hour;
type Amount = DigestResult["amounts"][number];
type Money = Omit<Amount, "key">;

export function unavailableDigestResult(dataset: DigestDataset, reason: NonNullable<DigestResult["reason"]>): DigestResult {
  return {
    dataset, state: reason === "partialCoverage" ? "partial" : "unavailable",
    reason, coverage: null, exceptions: 0, counts: [], amounts: [], handles: [],
  };
}

/** Aggregate a complete, canonical row set. Missing fields are visible even after the cursor is exhausted. */
export function aggregateDigestDataset(
  dataset: DigestDataset, rows: readonly DigestRow[], coverage: DigestCoverage, window: DigestWindow,
): DigestResult {
  const counts = new Map<DigestCount, number>();
  const amounts = new Map<string, Amount>();
  const missingCounts = new Set<DigestCount>();
  const missingAmounts = new Set<DigestAmount>();
  const noPost: { handle: string; due: number }[] = [];
  const slot = Date.parse(window.scheduledAt);
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  const todayEnd = Date.parse(window.nextDayStart);
  const asOf = Date.parse(coverage.sourceAsOf);
  let exceptions = 0;
  let unknown = false;
  let activeStages = 0;
  let exceptionLastSuccessAt: string | null | undefined;

  const add = (key: DigestCount, value = 1) => {
    const total = (counts.get(key) ?? 0) + value;
    if (!Number.isSafeInteger(total)) {
      missingCounts.add(key);
      unknown = true;
    } else {
      counts.set(key, total);
    }
  };
  const flag = (key: DigestCount) => { add(key); exceptions += 1; };
  const noteSuccess = (value: string | null) => {
    if (value === null || exceptionLastSuccessAt === undefined ||
        (exceptionLastSuccessAt !== null && Date.parse(value) < Date.parse(exceptionLastSuccessAt))) {
      exceptionLastSuccessAt = value;
    }
  };
  const missing = (key: DigestCount) => { missingCounts.add(key); unknown = true; };
  const money = (key: DigestAmount, value: Money | null) => {
    if (!value) { missingAmounts.add(key); unknown = true; return; }
    const group = key + "/" + value.currency;
    const prior = amounts.get(group);
    const minorUnits = (prior?.minorUnits ?? 0) + value.minorUnits;
    if ((prior && prior.decimals !== value.decimals) || !Number.isSafeInteger(minorUnits)) {
      missingAmounts.add(key);
      unknown = true;
      return;
    }
    amounts.set(group, { key, ...value, minorUnits });
  };
  const yesterday = (time: number) => start <= time && time < end;

  for (const row of rows) {
    if (row.dataset !== dataset) throw new Error("DIGEST_DATASET_MISMATCH");
    switch (row.dataset) {
      case "launch": {
        if (!row.open) break;
        if (row.type === "approval") {
          if (!row.openedAt || Date.parse(row.openedAt) > asOf) missing("pendingApprovals");
          else if (slot - Date.parse(row.openedAt) > 24 * hour) flag("pendingApprovals");
          break;
        }
        const due = row.dueAt ? Date.parse(row.dueAt) : null;
        if (row.priority === null || (row.priority === "P0" && due === null)) {
          missing("overdueP0");
          missing("nextP0");
        }
        if (row.priority === "P0" && due !== null) {
          if (due < slot) flag("overdueP0");
          else if (due <= slot + 48 * hour) flag("nextP0");
        }
        if (row.ownerAssigned === false && due === null) missing("ownerless");
        if (due !== null && slot <= due && due <= slot + week) {
          if (row.ownerAssigned === false) flag("ownerless");
          if (row.ownerAssigned === null) missing("ownerless");
        }
        break;
      }
      case "creators": {
        if (row.followUpPending) {
          if (!row.followUpDueAt) missing("followUps");
          else if (end <= Date.parse(row.followUpDueAt) && Date.parse(row.followUpDueAt) < todayEnd) flag("followUps");
        }
        if (row.dataCheck) flag("creatorChecks");
        if (row.postState === "unknown") {
          missing("noPost");
          missing("awaitingPost");
        }
        if (row.postState === "awaiting") {
          if (!row.postingDueAt) missing("noPost");
          else if (Date.parse(row.postingDueAt) < slot) {
            flag("noPost");
            if (row.handle) noPost.push({ handle: row.handle, due: Date.parse(row.postingDueAt) });
          }
          if (row.sampleDeliveredAt) {
            if (Date.parse(row.sampleDeliveredAt) > asOf) missing("awaitingPost");
            else if (Date.parse(row.sampleDeliveredAt) <= slot) flag("awaitingPost");
          }
        }
        break;
      }
      case "content": {
        if (row.state === "review") {
          if (!row.reviewDueAt) missing("overdueReview");
          else if (Date.parse(row.reviewDueAt) < slot) flag("overdueReview");
        }
        if (row.rights === "unknown" || (row.rights === "finite") !== (row.rightsExpiresAt !== null)) {
          missing("expiringRights");
        } else if (row.rightsExpiresAt && slot <= Date.parse(row.rightsExpiresAt) && Date.parse(row.rightsExpiresAt) <= slot + week) {
          flag("expiringRights");
        }
        if (row.state === "live") {
          if (!row.metricsAsOf || Date.parse(row.metricsAsOf) > asOf) missing("staleMetrics");
          else if (slot - Date.parse(row.metricsAsOf) > week) {
            flag("staleMetrics");
            noteSuccess(row.metricsAsOf);
          }
        }
        break;
      }
      case "orders": {
        if (row.type === "refund") {
          const occurred = Date.parse(row.occurredAt);
          if (occurred > asOf) money("refunds", null);
          else if (yesterday(occurred)) money("refunds", row.refund);
          break;
        }
        const placed = Date.parse(row.placedAt);
        if (placed > asOf) {
          missing("orders");
          missing("retainedUnits");
          money("netReceipts", null);
        } else if (row.validOrder && yesterday(placed)) {
          add("orders");
          if (row.retainedUnits === null) missing("retainedUnits");
          else add("retainedUnits", row.retainedUnits);
          // The source already applied its refund rules to net receipts.
          // Refund events are a separate total, never subtracted a second time.
          money("netReceipts", row.netReceipts);
        }
        if (row.check === "failed" || row.check === "unattributed") flag("orderChecks");
        else if (row.check === "unknown") missing("orderChecks");
        break;
      }
      case "media": {
        if (Date.parse(row.start) !== start || Date.parse(row.end) !== end) money("adSpend", null);
        else money("adSpend", row.spend);
        if (row.stageState === "unknown") missing("capWarnings");
        if (row.stageState === "released") {
          activeStages += 1;
          if (!row.stage || row.stage.spent.currency !== row.stage.limit.currency || row.stage.spent.decimals !== row.stage.limit.decimals) {
            missing("capWarnings");
          } else {
            money("stageSpent", row.stage.spent);
            money("stageLimit", row.stage.limit);
            if (10n * BigInt(row.stage.spent.minorUnits) >= 9n * BigInt(row.stage.limit.minorUnits)) flag("capWarnings");
          }
        }
        break;
      }
      case "support": {
        if (!row.open) break;
        if (!row.currentOpenedAt || Date.parse(row.currentOpenedAt) > asOf) missing("agedSupport");
        else if (slot - Date.parse(row.currentOpenedAt) > 48 * hour) flag("agedSupport");
        break;
      }
      case "reviews": {
        const posted = Date.parse(row.postedAt);
        if (posted > asOf || (yesterday(posted) && row.stars === null)) missing("lowReviews");
        else if (yesterday(posted) && row.stars !== null && row.stars <= 2) flag("lowReviews");
        break;
      }
      case "stock": {
        if (row.available === null) missing("availableStock");
        else add("availableStock", row.available);
        if (row.low === null) missing("lowStock");
        else if (row.low) flag("lowStock");
        break;
      }
      case "freshness": {
        if (row.adImport && (row.state === "stale" || row.state === "neverSynced")) {
          const lastSuccessAt = row.adImport.lastSuccessAt;
          const inconsistent = (row.state === "neverSynced") !== (lastSuccessAt === null);
          if (inconsistent || (lastSuccessAt !== null && Date.parse(lastSuccessAt) > asOf)) missing("missedAdImports");
          else {
            flag("missedAdImports");
            noteSuccess(lastSuccessAt);
          }
        } else if (row.state === "unknown" || row.state === "partial") missing(row.adImport ? "missedAdImports" : "staleSources");
        else if (["stale", "failed", "revoked", "neverSynced"].includes(row.state)) flag("staleSources");
        break;
      }
    }
  }
  if (activeStages > 1) {
    // No financial comparison may combine two independently capped stages.
    missing("capWarnings");
    missingAmounts.add("stageSpent");
    missingAmounts.add("stageLimit");
  }
  const comparableAmounts = [...amounts.values()].filter(value => !missingAmounts.has(value.key));
  if (comparableAmounts.length > 8) unknown = true;
  const handles = [...new Set(noPost.sort((a, b) => b.due - a.due || a.handle.localeCompare(b.handle)).map(value => value.handle))].slice(0, 3);
  return digestResultSchema.parse({
    dataset, state: unknown ? "partial" : "complete", reason: unknown ? "unknownFields" : null,
    coverage, exceptions, handles,
    ...(exceptionLastSuccessAt === undefined ? {} : { exceptionLastSuccessAt }),
    counts: [...counts].filter(([key]) => !missingCounts.has(key)).map(([key, value]) => ({ key, value })),
    amounts: comparableAmounts.length > 8 ? [] : comparableAmounts,
  });
}
