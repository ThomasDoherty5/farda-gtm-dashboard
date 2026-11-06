import { z } from "zod";
import { digest } from "./config.ts";
import type { PortfolioPacket } from "./portfolio.ts";

const ref = z.string().trim().min(1).max(240);
const instant = z.string().datetime({ offset: true });
const scope = z.object({ workspaceId: ref, accountId: ref }).strict();
export const portfolioSourceBindingSchema = z.object({
  programId: ref, campaignId: ref, reviewWindow: z.object({ start: instant, end: instant }).strict(),
  evidenceRevision: ref, packetDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function portfolioSourceBinding(packet: PortfolioPacket): z.infer<typeof portfolioSourceBindingSchema> {
  // A source assigns its own locator after sealing. Verify it separately from the packet contents.
  const { kind, eventId } = packet.trigger;
  return { programId: packet.programId, campaignId: packet.campaignId, reviewWindow: packet.reviewWindow,
    evidenceRevision: packet.evidenceRevision, packetDigest: digest({ ...packet, trigger: { kind, eventId } }) };
}
export const verifiedPortfolioWeeklyEventSchema = z.object({
  scope, sourceRef: ref, eventId: ref, snapshotVersion: ref, sealedAt: instant,
  binding: portfolioSourceBindingSchema,
}).strict();
export type VerifiedPortfolioWeeklyEvent = z.infer<typeof verifiedPortfolioWeeklyEventSchema>;
export const portfolioLinearProofSchema = z.object({
  issueId: z.string().uuid(), commentId: z.string().uuid(), manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  j04ReceiptRef: ref, expiresAt: instant,
}).strict();

const calendar = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function pacific(time: string) {
  const parts = Object.fromEntries(calendar.formatToParts(new Date(time)).map(({ type, value }) => [type, value]));
  return { date: [parts.year, parts.month, parts.day].join("-"), time: [parts.hour, parts.minute].join(":") };
}
/** The first pre-read is Monday after launch at 08:30 Pacific, covering the completed local week. */
export function weeklyWindowReleased(launchAt: string | null | undefined, snapshot: VerifiedPortfolioWeeklyEvent): boolean {
  if (typeof launchAt !== "string" || !instant.safeParse(launchAt).success) return false;
  const day = (date: string) => new Date(date + "T00:00:00Z");
  const firstMonday = day(pacific(launchAt).date);
  firstMonday.setUTCDate(firstMonday.getUTCDate() + ((8 - firstMonday.getUTCDay()) % 7 || 7));
  const window = snapshot.binding.reviewWindow;
  const start = pacific(window.start);
  const end = pacific(window.end);
  const exactMidnight = (time: string) => Date.parse(time) % 60_000 === 0;
  if (start.time !== "00:00" || end.time !== "00:00" || !exactMidnight(window.start) || !exactMidnight(window.end)) return false;
  // Calendar-day arithmetic handles weeks containing a daylight-saving transition.
  if (day(end.date).getUTCDay() !== 1 || +day(end.date) - +day(start.date) !== 7 * 86_400_000 || day(end.date) < firstMonday) return false;
  const sealed = pacific(snapshot.sealedAt);
  return sealed.date > end.date || sealed.date === end.date && sealed.time >= "08:30";
}
