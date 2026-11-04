/* eslint-disable @typescript-eslint/no-explicit-any -- the negative cases corrupt typed fixtures on purpose, so they edit them untyped */
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { SCHEMA_VERSION, readResponseSchema, type ReadRequest } from "../contract";
import { createDemoAdapter } from "../demoAdapter";
import { AdapterError } from "../errors";
import { overviewFixtureKeys, overviewOriginal, type OverviewData, type OverviewFixtureKey } from "@/fixtures/overview";
import { metricDictionaryDemo, type MetricDictionaryData } from "@/fixtures/headlineMetrics";
import { attributionDemo, campaignFunnelDemo, customerJourneyDemo, launchControlDemo, launchSnapshotDemo, paidMediaDemo, type AttributionData, type CampaignFunnelData, type CustomerJourneyData, type LaunchControlData, type LaunchSnapshotData, type PaidMediaData } from "@/fixtures/analytics";
import { analyticsViewSchemas, attributionSchema, campaignFunnelSchema, customerJourneySchema, launchControlSchema, metricDictionarySchema, launchSnapshotSchema, overviewSummarySchema, paidMediaSchema } from "./analytics";

const scope = { workspaceId: "w", accountIds: ["a"], environment: "demo" as const };
const request = (viewKey: string, filters: object = {}): ReadRequest<unknown> => ({
  schemaVersion: SCHEMA_VERSION, operation: "readView", viewKey, requestedScope: scope, filters, period: null, sort: [], page: { cursor: null, limit: 50 }, requestId: "r-1",
});

/** The schema must not be looser than the fixture type: what it accepts is assignable to what the screens read. */
type Fits<Parsed, Screen> = Parsed extends Screen ? true : never;
const typeChecks: [
  Fits<z.infer<typeof overviewSummarySchema>, OverviewData>,
  Fits<z.infer<typeof launchSnapshotSchema>, LaunchSnapshotData>,
  Fits<z.infer<typeof launchControlSchema>, LaunchControlData>,
  Fits<z.infer<typeof attributionSchema>, AttributionData>,
  Fits<z.infer<typeof paidMediaSchema>, PaidMediaData>,
  Fits<z.infer<typeof campaignFunnelSchema>, CampaignFunnelData>,
  Fits<z.infer<typeof customerJourneySchema>, CustomerJourneyData>,
  Fits<z.infer<typeof metricDictionarySchema>, MetricDictionaryData>,
] = [true, true, true, true, true, true, true, true];

const REJECTED: Partial<Record<OverviewFixtureKey, string>> = {
  "FX-07-offline-read": "SOURCE_UNAVAILABLE",
  "FX-08-forbidden-account": "FORBIDDEN",
  "FX-09-expired-session": "SESSION_EXPIRED",
};

const paidMediaFilters = (["all", "cleared", "expiring", "notGranted", "unknown"] as const).flatMap((rights) => (["all", "meta", "tiktok"] as const).map((platform) => ({ rights, platform })));

const variants: Record<string, object[]> = {
  overviewSummary: [{}],
  launchSnapshot: [{}],
  launchControl: [{}],
  attribution: [{}],
  paidMedia: [{}, ...paidMediaFilters],
  campaignFunnel: [{ cohort: "first-wave" }, { cohort: "launch-a" }, {}],
  customerJourney: [{}],
  metricDictionary: [{}],
};

