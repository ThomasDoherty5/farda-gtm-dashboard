import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createDemoAdapter } from "@/adapter/demoAdapter";
import { appendAdjustment, ledgerDemo, netOfAdjustments, type CommissionGroup } from "@/fixtures/finance";
import { renderRoute } from "@/test/renderWithAdapter";

const group = (id: string) => ledgerDemo().groups.find((g) => g.id === id)!;

describe("FE08-03 immutable receipts and appended adjustments", () => {
  it("a paid group already carries its adjustment beside an unchanged receipt", () => {
    const paid = group("COMM-DEMO-D");
    expect(paid.evidence.receipt).toBe("TEST-RCPT-0090");
    expect(paid.adjustments).toEqual([expect.objectContaining({ id: "ADJ-0001", amountMinor: -500, receiptRef: "TEST-RCPT-0090" })]);
    expect(netOfAdjustments(9000, paid)).toBe(8500);
  });

  it("appending an adjustment leaves the receipt and every earlier adjustment exactly as they were", () => {
    const paid = group("COMM-DEMO-D");
    const before = structuredClone(paid);
    const next = appendAdjustment(paid, { id: "ADJ-0002", kind: "reversal", amountMinor: -200, at: "2026-11-01T10:00:00.000Z", reason: "A second refund", receiptRef: "TEST-RCPT-0090" });
    expect(paid).toEqual(before);
    expect(next.evidence).toEqual(before.evidence);
    expect(next.adjustments!.slice(0, 1)).toEqual(before.adjustments);
    expect(next.adjustments).toHaveLength(2);
    expect(netOfAdjustments(9000, next)).toBe(8300);
  });

  it("refuses an adjustment on an unpaid group, a positive one, a reused id or the wrong receipt", () => {
    const adj = { id: "ADJ-0009", kind: "reversal" as const, amountMinor: -100, at: "x", reason: "r", receiptRef: "TEST-RCPT-0090" };
    expect(() => appendAdjustment(group("COMM-DEMO-A") as CommissionGroup, adj)).toThrow(/Only a paid group/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, amountMinor: 100 })).toThrow(/negative/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, id: "ADJ-0001" })).toThrow(/never reused/);
    expect(() => appendAdjustment(group("COMM-DEMO-D"), { ...adj, receiptRef: "OTHER" })).toThrow(/receipt it adjusts/);
  });

  it("the settlement evidence names the adjustment and still shows the immutable receipt", async () => {
    const user = userEvent.setup();
    renderRoute("/finance/settlements/COMM-DEMO-D", createDemoAdapter());
    await user.click(await screen.findByRole("button", { name: "Review matching evidence" }));
    const dialog = (await screen.findAllByRole("dialog", { hidden: true })).find((d) => d.querySelector("h2"))!;
    expect(within(dialog).getByText("TEST-RCPT-0090")).toBeInTheDocument();
    expect(within(dialog).getByText(/ADJ-0001: -\$5 \(A customer refund after payout reversed \$5 of commission\)/)).toBeInTheDocument();
  });

  it("a payable with no provider transaction or QuickBooks reference says so, not blank or zero", async () => {
    renderRoute("/finance/payables/PAY-0012", createDemoAdapter());
    await screen.findByText("Settlement evidence");
    expect(screen.getByText("Provider transaction").nextElementSibling).toHaveTextContent("Not available");
    expect(screen.getByText("QuickBooks reference").nextElementSibling).toHaveTextContent("Not posted");
    expect(screen.getByText("Settlement status").nextElementSibling).toHaveTextContent("Not paid");
  });
});
