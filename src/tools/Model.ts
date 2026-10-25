/**
 * The configured model, as a service METIS itself can ask: one completion, text in and text out.
 *
 * It is answered by the same model server that answers `design.*` and packs' sampling requests
 * (`metis.model-cli` or `metis.model`), through that server's `complete` tool, so the CLI or the
 * key stays in that one process and every model call METIS makes goes the same way. The model gets
 * no tools: whatever it returns is text for the caller to check, never an action.
 */

import { Context, Effect, Layer, Schema } from "effect"

import { ToolSpec } from "../domain/ToolSpec.js"
import { ToolRunner } from "./ToolRunner.js"

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  message: Schema.String
}) {}

export interface Turn {
  readonly role: "user" | "assistant"
  readonly text: string
}

export class Model extends Context.Tag("tools/Model")<Model, {
  readonly complete: (system: string, turns: ReadonlyArray<Turn>) => Effect.Effect<string, ModelError>
}>() {}

/** The model server's `complete` tool, as a descriptor the runner can call. Not a capability. */
const completeOn = (server: string) =>
  Schema.decodeUnknownSync(ToolSpec)({
    name: "metis-complete",
    version: "1.0.0",
    capability: "model.complete@1.0",
    mcp: { server, tool: "complete" },
    idempotent: true,
    isolation: "process",
    tests: [{ name: "minimal", input: { system: "", messages: [{ role: "user", text: "hi" }] } }]
  })

/** The model answered by `server`, over the runner every tool call uses. */
export const layerVia = (server: string) =>
  Layer.effect(
    Model,
    Effect.gen(function*() {
      const runner = yield* ToolRunner
      const spec = completeOn(server)
      return Model.of({
        complete: (system, turns) =>
          runner.run(spec, { system, messages: turns }).pipe(
            Effect.mapError((error) => new ModelError({ message: error.message })),
            Effect.map(({ output }) => (output as { markdown?: string }).markdown ?? "")
          )
      })
    })
  )
