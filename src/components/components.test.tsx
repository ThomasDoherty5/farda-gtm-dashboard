import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Checkbox } from "./Checkbox";
import { Drawer } from "./Drawer";
import { Modal } from "./Modal";
import { SearchField } from "./Search";
import { Skeleton, SkeletonCard, SkeletonRow } from "./Skeleton";
import { SourceFreshness } from "./SourceFreshness";
import { StepCard } from "./StepCard";
import { SUCCESS_TOAST_MS, Toast, ToastProvider, useToast } from "./Toast";
import { Toggle } from "./Toggle";
import { Tooltip } from "./Tooltip";

// jsdom has no showModal; opening the dialog by attribute is enough to make it part of the accessibility tree.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute("open"); };
});

describe("SearchField (6:414)", () => {
  it("is a named searchbox, shows its placeholder, and reports typing", async () => {
    const onChange = vi.fn();
    render(<SearchField label="Search creators" placeholder="Search creators, orders, tasks" value="" onChange={onChange} />);
    const box = screen.getByRole("searchbox", { name: "Search creators" });
    expect(box).toHaveAttribute("placeholder", "Search creators, orders, tasks");
    await userEvent.type(box, "ab");
    expect(onChange).toHaveBeenLastCalledWith("b");
  });
  it("shows the query when it has one", () => {
    render(<SearchField label="Search" value="social cat" onChange={() => undefined} />);
    expect(screen.getByRole("searchbox")).toHaveValue("social cat");
  });
});

describe("Checkbox (6:443)", () => {
  const Controlled = (p: { mixed?: boolean; disabled?: boolean; readOnly?: boolean }) => {
    const [on, setOn] = useState(false);
    return <Checkbox label="Select item" checked={on} onChange={setOn} {...p} />;
  };
  it("toggles by click on the label and by Space, and shows the mark", async () => {
    render(<Controlled />);
    const box = screen.getByRole("checkbox", { name: "Select item" });
    await userEvent.click(screen.getByText("Select item"));
    expect(box).toBeChecked();
    expect(document.body).toHaveTextContent("✓");
    box.focus();
    await userEvent.keyboard(" ");
    expect(box).not.toBeChecked();
  });
  it("mixed is announced as mixed, not as checked", () => {
    render(<Checkbox label="All" checked={false} mixed onChange={() => undefined} />);
    const box = screen.getByRole("checkbox", { name: "All" }) as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(document.body).toHaveTextContent("−");
  });
  it("disabled cannot be changed", async () => {
    render(<Controlled disabled />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(screen.getByRole("checkbox")).toBeDisabled();
  });
  it("read-only stays as it was and says so", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Consent" checked readOnly onChange={onChange} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("checkbox")).toHaveAttribute("aria-readonly", "true");
  });
});

