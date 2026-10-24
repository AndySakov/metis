/**
 * A pack: a domain METIS does not know about, added from outside (`specs/packs/Pack.schema.json`).
 *
 * The manifest is data. A pack's code runs only as the MCP server processes it declares, so the
 * orchestrator never imports it, and its tools reach the world through the same registry, policy
 * and event log as core's. Its planner templates are data too: a pattern to match the goal and the
 * tool inputs to fill from it, compiled by the planner rather than handed to it as functions.
 */

import { Schema } from "effect"

import { ArtifactKind, CapabilityId } from "./Common.js"
import { SemVer } from "./ToolSpec.js"

const PackName = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]{0,62}$/))
/** `metis.*` is core's, so a pack can never stand in for one of core's servers. */
const ServerName = Schema.String.pipe(Schema.pattern(/^(?!metis\.)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/))
/** Relative, and never climbing out of the pack. */
const RelativePath = Schema.String.pipe(Schema.pattern(/^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/@-]+$/))
const EnvName = Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]*$/))
const Pointer = Schema.String.pipe(Schema.pattern(/^(\/([^~/]|~[01])*)*$/))

/** A regular expression in its source form, refused at load if it does not compile. */
const Pattern = Schema.NonEmptyString.pipe(
  Schema.filter((source) => {
    try {
      new RegExp(source, "i")
      return true
    } catch (cause) {
      return `not a regular expression: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  })
)

export class PackServer extends Schema.Class<PackServer>("PackServer")({
  command: Schema.NonEmptyString,
  args: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  env: Schema.optionalWith(Schema.Array(EnvName), { default: () => [] }),
  paths: Schema.optionalWith(Schema.Array(EnvName), { default: () => [] })
}) {}

export class PackStep extends Schema.Class<PackStep>("PackStep")({
  description: Schema.NonEmptyString,
  capability: CapabilityId,
  input: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  bindings: Schema.optional(
    Schema.Array(Schema.Struct({ to: Pointer, fromStep: Schema.Int.pipe(Schema.nonNegative()), from: Pointer }))
  )
}) {}

export class PackTemplate extends Schema.Class<PackTemplate>("PackTemplate")({
  name: PackName,
  match: Pattern,
  unless: Schema.optional(Pattern),
  needsPasted: Schema.optional(Schema.NonEmptyString),
  steps: Schema.NonEmptyArray(PackStep),
  assumptions: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
  risks: Schema.optionalWith(Schema.Array(Schema.NonEmptyString), { default: () => [] }),
  expects: Schema.optionalWith(
    Schema.Array(Schema.Struct({ kind: ArtifactKind, description: Schema.NonEmptyString })),
    { default: () => [] }
  )
}) {}

export class PackExample extends Schema.Class<PackExample>("PackExample")({
  goal: Schema.NonEmptyString,
  pasted: Schema.optional(Schema.NonEmptyString)
}) {}

export class Pack extends Schema.Class<Pack>("Pack")({
  name: PackName,
  version: SemVer,
  description: Schema.NonEmptyString,
  servers: Schema.Record({ key: ServerName, value: PackServer }).pipe(
    Schema.filter((servers) => Object.keys(servers).length > 0 || "a pack runs at least one server")
  ),
  tools: Schema.NonEmptyArray(RelativePath),
  templates: Schema.optionalWith(Schema.Array(PackTemplate), { default: () => [] }),
  examples: Schema.optionalWith(Schema.Array(PackExample), { default: () => [] })
}) {}
