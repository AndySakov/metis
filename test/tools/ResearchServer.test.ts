import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/**
 * The `research.*` capabilities, over MCP.
 *
 * `fetch` performs real HTTP, which makes it the one tool here with a genuine attack surface — a
 * URL reaching it may have been shaped by untrusted content, and issuing that request from inside
 * the trust boundary is a server-side request forgery primitive. Most of this file is about that.
 */

const decodeToolSpec = Schema.decodeUnknownSync(ToolSpec)

const specFor = (file: string, tool: string) =>
  decodeToolSpec({
    ...JSON.parse(readFileSync(resolve(__dirname, `../../specs/tools/examples/${file}`), "utf8")),
    mcp: { server: "metis.research", tool, transport: "stdio" }
  })

const servers: McpToolRunner.ServerMap = {
  "metis.research": {
    command: "node",
    args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/research.ts")]
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

describe("research.fetch guards its own boundary", () => {
  const spec = specFor("research.fetch.tool.json", "fetch")

  it("refuses loopback, private and link-local hosts (SSRF)", async () => {
    // 169.254.169.254 is the cloud metadata endpoint — the classic target. The private ranges
    // reach whatever else happens to be running on the host or the LAN.
    for (
      const url of [
        "http://127.0.0.1:8080/admin",
        "http://localhost/secrets",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://172.16.0.1/"
      ]
    ) {
      const outcome = await call(spec, { url })
      expect(outcome._tag, `${url} must be refused`).toBe("Left")
    }
  }, 60_000)

  it("refuses non-http schemes", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/1"]) {
      const outcome = await call(spec, { url })
      expect(outcome._tag, `${url} must be refused`).toBe("Left")
    }
  }, 60_000)

  it("refuses a malformed URL rather than guessing", async () => {
    const outcome = await call(spec, { url: "not a url at all" })
    expect(outcome._tag).toBe("Left")
  }, 30_000)

  it("survives a refused call and answers the next one", async () => {
    // One server hosts three capabilities; a rejected input must not take the process down.
    await call(spec, { url: "http://127.0.0.1/" })
    const summarize = specFor("research.summarize.tool.json", "summarize")
    const after = await call(summarize, { chunks: [{ text: "Still alive and answering." }] })
    expect(after._tag).toBe("Right")
  }, 30_000)
})

describe("research.summarize is extractive, so citations cannot be fabricated", () => {
  const spec = specFor("research.summarize.tool.json", "summarize")

  it("quotes only sentences that appear in the input", async () => {
    const chunks = [
      { text: "Alpha beta gamma delta epsilon. Zeta eta theta iota kappa.", source: "https://example.com/a" },
      { text: "Alpha beta gamma lambda mu. Nu xi omicron pi rho.", source: "https://example.com/b" }
    ]
    const outcome = await call(spec, { chunks })
    expect(outcome._tag).toBe("Right")

    const markdown = String((outcome.right.output as { markdown?: string }).markdown ?? "")
    const corpus = chunks.map((c) => c.text).join(" ")

    for (const line of markdown.split("\n").filter((l) => l.startsWith("- "))) {
      const sentence = line.slice(2).trim()
      // The property a generated summary cannot offer: the text is quoted, not invented, so a
      // citation always points at something that was genuinely said.
      expect(corpus, `"${sentence}" must come from the input`).toContain(sentence)
    }
  }, 30_000)

  it("cites every source it was given, and none it was not", async () => {
    const outcome = await call(spec, {
      chunks: [
        { text: "One two three four five.", source: "https://example.com/a" },
        { text: "Six seven eight nine ten.", source: "https://example.com/b" },
        { text: "No source on this one." }
      ]
    })

    const citations = (outcome.right.output as { citations?: Array<{ url: string }> }).citations ?? []
    const urls = citations.map((c) => c.url).sort()
    expect(urls).toEqual(["https://example.com/a", "https://example.com/b"])
  }, 30_000)
})

describe("research.claim_graph asserts only what it can justify", () => {
  const spec = specFor("research.claim_graph.tool.json", "claim_graph")

  it("emits mentions edges linking claims to their source", async () => {
    const outcome = await call(spec, {
      chunks: [{
        text: "Retrieval augmented generation is a method that grounds answers in retrieved sources.",
        sourceId: "s1"
      }]
    })

    expect(outcome._tag).toBe("Right")
    const edges = (outcome.right.output as { edges?: Array<{ rel: string; to: string }> }).edges ?? []
    expect(edges.length).toBeGreaterThan(0)
    expect(edges[0]!.to).toBe("s1")
  }, 30_000)

  it("never claims supports or refutes", async () => {
    // Deciding that one claim supports or refutes another is an inference. Emitting one from a
    // keyword match would manufacture exactly the unfounded confidence a claim graph exists to
    // prevent — so the vocabulary is restricted until there is a model and an evidence check.
    const outcome = await call(spec, {
      chunks: [
        { text: "The study shows that retrieval improves factuality substantially.", sourceId: "s1" },
        { text: "Another paper found that retrieval has no measurable effect at all.", sourceId: "s2" }
      ]
    })

    const edges = (outcome.right.output as { edges?: Array<{ rel: string }> }).edges ?? []
    expect(edges.length).toBeGreaterThan(0)
    expect(new Set(edges.map((e) => e.rel))).toEqual(new Set(["mentions"]))
  }, 30_000)

  it("does not treat sentence fragments as claims", async () => {
    const outcome = await call(spec, { chunks: [{ text: "Short. Also short. Tiny.", sourceId: "s1" }] })
    const edges = (outcome.right.output as { edges?: Array<unknown> }).edges ?? []
    expect(edges).toEqual([])
  }, 30_000)
})
