import { describe, expect, it } from "vitest";
import { shippingHubDemo, SHIPPING_DEMO_NOW } from "@/fixtures/shippingHub";
import { hubShipmentSchema, shippingHubSchema } from "@/adapter/viewSchemas/shippingHub";
import { duplicateTrackingIds, filterShipments, hubCounts, reviewBlockers, reviewSelection, selectShipment } from "./selectors";
import { HUB_DEFAULT_FILTERS } from "./types";

describe("shared shipping model", () => {
  it("reconciles recipients and disjoint pipeline counts without adding exceptions twice", () => {
    const d = shippingHubDemo();
    expect(shippingHubSchema.safeParse(d).success).toBe(true);
    const c = hubCounts(d.shipments, d.observedAt);
    expect(c).toMatchObject({ total: 6, customers: 3, creators: 3, ready: 2, label: 1, transit: 1, delivered: 1, returns: 1, exceptions: 2, needsAction: 3 });
    expect(c.ready + c.label + c.transit + c.delivered + c.returns).toBe(c.total);
  });
  it("keeps a creator replacement typed as creator and a split order as two parcels", () => {
    const d = shippingHubDemo("edge");
    expect(shippingHubSchema.safeParse(d).success).toBe(true);
    const replacement = d.shipments.find(s => s.id === "DEMO-SHIP-C021")!;
    expect(replacement.recipient.type).toBe("creator");
    expect(replacement.origin).toMatchObject({ kind: "replacement", parentOriginRef: "DEMO-C018" });
    const split = d.shipments.filter(s => s.origin.ref === "DEMO-1043");
    expect(split.map(s => s.parcelIndex)).toEqual([1, 2]);
    expect(new Set(split.map(s => s.parcelId)).size).toBe(2);
  });
  it("does not infer carrier acceptance from a purchased label", () => {
    const s = shippingHubDemo().shipments.find(s => s.pipeline === "label")!;
    expect(s.label.state).toBe("purchased");
    expect(s.carrierState).toBe("pre-transit");
    expect(reviewBlockers(s, SHIPPING_DEMO_NOW).join(" ")).toContain("Print/reprint must reuse it");
    expect(hubShipmentSchema.safeParse({ ...s, pipeline: "delivered" }).success).toBe(false);
  });
  it("blocks uncertain labels, conflicting stock, unapproved samples and duplicate tracking", () => {
    const d = shippingHubDemo("edge");
    const dup = duplicateTrackingIds(d.shipments);
    expect([...dup]).toEqual(["DEMO-SHIP-1041", "DEMO-SHIP-1043-P1"]);
    expect(reviewBlockers(d.shipments.find(s => s.id === "DEMO-SHIP-C021")!, d.observedAt)[0]).toMatch(/Reconcile/);
    expect(reviewBlockers(d.shipments.find(s => s.id === "DEMO-SHIP-1043-P2")!, d.observedAt).join(" ")).toMatch(/reservation conflict/);
    expect(reviewBlockers(d.shipments.find(s => s.id === "DEMO-SHIP-C022")!, d.observedAt).join(" ")).toMatch(/Accepted sample terms are missing/);
    expect(reviewBlockers(d.shipments.find(s => s.id === "DEMO-SHIP-1043-P1")!, d.observedAt, dup).join(" ")).toMatch(/Tracking identity/);
  });
  it("keeps unknown costs out of the subtotal and never treats a quote as an actual label cost", () => {
    const d = shippingHubDemo();
    const review = reviewSelection(d.initialSelection.map(id => selectShipment(d.shipments.find(s => s.id === id)!)), d.shipments, d.observedAt);
    expect(review).toMatchObject({ blocked: 1, quotedMinorUnits: 685, maximumMinorUnits: 700, currency: "USD" });
    expect(review.eligible[0]!.row!.label.cost).toBeNull();
  });
  it.each(["version", "address", "package", "quote", "capability", "freshness"])("invalidates selection when %s changes, even if other fields remain unchanged", (field) => {
    const d = shippingHubDemo(); const row = d.shipments.find(s => s.id === "DEMO-SHIP-1042")!; const selected = [selectShipment(row)];
    if (field === "version") row.version = "v2";
    if (field === "address") row.addressRef = "demo-new-address";
    if (field === "package") row.package!.weightGrams = 650;
    if (field === "quote") row.quote!.cost.minorUnits = 699;
    if (field === "capability") row.reviewCapability.state = "denied";
    if (field === "freshness") row.freshness[1]!.state = "stale";
    const result = reviewSelection(selected, d.shipments, d.observedAt);
    expect(result.stale).toBe(true); expect(result.eligible).toHaveLength(0);
  });
  it("holds expired quotes and missing parcel measurements", () => {
    const row = shippingHubDemo().shipments.find(s => s.id === "DEMO-SHIP-1042")!;
    expect(reviewBlockers(row, "2026-11-04T20:00:00.000Z").join(" ")).toMatch(/quote expired/);
    row.package = null;
    expect(reviewBlockers(row, SHIPPING_DEMO_NOW).join(" ")).toMatch(/weight and dimensions/);
  });
  it("requires verified creator delivery before exposing a posting clock", () => {
    const delivered = shippingHubDemo().shipments.find(s => s.postingClock)!;
    expect(hubShipmentSchema.safeParse(delivered).success).toBe(true);
    expect(hubShipmentSchema.safeParse({ ...delivered, carrierState: "pre-transit" }).success).toBe(false);
  });
  it("rejects unexpected personal fields and ambiguous parcel identity", () => {
    const d = shippingHubDemo();
    expect(hubShipmentSchema.safeParse({ ...d.shipments[0], address: "Should not be mirrored" }).success).toBe(false);
    expect(shippingHubSchema.safeParse({ ...d, shipments: [...d.shipments, d.shipments[0]] }).success).toBe(false);
  });
  it("searches native allocation references, retains creator-only samples, and sorts exceptions first", () => {
    const d = shippingHubDemo();
    const creators = filterShipments(d.shipments, { ...HUB_DEFAULT_FILTERS, recipient: "creator" }, d.observedAt);
    expect(creators).toHaveLength(3);
    expect(creators[0]!.origin.kind).toBe("allocation");
    expect(filterShipments(d.shipments, { ...HUB_DEFAULT_FILTERS, query: "demo-c020" }, d.observedAt)[0]!.id).toBe("DEMO-SHIP-C020");
    expect(filterShipments(d.shipments, HUB_DEFAULT_FILTERS, d.observedAt).slice(0, 2).map(s => s.id)).toEqual(["DEMO-SHIP-1041", "DEMO-SHIP-C018"]);
  });
});
