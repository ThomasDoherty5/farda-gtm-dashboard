// @vitest-environment node
import { afterEach, expect, it } from "vitest";
import { ACCOUNTING_POLICY_UNVERIFIED, type Statement } from "./contract.ts";
import { externalPayableFixture } from "./fakes.testkit.ts";

const open: { close(): void }[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });
const books = (sourceId: string) => ({ provider: "synthetic-books", accountId: "synthetic-ledger", sourceId, url: null });
async function settled(accountingOwnerRef?: string | null) {
  const f = await externalPayableFixture({ accountingOwnerRef }); open.push(f.approval.db);
  f.publish(f.liability());
  const intent = f.repository.proposeIntent("synthetic-liability-1", "propose");
  const run = await f.handoff(await f.approve(intent.intentRef));
  await f.dispatch.execute(run.runRef);
  const receiptRef = f.provider.settle(intent.providerKey, 60_000);
  await f.bridge.syncSettlement(intent.intentRef);
  const statement: Statement = { statementRef: "synthetic-statement-1", account: { provider: "synthetic-payout", accountId: "synthetic-operating", sourceId: "synthetic-bank-feed", url: null },
    observedAt: f.at(), lines: [
      { lineRef: "synthetic-line-1", direction: "outflow", amount: { minorUnits: 60_000, currency: "USD" }, postedAt: f.at(), reference: receiptRef },
      { lineRef: "synthetic-line-native", direction: "inflow", amount: { minorUnits: 9_000, currency: "USD" }, postedAt: f.at(), reference: "synthetic-native-payout" },
    ] };
  const policy = { policyRef: "synthetic-accounting-policy", version: "accounting-v1", adoptedBy: "synthetic:finance-owner", adoptedAt: f.at(), documentRef: books("synthetic-policy-doc"),
    mapping: { expenseAccount: books("synthetic-expense"), liabilityAccount: books("synthetic-payable"), cashAccount: books("synthetic-cash") } };
  return { ...f, intent, run, receiptRef, statement, policy };
}

it("J12-09 holds matching with ACCOUNTING_POLICY_UNVERIFIED while no owner-adopted policy exists, and stores nothing", async () => {
  const f = await settled();
  expect(f.repository.ingestStatement(f.statement, "ingest-1")).toEqual({ state: "held", reasonCode: ACCOUNTING_POLICY_UNVERIFIED });
  expect(f.repository.matches()).toEqual([]);
  expect(f.repository.status("synthetic-liability-1").accountingMatch).toBeNull();
});
it("J12-09 has no default policy and only the configured responsible owner can adopt one", async () => {
  const unset = await settled(null);
  expect(() => unset.repository.adoptAccountingPolicy(unset.policy, "adopt")).toThrow("ACCOUNTING_OWNER_UNVERIFIED");
  const f = await settled();
  expect(() => f.repository.adoptAccountingPolicy({ ...f.policy, adoptedBy: "synthetic:someone-else" }, "adopt")).toThrow("ACCOUNTING_OWNER_UNVERIFIED");
  expect(f.repository.accountingPolicy()).toBeNull();
});
it("J12-09 matches a settled receipt once under the adopted mapping; ingestion never triggers a transfer or touches native settlement", async () => {
  const f = await settled();
  f.repository.adoptAccountingPolicy(f.policy, "adopt");
  const calls = { submit: f.provider.submitCalls, lookup: f.provider.lookupCalls, reads: f.sourceState.reads };
  const runs = f.approval.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n;
  const result = f.repository.ingestStatement(f.statement, "ingest-1");
  if (result.state !== "recorded") throw new Error("Expected a recorded statement");
  expect(result.dispositions.map(d => d.disposition)).toEqual(["matched", "notExternalPayable"]);
  expect(result.matches).toEqual([expect.objectContaining({ receiptRef: f.receiptRef, policyRef: "synthetic-accounting-policy", policyVersion: "accounting-v1",
    mapping: f.policy.mapping, amount: { minorUnits: 60_000, currency: "USD" } })]);
  expect(f.repository.ingestStatement(f.statement, "ingest-1")).toEqual(result);
  const again = f.repository.ingestStatement({ ...f.statement, statementRef: "synthetic-statement-2", lines: [{ ...f.statement.lines[0]!, lineRef: "synthetic-line-repeat" }] }, "ingest-2");
  expect(again.state === "recorded" && again.dispositions.map(d => d.disposition)).toEqual(["alreadyMatched"]);
  expect(f.repository.matches()).toHaveLength(1);
  expect(f.repository.status("synthetic-liability-1")).toMatchObject({ paymentState: "settled", accountingMatch: result.matches[0]!.matchRef, outstandingBalance: { minorUnits: 0 } });
  expect({ submit: f.provider.submitCalls, lookup: f.provider.lookupCalls, reads: f.sourceState.reads }).toEqual(calls);
  expect(f.approval.db.prepare("SELECT COUNT(*) n FROM job_runs").get()?.n).toBe(runs);
});
it("leaves amount and currency mismatches unmatched and refuses a statement from another account", async () => {
  const f = await settled();
  f.repository.adoptAccountingPolicy(f.policy, "adopt");
  const line = f.statement.lines[0]!;
  const result = f.repository.ingestStatement({ ...f.statement, lines: [{ ...line, amount: { minorUnits: 59_999, currency: "USD" } }, { ...line, lineRef: "synthetic-line-eur", amount: { minorUnits: 60_000, currency: "EUR" } }] }, "ingest-1");
  expect(result.state === "recorded" && result.dispositions.map(d => d.disposition)).toEqual(["amountMismatch", "currencyMismatch"]);
  expect(f.repository.matches()).toEqual([]);
  expect(() => f.repository.ingestStatement({ ...f.statement, account: { ...f.statement.account, accountId: "synthetic-foreign" } }, "ingest-2")).toThrow("CROSS_ACCOUNT_PAYLOAD");
});
