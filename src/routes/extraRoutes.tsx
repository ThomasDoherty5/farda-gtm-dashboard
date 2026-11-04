import type { RouteObject } from "react-router-dom";
import { RewardsPage } from "@/features/scorecards/RewardsPage";

/** Pages that are not Figma sources, so they are not in the generated manifest. Each is read-only or demo-labeled. */
export const extraRoutes: RouteObject[] = [
  { path: "/offers/:offerId/rewards", element: <RewardsPage /> },
];
