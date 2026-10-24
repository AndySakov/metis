import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
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
      {
        text: "Alpha beta gamma delta epsilon zeta eta theta. Zeta eta theta iota kappa lambda mu nu.",
        source: "https://example.com/a"
      },
      {
        text: "Alpha beta gamma lambda mu nu xi omicron. Nu xi omicron pi rho sigma tau upsilon.",
        source: "https://example.com/b"
      }
    ]
    const outcome = await call(spec, { chunks })
    expect(outcome._tag).toBe("Right")

    const markdown = String((outcome.right.output as { markdown?: string }).markdown ?? "")
    const corpus = chunks.map((c) => c.text).join(" ")

    const quoted = markdown.split("\n").filter((l) => l.startsWith("- "))
    expect(quoted.length).toBeGreaterThan(0)
    for (const line of quoted) {
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

describe("research.summarize reads like a summary", () => {
  const spec = specFor("research.summarize.tool.json", "summarize")
  const bullets = async (text: string) => {
    const outcome = await call(spec, { chunks: [{ text }] })
    expect(outcome._tag).toBe("Right")
    return String((outcome.right.output as { markdown: string }).markdown)
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2))
  }

  it("quotes whole sentences, not the fragments a web page is full of", async () => {
    const quoted = await bullets(
      "Home. Menu. Contents [hide]. Metis was the goddess of wisdom and counsel in Greek mythology.\n" +
        "Edit\nThe Greek word metis meant a quality that combined wisdom and cunning together."
    )
    expect(quoted).toEqual([
      "Metis was the goddess of wisdom and counsel in Greek mythology.",
      "The Greek word metis meant a quality that combined wisdom and cunning together."
    ])
  }, 30_000)

  it("keeps the source's order and says each sentence once", async () => {
    const opening = "Offline-first notes apps keep every note on the device before they sync anywhere."
    const later = "Sync conflicts in offline-first notes apps are resolved per note, not per device."
    const quoted = await bullets(`${opening} ${later} ${opening}`)
    expect(quoted).toEqual([opening, later])
  }, 30_000)

  it("says so rather than quoting junk when nothing is a sentence", async () => {
    const outcome = await call(spec, { chunks: [{ text: "Home | About | Contact" }] })
    expect(String((outcome.right.output as { markdown: string }).markdown)).toContain("nothing to quote")
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

describe("research.search queries Wikipedia and arXiv, and says it searched only those", () => {
  const seen: Array<URL> = []
  let failWikipedia = false
  const stand = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local")
    seen.push(url)
    if (url.pathname === "/w/api.php") {
      if (failWikipedia) {
        res.writeHead(503).end()
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        query: {
          search: [
            {
              title: "Retrieval-augmented generation",
              snippet: "<span class=\"searchmatch\">RAG</span> grounds &amp; cites"
            },
            { title: "Large language model", snippet: "A model trained on text" }
          ]
        }
      }))
      return
    }
    res.writeHead(200, { "content-type": "application/atom+xml" })
    res.end(`<?xml version="1.0"?><feed>
      <entry><id>http://arxiv.org/abs/2005.11401v4</id><published>2020-05-22T17:32:47Z</published>
        <title>Retrieval-Augmented Generation for
          Knowledge-Intensive NLP Tasks</title><summary>Large pre-trained language models store knowledge.</summary></entry>
      <entry><id>http://arxiv.org/abs/2312.10997v5</id><published>2023-12-18T07:47:33Z</published>
        <title>RAG for LLMs: A Survey</title><summary>A survey &amp; review.</summary></entry>
    </feed>`)
  })
  let base = ""
  beforeAll(async () => {
    await new Promise<void>((done) => stand.listen(0, "127.0.0.1", done))
    base = `http://127.0.0.1:${(stand.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((done) => stand.close(() => done())))

  const search = (input: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const runner = yield* ToolRunner
          return yield* Effect.either(runner.run(specFor("research.search.tool.json", "search"), input))
        })
      ).pipe(
        Effect.provide(McpToolRunner.layer({
          "metis.research": {
            ...servers["metis.research"]!,
            env: { METIS_WIKIPEDIA_API: `${base}/w/api.php`, METIS_ARXIV_API: `${base}/api/query` }
          }
        }))
      ) as Effect.Effect<any>
    )

  it("interleaves both indexes by rank, as the contract shapes them", async () => {
    seen.length = 0
    const outcome = await search({ query: "retrieval augmented generation", limit: 4 })
    expect(outcome._tag).toBe("Right")
    const { markdown, results } = outcome.right.output
    expect(results.map((r: any) => r.url)).toEqual([
      "https://en.wikipedia.org/wiki/Retrieval-augmented_generation",
      "https://arxiv.org/abs/2005.11401v4",
      "https://en.wikipedia.org/wiki/Large_language_model",
      "https://arxiv.org/abs/2312.10997v5"
    ])
    expect(results[0]).toMatchObject({ snippet: "RAG grounds & cites", license: "CC BY-SA 4.0", score: 1 })
    expect(results[1]).toMatchObject({
      title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      date: "2020-05-22",
      score: 1
    })
    expect(results[3].score).toBe(0.5)
    expect(markdown).toContain("Searched Wikipedia and arXiv only")
    expect(markdown).toContain("[RAG for LLMs: A Survey](https://arxiv.org/abs/2312.10997v5)")

    // The query reaches arXiv as plain terms, so its syntax cannot be injected.
    const arxiv = seen.find((u) => u.pathname === "/api/query")!
    expect(arxiv.searchParams.get("search_query")).toBe("all:retrieval AND all:augmented AND all:generation")
  }, 30_000)

  it("leaves Wikipedia out of a date range, since its articles have no publication date", async () => {
    seen.length = 0
    const outcome = await search({ query: "rag", filters: { from: "2023-01-01" } })
    expect(outcome.right.output.results.map((r: any) => r.date)).toEqual(["2023-12-18"])
    expect(outcome.right.output.markdown).toContain("Wikipedia left out")
    expect(seen.some((u) => u.pathname === "/w/api.php")).toBe(false)
    expect(seen.find((u) => u.pathname === "/api/query")!.searchParams.get("search_query")).toContain(
      "submittedDate:[202301010000 TO 299912312359]"
    )
  }, 30_000)

  it("searches only the domains asked for", async () => {
    seen.length = 0
    const outcome = await search({ query: "rag", filters: { domains: ["arxiv.org"] } })
    expect(outcome.right.output.results.every((r: any) => r.url.startsWith("https://arxiv.org/"))).toBe(true)
    expect(seen.every((u) => u.pathname === "/api/query")).toBe(true)
  }, 30_000)

  it("reports an index that failed, and fails only when every index it needed did", async () => {
    failWikipedia = true
    try {
      const partial = await search({ query: "rag" })
      expect(partial._tag).toBe("Right")
      expect(partial.right.output.results.every((r: any) => r.url.startsWith("https://arxiv.org/"))).toBe(true)
      expect(partial.right.output.markdown).toContain("Wikipedia could not be searched")

      const total = await search({ query: "rag", filters: { domains: ["en.wikipedia.org"] } })
      expect(total._tag).toBe("Left")
    } finally {
      failWikipedia = false
    }
  }, 30_000)
})
