/**
 * The tool registry (ADR-006, ADR-017).
 *
 * Maps a capability id to the implementations that satisfy it. This indirection is the thing that
 * makes hot-swap, versioning and the graduation loop coherent — the planner names
 * `design.prd@1.0` and never learns which server answers it, so an implementation can be replaced
 * without touching a plan.
 *
 * Validation is enforced here rather than trusted: ADR-006 requires schema-valid descriptors,
 * declared scopes, and at least one conformance vector per capability version. A registry that
 * accepts anything is not governance.
 */

import { Context, Effect, Layer, Schema } from "effect"

import type { CapabilityId } from "../domain/Common.js"
import type { ToolSpec } from "../domain/ToolSpec.js"

export class ToolNotFound extends Schema.TaggedError<ToolNotFound>()(
  "ToolNotFound",
  {
    capability: Schema.String,
    message: Schema.String
  }
) {}

export class InvalidToolSpec extends Schema.TaggedError<InvalidToolSpec>()(
  "InvalidToolSpec",
  {
    name: Schema.String,
    errors: Schema.Array(Schema.String)
  }
) {}

/**
 * ADR-006's registration rules, as checks rather than prose.
 *
 * Returns the reasons a descriptor is unacceptable; empty means it may be registered.
 */
export const validationErrors = (spec: ToolSpec): Array<string> => {
  const errors: Array<string> = []

  if (spec.tests.length === 0) {
    errors.push(
      "no conformance vectors: ADR-006 requires at least one per capability version"
    )
  }

  // The descriptor's version and the capability's MAJOR.MINOR are independent, but a tool claiming
  // to satisfy `research.search@0.1` while declaring major version 3 is almost certainly a mistake
  // in one of the two, and silently registering it would make capability versioning meaningless.
  const capabilityMajor = spec.capability.split("@")[1]?.split(".")[0]
  const specMajor = spec.version.split(".")[0]
  if (
    capabilityMajor !== undefined &&
    specMajor !== undefined &&
    capabilityMajor !== specMajor
  ) {
    errors.push(
      `version ${spec.version} does not share a major with capability ${spec.capability}; ` +
        "one of the two is wrong"
    )
  }

  // A tool that reaches the network without saying so cannot be governed by scope rules.
  if (spec.mcp.transport === "http" && spec.authScopes.length === 0) {
    errors.push("an http-transport tool must declare its auth scopes")
  }

  return errors
}

export class ToolRegistry extends Context.Tag("tools/ToolRegistry")<
  ToolRegistry,
  {
    /** Every implementation satisfying a capability. */
    readonly resolve: (
      capability: CapabilityId
    ) => Effect.Effect<Array<ToolSpec>, ToolNotFound>
    /**
     * The implementation to use. Multiple may satisfy one capability and policy is meant to choose
     * between them; until a selection policy exists this takes the first registered, deterministically.
     */
    readonly select: (
      capability: CapabilityId
    ) => Effect.Effect<ToolSpec, ToolNotFound>
    readonly all: Effect.Effect<Array<ToolSpec>>
  }
>() {}

/**
 * Builds a registry, rejecting invalid descriptors up front.
 *
 * Failing at construction rather than at dispatch is deliberate: a malformed tool should stop a
 * deployment, not surface halfway through executing someone's plan.
 */
export const make = (
  specs: ReadonlyArray<ToolSpec>
): Effect.Effect<typeof ToolRegistry.Service, InvalidToolSpec> =>
  Effect.gen(function*() {
    for (const spec of specs) {
      const errors = validationErrors(spec)
      if (errors.length > 0) {
        return yield* new InvalidToolSpec({ name: spec.name, errors })
      }
    }

    const byCapability = new Map<string, Array<ToolSpec>>()
    for (const spec of specs) {
      const existing = byCapability.get(spec.capability)
      if (existing === undefined) byCapability.set(spec.capability, [spec])
      else existing.push(spec)
    }

    const resolve = (capability: CapabilityId) => {
      const found = byCapability.get(capability)
      return found === undefined || found.length === 0
        ? Effect.fail(
          new ToolNotFound({
            capability,
            message: `no implementation registered for ${capability}`
          })
        )
        : Effect.succeed(found)
    }

    return {
      resolve,
      select: (capability) => Effect.map(resolve(capability), (found) => found[0]!),
      all: Effect.succeed([...specs])
    }
  })

export const layer = (specs: ReadonlyArray<ToolSpec>) => Layer.effect(ToolRegistry, Effect.orDie(make(specs)))