describe("analytics view schemas: every demo response parses", () => {
  it("covers the view keys the demo adapter serves", () => {
    expect(Object.keys(analyticsViewSchemas).sort()).toEqual(Object.keys(variants).sort());
    expect(typeChecks).toHaveLength(8);
  });

  for (const [viewKey, filterSets] of Object.entries(variants)) {
    for (const fixture of overviewFixtureKeys) {
      it(`${viewKey} · ${fixture}`, async () => {
        const schema = analyticsViewSchemas[viewKey]!;
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
          // The whole envelope, with this view's schema as the data schema.
          expect(() => readResponseSchema(schema).parse(response), JSON.stringify(filters)).not.toThrow();
          // Null data is only the empty filter, or the empty launch-a cohort. The demo keeps that null even when the
          // fixture marks the response partial or stale (see the PR notes), so the state is not pinned to "empty" there.
          if (response.data === null) expect(["empty", "partial", "stale"]).toContain(response.dataState);
          else expect(() => schema.parse(response.data), JSON.stringify(filters)).not.toThrow();
        }
      });
    }
  }

  it("keeps a known zero as 0, and an unknown as null with its reason (FX-02, FX-04)", async () => {
    const zero = (await createDemoAdapter({ fixture: "FX-02-known-zero" }).readView<unknown, OverviewData>(request("overviewSummary"))).data!;
    const parsed = overviewSummarySchema.parse(zero);
    expect(parsed.attributedOrders).toMatchObject({ state: "known", value: 0 });
    expect(parsed.attributedNetSales).toMatchObject({ state: "known", value: { minorUnits: 0 } });
    const missing = (await createDemoAdapter({ fixture: "FX-04-missing-metric" }).readView<unknown, AttributionData>(request("attribution"))).data!;
    expect(attributionSchema.parse(missing).tiktokPlatformRoas).toMatchObject({ state: "unknown", value: null, reasonCode: "PLATFORM_SPEND_MISSING" });
    const posts = (await createDemoAdapter({ fixture: "FX-04-missing-metric" }).readView<unknown, OverviewData>(request("overviewSummary"))).data!.posts;
    expect(overviewSummarySchema.parse({ ...overviewOriginal, posts }).posts.every((p) => p.shares === null)).toBe(true);
  });

  it("filters paid media to an empty asset list without losing the denominator", async () => {
    const res = await createDemoAdapter().readView<unknown, PaidMediaData>(request("paidMedia", { rights: "unknown", platform: "meta" }));
    const parsed = paidMediaSchema.parse(res.data);
    expect(parsed.assets).toEqual([]);
    expect(parsed.assetTotal).toBe(4);
  });

  it("answers the empty launch-a cohort with no data rather than an empty campaign list", async () => {
    const res = await createDemoAdapter().readView(request("campaignFunnel", { cohort: "launch-a" }));
    expect(res).toMatchObject({ dataState: "empty", data: null });
  });
});

type Case = [name: string, mutate: (d: any) => void];
const clone = <T,>(v: T): T => structuredClone(v);

