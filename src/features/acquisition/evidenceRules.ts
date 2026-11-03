import type { CheckoutRoute, Modality, Observation, ObservationCategory } from "./evidenceTypes";

export const MODEL_FOR_ROUTE: Record<CheckoutRoute, string> = { website: "WEBSITE-AFFILIATE-v3", "tiktok-shop": "TIKTOK-SHOP-AFFILIATE-v3" };
export const ROUTE_LABEL: Record<CheckoutRoute, string> = { website: "Shopify website", "tiktok-shop": "TikTok Shop" };
export const CATEGORY_LABEL: Record<ObservationCategory, string> = {
  hook: "Opening hook",
  demonstration: "Routine / product demonstration",
  framing: "Visual framing and accessibility",
  audio: "Audio and narrative",
};
export const MAX_OBSERVATIONS = 50;
export const MAX_TEXT = 500;

export const modalityOf = (category: ObservationCategory): Modality => (category === "audio" ? "audio" : "visual");

export const formatTime = (totalSec: number) => `${Math.floor(totalSec / 60)}:${String(Math.floor(totalSec % 60)).padStart(2, "0")}`;

/** "m:ss" to seconds, or null when it isn't a time. */
export function parseTime(text: string): number | null {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(text.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const PROFILE = "That looks like a profile or listing page. Use the address of one video; a profile isn't video evidence.";

/** An error message, or null when the address is acceptable. An empty address is acceptable: it stays unknown. */
export function validateMediaUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Enter the full address of the video, starting with https://.";
  }
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (url.username || url.password) return "Remove the login details from the address.";
  const host = url.hostname.replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");
  if (host === "instagram.com") {
    if (/^\/(reel|reels|p|tv)\/[\w-]+$/.test(path)) return null;
    return /^\/[\w.]+$/.test(path) ? PROFILE : "That Instagram address isn't a single video.";
  }
  if (host === "tiktok.com") {
    if (/^\/@[\w.]+\/video\/\d+$/.test(path)) return null;
    return /^\/@[\w.]+$/.test(path) ? PROFILE : "That TikTok address isn't a single video.";
  }
  return "Only Instagram and TikTok videos are supported.";
}

/** Field errors for one observation, keyed by field. Empty when valid. */
export function validateObservation(o: Pick<Observation, "category" | "startSec" | "endSec" | "text">): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!(o.category in CATEGORY_LABEL)) errors.category = "Choose what was observed.";
  if (!Number.isFinite(o.startSec) || o.startSec < 0) errors.start = "Enter the start time as m:ss.";
  if (!Number.isFinite(o.endSec) || o.endSec <= o.startSec) errors.end = "The end must be after the start.";
  const text = o.text.trim();
  if (!text) errors.text = "Describe what you saw or heard.";
  else if (text.length > MAX_TEXT) errors.text = `Keep it under ${MAX_TEXT} characters.`;
  return errors;
}

/** Seconds covered for one modality, counting overlapping intervals once and ignoring observations from other media. */
export function coveredSeconds(observations: readonly Observation[], modality: Modality, mediaUrl: string | null): number {
  const spans = observations
    .filter((o) => modalityOf(o.category) === modality && o.recordedAgainst === mediaUrl)
    .map((o) => [o.startSec, o.endSec] as const)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [s, e] of spans) {
    const from = Math.max(s, end);
    if (e > from) total += e - from;
    end = Math.max(end, e);
  }
  return total;
}
