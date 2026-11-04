/* eslint-disable @typescript-eslint/no-explicit-any -- the negative cases corrupt typed fixtures on purpose, so they edit them untyped */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ActionRequest, type ReadRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { financeDashboardDemo, ledgerDemo, payableDemo, periodCloseDemo, settlementDemo, type CommissionLedger, type FinanceDashboard, type PayableDetail, type PeriodClose, type SettlementRecord } from "@/fixtures/finance";
import { commissionLedgerSchema, financeDashboardSchema, financeViewSchemas, payableDetailSchema, periodCloseSchema, settlementDetailSchema } from "./finance";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const request = (viewKey: string, filters: object = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r-1",
});

/** The schema must not be looser than the fixture type: what it accepts is assignable to what the screens read. */
type Fits<Parsed, Screen> = Parsed extends Screen ? true : never;
const typeChecks: [
  Fits<z.infer<typeof commissionLedgerSchema>, CommissionLedger>,
  Fits<z.infer<typeof settlementDetailSchema>, SettlementRecord>,
  Fits<z.infer<typeof payableDetailSchema>, PayableDetail>,
  Fits<z.infer<typeof financeDashboardSchema>, FinanceDashboard>,
  Fits<z.infer<typeof periodCloseSchema>, PeriodClose>,
] = [true, true, true, true, true];

// Finance reads are scenario-driven (?scenario=), not driven by the Overview fixture switch, so the fixture key is not varied.
const variants: { viewKey: string; filters: object; throws?: string }[] = [
  { viewKey: "commissionLedger", filters: {} },
  { viewKey: "commissionLedger", filters: { scenario: "partial" } },
  { viewKey: "commissionLedger", filters: { scenario: "stale" } },
  { viewKey: "commissionLedger", filters: { scenario: "unavailable" }, throws: "SOURCE_UNAVAILABLE" },
  { viewKey: "settlementDetail", filters: { settlementId: "COMM-DEMO-D" } },
  { viewKey: "settlementDetail", filters: { settlementId: "TT-NATIVE-DEMO" } },
  { viewKey: "settlementDetail", filters: { settlementId: "nope" }, throws: "RECORD_NOT_FOUND" },
  { viewKey: "payableDetail", filters: { payableId: "PAY-0012" } },
  { viewKey: "payableDetail", filters: { payableId: "nope" }, throws: "RECORD_NOT_FOUND" },
  { viewKey: "financeDashboard", filters: {} },
  { viewKey: "financeDashboard", filters: { scenario: "stale" } },
  { viewKey: "financeDashboard", filters: { scenario: "insufficient" } },
  { viewKey: "financeDashboard", filters: { scenario: "zeroburn" } },
  { viewKey: "financeDashboard", filters: { scenario: "unavailable" }, throws: "SOURCE_UNAVAILABLE" },
  { viewKey: "periodClose", filters: { period: "2026-10" } },
  { viewKey: "periodClose", filters: { period: "2026-10", scenario: "exportfailed" } },
  { viewKey: "periodClose", filters: { period: "2025-01" }, throws: "RECORD_NOT_FOUND" },
];

describe("finance view schemas: every demo response parses", () => {
  it("covers the finance view keys", () => {
    expect(Object.keys(financeViewSchemas).sort()).toEqual([...new Set(variants.map((v) => v.viewKey))].sort());
    expect(typeChecks).toHaveLength(5);
  });

  for (const v of variants) {
    it(`${v.viewKey} ${JSON.stringify(v.filters)}`, async () => {
      const read = createDemoAdapter().readView(request(v.viewKey, v.filters));
      if (v.throws) {
        await expect(read).rejects.toBeInstanceOf(AdapterError);
        await expect(read).rejects.toMatchObject({ body: { code: v.throws } });
        return;
      }
      const response = await read;
      const schema = financeViewSchemas[v.viewKey]!;
      expect(() => readResponseSchema(schema).parse(response)).not.toThrow();
      expect(response.data).not.toBeNull();
      expect(() => schema.parse(response.data)).not.toThrow();
    });
  }

  it("parses a settlement after a match is submitted for review", async () => {
    const adapter = createDemoAdapter();
    const action: ActionRequest<unknown> = {
      schemaVersion: SCHEMA_VERSION, operation: "requestApproval", requestedScope: scope, actionKind: "reconcileSettlement", entityRefs: [], expectedVersion: "st1", approvalRef: null, manifestRef: null,
      idempotencyKey: "k-1", payload: { settlementId: "COMM-DEMO-D", matches: [{ statementRef: "STMT-DEMO-0001", groupId: "COMM-DEMO-D" }] }, requestId: "a-1",
    };
    await adapter.submitAction(action);
    const res = await adapter.readView(request("settlementDetail", { settlementId: "COMM-DEMO-D" }));
    const parsed = settlementDetailSchema.parse(res.data);
    expect(parsed.submitted).not.toBeNull();
    expect(parsed.group.state).toBe("paid");
  });

  it("keeps the dashboard's unknowns and known zero distinct", async () => {
    const adapter = createDemoAdapter();
    const base = financeDashboardSchema.parse((await adapter.readView(request("financeDashboard"))).data);
    expect(base.pnl.ytd).toMatchObject({ state: "unknown", value: null, reasonCode: "YTD_REPORT_NOT_RECEIVED" });
    const insufficient = financeDashboardSchema.parse((await adapter.readView(request("financeDashboard", { scenario: "insufficient" }))).data);
    expect(insufficient.burn).toMatchObject({ state: "unknown", value: null });
    const zero = financeDashboardSchema.parse((await adapter.readView(request("financeDashboard", { scenario: "zeroburn" }))).data);
    expect(zero.burn).toMatchObject({ state: "known", value: 0 });
  });
});

