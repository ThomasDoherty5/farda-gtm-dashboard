import { useSearchParams } from "react-router-dom";
import { LaunchControlPage } from "./LaunchControlPage";
import { ReconciliationPage } from "./ReconciliationPage";
import { LaunchSnapshotPage } from "./LaunchSnapshotPage";

/** `/launch` holds two sources (and `?view=reconciliation`, which is not a Figma source), selected by `view`: the snapshot (3:6) and launch control (14:74). An unknown value shows the snapshot. */
export function LaunchPage() {
  const [search] = useSearchParams();
  const view = search.get("view");
  if (view === "reconciliation") return <ReconciliationPage />;
  return view === "control" ? <LaunchControlPage /> : <LaunchSnapshotPage />;
}
