/**
 * Building blocks shared by the creators, collaboration, scorecards, recruitment and evidence view schemas.
 * Money comes from the contract's `moneySchema` (integer minor units plus a three-letter currency) and is
 * narrowed here to non-negative, because no view in these areas carries a signed amount. Provenance values
 * come from the contract's `provenanceValueSchema`, so known zero, unknown and not applicable stay distinct.
 *
 * Counts that can be unknown are written `count.nullable()` and mean "unknown, not zero": a null is never
 * coerced to 0 here, and 0 is never accepted as a stand-in for a missing value.
 */
import { z } from "zod";
import { moneySchema } from "../contract.ts";

/** A count of things: a whole number, zero or more. */
export const count = z.number().int().nonnegative();

/** An amount in integer minor units with no currency (fields named `...Minor`). Never a float, never negative. */
export const minorUnits = z.number().int().nonnegative();

/** A percentage between 0 and 100. */
export const percent = z.number().min(0).max(100);

/** The contract's money shape, narrowed to a non-negative amount. */
export const money = moneySchema.refine((m) => m.minorUnits >= 0, { message: "Amount cannot be negative", path: ["minorUnits"] });

/** A non-empty display string. Labels and handles are never blank in a real response. */
export const text = z.string().min(1);

/** UTC instant, e.g. 2026-11-02T17:00:00.000Z. */
export const instant = z.string().datetime();

/** Calendar date, e.g. 2026-11-04. */
export const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const owner = z.enum(["Thomas", "Operations", "Creator agent", "Operator"]);

/** Per-owner counts. Strict: an unknown owner key would silently drop its count from every total. */
export const countsByOwner = z.object({ Thomas: count, Operations: count, "Creator agent": count, Operator: count }).strict();

export const tone = z.enum(["neutral", "violet", "success", "warning"]);

/** A "state is unknown" marker used by fixtures that are not full provenance values. A value key is refused, not stripped. */
export const unknownMarker = z.object({ state: z.literal("unknown"), reasonCode: text }).strict();

export const labelCount = z.object({ label: text, count });
