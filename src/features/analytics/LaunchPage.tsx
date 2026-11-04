import { useSearchParams } from "react-router-dom";
import { LaunchControlPage } from "./LaunchControlPage";
import { LaunchSnapshotPage } from "./LaunchSnapshotPage";

/** `/launch` holds two sources, selected by `view`: the snapshot (3:6) and launch control (14:74). An unknown value shows the snapshot. */
export function LaunchPage() {
  const [search] = useSearchParams();
  return search.get("view") === "control" ? <LaunchControlPage /> : <LaunchSnapshotPage />;
}
