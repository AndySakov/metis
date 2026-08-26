import { Schema } from "effect"

/**
 * A UUIDv7 in canonical lowercase hex form.
 *
 * The version nibble is pinned to 7 and the variant nibble to 8/9/a/b, so a UUIDv4 does not
 * decode. `Schema.UUID` would accept one, which is why it is not used here: ADR-005 wants
 * identifiers that sort lexicographically by creation time, and v4 defeats exactly that.
 */
export const Uuid7 = Schema.String.pipe(
  Schema.pattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  Schema.annotations({
    identifier: "Uuid7",
    description: "UUIDv7, lowercase hex, time-sortable (ADR-005)",
    examples: ["01890a5d-ac96-774b-bcce-b302099a8057"]
  })
)

/** UNIX epoch seconds. One representation at every layer, storage included (ADR-019). */
export const EpochSeconds = Schema.Int.pipe(
  Schema.nonNegative(),
  Schema.brand("EpochSeconds"),
  Schema.annotations({ identifier: "EpochSeconds", description: "UNIX epoch seconds (ADR-005)" })
)
export type EpochSeconds = typeof EpochSeconds.Type

/**
 * Who caused a thing to happen. The optional `:qualifier` names a specific principal; METIS is
 * single-user today, so the bare forms are what actually appear.
 */
export const Actor = Schema.String.pipe(
  Schema.pattern(/^(user|metis)(:[a-z0-9._-]+)?$/),
  Schema.annotations({ examples: ["user", "metis", "user:andysakov"] }),
  Schema.brand("Actor"),
  Schema.annotations({ identifier: "Actor" })
)
export type Actor = typeof Actor.Type

/** `domain.action@MAJOR.MINOR` — what the planner targets, never an implementation (ADR-003, ADR-017). */
export const CapabilityId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*@[0-9]+\.[0-9]+$/),
  Schema.annotations({ examples: ["research.search@0.1", "design.prd@1.0"] }),
  Schema.brand("CapabilityId"),
  Schema.annotations({ identifier: "CapabilityId" })
)
export type CapabilityId = typeof CapabilityId.Type

export const Autonomy = Schema.Literal("S0", "S1", "S2", "S3", "S4").annotations({
  identifier: "Autonomy",
  description: "Autonomy gear (ADR-002). S0 advise, S1 draft, S2 sandbox, S3 gated, S4 scheduled."
})
export type Autonomy = typeof Autonomy.Type

export const ArtifactKind = Schema.Literal(
  "text",
  "image",
  "audio",
  "video",
  "file",
  "link",
  "code",
  "binary"
).annotations({ identifier: "ArtifactKind" })
export type ArtifactKind = typeof ArtifactKind.Type

/** Free text that must carry something. Mirrors the `NonEmptyString` domain in the SQL schema. */
export const ShortText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(200))
export const LongText = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(5000))

export const Tags = Schema.optionalWith(Schema.Array(Schema.NonEmptyTrimmedString), {
  default: () => []
})

/**
 * A named value carrying tags.
 *
 * Tags are where trust labels live — content pulled from the open web is tagged `untrusted` at
 * ingest and policy reads that tag at dispatch. A plain record of name to value could not carry
 * that, which is why intent inputs and constraints are ordered arrays of these.
 */
export class TaggedValue extends Schema.Class<TaggedValue>("TaggedValue")({
  name: Schema.NonEmptyTrimmedString,
  value: Schema.Unknown,
  tags: Tags
}) {}

/** Time, money and token ceilings for a single call. All optional; absent means unbounded (ADR-010). */
export class Budget extends Schema.Class<Budget>("Budget")({
  seconds: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  dollars: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  tokens: Schema.optional(Schema.Number.pipe(Schema.nonNegative()))
}) {}
