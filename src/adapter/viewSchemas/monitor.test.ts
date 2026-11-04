/* eslint-disable @typescript-eslint/no-explicit-any -- the negative cases corrupt typed fixtures on purpose, so they edit them untyped */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ReadRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { contentMonitorDemo, hourlyRunDemo, monitorPosts, postPerformanceDemo, watchlistDemo, type ContentMonitorData, type HourlyRunData, type PostPerformanceData, type WatchlistData } from "@/fixtures/monitor";
import { overviewFixtureKeys, type OverviewFixtureKey } from "@/fixtures/overview";
import { contentMonitorSchema, hourlyRunSchema, monitorViewSchemas, postPerformanceSchema, watchlistSchema } from "./monitor";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const request = (viewKey: string, filters: object = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r-1",
});

/** The schema must not be looser than the fixture type, except where the schema file says otherwise (post interactions). */
type Fits<Parsed, Screen> = Parsed extends Screen ? true : never;
const typeChecks: [
  Fits<z.infer<typeof contentMonitorSchema>, ContentMonitorData>,
  Fits<z.infer<typeof watchlistSchema>, WatchlistData>,
  Fits<z.infer<typeof hourlyRunSchema>, HourlyRunData>,
] = [true, true, true];
// postPerformance is looser than its type on purpose: saves/uniqueReach are typed `null` but may carry counts.
const looserThanType: z.infer<typeof postPerformanceSchema> extends PostPerformanceData ? "same" : "looser" = "looser";

const REJECTED: Partial<Record<OverviewFixtureKey, string>> = {
  "FX-07-offline-read": "SOURCE_UNAVAILABLE",
  "FX-08-forbidden-account": "FORBIDDEN",
  "FX-09-expired-session": "SESSION_EXPIRED",
};

const sources = ["all", "tiktok-affiliate", "social-cat"] as const;
const contentFilters = sources.flatMap((source) =>
  (["all", "tiktok", "instagram"] as const).flatMap((network) => (["last-30", "last-7"] as const).flatMap((window) => ["", "rae", "P-00", "zzz-no-match"].map((q) => ({ source, network, window, q })))),
);
const watchFilters = sources.flatMap((source) => (["all", "active", "identity-review", "excluded"] as const).flatMap((state) => (["all", "launch-a"] as const).map((cohort) => ({ source, state, cohort }))));

const variants: Record<string, object[]> = {
  contentMonitor: [{}, ...contentFilters],
  watchlist: [{}, ...watchFilters],
  hourlyRun: [{ runId: "demo-run-hourly" }],
  postPerformance: monitorPosts.map((p) => ({ postId: p.postId })),
};

describe("monitor view schemas: every demo response parses", () => {
  it("covers the monitor view keys", () => {
    expect(Object.keys(monitorViewSchemas).sort()).toEqual(Object.keys(variants).sort());
    expect(typeChecks).toHaveLength(3);
    expect(looserThanType).toBe("looser");
  });

  for (const [viewKey, filterSets] of Object.entries(variants)) {
    for (const fixture of overviewFixtureKeys) {
      it(`${viewKey} · ${fixture}`, async () => {
        const schema = monitorViewSchemas[viewKey]!;
        const adapter = createDemoAdapter({ fixture });
        for (const filters of filterSets) {
          const read = adapter.readView(request(viewKey, filters));
          const rejected = REJECTED[fixture];
          if (rejected) {
            await expect(read).rejects.toBeInstanceOf(AdapterError);
            await expect(read).rejects.toMatchObject({ body: { code: rejected } });
            continue;
          }
          const response = await read;
          expect(() => readResponseSchema(schema).parse(response), JSON.stringify(filters)).not.toThrow();
          if (response.data === null) expect(response.dataState).toBe("empty");
          else expect(() => schema.parse(response.data), JSON.stringify(filters)).not.toThrow();
        }
      });
    }
  }

  it("answers not found for an unknown run and an unknown post", async () => {
    const adapter = createDemoAdapter();
    await expect(adapter.readView(request("hourlyRun", { runId: "x" }))).rejects.toMatchObject({ body: { code: "RECORD_NOT_FOUND" } });
    await expect(adapter.readView(request("postPerformance", { postId: "P-999" }))).rejects.toMatchObject({ body: { code: "RECORD_NOT_FOUND" } });
  });

  it("keeps the 7-day window's missing counts as null, not zero", async () => {
    const res = await createDemoAdapter().readView<unknown, ContentMonitorData>(request("contentMonitor", { window: "last-7" }));
    const parsed = contentMonitorSchema.parse(res.data);
    expect(parsed.windowAvailable).toBe(false);
    expect(parsed.attributedOrders).toBeNull();
    expect(parsed.attributedNetSales).toBeNull();
    expect(parsed.posts.every((p) => p.views === null && p.orders === null && p.netSales === null)).toBe(true);
  });

  it("keeps a post with no interactions as null (FX-04)", async () => {
    const res = await createDemoAdapter({ fixture: "FX-04-missing-metric" }).readView<unknown, PostPerformanceData>(request("postPerformance", { postId: "P-001" }));
    expect(postPerformanceSchema.parse(res.data)).toMatchObject({ views: null, interactions: null });
  });
});

