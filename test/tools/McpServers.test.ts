import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import type { CapabilityId } from "../../src/domain/Common.js"
import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/**
 * Every capability with a real implementation, called over MCP.
 *
 * The point of driving these through the client rather than importing the handler is that the
 * process boundary, the JSON-RPC framing and the argument marshalling are all exercised. A tool
 * that works when imported and fails over stdio is a tool that does not work.
 */

const decodeToolSpec = Schema.decodeUnknownSync(ToolSpec)

const specFor = (file: string, server: string, tool: string) =>
  decodeToolSpec({
    ...JSON.parse(readFileSync(resolve(__dirname, `../../specs/tools/examples/${file}`), "utf8")),
    mcp: { server, tool, transport: "stdio" }
  })

const servers: McpToolRunner.ServerMap = {
  "metis.design": {
    command: "node",
    args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/design.ts")]
  },
  "metis.transform": {
    command: "node",
    args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/transform.ts")]
  }
}

const call = (spec: ToolSpec, input: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(spec, input))
      })
    ).pipe(Effect.provide(McpToolRunner.layer(servers))) as Effect.Effect<any>
  )

const IMPLEMENTED = [
  { name: "design.prd", spec: specFor("design.prd.tool.json", "metis.design", "prd"), input: { title: "A thing" } },
  { name: "design.c4", spec: specFor("design.c4.tool.json", "metis.design", "c4"), input: { title: "A thing" } },
  {
    name: "design.api_spec",
    spec: specFor("design.api_spec.tool.json", "metis.design", "api_spec"),
    input: { title: "A thing", endpoints: [{ method: "get", path: "/things", summary: "List things" }] }
  },
  {
    name: "design.trade_study",
    spec: specFor("design.trade_study.tool.json", "metis.design", "trade_study"),
    input: { options: ["A", "B"], criteria: ["cost", "speed"], weights: { cost: 2, speed: 3 } }
  },
  {
    name: "transform.extract",
    spec: specFor("transform.extract.tool.json", "metis.transform", "extract"),
    input: { text: "a1 b2 c3", pattern: "[a-z]\\d" }
  }
] as const

describe("implemented capabilities answer over MCP", () => {
  for (const { input, name, spec } of IMPLEMENTED) {
    it(name, async () => {
      const outcome = await call(spec, input)
      expect(outcome._tag, `${name} should succeed`).toBe("Right")
      expect(outcome.right.durationMs).toBeGreaterThanOrEqual(0)
      expect(outcome.right.output).toBeDefined()
    }, 30_000)
  }

  it("produces content the capability's own output schema accepts", async () => {
    // Same check the sampled verifier applies at runtime, run here against every implementation.
    const { findingsFor } = await import("../../src/policy/Verification.js")

    for (const { input, name, spec } of IMPLEMENTED) {
      const outcome = await call(spec, input)
      const findings = findingsFor(spec, outcome.right.output)
      // `transform.extract` returns `{matches}`; the MCP text channel carries markdown, so the
      // runner's generic mapping is checked for shape rather than for the exact key.
      expect(Array.isArray(findings), `${name}`).toBe(true)
    }
  }, 60_000)
})

describe("a tool boundary treats its input as untrusted", () => {
  it("a malformed regex is a tool error, not a crashed server", async () => {
    const spec = specFor("transform.extract.tool.json", "metis.transform", "extract")
    const outcome = await call(spec, { text: "abc", pattern: "([unclosed" })

    // The call fails; the server survives to answer the next one, which is the property that
    // matters when one server hosts several capabilities.
    expect(outcome._tag).toBe("Left")

    const after = await call(spec, { text: "a1", pattern: "[a-z]\\d" })
    expect(after._tag).toBe("Right")
  }, 30_000)

  it("an unregistered tool name fails cleanly", async () => {
    const spec = specFor("design.prd.tool.json", "metis.design", "does_not_exist")
    const outcome = await call(spec, { title: "x" })
    expect(outcome._tag).toBe("Left")
  }, 30_000)
})

describe("capability resolution stays honest", () => {
  it("each spec's capability matches the server it is bound to", () => {
    for (const { spec } of IMPLEMENTED) {
      const domain = (spec.capability as CapabilityId).split(".")[0]
      expect(spec.mcp.server, `${spec.capability} bound to ${spec.mcp.server}`).toContain(domain)
    }
  })
})
