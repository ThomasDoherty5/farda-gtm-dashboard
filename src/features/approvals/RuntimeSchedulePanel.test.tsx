import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { safeRuntimeSchedulingSchema, type SafeRuntimeScheduling } from "@/creator-agent/jobs/runtimeViews";
import { RuntimeSchedulePanel } from "./RuntimeSchedulePanel";
import { dateTime } from "./shared";

const at = "2026-11-07T12:00:00Z";
function scheduling(): SafeRuntimeScheduling {
  return safeRuntimeSchedulingSchema.parse({ observedAt: at, validUntil: "2026-11-07T12:01:00Z",
    trigger: { alias: "trigger-" + "a".repeat(64), versionAlias: "trigger-version-" + "b".repeat(64) },
    cadence: { kind: "calendar", timezone: "Asia/Hong_Kong", localTime: "08:30", cadence: "daily", startsAt: "2026-11-05T00:30:00Z" },
    backlog: { state: "observed", nextPlannedAt: "2026-11-08T00:30:00Z", oldestUnadmittedAt: "2026-11-05T00:30:00Z",
      unadmittedInScannedRange: 2, scannedSlots: 3, scannedFrom: "2026-11-05T00:30:00Z", requestedThrough: at,
      scannedThrough: "2026-11-07T00:30:00Z", scanComplete: true, scanCursor: null, total: null } });
}
const row = (label: string) => screen.getByText(label, { selector: "dt" }).parentElement!;
afterEach(cleanup);
describe("runtime schedule evidence", () => {
  it("keeps legacy missing schedule evidence unknown without inventing a trigger or zero backlog", () => {
    render(<RuntimeSchedulePanel data={{ family: "J08" }} stale={false} />);
    expect(screen.getByText("Schedule evidence unknown")).toBeInTheDocument();
    expect(screen.queryByText("Global backlog total")).not.toBeInTheDocument();
    expect(screen.queryByText("Event-driven")).not.toBeInTheDocument();
    expect(screen.getByText(/does not mean no backlog or an inactive trigger/)).toBeInTheDocument();
  });
  it("distinguishes an actual event trigger from scheduled counts and keeps opaque references focusable without adding activation controls", async () => {
    const value = scheduling(); value.cadence = { kind: "event" }; value.backlog = { state: "notApplicable", reasonCode: "EVENT_DRIVEN_NO_DUE_SLOTS" };
    render(<RuntimeSchedulePanel data={{ family: "registered-business", scheduling: value }} stale={false} />);
    expect(row("Cadence")).toHaveTextContent("Event-driven");
    expect(screen.getByText("Not applicable · event-driven")).toBeInTheDocument();
    expect(screen.queryByText("Next planned slot")).not.toBeInTheDocument();
    expect(screen.queryByText("Unadmitted in inspected range")).not.toBeInTheDocument();
    const details = screen.getByText("Trigger evidence references").parentElement!;
    expect(details).not.toHaveAttribute("open");
    await userEvent.tab(); expect(screen.getByText("Trigger evidence references")).toHaveFocus();
    await userEvent.click(screen.getByText("Trigger evidence references")); expect(details).toHaveAttribute("open");
    expect(within(details).getByText("Trigger: " + value.trigger.alias)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("shows the exact daily rule and inspected range without converting it into a global total", () => {
    const value = scheduling(); render(<RuntimeSchedulePanel data={{ family: "J19", scheduling: value }} stale={false} />);
    expect(row("Cadence")).toHaveTextContent("Daily at 08:30");
    expect(row("Time zone")).toHaveTextContent("Asia/Hong_Kong");
    expect(row("Verified at")).toHaveTextContent(dateTime(value.observedAt));
    expect(row("Valid until")).toHaveTextContent(dateTime(value.validUntil));
    expect(row("Oldest unadmitted slot")).toHaveTextContent(dateTime("2026-11-05T00:30:00Z"));
    expect(row("Unadmitted in inspected range")).toHaveTextContent("2");
    expect(row("Slots inspected")).toHaveTextContent("3");
    expect(row("Global backlog total")).toHaveTextContent("Unknown");
    expect(screen.getByText(/not an all-time or global backlog total/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable|activate|run|save/i })).not.toBeInTheDocument();
  });
  it("keeps a partial hourly scan's last inspected slot distinct from its next uninspected slot", () => {
    const value = scheduling(); value.cadence = { kind: "hourly", timezone: "UTC", minute: 15, startsAt: "2026-11-01T00:15:00Z" };
    value.backlog = { state: "observed", nextPlannedAt: "2026-11-07T12:15:00Z", oldestUnadmittedAt: "2026-11-01T00:15:00Z",
      unadmittedInScannedRange: 48, scannedSlots: 48, scannedFrom: "2026-11-01T00:15:00Z", requestedThrough: at,
      scannedThrough: "2026-11-02T23:15:00Z", scanComplete: false, scanCursor: "2026-11-03T00:15:00Z", total: null };
    render(<RuntimeSchedulePanel data={{ family: "J08", scheduling: value }} stale={false} />);
    expect(screen.getByText("Partial due-work scan")).toBeInTheDocument();
    expect(row("Cadence")).toHaveTextContent("Hourly at minute 15");
    expect(row("Last slot inspected")).toHaveTextContent(dateTime("2026-11-02T23:15:00Z"));
    expect(row("Next uninspected slot")).toHaveTextContent(dateTime("2026-11-03T00:15:00Z"));
    expect(row("Requested through")).toHaveTextContent(dateTime(at));
    expect(row("Global backlog total")).toHaveTextContent("Unknown");
    expect(screen.getByText(/partial scan cannot establish zero backlog/)).toBeInTheDocument();
  });
  it("scopes verified zero to the inspected range while missing next-slot evidence remains unknown", () => {
    const value = scheduling(); value.backlog = { state: "observed", nextPlannedAt: null, oldestUnadmittedAt: null,
      unadmittedInScannedRange: 0, scannedSlots: 0, scannedFrom: at, requestedThrough: at, scannedThrough: null,
      scanComplete: true, scanCursor: null, total: null };
    render(<RuntimeSchedulePanel data={{ family: "J20", scheduling: value }} stale={false} />);
    expect(row("Unadmitted in inspected range")).toHaveTextContent("0");
    expect(row("Oldest unadmitted slot")).toHaveTextContent("None in the inspected range");
    expect(row("Last slot inspected")).toHaveTextContent("No slots inspected");
    expect(row("Next planned slot")).toHaveTextContent("Unknown");
    expect(row("Global backlog total")).toHaveTextContent("Unknown");
  });
  it("labels a stale snapshot without treating a historical run or the client's clock as authority", () => {
    render(<RuntimeSchedulePanel data={{ family: "J20", scheduling: scheduling() }} stale />);
    expect(screen.getByText("Stale source snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Read-only source snapshot")).not.toBeInTheDocument();
    expect(screen.getByText(/does not prove future delivery or authorize activation/)).toBeInTheDocument();
  });
});