type Case = [name: string, mutate: (d: any) => void];
const clone = <T,>(v: T): T => structuredClone(v);

const negatives: { view: string; schema: z.ZodTypeAny; valid: unknown; cases: Case[] }[] = [
  {
    view: "commissionLedger", schema: commissionLedgerSchema, valid: ledgerDemo(),
    cases: [
      ["missing required field", (d) => delete d.groups],
      ["wrong dataset", (d) => (d.datasetKey = "overview-original")],
      ["unknown commission state", (d) => (d.groups[0].state = "settled")],
      ["negative earned", (d) => (d.groups[0].earned = -1)],
      ["fractional net base", (d) => (d.groups[0].netBase = 600.5)],
      ["amount as a string", (d) => (d.groups[0].grossSales = "80000")],
      ["receipt missing instead of null", (d) => delete d.groups[3].evidence.receipt],
      ["currency other than USD", (d) => (d.currency = "EUR")],
      ["negative processing fee rate", (d) => (d.economics.processingFeePct = -2.9)],
    ],
  },
  {
    view: "settlementDetail", schema: settlementDetailSchema, valid: settlementDemo("COMM-DEMO-D"),
    cases: [
      ["missing required field", (d) => delete d.group],
      ["unknown provider", (d) => (d.provider = "amazon")],
      ["unknown invoice state", (d) => (d.invoiceState = "paid")],
      ["unknown mismatch problem", (d) => (d.candidates[1].problem = "late")],
      ["negative candidate amount", (d) => (d.candidates[0].amount.minorUnits = -9000)],
      ["fractional candidate amount", (d) => (d.candidates[0].amount.minorUnits = 9000.5)],
      ["known rate that is null", (d) => Object.assign(d.rates[0].active, { state: "known", value: null, reasonCode: null })],
      ["unknown rate that is zero", (d) => Object.assign(d.rates[0].active, { value: 0 })],
      ["unknown rate without reason", (d) => (d.rates[0].active.reasonCode = null)],
      ["unknown rate lane", (d) => (d.rates[0].lane = "organic")],
      ["proposed rate no longer a draft", (d) => (d.rates[0].proposed = "Active")],
      ["submitted without an action ref", (d) => (d.submitted = { state: "Submitted" })],
    ],
  },
  {
    view: "payableDetail", schema: payableDetailSchema, valid: payableDemo("PAY-0012"),
    cases: [
      ["missing required field", (d) => delete d.approvalRef],
      ["unknown stage", (d) => (d.stage = "paid")],
      ["amount known but null", (d) => (d.amount.value = null)],
      ["amount unknown but zero", (d) => Object.assign(d.amount, { state: "unknown", value: { minorUnits: 0, currency: "USD" }, reasonCode: "X" })],
      ["negative amount", (d) => (d.amount.value.minorUnits = -15000)],
      ["fractional amount", (d) => (d.amount.value.minorUnits = 150.5)],
      ["transaction as a number", (d) => (d.providerTransaction = 12)],
    ],
  },
  {
    view: "financeDashboard", schema: financeDashboardSchema, valid: financeDashboardDemo(),
    cases: [
      ["missing required field", (d) => delete d.cashHistory],
      ["wrong period length", (d) => (d.period.days = 31)],
      ["YTD known but null", (d) => Object.assign(d.pnl.ytd, { state: "known", reasonCode: null })],
      ["YTD unknown but zero", (d) => (d.pnl.ytd.value = 0)],
      ["cash known but null", (d) => (d.cash.value = null)],
      ["burn unknown with no reason", (d) => Object.assign(d.burn, { state: "unknown", value: null, reasonCode: null })],
      ["burn not applicable carrying zero", (d) => Object.assign(d.burn, { state: "notApplicable", value: 0, reasonCode: "X" })],
      ["fractional cash", (d) => (d.cash.value = 4620000.5)],
      ["negative inventory value", (d) => (d.inventoryValue = -1)],
      ["fractional payable", (d) => (d.accountsPayable = 480000.25)],
      ["negative cost line", (d) => (d.costBreakdown[0].minor = -1)],
      ["revenue as a string", (d) => (d.pnl.revenue = "1259600")],
    ],
  },
  {
    view: "periodClose", schema: periodCloseSchema, valid: periodCloseDemo("2026-10"),
    cases: [
      ["missing required field", (d) => delete d.checks],
      ["unknown close status", (d) => (d.status = "locked")],
      ["unknown check state", (d) => (d.checks[0].state = "done")],
      ["period not YYYY-MM", (d) => (d.period = "October")],
      ["negative expected payout", (d) => (d.exceptions[0].expected = -1)],
      ["fractional difference", (d) => (d.exceptions[0].difference = 12.5)],
      ["export flag as a string", (d) => (d.exportFailed = "false")],
    ],
  },
];

describe("finance view schemas: bad shapes are rejected", () => {
  for (const { view, schema, valid, cases } of negatives) {
    describe(view, () => {
      it("accepts the unmodified fixture", () => {
        expect(schema.safeParse(valid).success).toBe(true);
      });
      for (const [name, mutate] of cases) {
        it(`rejects: ${name}`, () => {
          const bad = clone(valid);
          mutate(bad);
          expect(schema.safeParse(bad).success).toBe(false);
        });
      }
    });
  }

  it("accepts a negative reconciliation difference and a negative contribution per order, which can be real", () => {
    const d = clone(periodCloseDemo("2026-10")!);
    d.exceptions[0]!.difference = -1200;
    expect(periodCloseSchema.safeParse(d).success).toBe(true);
    const f = clone(financeDashboardDemo());
    f.contributionPerOrder = -50;
    expect(financeDashboardSchema.safeParse(f).success).toBe(true);
  });
});
