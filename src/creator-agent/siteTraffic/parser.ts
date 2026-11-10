import { trafficReportSchema, type TrafficReport } from "./contract.ts";
import { SiteTrafficError } from "./source.ts";

export const TRAFFIC_REPORT_MAX_BYTES = 1_000_000;
/** A provider API/export adapter supplies this bounded normalized aggregate format, never raw customers or URL/UTM strings. */
export function parseTrafficReport(body: string): TrafficReport {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > TRAFFIC_REPORT_MAX_BYTES) throw new SiteTrafficError("TRAFFIC_REPORT_TOO_LARGE", 422);
  let raw: unknown;
  try { raw = JSON.parse(body); } catch { throw new SiteTrafficError("TRAFFIC_REPORT_INVALID", 422); }
  const parsed = trafficReportSchema.safeParse(raw);
  if (!parsed.success || parsed.data.partitions.reduce((sum, partition) => sum + partition.rows.length, 0) > 10_000) throw new SiteTrafficError("TRAFFIC_REPORT_INVALID", 422);
  return parsed.data;
}
