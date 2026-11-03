import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "./Button";

describe("Button", () => {
  it("fires its action when enabled", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("defaults to type=button, so it can't submit a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("blocks duplicate submission while loading and announces progress", async () => {
    const onClick = vi.fn();
    render(<Button loading onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: /Save/ });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAccessibleName("Save (in progress)");
    await userEvent.dblClick(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("stays focusable when disabled, announces why, and swallows clicks and keys", async () => {
    const onClick = vi.fn();
    render(<Button disabledReason="Launch date is not set." onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    await userEvent.tab();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAccessibleDescription("Launch date is not set.");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
