/**
 * Short-let domain types: the unit a lead is triaged against.
 *
 * Mirrors `specs/stays/UnitProfile.schema.json`. The triage engine (`src/stays/Triage.ts`) takes
 * the decoded value; it is decoded here first so a malformed profile fails at startup, not as a
 * wrong verdict on a real lead.
 */

import { Schema } from "effect"

const Names = Schema.Array(Schema.NonEmptyTrimmedString)

export class UnitProfile extends Schema.Class<UnitProfile>("UnitProfile")({
  id: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*$/)),
  name: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200)),
  timezone: Schema.NonEmptyTrimmedString.pipe(
    Schema.filter((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone })
        return true
      } catch {
        return `unknown time zone ${zone}`
      }
    })
  ),
  bedrooms: Schema.Int.pipe(Schema.between(1, 20)),
  areas: Schema.Struct({ accept: Names, borderline: Names, reject: Names }),
  availability: Schema.optional(
    Schema.Struct({ spreadsheetId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]+$/)) })
  ),
  /** What a reply may state. Anything missing is a placeholder in the draft, never a guess. */
  listing: Schema.optional(Schema.Struct({
    headline: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120))),
    headlineSw: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120))),
    currency: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(8))),
    nightlyRate: Schema.optional(Schema.Int.pipe(Schema.positive())),
    highlights: Schema.optional(
      Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80))).pipe(Schema.maxItems(5))
    ),
    photos: Schema.optional(Schema.String.pipe(Schema.pattern(/^https:\/\//)))
  }))
}) {}
