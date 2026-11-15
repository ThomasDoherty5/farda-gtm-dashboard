export const alertCatalog = {
  mediaNearCap: ["media", "Media at 90% of stage cap"],
  mediaAtCap: ["media", "Media at stage cap"],
  budgetOverrun: ["budget", "Budget overrun"],
  budgetCeiling: ["budget", "Approved budget ceiling"],
  lowStock: ["inventory", "Low customer stock"],
  zeroStock: ["inventory", "No customer stock available"],
  sampleReserve: ["inventory", "Sample reserve exhausted"],
  shipmentStale: ["shipment", "Shipment tracking stale"],
  shipmentException: ["shipment", "Shipment exception"],
  supportAge: ["support", "Open support case over threshold"],
  lowRating: ["review", "Low product rating"],
  orderChecks: ["orders", "Orders with identity or attribution issues"],
} as const;
export type AlertKind = keyof typeof alertCatalog;
export const alertKinds = Object.keys(alertCatalog) as [AlertKind, ...AlertKind[]];
