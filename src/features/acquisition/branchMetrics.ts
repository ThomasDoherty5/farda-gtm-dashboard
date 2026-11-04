import type { BranchSource, TerminalKind } from "@/fixtures/pipelineBranches";

const add = (sources: BranchSource[], pick: (s: BranchSource) => number) => sources.reduce((a, s) => a + pick(s), 0);
/** Delivered is unknown for a source with no carrier receipt in the fixture; one unknown makes the total unknown. */
const addNullable = (sources: BranchSource[], pick: (s: BranchSource) => number | null) => (sources.some((s) => pick(s) === null) ? null : add(sources, (s) => pick(s)!));

export function terminalTotals(sources: BranchSource[]): Record<TerminalKind, number> {
  return { declined: add(sources, (s) => s.terminal.declined), optOut: add(sources, (s) => s.terminal.optOut), expired: add(sources, (s) => s.terminal.expired) };
}

export function sampleTotals(sources: BranchSource[]) {
  return {
    accepted: add(sources, (s) => s.sample.accepted),
    requested: add(sources, (s) => s.sample.requested),
    notRequested: add(sources, (s) => s.sample.notRequested),
    stockCostApproved: add(sources, (s) => s.sample.stockCostApproved),
    shipped: add(sources, (s) => s.sample.shipped),
    delivered: addNullable(sources, (s) => s.sample.delivered),
  };
}

export function contentTotals(sources: BranchSource[]) {
  const c = (pick: (s: BranchSource["content"]) => number) => add(sources, (s) => pick(s.content));
  return {
    terms: c((x) => x.terms), withObligation: c((x) => x.withObligation), withoutObligation: c((x) => x.withoutObligation),
    posted: c((x) => x.posted), due: c((x) => x.due), overdue: c((x) => x.overdue),
    postedVoluntarily: c((x) => x.postedVoluntarily), noneYet: c((x) => x.noneYet), trackingActive: c((x) => x.trackingActive),
  };
}

/** A no-post violation can only exist where the terms created the obligation. Without one, a missing post is not a violation. */
export const violationsPossible = (s: BranchSource["content"]) => s.withObligation;
