import type { HubFilters, HubShipment, SelectedShipment } from "./types";
import { analyticsPeriodSchemaNative } from "@/creator-agent/analytics/contract";

export function shippingReportingPeriod(f: Pick<HubFilters, "start" | "end" | "timezone">) {
  if (!f.start && !f.end && !f.timezone) return { state: "none" as const };
  const parsed = analyticsPeriodSchemaNative.safeParse({ startAt: f.start, endAt: f.end, timezone: f.timezone, basis: "eventTime" });
  return parsed.success ? { state: "valid" as const, period: parsed.data } : { state: "invalid" as const };
}

export const pipelineLabels = { ready: "Ready to ship", label: "Label created", transit: "In transit", delivered: "Delivered", returns: "Return in progress" } as const;
export const originLabel = (s: HubShipment) => `${{ order: "Order", allocation: "Allocation", replacement: "Case", reward: "Reward" }[s.origin.kind]} ${s.origin.ref}`;
export const isLate = (s: HubShipment, now: string) => s.pipeline === "transit" && s.eta !== null && Date.parse(s.eta) < Date.parse(now);
export const needsAction = (s: HubShipment) => Boolean(s.exception) || s.pipeline === "returns";
export const duplicateTrackingIds = (rows: HubShipment[]) => {
  const refs = rows.map(s => s.trackingRef && `${s.carrier}:${s.trackingRef}`).filter(Boolean);
  return new Set(rows.filter(s => s.trackingRef && refs.filter(r => r === `${s.carrier}:${s.trackingRef}`).length > 1).map(s => s.id));
};
export function hubCounts(rows: HubShipment[], now: string) {
  return { total: rows.length, customers: rows.filter(s => s.recipient.type === "customer").length, creators: rows.filter(s => s.recipient.type === "creator").length,
    ready: rows.filter(s => s.pipeline === "ready").length, label: rows.filter(s => s.pipeline === "label").length, transit: rows.filter(s => s.pipeline === "transit").length,
    delivered: rows.filter(s => s.pipeline === "delivered").length, returns: rows.filter(s => s.pipeline === "returns").length,
    exceptions: rows.filter(s => s.exception).length, late: rows.filter(s => isLate(s, now)).length, needsAction: rows.filter(needsAction).length };
}
export function filterShipments(rows: HubShipment[], f: HubFilters, now: string) {
  const reporting = shippingReportingPeriod(f);
  if (reporting.state === "invalid") return [];
  const q = f.query.trim().toLowerCase();
  return rows.filter(s => (f.recipient === "all" || s.recipient.type === f.recipient) && (f.purpose === "all" || s.purpose === f.purpose)
    && (f.location === "all" || s.location === f.location) && (f.carrier === "all" || s.carrier === f.carrier) && (f.owner === "all" || s.owner === f.owner)
    && (f.state === "all" || (f.state === "exceptions" ? Boolean(s.exception) : s.pipeline === f.state))
    && (reporting.state !== "valid" || Date.parse(s.requestedAt) >= Date.parse(reporting.period.startAt) && Date.parse(s.requestedAt) < Date.parse(reporting.period.endAt))
    && (f.date === "all" || (f.date === "late" ? isLate(s, now) : Date.parse(s.requestedAt) >= Date.parse(now) - 7 * 86400000))
    && (!q || [s.id, s.parcelId, s.recipient.display, s.recipient.ref, s.origin.ref, s.trackingRef, s.recipient.type === "creator" ? s.recipient.collaborationRef : ""].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => (isLate(b, now) ? 2 : Number(Boolean(b.exception))) - (isLate(a, now) ? 2 : Number(Boolean(a.exception))) || Number(b.pipeline === "ready") - Number(a.pipeline === "ready") || Date.parse(a.requestedAt) - Date.parse(b.requestedAt) || a.id.localeCompare(b.id));
}

/** Includes every reviewed input so even an incorrectly unchanged row version cannot silently reuse a draft. */
export const proposalKey = (s: HubShipment) => JSON.stringify([s.version, s.origin, s.recipient, s.sku, s.quantity, s.location, s.reservationRef, s.addressRef, s.addressVerified, s.package, s.quote, s.readiness, s.label, s.reviewCapability, s.approval, s.freshness]);
export const selectShipment = (s: HubShipment): SelectedShipment => ({ id: s.id, version: s.version, proposalKey: proposalKey(s) });
export function reviewBlockers(s: HubShipment, now: string, duplicates = new Set<string>()): string[] {
  const reasons: string[] = [];
  if (s.label.state === "uncertain") return ["Label outcome is uncertain. Reconcile the existing request before retrying."];
  if (duplicates.has(s.id)) reasons.push("Tracking identity is shared by multiple parcels; reconcile the mapping.");
  if (s.label.state === "purchased") reasons.push("A purchased label already exists. Print/reprint must reuse it.");
  if (s.label.state === "failed") reasons.push("Failed label needs a source-confirmed not-applied result before a new proposal.");
  if (s.pipeline !== "ready") reasons.push("This parcel is not in the ready queue.");
  if (s.readiness !== "ready") reasons.push(`Readiness hold: ${s.readiness.replaceAll("-", " ")}.`);
  if (!s.reservationRef) reasons.push("A current stock reservation is required.");
  if (!s.addressVerified || !s.addressRef) reasons.push("Address verification is pending.");
  if (!s.package) reasons.push("Measured parcel weight and dimensions are required.");
  if (s.origin.kind === "allocation" && !s.origin.acceptedTermsVersion) reasons.push("Accepted sample terms are missing.");
  if ((s.origin.kind === "replacement" || s.origin.kind === "reward") && !s.origin.approvalRef) reasons.push("Source authorization is missing.");
  for (const field of ["inventory", "address", "quote", "terms"] as const) if (!s.freshness.some(f => f.field === field && f.state === "current")) reasons.push(`${field[0]!.toUpperCase()}${field.slice(1)} evidence is not current.`);
  if (!s.quote) reasons.push("No rate is available; cost is unknown.");
  else if (Date.parse(s.quote.expiresAt) <= Date.parse(now)) reasons.push("The quote expired. Refresh the proposal.");
  if (s.reviewCapability.state !== "available") reasons.push(s.reviewCapability.reason ?? "Label review capability is not available.");
  return [...new Set(reasons)];
}
export function reviewSelection(selected: SelectedShipment[], rows: HubShipment[], now: string, sourceHold: string | null = null) {
  const duplicates = duplicateTrackingIds(rows);
  const items = selected.map(prior => {
    const row = rows.find(s => s.id === prior.id);
    const changed = !row || prior.version !== row.version || prior.proposalKey !== proposalKey(row);
    return { id: prior.id, row, changed, reasons: !row ? ["Shipment is no longer present in this read."] : changed ? ["Shipment or capability changed. Reselect it after reviewing the refreshed source."] : sourceHold ? [sourceHold] : reviewBlockers(row, now, duplicates) };
  });
  const eligible = items.filter(x => x.row && x.reasons.length === 0);
  const currencies = [...new Set(eligible.map(x => x.row!.quote!.cost.currency))];
  return { items, eligible, blocked: items.length - eligible.length, stale: items.some(x => x.changed), currency: currencies.length === 1 ? currencies[0]! : null,
    quotedMinorUnits: eligible.length && currencies.length === 1 ? eligible.reduce((sum, x) => sum + x.row!.quote!.cost.minorUnits, 0) : null,
    maximumMinorUnits: eligible.length && currencies.length === 1 ? eligible.reduce((sum, x) => sum + x.row!.quote!.maxCost.minorUnits, 0) : null };
}