type Case = [name: string, mutate: (d: any) => void];
const clone = <T,>(v: T): T => structuredClone(v);

const negatives: { view: string; schema: z.ZodTypeAny; valid: unknown; cases: Case[] }[] = [
  {
    view: "contentMonitor", schema: contentMonitorSchema, valid: contentMonitorDemo,
    cases: [
      ["missing required field", (d) => delete d.coverage],
      ["wrong dataset", (d) => (d.datasetKey = "watchlist-demo")],
      ["unknown network", (d) => (d.posts[0].network = "youtube")],
      ["unknown intake source", (d) => (d.posts[0].source = "manual")],
      ["negative views", (d) => (d.posts[0].views = -1)],
      ["fractional views", (d) => (d.posts[0].views = 84000.5)],
      ["views as a string", (d) => (d.posts[0].views = "84000")],
      ["interactions with a missing counter", (d) => delete d.posts[0].interactions.shares],
      ["negative net sales", (d) => (d.posts[0].netSales.minorUnits = -1)],
      ["fractional net sales", (d) => (d.posts[0].netSales.minorUnits = 201500.5)],
      ["unknown signal tone", (d) => (d.signals[0].tone = "danger")],
      ["window without a snapshot reporting an order total", (d) => (d.windowAvailable = false)],
      ["window without a snapshot reporting post counts", (d) => Object.assign(d, { windowAvailable: false, attributedOrders: null, attributedNetSales: null })],
    ],
  },
  {
    view: "watchlist", schema: watchlistSchema, valid: watchlistDemo,
    cases: [
      ["missing required field", (d) => delete d.totals],
      ["unknown monitoring state", (d) => (d.rows[0].state = "paused")],
      ["unknown next-step kind", (d) => (d.rows[0].next.kind = "pay")],
      ["unknown cohort", (d) => (d.rows[0].cohort = "launch-b")],
      ["unknown network", (d) => (d.rows[0].network = "tiktok")],
      ["negative total", (d) => (d.totals.active = -1)],
      ["fractional total", (d) => (d.totals.tracked = 40.5)],
    ],
  },
  {
    view: "hourlyRun", schema: hourlyRunSchema, valid: hourlyRunDemo,
    cases: [
      ["missing required field", (d) => delete d.policy],
      ["unknown stage state", (d) => (d.stages[0].state = "failed")],
      ["unknown evidence kind", (d) => (d.evidence[0].kind = "payment")],
      ["failed profile missing a reason", (d) => delete d.profiles.failed.reason],
      ["negative checked count", (d) => (d.profiles.checked = -1)],
      ["fractional link count", (d) => (d.newPostLinks = 4.5)],
      ["inbox changes as a string", (d) => (d.inboxChanges = "9")],
    ],
  },
  {
    view: "postPerformance", schema: postPerformanceSchema, valid: postPerformanceDemo,
    cases: [
      ["missing required field", (d) => delete d.details],
      ["wrong dataset", (d) => (d.datasetKey = "monitor-demo")],
      ["unknown network label", (d) => (d.network = "tiktok")],
      ["negative views", (d) => (d.views = -84000)],
      ["fractional orders", (d) => (d.orders = 62.5)],
      ["negative net sales", (d) => (d.netSales.minorUnits = -2015)],
      ["fractional net sales", (d) => (d.netSales.minorUnits = 2015.5)],
      ["negative saves", (d) => (d.interactions.saves = -1)],
      ["negative daily delta", (d) => (d.dailyDeltas[0].thousands = -1)],
    ],
  },
];

describe("monitor view schemas: bad shapes are rejected", () => {
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

  it("accepts saves and unique reach when a real source reports them", () => {
    const d = clone(postPerformanceDemo) as any;
    d.interactions.saves = 310;
    d.interactions.uniqueReach = 60000;
    expect(postPerformanceSchema.safeParse(d).success).toBe(true);
  });
});
