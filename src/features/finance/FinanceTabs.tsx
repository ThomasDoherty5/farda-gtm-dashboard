import { SectionTabs } from "@/components/SectionTabs";

export type FinanceTab = "commissions" | "payouts" | "economics" | "access";

/** Section navigation of the commission screens (Figma "Tab" set 6:424). Economics is a section of the ledger page. */
export function FinanceTabs({ current }: { current: FinanceTab }) {
  const c = (k: FinanceTab) => current === k;
  return (
    <SectionTabs
      label="Commission sections"
      tabs={[
        { label: "Commissions", to: "/finance/commissions", width: 109, current: c("commissions") },
        { label: "Payouts", to: "/finance/settlements/COMM-DEMO-D", width: 100, current: c("payouts") },
        { label: "Economics", to: "/finance/commissions#contribution", width: 100, current: c("economics") },
        { label: "Provider access", to: "/settings/capabilities", width: 137, current: c("access") },
      ]}
    />
  );
}
