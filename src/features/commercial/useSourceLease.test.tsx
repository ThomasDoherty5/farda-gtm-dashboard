import { act, cleanup, render, screen } from "@testing-library/react";
import { useSourceLease } from "./useSourceLease";

const at=Date.parse("2026-11-07T12:00:00Z");
function Probe({until}:{until:string|null}) { const current=useSourceLease(until);return <button disabled={!current}>{current?"Current source selection":"Retained source evidence"}</button>; }
afterEach(()=>{cleanup();vi.useRealTimers();});
it("holds a source selection at its exact lease expiry and requires a newly returned future lease",()=>{
  vi.useFakeTimers();vi.setSystemTime(at);const view=render(<Probe until={new Date(at+1000).toISOString()}/>);
  expect(screen.getByRole("button")).toBeEnabled();act(()=>vi.advanceTimersByTime(1001));expect(screen.getByRole("button")).toBeDisabled();expect(screen.getByRole("button")).toHaveTextContent("Retained source evidence");
  view.rerender(<Probe until={new Date(at+1000).toISOString()}/>);expect(screen.getByRole("button")).toBeDisabled();
  view.rerender(<Probe until={new Date(at+2000).toISOString()}/>);expect(screen.getByRole("button")).toBeEnabled();
  view.rerender(<Probe until={null}/>);expect(screen.getByRole("button")).toBeDisabled();
});
