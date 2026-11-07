import type { CommercialEligibilityView } from "@/creator-agent/commercialPolicy/views";
import { creatorAssessmentPath } from "@/features/acquisition/creatorReviewPaths";

export type CommercialSelection = { offerId?: string; offerVersion?: string; phase?: CommercialEligibilityView["phase"] };
/** Invalid or duplicate explicit URL context is never silently replaced with another offer. */
export function commercialSelectionFromSearch(params: URLSearchParams): CommercialSelection | null {
  if (["offerId", "offerVersion", "phase"].some(key => params.getAll(key).length > 1)) return null;
  const offerId = params.get("offerId"), offerVersion = params.get("offerVersion"), phase = params.get("phase");
  if (offerId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(offerId) || offerVersion !== null && !/^v[1-9]\d*$/.test(offerVersion)) return null;
  if (phase !== null && phase !== "invitation" && phase !== "activation" && phase !== "shipment") return null;
  return { ...(offerId === null ? {} : { offerId }), ...(offerVersion === null ? {} : { offerVersion }), ...(phase === null ? {} : { phase }) };
}
export function commercialAssessmentPath(creatorId: string, runId: string, selection: CommercialSelection = {}): string {
  const params = new URLSearchParams();
  for (const key of ["offerId", "offerVersion", "phase"] as const) {
    const value = selection[key];
    if (value !== undefined) params.set(key, value);
  }
  return creatorAssessmentPath(creatorId, runId) + (params.size ? `?${params}` : "");
}
