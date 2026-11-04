/**
 * Support fixtures (Figma source 7:317) — SYNTHETIC. The 14-day cohort: 45 tickets = 18 setup + 12 shipping + 6 returns + 9 hardware;
 * 27 of 45 resolved on first contact; 18 returns of 300 delivered units. The all-time open queue (7) is a different set from the six
 * cohort-open tickets. Only safe operational fields are mirrored: no conversation text, name, email or address.
 */
import type { Money, ProvenanceValue } from "@/adapter/contract";
import { known, usd } from "./values";

export type SupportState = "Needs reply" | "Waiting" | "In review" | "Resolved";
export type SupportCase = {
  id: string;
  orderRef: string;
  type: string;
  state: SupportState;
  owner: string;
  /** Human-readable status in the case panel. */
  status: string;
  linkedShipment: string | null;
  linkedReturn: string | null;
  updatedMinutesAgo: number;
  nextStep: string;
  /** Resolved cases can reopen. Others can't be "reopened". */
  canReopen: boolean;
  version: string;
};

export type SupportWorkspace = {
  datasetKey: "support-demo";
  caseId: string;
  case: SupportCase;
  queue: SupportCase[];
  allTimeOpen: ProvenanceValue<number>;
  cohort: { days: 14; tickets: { label: string; count: number }[]; resolvedFirstContact: number; open: number; returns: number; deliveredUnits: number; reviews: number };
  fin: { cost: Money; cap: Money };
  outcomes: { refundedAmount: Money; refundedOrders: number; replacementShipments: number };
  source: { label: string; syncedMinutesAgo: number };
};

const NEXT_RESOLVE = "Confirm refund or replacement in Intercom. A decision is complete only after the source receipt is recorded.";

const CASES: SupportCase[] = [
  { id: "TEST-ISS-021", orderRef: "TEST-SH-1031", type: "Lost shipment", state: "Needs reply", owner: "Ops", status: "Human handoff", linkedShipment: "TEST-SP-0093", linkedReturn: null, updatedMinutesAgo: 11, nextStep: NEXT_RESOLVE, canReopen: false, version: "c1" },
  { id: "TEST-ISS-020", orderRef: "TEST-TT-1031", type: "Setup help", state: "Waiting", owner: "Support", status: "Waiting for the customer", linkedShipment: null, linkedReturn: null, updatedMinutesAgo: 95, nextStep: "Wait for the customer's reply in Intercom. Nothing is due from operations.", canReopen: false, version: "c1" },
  { id: "TEST-ISS-018", orderRef: "TEST-SH-1028", type: "Return", state: "In review", owner: "Support", status: "Return in review", linkedShipment: null, linkedReturn: "TEST-RET-028", updatedMinutesAgo: 240, nextStep: "Review the inspected return and its refund. The return page shows which source receipts are still missing.", canReopen: false, version: "c1" },
  { id: "TEST-ISS-016", orderRef: "TEST-SH-1019", type: "Pairing", state: "Resolved", owner: "Fin", status: "Resolved by Fin", linkedShipment: null, linkedReturn: null, updatedMinutesAgo: 1440, nextStep: "No action. If the customer needs further help, reopen the case in Intercom.", canReopen: true, version: "c1" },
];

export const supportCaseIds = CASES.map((c) => c.id);

export const supportDemo = (caseId: string, scenario?: string): SupportWorkspace | null => {
  const found = CASES.find((c) => c.id === caseId);
  if (!found) return null;
  const tickets = [{ label: "Setup / pairing", count: 18 }, { label: "Shipping", count: 12 }, { label: "Returns", count: 6 }, { label: "Hardware", count: 9 }];
  return {
    datasetKey: "support-demo",
    caseId,
    case: structuredClone(found),
    queue: structuredClone(CASES),
    allTimeOpen: known(7),
    cohort: { days: 14, tickets, resolvedFirstContact: 27, open: 6, returns: 18, deliveredUnits: 300, reviews: 19 },
    fin: { cost: usd(4800), cap: usd(15000) },
    outcomes: { refundedAmount: usd(10497), refundedOrders: 3, replacementShipments: 2 },
    source: { label: "Intercom", syncedMinutesAgo: scenario === "stale" ? 190 : 11 },
  };
};
