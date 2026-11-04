import type { LaunchGate } from "@/fixtures/analytics";

export function summarizeGates(gates: LaunchGate[]) {
  const blocked = gates.filter((g) => g.state === "blocked").length;
  return { total: gates.length, passed: gates.length - blocked, blocked };
}

/** A real calendar date in YYYY-MM-DD form. "2026-02-30" is rejected, not rolled over. */
export function isCalendarDate(text: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export type ProposalCheck = { dateError: string | null; evidenceError: string | null; ok: boolean; proposedDate: string | null };

/**
 * Checks a proposed launch date (CTRL-200) and its evidence reference (CTRL-201). An empty date is valid and means
 * L stays unset. A date needs a reason or evidence reference before founder review, and a link must be https.
 */
export function checkProposal(date: string, evidence: string): ProposalCheck {
  const d = date.trim();
  const e = evidence.trim();
  const dateError = d === "" || isCalendarDate(d) ? null : "Enter a real calendar date as YYYY-MM-DD, or leave it unset.";
  let evidenceError: string | null = null;
  if (e === "") evidenceError = "Required before founder review.";
  else if (e.includes("://") && !e.toLowerCase().startsWith("https://")) evidenceError = "Use an https link to the sample acceptance, or a record reference.";
  return { dateError, evidenceError, ok: !dateError && !evidenceError, proposedDate: d === "" || dateError ? null : d };
}

/** Go needs a set launch date and every required gate passing (CTRL-199). */
export function goBlockedReason(launchDateSet: boolean, blocked: number): string | null {
  const reasons: string[] = [];
  if (!launchDateSet) reasons.push("the launch date is unset");
  if (blocked > 0) reasons.push(`${blocked} required ${blocked === 1 ? "gate is" : "gates are"} blocked`);
  return reasons.length ? `Go is unavailable: ${reasons.join(" and ")}.` : null;
}
