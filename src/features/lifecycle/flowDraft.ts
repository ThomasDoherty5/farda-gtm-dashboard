import { TIMING_OPTIONS, type FlowKey } from "@/fixtures/lifecycle";

export type FlowDraft = { timing: string; template: string };

/** Field errors for a flow draft. The page and the demo server share it, so a client check and the server's agree. */
export function validateFlowDraft(flow: FlowKey, draft: FlowDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!TIMING_OPTIONS[flow].includes(draft.timing)) errors.timing = "Choose one of the approved timings for this flow.";
  const template = draft.template.trim();
  if (template.length < 3 || template.length > 80) errors.template = "Name the template in 3 to 80 characters.";
  else if (/[<>{}]/.test(template)) errors.template = "A template name can't contain markup or variables.";
  return errors;
}
