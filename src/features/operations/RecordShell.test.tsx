import { cleanup, render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ReadResponse } from "@/adapter/contract";
import { RecordShell } from "./RecordShell";

afterEach(cleanup);
it.each([["partial", false], ["stale", false], ["stale", true], ["empty", false]] as const)("does not call a %s null response confirmed empty (complete=%s)", (dataState, complete) => {
  const query = { data: { data: null, dataState, coverage: { complete }, sourceFreshness: [] }, isPending: false, isError: false } as unknown as UseQueryResult<ReadResponse<unknown>, Error>;
  render(<RecordShell query={query} id="test-record" title="Record" subject="order" figma="4:171">{() => null}</RecordShell>);
  expect(screen.queryByText("No order yet")).not.toBeInTheDocument();
  expect(screen.getByText("Missing evidence does not prove that no record exists.", { exact: false })).toBeVisible();
});
it("uses empty wording only for an authoritative complete empty result", () => {
  const query = { data: { data: null, dataState: "empty", coverage: { complete: true } }, isPending: false, isError: false } as unknown as UseQueryResult<ReadResponse<unknown>, Error>;
  render(<RecordShell query={query} id="test-record" title="Record" subject="order" figma="4:171">{() => null}</RecordShell>);
  expect(screen.getByText("No order yet")).toBeVisible();
});
