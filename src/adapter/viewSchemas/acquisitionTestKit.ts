/**
 * Test helpers for the view-schema tests: build demo read requests, read every demo fixture variant of a view, and
 * run path-based negative cases. Imported by *.test.ts only.
 */
import type { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ReadRequest, type ReadResponse } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { overviewFixtureKeys, type OverviewFixtureKey } from "@/fixtures/overview";

export const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };

export const readRequest = (viewKey: string, filters: object = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION,
  operation: "readView",
  viewKey,
  requestedScope: scope,
  filters,
  period: null,
  sort: [],
  page: { cursor: null, limit: 50 },
  requestId: "r1",
});

/** The fixtures that make a service fail the read instead of answering. */
export const FAILING_FIXTURES: readonly OverviewFixtureKey[] = ["FX-07-offline-read", "FX-08-forbidden-account", "FX-09-expired-session"];

export type Variant = { label: string; fixture: OverviewFixtureKey; response: ReadResponse<unknown> | null; error: AdapterError | null };

/** Reads one view with each filter set under each of the nine ?fixture= switches. */
export async function readVariants(viewKey: string, filtersList: object[], prepare?: (adapter: ReturnType<typeof createDemoAdapter>) => Promise<void>): Promise<Variant[]> {
  const out: Variant[] = [];
  for (const fixture of overviewFixtureKeys) {
    for (const filters of filtersList) {
      const adapter = createDemoAdapter({ fixture });
      await prepare?.(adapter);
      const label = `${viewKey} ${JSON.stringify(filters)} ${fixture}`;
      try {
        out.push({ label, fixture, response: await adapter.readView(readRequest(viewKey, filters)), error: null });
      } catch (e) {
        if (!(e instanceof AdapterError)) throw e;
        out.push({ label, fixture, response: null, error: e });
      }
    }
  }
  return out;
}

/**
 * Asserts the response passes the full read envelope with this data schema, that nothing was stripped or changed
 * (parsed data equals the demo data), and returns how many responses were checked.
 */
export function expectAllParse(schema: z.ZodTypeAny, variants: Variant[], failsOn: readonly OverviewFixtureKey[] = []): number {
  let parsed = 0;
  const envelope = readResponseSchema(schema);
  for (const v of variants) {
    if (v.error) {
      if (!failsOn.includes(v.fixture)) throw new Error(`${v.label}: unexpected read failure ${v.error.body.code}`);
      continue;
    }
    if (failsOn.includes(v.fixture)) throw new Error(`${v.label}: expected the read to fail`);
    const result = envelope.safeParse(v.response);
    if (!result.success) throw new Error(`${v.label}: ${JSON.stringify(result.error.issues.slice(0, 3))}`);
    expect(result.data.data, v.label).toEqual(v.response!.data);
    parsed += 1;
  }
  return parsed;
}

export const REMOVE = Symbol("remove");
export type Mutation = [name: string, path: string, value: unknown];

/** Applies one change at a dotted path ("stages.0.byOwner.Thomas") to a deep copy. REMOVE deletes the key. */
export function mutate<T>(valid: T, path: string, value: unknown): unknown {
  const copy = structuredClone(valid) as Record<string, unknown>;
  const keys = path.split(".");
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (typeof next !== "object" || next === null) throw new Error(`Test path ${path} does not exist at ${key}`);
    node = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  if (!(last in node) && value !== REMOVE) throw new Error(`Test path ${path} does not name an existing field`);
  if (value === REMOVE) delete node[last];
  else node[last] = value;
  return copy;
}

/** One failing case per mutation, plus the unchanged data as the passing control. */
export function expectRejections(schema: z.ZodTypeAny, valid: unknown, mutations: Mutation[]) {
  it("accepts the unchanged data", () => {
    expect(schema.safeParse(valid).success).toBe(true);
  });
  it.each(mutations)("rejects: %s", (_name, path, value) => {
    expect(schema.safeParse(mutate(valid, path, value)).success).toBe(false);
  });
}
