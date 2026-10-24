import type { IncomingHttpHeaders } from "node:http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import { findingsFor } from "../../src/policy/Verification.js"
import { readDescriptor } from "../../src/tools/Descriptors.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/**
 * `metis.model` over real MCP, against a local stand-in for the Messages API.
 *
 * The server runs as its own process and makes real HTTP requests through the real SDK; only the
 * far end is local, so what is under test is everything METIS owns: the request it builds, how it
 * reads the reply, and how each way a reply can fall short becomes a tool error. The one call to
 * the real API is the live test at the bottom, which spends money and so runs only when asked.
 */

const SERVER = resolve(__dirname, "../../src/tools/servers/model.ts")

const specFor = (capability: string) =>
  readDescriptor(resolve(__dirname, `../../specs/tools/examples/${capability}.claude.tool.json`))

interface Recorded {
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: Record<string, any>
}

/** What the stand-in answers with next: a stop reason and the text of the reply. */
let reply: { stop_reason: string; text: string; stop_details?: unknown } = { stop_reason: "end_turn", text: "" }
const requests: Array<Recorded> = []

const api = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    requests.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) })
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id: "msg_local",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: reply.text === "" ? [] : [{ type: "text", text: reply.text }],
      stop_reason: reply.stop_reason,
      stop_sequence: null,
      stop_details: reply.stop_details ?? null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }))
  })
})

let baseURL = ""
beforeAll(async () => {
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done))
  baseURL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((done) => api.close(() => done())))

const run = (
  capability: string,
  input: Record<string, unknown>,
  env: Readonly<Record<string, string>> | undefined
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(specFor(capability), input))
      })
    ).pipe(
      Effect.provide(
        McpToolRunner.layer({
          "metis.model": {
            command: "node",
            args: ["--experimental-strip-types", SERVER],
            ...(env !== undefined ? { env } : {})
          }
        })
      )
    ) as Effect.Effect<any>
  )

const withKey = () => ({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: baseURL })

const CASES = [
  { capability: "design.prd", input: { title: "Offline notes", constraints: ["no server"] }, heading: "title" },
  { capability: "design.c4", input: { title: "Offline notes" }, heading: "C4: " },
  {
    capability: "design.api_spec",
    input: { title: "Notes", endpoints: [{ method: "get", path: "/notes" }] },
    heading: "API: "
  },
  {
    capability: "design.trade_study",
    input: { options: ["SQLite", "IndexedDB"], criteria: ["cost"] },
    heading: "Trade study"
  }
] as const

describe("metis.model answers the design capabilities with a model", () => {
  for (const { capability, heading, input } of CASES) {
    it(capability, async () => {
      requests.length = 0
      reply = { stop_reason: "end_turn", text: `# drafted for ${capability}\n\nbody` }

      const outcome = await run(capability, input, withKey())

      expect(outcome._tag, JSON.stringify(outcome.left)).toBe("Right")
      expect(outcome.right.output).toEqual({ markdown: `# drafted for ${capability}\n\nbody` })
      expect(findingsFor(specFor(capability), outcome.right.output)).toEqual([])

      expect(requests).toHaveLength(1)
      const sent = requests[0]!
      expect(sent.url).toContain("/v1/messages")
      expect(sent.body.model).toBe("claude-opus-5-5")
      expect(sent.body.output_config).toEqual({ effort: "high" })
      expect(sent.body.fallbacks).toBe("default")
      expect(sent.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01")
      // The model is given nothing to act with: the reply's text is the whole effect of the call.
      expect(sent.body.tools).toBeUndefined()
      expect(sent.body.system).toContain(heading)
      // Inputs travel as data inside <inputs>, never spliced into the instructions.
      expect(sent.body.system).not.toContain(JSON.stringify(input))
      const content = sent.body.messages[0].content as string
      expect(content.startsWith("<inputs>")).toBe(true)
      expect(JSON.parse(content.slice("<inputs>".length, -"</inputs>".length))).toEqual(input)
    }, 30_000)
  }
})

describe("every way a reply can fall short is a tool error, not a document", () => {
  it("a refusal", async () => {
    reply = { stop_reason: "refusal", text: "", stop_details: { type: "refusal", category: "cyber", explanation: "" } }
    const outcome = await run("design.prd", { title: "x" }, withKey())
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("declined (cyber)")
  }, 30_000)

  it("a document cut off at max_tokens", async () => {
    reply = { stop_reason: "max_tokens", text: "# half a docu" }
    const outcome = await run("design.prd", { title: "x" }, withKey())
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("stopped early (max_tokens)")
  }, 30_000)

  it("an empty reply", async () => {
    reply = { stop_reason: "end_turn", text: "" }
    const outcome = await run("design.prd", { title: "x" }, withKey())
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("no text")
  }, 30_000)

  it("no credentials, without ever calling out", async () => {
    requests.length = 0
    const outcome = await run("design.prd", { title: "x" }, { ANTHROPIC_BASE_URL: baseURL })
    expect(outcome._tag).toBe("Left")
    expect(outcome.left.message).toContain("ANTHROPIC_API_KEY")
    expect(requests).toHaveLength(0)
  }, 30_000)
})

describe("a credential reaches only the servers it is configured for", () => {
  it("a key in METIS's own environment is not inherited by a tool server", async () => {
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = "parent-only-key"
    try {
      const outcome = await run("design.prd", { title: "x" }, undefined)
      expect(outcome._tag).toBe("Left")
      expect(outcome.left.message).toContain("no Anthropic credentials")
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = saved
    }
  }, 30_000)
})

// Spends money, so it needs both a key and an explicit opt-in.
const live = process.env.METIS_TEST_LIVE_MODEL === "1" && (process.env.ANTHROPIC_API_KEY ?? "") !== ""

describe.skipIf(!live)("the real API (METIS_TEST_LIVE_MODEL=1)", () => {
  it("drafts a PRD", async () => {
    const outcome = await run(
      "design.prd",
      { title: "Offline-first notes", constraints: ["works with no network"] },
      { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! }
    )
    expect(outcome._tag, JSON.stringify(outcome.left)).toBe("Right")
    expect(outcome.right.output.markdown).toMatch(/^# Offline-first notes/)
  }, 300_000)
})
