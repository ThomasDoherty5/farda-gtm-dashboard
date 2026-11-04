import type { ProvenanceValue } from "@/adapter/contract";
import { DEMO_NOW } from "./overview";

/** Builders for demo provenance values. Known zero, unknown and not applicable stay three different states. */
const base = { evidenceRefs: [] as string[], sourceRef: null, occurredAt: null, sourceUpdatedAt: DEMO_NOW, observedAt: DEMO_NOW };

export const known = <T>(value: T): ProvenanceValue<T> => ({ ...base, state: "known", value, reasonCode: null });
export const unknown = <T>(reasonCode: string): ProvenanceValue<T> => ({ ...base, state: "unknown", value: null, reasonCode });
export const notApplicable = <T>(reasonCode: string): ProvenanceValue<T> => ({ ...base, state: "notApplicable", value: null, reasonCode });
export const usd = (minorUnits: number) => ({ minorUnits, currency: "USD" });
