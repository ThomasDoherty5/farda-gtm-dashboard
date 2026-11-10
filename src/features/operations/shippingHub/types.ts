export type { HubShipment, ShippingHubData } from "@/adapter/viewSchemas/shippingHub";
export type HubFilters = { recipient: string; purpose: string; location: string; carrier: string; owner: string; date: string; state: string; query: string; start: string; end: string; timezone: string };
export const HUB_DEFAULT_FILTERS: HubFilters = { recipient: "all", purpose: "all", location: "all", carrier: "all", owner: "all", date: "all", state: "all", query: "", start: "", end: "", timezone: "" };
export type SelectedShipment = { id: string; version: string; proposalKey: string };
