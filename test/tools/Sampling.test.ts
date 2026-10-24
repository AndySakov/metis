import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import type { Sampling, ServerMap } from "../../src/tools/McpToolRunner.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/**
 * MCP sampling, as the runner answers it: a server asks for completions, and gets them only if it
 * was granted the model, only from the configured model server, and only so many per tool call.
 * The model server is the real `metis.model` against a stand-in for the Messages API.
 */

const prompts: Array<Record<string, any>> = []
const api = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    const body = JSON.parse(raw)
    prompts.push(body)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id: "msg_local",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: `answer to ${body.messages.at(-1).content}` }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }))
  })
})

let servers: ServerMap
beforeAll(async () => {
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done))
  const node = (file: string) => ({ command: "node", args: ["--experimental-strip-types", resolve(__dirname, file)] })
  servers = {
    "asker.tools": node("fixtures/asker.ts"),
    "metis.model": {
      ...node("../../src/tools/servers/model.ts"),
      env: {
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`
      }
    }
  }
})
afterAll(() => new Promise<void>((done) => api.close(() => done())))

const ask = Schema.decodeUnknownSync(ToolSpec)({
  name: "asker",
  version: "0.1.0",
  capability: "test.ask@0.1",
  mcp: { server: "asker.tools", tool: "ask" },
  idempotent: true,
  isolation: "process",
  authScopes: ["model.sample"],
  tests: [{ name: "minimal", input: { times: 1 } }]
})

const run = (times: number, sampling?: Sampling) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(ask, { times }))
      })
    ).pipe(Effect.provide(McpToolRunner.layer(servers, sampling))) as Effect.Effect<any>
  )

const granted: Sampling = { granted: new Set(["asker.tools"]), via: "metis.model", perCall: 3 }

describe("sampling", () => {
  it("answers a granted server from the model server, and reports how many it asked for", async () => {
    const outcome = await run(2, granted)
    expect(outcome._tag).toBe("Right")
    expect(outcome.right.output.answers).toEqual(["answer to question 1", "answer to question 2"])
    expect(outcome.right.samples).toBe(2)
    // The server's own system prompt reached the model, and nothing of METIS's was added to it.
    expect(prompts.at(-1)).toMatchObject({ system: "Answer briefly.", max_tokens: 100 })
  }, 30_000)

  it("refuses a server that was not granted the model", async () => {
    const outcome = await run(1, { ...granted, granted: new Set() })
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("after 0")
  }, 30_000)

  it("stops a server asking more than its allowance in one call, and resets it for the next", async () => {
    const outcome = await run(4, granted)
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("after 3:")
    expect(outcome.left.message).toContain("asker.tools asked for more than 3 completions in one tool call")
    expect((await run(3, granted))._tag).toBe("Right")
  }, 30_000)

  it("refuses when no model is configured, saying how to configure one", async () => {
    const outcome = await run(1, { ...granted, via: undefined })
    expect(outcome.left.message).toContain("no model is configured: set METIS_MODEL_CLI or ANTHROPIC_API_KEY")
  }, 30_000)
})