describe("Toggle (6:459)", () => {
  it("is a switch that flips by click on its label and by keyboard", async () => {
    const Wrap = () => { const [on, setOn] = useState(false); return <Toggle label="Enable setting" checked={on} onChange={setOn} />; };
    render(<Wrap />);
    const sw = screen.getByRole("switch", { name: "Enable setting" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(screen.getByText("Enable setting"));
    expect(sw).toHaveAttribute("aria-checked", "true");
    sw.focus();
    await userEvent.keyboard("{Enter}");
    expect(sw).toHaveAttribute("aria-checked", "false");
  });
  it("disabled stays focusable, gives its reason, and does not flip", async () => {
    const onChange = vi.fn();
    render(<Toggle label="Enable setting" checked={false} onChange={onChange} disabledReason="Only the owning tool can change this." />);
    const sw = screen.getByRole("switch");
    await userEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
    expect(sw).toHaveAccessibleDescription("Only the owning tool can change this.");
  });
});

describe("disabled and read-only states match what is announced", () => {
  it("a disabled switch that is on is drawn on", () => {
    const { container } = render(<Toggle label="Policy" checked onChange={() => undefined} disabledReason="Owned elsewhere." />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(container.querySelector("[data-visual]")).toHaveAttribute("data-visual", "on");
    const off = render(<Toggle label="Other" checked={false} onChange={() => undefined} disabledReason="Owned elsewhere." />);
    expect(off.container.querySelector("[data-visual]")).toHaveAttribute("data-visual", "off");
  });
  it("a read-only checkbox is marked so it is styled as not clickable", () => {
    const { container } = render(<Checkbox label="Consent" checked readOnly />);
    expect(container.firstElementChild).toHaveAttribute("data-readonly", "true");
    const normal = render(<Checkbox label="Plain" checked onChange={() => undefined} />);
    expect(normal.container.firstElementChild).not.toHaveAttribute("data-readonly");
  });
});

describe("Tooltip (6:714)", () => {
  it("opens on focus and hover, describes its trigger, and Escape dismisses without moving focus", async () => {
    render(<Tooltip label="Only the owning tool can edit this record.">{(p) => <button {...p}>Edit</button>}</Tooltip>);
    const button = screen.getByRole("button", { name: "Edit" });
    expect(screen.getByRole("tooltip", { hidden: true })).not.toBeVisible();
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(button).toHaveAccessibleDescription("Only the owning tool can edit this record.");
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("tooltip", { hidden: true })).not.toBeVisible();
    expect(button).toHaveFocus();
    await userEvent.hover(button);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });
});

describe("Toast (6:710)", () => {
  it("success is a polite status; error is an alert", () => {
    render(<><Toast state="success">Task updated.</Toast><Toast state="error">Task failed.</Toast></>);
    expect(screen.getByRole("status")).toHaveTextContent("Task updated.");
    expect(screen.getByRole("alert")).toHaveTextContent("Task failed.");
  });
  it("the provider shows toasts, dismisses on request and clears success on its own", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const Trigger = () => { const t = useToast(); return <><button onClick={() => t.notify("success", "Saved.")}>ok</button><button onClick={() => t.notify("error", "Not saved.")}>bad</button></>; };
    render(<ToastProvider><Trigger /></ToastProvider>);
    await userEvent.click(screen.getByText("ok"));
    await userEvent.click(screen.getByText("bad"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved.");
    await vi.advanceTimersByTimeAsync(6100);
    expect(screen.getByText("Saved.")).toBeInTheDocument(); // no longer cleared at the old 6 seconds
    await vi.advanceTimersByTimeAsync(SUCCESS_TOAST_MS);
    expect(screen.queryByText("Saved.")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved.");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(screen.queryByRole("alert")).toBeNull();
    vi.useRealTimers();
  });
});

describe("Toast timing (WCAG 2.2.1)", () => {
  it("a success toast outlasts 6 seconds and waits while hovered or focused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const Trigger = () => { const t = useToast(); return <button onClick={() => t.notify("success", "Saved.")}>ok</button>; };
    render(<ToastProvider><Trigger /></ToastProvider>);
    await userEvent.click(screen.getByText("ok"));
    expect(SUCCESS_TOAST_MS).toBeGreaterThanOrEqual(20000);
    await userEvent.hover(screen.getByText("Saved."));
    await vi.advanceTimersByTimeAsync(SUCCESS_TOAST_MS * 3);
    expect(screen.getByText("Saved.")).toBeInTheDocument();
    await userEvent.unhover(screen.getByText("Saved."));
    await vi.advanceTimersByTimeAsync(SUCCESS_TOAST_MS - 1000);
    expect(screen.getByText("Saved.")).toBeInTheDocument(); // the countdown restarted in full
    await vi.advanceTimersByTimeAsync(1200);
    expect(screen.queryByText("Saved.")).toBeNull();
    vi.useRealTimers();
  });
});

describe("Modal (6:687)", () => {
  it("uses Continue for Confirm and Access, and Open source for Reconcile", () => {
    const { rerender } = render(<Modal open state="confirm" title="Pause this run?" description="d" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
    rerender(<Modal open state="reconcile" title="Pause this run?" description="d" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole("button", { name: "Open source" })).toBeInTheDocument();
  });
  it("names itself and its description, cancels first, and confirms once while busy", async () => {
    const onConfirm = vi.fn(); const onCancel = vi.fn();
    const { rerender } = render(<Modal open title="Pause this run?" description="The current step finishes safely." onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Pause this run?");
    expect(dialog).toHaveAccessibleDescription("The current step finishes safely.");
    const buttons = within(dialog).getAllByRole("button", );
    expect(buttons[0]).toHaveTextContent("Cancel");
    await userEvent.click(buttons[0]!);
    expect(onCancel).toHaveBeenCalledTimes(1);
    rerender(<Modal open busy title="Pause this run?" description="d" onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.dblClick(screen.getByRole("button", { name: /Continue/ }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
  it("renders nothing inside while closed", () => {
    render(<Modal open={false} title="Pause?" description="d" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByText("Pause?")).toBeNull();
  });
});

describe("Drawer (6:703)", () => {
  it("shows the record's state in words, its details and the action, and closes", async () => {
    const onClose = vi.fn();
    render(<Drawer open title="Task details" badge="Awaiting approval" details={[["Task ID", "RUN-0084"], ["Source", "Social Cat web"]]} note="The exact approved action and evidence are always available here." action={<a href="/runs/x">Open full run</a>} onClose={onClose} />);
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByText("RUN-0084")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open full run" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close Task details" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SourceFreshness (6:500)", () => {
  it.each([["live", "Live"], ["synced", "Synced"], ["stale", "Stale"], ["unknown", "Unknown"], ["error", "Error"]] as const)("%s names its state in words", (state, word) => {
    render(<SourceFreshness source="Google Sheets" state={state} updated="Last synced 4 minutes ago" />);
    expect(screen.getByText(word)).toBeInTheDocument();
  });
  it("unknown never shows a time, even if one is passed", () => {
    render(<SourceFreshness source="Google Sheets" state="unknown" updated="Last synced 4 minutes ago" />);
    expect(screen.getByText("Last sync unknown")).toBeInTheDocument();
    expect(screen.queryByText(/4 minutes/)).toBeNull();
  });
  it("a missing time on a known state says it was not reported, not zero minutes", () => {
    render(<SourceFreshness source="Sheets" state="synced" />);
    expect(screen.getByText("Last sync time not reported")).toBeInTheDocument();
  });
  it("stale and error are announced; live is quiet; the action calls back", async () => {
    const onAction = vi.fn();
    const { rerender } = render(<SourceFreshness source="Sheets" state="stale" updated="u" action="Open source →" onAction={onAction} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open source →" }));
    expect(onAction).toHaveBeenCalled();
    rerender(<SourceFreshness source="Sheets" state="live" updated="u" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("StepCard (6:595)", () => {
  it.each([["pending", "Pending"], ["approval", "Approval"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"]] as const)("%s shows its state in words", (state, word) => {
    render(<StepCard state={state} title="Send approved brief" description="Browser task · Social Cat" />);
    expect(screen.getByText(word)).toBeInTheDocument();
    expect(screen.getByText("Send approved brief")).toBeInTheDocument();
  });
  it("marks only the running step as current", () => {
    const { container } = render(<ul><StepCard as="li" state="running" title="a" description="b" /><StepCard as="li" state="pending" title="c" description="d" /></ul>);
    expect(container.querySelectorAll("[aria-current='step']")).toHaveLength(1);
  });
});

describe("Skeleton (6:659)", () => {
  it("card has three bars and row two, with one spoken status", () => {
    const { container, rerender } = render(<SkeletonCard label="Loading orders…" />);
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveTextContent("Loading orders…");
    rerender(<SkeletonRow label="Loading rows…" />);
    expect(container.querySelectorAll("[aria-hidden='true']")).toHaveLength(2);
    rerender(<Skeleton variant="row" label="Loading rows…" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading rows…");
  });
});
