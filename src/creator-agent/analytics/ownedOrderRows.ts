import { digest } from "../config.ts";
import { orderChannels, type OrderFeed, type OrderRow } from "./sources.ts";

const material = (rows: OrderRow[]) => rows.map(row => [
  row.canonicalOrderId ?? row.orderRef, row.recordOwner, row.valid, row.currency, row.netReceiptsMinor,
  row.placedAt, row.attribution, row.codeOwner,
]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));

/** The dashboard and operational reports share the same channel ownership, native precedence and order identity rules. */
export function ownedOrderRows(feeds: readonly OrderFeed[]) {
  const seen = new Set<string>();
  let conflict = false;
  const channels = orderChannels.map(channel => {
    const native = feeds.find(value => value.channel === channel && value.origin === "native");
    const mirror = feeds.find(value => value.channel === channel && value.origin === "mirror");
    const feed = native ?? mirror;
    const mismatch = Boolean(native && mirror && digest(material(native.orders)) !== digest(material(mirror.orders)));
    const rows = feed?.orders.filter(row => row.recordOwner === channel && row.valid) ?? [];
    for (const row of rows) {
      if (row.canonicalOrderId === null || seen.has(row.canonicalOrderId)) conflict = true;
      else seen.add(row.canonicalOrderId);
    }
    return { channel, feed, rows, mismatch };
  });
  return { channels, conflict };
}
