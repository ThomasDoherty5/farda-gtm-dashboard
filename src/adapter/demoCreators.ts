import type { ReadRequest, ReadResponse } from "./contract";
import { AdapterError } from "./errors";
import { respondWith } from "./demoViews";
import { OWNERS, filterSocialCatBoard, filterSocialCatDashboard, searchTikTokBoard, tiktokDashboardDemo, type SocialCatBoardData, type SocialCatDashboardData } from "@/fixtures/creators";

const invalid = (requestId: string, message: string): never => {
  throw new AdapterError({ code: "VALIDATION_FAILED", message, requestId, correlationId: `demo-${requestId}`, retryable: false, retryAfterMs: null });
};

/** Demo reads for the Social Cat and TikTok boards and dashboards. Allowed filter values are checked; anything else is a validation error. */
export function readCreatorsView(request: ReadRequest<unknown>): ReadResponse<unknown> | null {
  const filters = (request.filters ?? {}) as Record<string, string | undefined>;
  switch (request.viewKey) {
    case "socialCatBoard": {
      const owner = filters.owner ?? "all";
      if (owner !== "all" && !(OWNERS as readonly string[]).includes(owner)) invalid(request.requestId, `owner must be all or one of ${OWNERS.join(", ")}.`);
      return respondWith(request, filterSocialCatBoard(owner as SocialCatBoardData["owner"]), { dataVersion: "social-cat-board-demo@1" });
    }
    case "socialCatDashboard": {
      const network = filters.network ?? "all";
      if (!["all", "instagram", "tiktok"].includes(network)) invalid(request.requestId, "network must be all, instagram or tiktok.");
      return respondWith(request, filterSocialCatDashboard(network as SocialCatDashboardData["network"]), { dataVersion: "social-cat-dashboard-demo@1" });
    }
    case "tiktokBoard":
      return respondWith(request, searchTikTokBoard(filters.q ?? ""), { dataVersion: "tiktok-board-demo@1" });
    case "tiktokDashboard":
      return respondWith(request, tiktokDashboardDemo, { dataVersion: "tiktok-dashboard-demo@1" });
    default:
      return null;
  }
}
