import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceReadGrant } from "./SourceReadGrant";

afterEach(() => { cleanup(); vi.useRealTimers(); });
describe("source display grant", () => {
  it("unmounts protected content and dialogs exactly at expiry and requires a fresh grant", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const refresh = vi.fn();
    const content = (expiry: string) => <SourceReadGrant validUntil={expiry} title="Source workspace" refresh={refresh}><p>Protected source facts</p><div role="dialog">Protected detail</div></SourceReadGrant>;
    const view = render(content("2026-11-01T00:00:01Z"));
    act(() => { vi.advanceTimersByTime(999); }); expect(screen.getByRole("dialog")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); }); expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); expect(screen.queryByText("Protected source facts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh source evidence" })); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText("Protected source facts")).not.toBeInTheDocument();
    view.rerender(content("2026-11-01T00:00:02Z")); expect(screen.getByText("Protected source facts")).toBeInTheDocument();
  });
  it("rechecks a suspended tab and rejects an invalid declared deadline", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
    const view = render(<SourceReadGrant validUntil="2026-11-01T00:00:01Z" title="Source workspace" refresh={() => {}}>Private row</SourceReadGrant>);
    act(() => { vi.setSystemTime(new Date("2026-11-01T00:00:02Z")); window.dispatchEvent(new Event("focus")); });
    expect(screen.queryByText("Private row")).not.toBeInTheDocument();
    view.rerender(<SourceReadGrant validUntil="invalid" title="Source workspace" refresh={() => {}}>Private row</SourceReadGrant>);
    expect(screen.getByRole("alert")).toHaveTextContent("Source access has expired");
  });
});
