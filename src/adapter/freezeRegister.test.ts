// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Drift check for docs/adapter-freeze-register.md. The extractor reads the source (see scripts/adapter-freeze-extract.mjs);
 * this test fails when the source names a view key, action kind, operation, resource kind, error code or next-action kind
 * that the register does not list, and when the register lists one the source no longer names.
 * The "Pending in open PRs" section is deliberately not read, so an open PR cannot make this test fail.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const extracted = JSON.parse(execFileSync(process.execPath, ["scripts/adapter-freeze-extract.mjs", "--json"], { cwd: root, encoding: "utf8" })) as Record<string, Record<string, unknown>>;
const register = readFileSync(`${root}docs/adapter-freeze-register.md`, "utf8");
const main = register.split(/^## Pending in open PRs/m)[0]!;

/** First-column names (in backticks) of the table rows between two headings. */
function listed(from: string, to: string): string[] {
  const start = main.indexOf(`\n${from}`);
  expect(start, `register is missing the heading "${from}"`).toBeGreaterThan(-1);
  const end = main.indexOf(`\n${to}`, start + 1);
  expect(end, `register is missing the heading "${to}"`).toBeGreaterThan(start);
  return main
    .slice(start, end)
    .split("\n")
    .flatMap((line) => /^\| `([A-Za-z0-9_]+)` \|/.exec(line)?.[1] ?? [])
    .sort();
}

const sets: { label: string; names: string[]; documented: string[] }[] = [
  { label: "operations", names: Object.keys(extracted.operations!), documented: listed("## Operations", "## View keys") },
  { label: "view keys", names: Object.keys(extracted.views!), documented: listed("## View keys", "## Action kinds") },
  { label: "action kinds", names: Object.keys(extracted.actionKinds!), documented: listed("## Action kinds", "## Resource kinds") },
  { label: "resource kinds", names: Object.keys(extracted.resourceKinds!), documented: listed("## Resource kinds", "## Error codes") },
  { label: "error codes", names: Object.keys(extracted.errorCodes!), documented: listed("## Error codes", "## Vocabularies the contract does not define") },
  { label: "next action kinds", names: Object.keys(extracted.nextActionKinds!), documented: listed("### `nextAction.kind` returned on action responses", "### Reason codes") },
];

describe("adapter freeze register", () => {
  it("reads the source and finds something (guards against a silent extractor failure)", () => {
    expect(Object.keys(extracted.views!).length).toBeGreaterThan(40);
    expect(Object.keys(extracted.actionKinds!).length).toBeGreaterThan(30);
    expect(Object.keys(extracted.errorCodes!).length).toBeGreaterThan(20);
  });

  it.each(sets)("lists every $label name the source uses", ({ names, documented }) => {
    const missing = names.filter((n) => !documented.includes(n));
    expect(missing, `in the source but not in docs/adapter-freeze-register.md: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(sets)("lists no $label name the source has dropped", ({ names, documented }) => {
    const stale = documented.filter((n) => !names.includes(n));
    expect(stale, `in the register but no longer in the source: ${stale.join(", ")}`).toEqual([]);
  });

  it("has no duplicate rows within a table", () => {
    for (const { label, documented } of sets) expect(new Set(documented).size, `${label} has a duplicate row`).toBe(documented.length);
  });
});
