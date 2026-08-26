/**
 * Column codecs for reading PostgreSQL rows into domain types.
 *
 * These exist because the wire representation of a column is not always the representation the
 * domain uses, and pretending otherwise produces bugs that only appear against a real database.
 */

import { Schema } from "effect"

import { EpochSeconds } from "../domain/Common.js"

/**
 * Reads a `bigint` column as `EpochSeconds`.
 *
 * node-postgres returns `int8` as a **string**, not a number. That is deliberate on its part: a
 * 64-bit integer can exceed `Number.MAX_SAFE_INTEGER`, so handing back a JS number would silently
 * lose precision for large values. It cannot know that this particular column holds epoch seconds,
 * which will not reach that magnitude for another quarter of a million years.
 *
 * So the conversion happens here, narrowly, rather than by installing a global type parser for
 * every `int8` in the process — a global parser would also reinterpret any genuinely large bigint
 * the system later stores, which is the failure mode node-postgres is avoiding in the first place.
 *
 * ADR-019 chose epoch seconds as `bigint` (not `integer`) so timestamps do not overflow in 2038;
 * this codec is the cost of that choice, paid in one place.
 */
export const EpochSecondsColumn = Schema.transform(
  Schema.Union(Schema.String, Schema.Number),
  EpochSeconds,
  {
    strict: false,
    decode: (value) => Number(value),
    encode: (value) => value
  }
).annotations({ identifier: "EpochSecondsColumn" })
