import { digest } from "../config.ts";
import { assertSynchronousVoid } from "../sourceFence.ts";
import { aggregateDigestDataset, unavailableDigestResult } from "./aggregate.ts";
import {
  digestPageSchema, type DigestCoverage, type DigestDataset, type DigestResult, type DigestRow,
  type DigestScope, type DigestSourceBinding, type DigestWindow,
} from "./contract.ts";

export type DigestQuery = {
  scope: DigestScope;
  dataset: DigestDataset;
  binding: DigestSourceBinding;
  window: DigestWindow;
};
export type DigestReadFence = { assertCurrent(): void };
export type DigestSource = {
  readPage(query: DigestQuery & { cursor: string | null; limit: 100 }, fence: DigestReadFence & { signal: AbortSignal }): Promise<unknown>;
  /** Check the current permission and exact source binding before reads and before admitting/using evidence. */
  assertCurrent(query: DigestQuery, coverage: DigestCoverage | null, now: number): void;
};

export class DigestSourceError extends Error {
  readonly reason: "readFailed" | "permissionDenied" | "partialCoverage";
  readonly retryAfterMs: number;
  constructor(reason: DigestSourceError["reason"], retryAfterMs = 0) {
    super("DIGEST_SOURCE_" + reason);
    this.reason = reason;
    this.retryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? Math.min(retryAfterMs, 3_600_000) : 0;
  }
}

async function readBoundedPage(
  source: DigestSource, query: DigestQuery & { cursor: string | null; limit: 100 }, fence: DigestReadFence,
) {
  const signal = AbortSignal.timeout(8_000);
  let expire: () => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    expire = () => reject(new DigestSourceError("readFailed"));
    signal.addEventListener("abort", expire, { once: true });
  });
  try {
    const assertCurrent = () => {
      if (signal.aborted) throw new DigestSourceError("readFailed");
      fence.assertCurrent();
    };
    return await Promise.race([source.readPage(query, { signal, assertCurrent }), timeout]);
  } finally {
    signal.removeEventListener("abort", expire);
  }
}

/** Read only this registered dataset and exact calendar window. An incomplete page chain contributes no totals. */
export async function collectDigestDataset(
  source: DigestSource, query: DigestQuery, fence: DigestReadFence, now: () => number,
): Promise<{ result: DigestResult; retryAfterMs: number }> {
  const rows: DigestRow[] = [];
  const rowRefs = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let basis: string | null = null;
  const assertCurrent = (coverage: DigestCoverage | null) => {
    fence.assertCurrent();
    assertSynchronousVoid(() => source.assertCurrent(structuredClone(query), coverage ? structuredClone(coverage) : null, now()));
    fence.assertCurrent();
  };
  try {
    for (let pages = 1; pages <= 5; pages += 1) {
      assertCurrent(null);
      const raw = await readBoundedPage(source, { ...structuredClone(query), cursor, limit: 100 }, { assertCurrent: () => assertCurrent(null) });
      assertCurrent(null);
      const parsed = digestPageSchema.safeParse(raw);
      if (!parsed.success) throw new DigestSourceError("partialCoverage");
      const page = parsed.data;
      if (digest(page.scope) !== digest(query.scope) || digest(page.binding) !== digest(query.binding)) {
        throw new DigestSourceError("permissionDenied");
      }
      if (page.dataset !== query.dataset || page.start !== query.window.start || page.end !== query.window.end ||
          page.scheduledAt !== query.window.scheduledAt || page.coverage !== "complete" ||
          Date.parse(page.sourceAsOf) < Date.parse(query.window.end) ||
          Date.parse(page.sourceAsOf) > Date.parse(page.observedAt) || Date.parse(page.observedAt) > now() ||
          page.exhausted !== (page.nextCursor === null)) {
        throw new DigestSourceError("partialCoverage");
      }
      const identity = digest([page.snapshotRef, page.sourceVersion, page.sourceAsOf]);
      if (basis !== null && basis !== identity) throw new DigestSourceError("partialCoverage");
      basis = identity;
      for (const row of page.rows) {
        if (row.dataset !== query.dataset || rowRefs.has(row.ref)) throw new DigestSourceError("partialCoverage");
        rowRefs.add(row.ref);
        rows.push(row);
      }
      if (page.exhausted) {
        const coverage: DigestCoverage = {
          binding: page.binding, snapshotRef: page.snapshotRef, sourceVersion: page.sourceVersion,
          sourceAsOf: page.sourceAsOf, observedAt: page.observedAt, pages, rows: rows.length, exhausted: true,
        };
        assertCurrent(coverage);
        return { result: aggregateDigestDataset(query.dataset, rows, coverage, query.window), retryAfterMs: 0 };
      }
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new DigestSourceError("partialCoverage");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new DigestSourceError("partialCoverage");
  } catch (error) {
    // A lost worker or machine authorization is a run-level failure, never a source datum.
    fence.assertCurrent();
    const denied = error instanceof Error && "status" in error && [401, 403].includes(Number(error.status));
    const problem = error instanceof DigestSourceError ? error
      : new DigestSourceError(denied ? "permissionDenied" : "readFailed");
    return { result: unavailableDigestResult(query.dataset, problem.reason), retryAfterMs: problem.retryAfterMs };
  }
}
