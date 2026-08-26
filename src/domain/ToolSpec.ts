import { Schema } from "effect"

import { CapabilityId } from "./Common.js"

export const SemVer = Schema.String.pipe(
  Schema.pattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/),
  Schema.brand("SemVer")
)
export type SemVer = typeof SemVer.Type

/**
 * The MCP binding (ADR-017).
 *
 * Names the server logically and the tool within it. Connection details — command line, URL,
 * credentials — are deployment configuration, not contract, and deliberately do not appear.
 */
export class McpBinding extends Schema.Class<McpBinding>("McpBinding")({
  server: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9._-]*$/)),
  tool: Schema.NonEmptyTrimmedString,
  transport: Schema.optional(Schema.Literal("stdio", "http"))
}) {}

export class ToolTest extends Schema.Class<ToolTest>("ToolTest")({
  name: Schema.NonEmptyTrimmedString,
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  expect: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
}) {}

export class ToolCosts extends Schema.Class<ToolCosts>("ToolCosts")({
  fixed: Schema.optional(Schema.Number.pipe(Schema.nonNegative())),
  perUnit: Schema.optional(Schema.Number.pipe(Schema.nonNegative()))
}) {}

/**
 * A thin descriptor binding one MCP tool to one capability, carrying what METIS needs and MCP does
 * not provide (ADR-017). The registry resolves a capability to one or more of these; policy chooses
 * between them.
 */
export class ToolSpec extends Schema.Class<ToolSpec>("ToolSpec")({
  name: Schema.NonEmptyTrimmedString,
  version: SemVer,
  capability: CapabilityId,
  mcp: McpBinding,
  /**
   * Whether calling this twice with the same input is indistinguishable from calling it once.
   * Required, with no default: durable execution replays (ADR-016), and a wrong guess here means a
   * real-world side effect happening twice.
   */
  idempotent: Schema.Boolean,
  /**
   * `process` is the only honest value today. MCP servers are separate processes, so the boundary
   * is the operating system's plus whatever METIS applies at dispatch — weaker than the
   * container-or-WASM story in ADR-003. A boolean `sandboxed: true` would assert containment that
   * does not exist.
   */
  isolation: Schema.Literal("process"),
  inputSchema: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  outputSchema: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  authScopes: Schema.optionalWith(Schema.Array(Schema.NonEmptyTrimmedString), { default: () => [] }),
  costs: Schema.optional(ToolCosts),
  /** ADR-006 requires at least one passing conformance vector per capability version. */
  tests: Schema.NonEmptyArray(ToolTest)
}) {}
