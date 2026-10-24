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
  )
}) {}
