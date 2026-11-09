import { invitationTermsSchema, type NativeInvitationView } from "@/creator-agent/recruitment/contract";

/** Field feedback only. Current source authority and all bounds are rechecked by the service. */
type ValidationSource = Pick<NativeInvitationView, "limits" | "products" | "creators"> & { offer: Pick<NonNullable<NativeInvitationView["offer"]>, "expiresAt" | "standardRateBps" | "shopAdsRateBps"> | null };
export function invitationFieldIssues(raw: unknown, data: ValidationSource, now = Date.now()): Record<string, string> {
  const parsed = invitationTermsSchema.safeParse(raw);
  if (!parsed.success) return Object.fromEntries(parsed.error.issues.map(issue => [issue.path[0] ?? "expiresAt", issue.message]));
  const terms = parsed.data, limits = data.limits, issues: Record<string, string> = {};
  const start = Date.parse(terms.startsAt), end = Date.parse(terms.expiresAt);
  if (start < now || limits.startsNotBefore && start < Date.parse(limits.startsNotBefore)) issues.startsAt = "Choose a future start within the source program window.";
  if (limits.maxValiditySeconds === null) issues.expiresAt = "The source has not provided its supported validity window.";
  else if (end - start > limits.maxValiditySeconds * 1000 || limits.expiresNotAfter && end > Date.parse(limits.expiresNotAfter) || data.offer?.expiresAt && end > Date.parse(data.offer.expiresAt)) issues.expiresAt = "Expiry exceeds the source program or saved offer window.";
  if (!limits.timezone || terms.timezone !== limits.timezone) issues.startsAt = "Refresh the source timezone before saving.";
  if (!data.products.some(p => p.ref === terms.productRef && p.programRef === terms.programRef && p.eligible === true)) issues.productRef = "Select a currently eligible source listing and program.";
  if (!data.creators.some(c => c.creatorId === terms.creatorId && c.eligible === true)) issues.creatorId = "This creator needs current source eligibility and suppression checks.";
  if (data.offer && [data.offer.standardRateBps, data.offer.shopAdsRateBps].some(rate => rate !== null && (limits.maxRateBps === null || rate > limits.maxRateBps))) issues.commission = "The saved commission exceeds current source limits. Revise the offer first.";
  return issues;
}
