/** Draft rules for the recruitment and invitation forms. They validate input; they never approve or send anything. */

export type Check = { ok: true } | { ok: false; error: string };
const ok: Check = { ok: true };
const bad = (error: string): Check => ({ ok: false, error });

/** The first "NN%" or "NN.N%" in a text, or null. */
export function percentOf(text: string): number | null {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Per-sale affiliate terms: a rate is required, and an upfront or guaranteed amount must be $0. */
export function checkAffiliateTerms(text: string, maxPct: number): Check {
  const pct = percentOf(text);
  if (pct === null) return bad("Enter a per-sale rate, for example 15%.");
  if (pct <= 0 || pct > maxPct) return bad(`The rate must be above 0% and at most ${maxPct}%.`);
  const fee = /\$\s*([\d,]+(?:\.\d+)?)\s*(upfront|guaranteed|flat|fixed)|(upfront|guaranteed|flat|fixed)[^$]*\$\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  const amount = fee ? Number((fee[1] ?? fee[4] ?? "0").replace(/,/g, "")) : 0;
  if (amount > 0) return bad("New acquisition has no upfront or guaranteed fee. Use $0, or remove it.");
  return ok;
}

/** Sample allocation in whole units, for example "1 creator · 1 sample". */
export function checkSampleAllocation(text: string): Check {
  const m = /^\s*(\d+)\s+creators?\s*[·,]\s*(\d+)\s+samples?\s*$/i.exec(text);
  if (!m) return bad("Use whole units, for example 1 creator · 1 sample.");
  return Number(m[2]) > Number(m[1]) ? bad("One sample per creator at most.") : ok;
}

/** A delivery window is either unset or two explicit dates. A posting date is never invented. */
export function checkDeliveryWindow(text: string): Check {
  const value = text.trim();
  if (value === "" || /^confirm in the source thread$/i.test(value)) return ok;
  const m = /^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (!m) return bad("Enter two dates as YYYY-MM-DD to YYYY-MM-DD, or leave it to confirm in the source thread.");
  return m[2]! < m[1]! ? bad("The window must not end before it starts.") : ok;
}

export const isDeliveryUnset = (text: string) => text.trim() === "" || /^confirm in the source thread$/i.test(text.trim());

/* ---- TikTok invitation ---- */

const pacificParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return [get("year"), get("month"), get("day"), get("hour"), get("minute")] as const;
};

/** A timestamp in Pacific time as "YYYY-MM-DD HH:mm PT", the demo's agreed timezone. Returns an ISO instant, or null for a malformed or impossible time. */
export function parsePacific(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) PT$/.exec(text.trim());
  if (!m) return null;
  const want = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(want[0], want[1] - 1, want[2], want[3], want[4]);
  const [y, mo, d, h, mi] = pacificParts(new Date(asUtc));
  const offset = asUtc - Date.UTC(y, mo - 1, d, h, mi);
  const instant = new Date(asUtc + offset);
  const back = pacificParts(instant);
  return back.every((v, i) => v === want[i]) ? instant.toISOString() : null;
}

export const checkStart = (text: string): Check => (parsePacific(text) ? ok : bad("Enter an exact start, for example 2026-11-10 09:00 PT."));

export function checkExpiry(text: string, start: string, maxDays: number): Check {
  const end = parsePacific(text);
  if (!end) return bad("Enter an exact end, for example 2026-11-17 09:00 PT. A seven-day validity is only a proposal.");
  const from = parsePacific(start);
  if (!from) return bad("Set the start first. The end must come after it.");
  if (end <= from) return bad("The invitation must expire after it starts.");
  const days = (Date.parse(end) - Date.parse(from)) / 86_400_000;
  return days > maxDays ? bad(`This program allows at most ${maxDays} days of validity.`) : ok;
}

export function checkCreator(text: string, known: readonly { handle: string; suppression: string }[]): Check {
  const found = known.find((c) => c.handle.toLowerCase() === text.trim().toLowerCase());
  if (!found) return bad("No creator matches this exact handle. Similar handles are never used.");
  return found.suppression === "suppressed" ? bad("This creator is suppressed. A fresh applicable approval is required.") : ok;
}

export function checkProduct(text: string, known: readonly { name: string }[]): Check {
  return known.some((p) => p.name.toLowerCase() === text.trim().toLowerCase()) ? ok : bad("No exact provider product matches. Pick a listed product.");
}

export function checkCommission(text: string, maxPct: number): Check {
  const pct = percentOf(text);
  if (pct === null) return bad("Enter a per-sale rate, for example 12%.");
  if (pct <= 0 || pct > maxPct) return bad(`The rate must be above 0% and at most ${maxPct}%.`);
  return /upfront|guaranteed|flat|fixed fee/i.test(text) ? bad("New acquisition has no upfront or guaranteed fee.") : ok;
}

export function checkSample(text: string): Check {
  return /^(no sample|free sample( · separate approval)?)$/i.test(text.trim()) ? ok : bad("Use Free sample · separate approval, or No sample.");
}