const negatives: { view: string; schema: z.ZodTypeAny; valid: unknown; cases: Case[] }[] = [
  {
    view: "overviewSummary", schema: overviewSummarySchema, valid: overviewOriginal,
    cases: [
      ["missing required field", (d) => delete d.netReceipts],
      ["wrong dataset", (d) => (d.datasetKey = "pilot")],
      ["wrong type for orders", (d) => (d.orders.value = "400")],
      ["known value that is null", (d) => (d.orders.value = null)],
      ["unknown value that is zero", (d) => Object.assign(d.orders, { state: "unknown", value: 0, reasonCode: "X" })],
      ["unknown without a reason", (d) => Object.assign(d.orders, { state: "unknown", value: null, reasonCode: null })],
      ["unknown state name", (d) => (d.orders.state = "zero")],
      ["negative minor units", (d) => (d.marketingSpend.minorUnits = -1)],
      ["fractional minor units", (d) => (d.netReceipts.value.minorUnits = 100.5)],
      ["bad currency", (d) => (d.marketingSpend.currency = "US")],
      ["unknown channel key", (d) => (d.channels[0].key = "amazon")],
      ["bad daily date", (d) => (d.daily[0].date = "30 Sep")],
      ["negative post counter", (d) => (d.posts[0].views = -5)],
      ["post counter undefined instead of null", (d) => delete d.posts[0].shares],
    ],
  },
  {
    view: "launchSnapshot", schema: launchSnapshotSchema, valid: launchSnapshotDemo,
    cases: [
      ["missing required field", (d) => delete d.stage],
      ["wrong type", (d) => (d.readyForNextStep = "32")],
      ["known launch date that is null", (d) => Object.assign(d.launchDate, { state: "known", value: null, reasonCode: null })],
      ["unknown conversations that is zero", (d) => Object.assign(d.conversations, { state: "unknown", value: 0, reasonCode: "X" })],
      ["negative budget", (d) => (d.budgetCeiling.minorUnits = -4_000_000)],
      ["fractional budget", (d) => (d.budgetCeiling.minorUnits = 0.5)],
      ["negative momentum", (d) => (d.momentum[0].ready = -1)],
      ["provenance without stale flag", (d) => delete d.provenance.stale],
    ],
  },
  {
    view: "launchControl", schema: launchControlSchema, valid: launchControlDemo,
    cases: [
      ["missing required field", (d) => delete d.gates],
      ["unknown gate state", (d) => (d.gates[0].state = "maybe")],
      ["unknown evidence kind", (d) => (d.gates[0].evidenceKind = "screenshot")],
      ["wrong type", (d) => (d.firstWaveSamples = "46")],
      ["negative samples", (d) => (d.firstWaveSamples = -1)],
      ["fractional budget", (d) => (d.budgetCeiling.minorUnits = 4_000_000.5)],
      ["launch date present with a null value", (d) => Object.assign(d.launchDate, { state: "known" })],
    ],
  },
  {
    view: "attribution", schema: attributionSchema, valid: attributionDemo,
    cases: [
      ["missing required field", (d) => delete d.weeks],
      ["wrong dataset", (d) => (d.datasetKey = "paid-media-demo")],
      ["unknown attribution key", (d) => (d.attribution[0].key = "referral")],
      ["negative weekly money", (d) => (d.weeks[0].shopify.minorUnits = -1)],
      ["fractional weekly money", (d) => (d.weeks[0].tiktok.minorUnits = 68000.2)],
      ["ROAS as a string", (d) => (d.tiktokPlatformRoas.value = "2.4")],
      ["ROAS known but null", (d) => (d.tiktokPlatformRoas.value = null)],
      ["negative ROAS", (d) => (d.tiktokPlatformRoas.value = -2.4)],
      ["unknown contribution carrying a value", (d) => Object.assign(d.contribution, { state: "unknown", reasonCode: "X" })],
    ],
  },
  {
    view: "paidMedia", schema: paidMediaSchema, valid: paidMediaDemo,
    cases: [
      ["missing required field", (d) => delete d.assetTotal],
      ["unknown rights state", (d) => (d.assets[0].rights = "granted")],
      ["unknown platform", (d) => (d.channels[0].key = "google")],
      ["negative spend", (d) => (d.channels[0].spend.minorUnits = -300000)],
      ["fractional spend", (d) => (d.channels[0].spend.minorUnits = 300000.5)],
      ["negative clicks", (d) => (d.assets[0].clicks = -1)],
      ["expiry as a string", (d) => (d.assets[2].expiresInDays = "12")],
    ],
  },
  {
    view: "campaignFunnel", schema: campaignFunnelSchema, valid: campaignFunnelDemo,
    cases: [
      ["missing required field", (d) => delete d.campaigns[0].steps.posted],
      ["unknown cohort", (d) => (d.cohort.key = "launch-b")],
      ["unknown campaign key", (d) => (d.campaigns[0].key = "youtube")],
      ["negative step", (d) => (d.campaigns[0].steps.replied = -1)],
      ["fractional step", (d) => (d.campaigns[0].steps.replied = 40.5)],
      ["wrong type", (d) => (d.notYetMature = "5")],
    ],
  },
  {
    view: "customerJourney", schema: customerJourneySchema, valid: customerJourneyDemo,
    cases: [
      ["missing required field", (d) => delete d.returns],
      ["sessions known but null", (d) => (d.sessions.value = null)],
      ["sessions unknown carrying zero", (d) => Object.assign(d.sessions, { state: "unknown", value: 0, reasonCode: "X" })],
      ["rated count unknown without reason", (d) => Object.assign(d.reviews.ratedCount, { state: "notApplicable", value: null, reasonCode: null })],
      ["star outside 1–5", (d) => (d.reviews.stars[0].star = 6)],
      ["negative AOV", (d) => (d.globalAov.minorUnits = -1)],
      ["fractional AOV", (d) => (d.globalAov.minorUnits = 3149.5)],
      ["negative ticket count", (d) => (d.tickets[0].count = -1)],
    ],
  },
  {
    view: "metricDictionary", schema: metricDictionarySchema, valid: metricDictionaryDemo,
    cases: [
      ["missing required field", (d) => delete d.entries[0].refundTreatment],
      ["another dataset", (d) => (d.datasetKey = "overview-original")],
      ["unknown metric key", (d) => (d.entries[0].key = "roi")],
      ["negative bucket", (d) => (d.buckets[0].minorUnits = -1)],
      ["fractional bucket", (d) => (d.buckets[0].minorUnits = 1.5)],
      ["unknown caveat", (d) => (d.cases[0].input.caveat = "WHATEVER")],
      ["NaN-like input as a string", (d) => (d.cases[0].input.validOrders = "400")],
    ],
  },
];

describe("analytics view schemas: bad shapes are rejected", () => {
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
});
