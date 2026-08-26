/**
 * Tool dispatch.
 *
 * The seam between METIS and whatever actually runs a tool. ADR-016 puts tool dispatch on METIS's
 * side of the line, so this is ours; ADR-017 makes MCP the transport, so the real implementation
 * speaks MCP. The interface exists separately from either so an executor can be tested without
 * spawning processes.
 */

import { Context, Schema } from "effect"
import type { Effect } from "effect"

import type { ToolSpec } from "../domain/ToolSpec.js"

export class ToolRunError extends Schema.TaggedError<ToolRunError>()("ToolRunError", {
  tool: Schema.String,
  message: Schema.String
}) {}

export interface ToolResult {
  readonly output: unknown
  /** Milliseconds spent in the tool — surfaced on TOOL_COMPLETED for the observability story. */
  readonly durationMs: number
}

export class ToolRunner extends Context.Tag("tools/ToolRunner")<ToolRunner, {
  readonly run: (
    spec: ToolSpec,
    input: Record<string, unknown>
  ) => Effect.Effect<ToolResult, ToolRunError>
}>() {}
