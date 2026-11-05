export type { HubShipment, ShippingHubData } from "@/adapter/viewSchemas/shippingHub";
export type HubFilters = { recipient: string; purpose: string; location: string; carrier: string; owner: string; date: string; state: string; query: string };
export const HUB_DEFAULT_FILTERS: HubFilters = { recipient: "all", purpose: "all", location: "all", carrier: "all", owner: "all", date: "all", state: "all", query: "" };
export type SelectedShipment = { id: string; version: string; proposalKey: string };
