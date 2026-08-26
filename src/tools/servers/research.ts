#!/usr/bin/env node
/**
 * An MCP server exposing the `research.*` capabilities that can be implemented honestly.
 *
 * `fetch` performs real HTTP. `summarize` and `claim_graph` are deterministic extractive
 * algorithms over supplied chunks — no model in the loop, which means their output is reproducible
 * and their citations are guaranteed to point at text that was actually provided rather than
 * plausibly generated.
 *
 * `research.search@0.1` is deliberately **not** here. It needs a search backend, and implementing
 * it against canned results would put a capability in the registry that does not do what its
 * contract says — worse than leaving it unimplemented, because the planner would then target it.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "metis.research", version: "0.1.0" })

/**
 * Hosts a fetch must refuse.
 *
 * A tool that takes a URL from a plan — which may itself have been shaped by untrusted content —
 * and issues a request from inside the trust boundary is a server-side request forgery primitive.
 * The cloud metadata endpoint (169.254.169.254) is the classic target; loopback and private ranges
 * reach whatever else happens to be running on the host or the LAN.
 *
 * This is a coarse guard, and it is deliberately coarse: it blocks by literal host rather than
 * resolving DNS, so a name that resolves to a private address still gets through. Closing that
 * requires resolving and re-checking after redirects, which belongs with the WASM sandbox work
 * rather than being half-done here. Recorded in the Limits doc as an open gap.
 */
const BLOCKED_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

const stripHtml = (html: string): string =>
  html
    // Script and style bodies are not content, and leaving them in would poison a summary.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/\s+/g, " ")
    .trim()

server.registerTool(
  "fetch",
  {
    title: "Fetch and clean a URL",
    description: "Retrieve a document and return its readable text.",
    inputSchema: { url: z.string().min(1) }
  },
  async ({ url }) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { isError: true, content: [{ type: "text" as const, text: `not a URL: ${url}` }] }
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `refusing scheme ${parsed.protocol}` }]
      }
    }
    if (BLOCKED_HOST.test(parsed.hostname)) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `refusing private or loopback host ${parsed.hostname}` }]
      }
    }

    try {
      const response = await fetch(parsed.toString(), {
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.8" }
      })

      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `HTTP ${response.status} from ${parsed.hostname}` }]
        }
      }

      const body = await response.text()
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)
      const result = {
        text: stripHtml(body),
        metadata: titleMatch?.[1] !== undefined ? { title: stripHtml(titleMatch[1]) } : {}
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result
      }
    } catch (cause) {
      return { isError: true, content: [{ type: "text" as const, text: `fetch failed: ${String(cause)}` }] }
    }
  }
)

/** Splits on sentence boundaries, keeping the terminator. */
const sentences = (text: string): Array<string> =>
  text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

server.registerTool(
  "summarize",
  {
    title: "Summarise chunks with citations",
    description: "Extractive summary over supplied chunks; every sentence comes from the input.",
    inputSchema: {
      chunks: z.array(z.object({ text: z.string(), source: z.string().optional() })).min(1),
      style: z.string().optional()
    }
  },
  ({ chunks }) => {
    /*
     * Extractive, not generative: sentences are scored by how much of the corpus vocabulary they
     * carry, and the best few are quoted verbatim. That means a citation always points at text
     * that genuinely exists in the input — the failure mode a generated summary has, where a
     * plausible sentence is attributed to a source that never said it, is unreachable here.
     */
    const frequency = new Map<string, number>()
    for (const chunk of chunks) {
      for (const word of chunk.text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
        if (word.length < 4) continue // skip the filler that would dominate the count
        frequency.set(word, (frequency.get(word) ?? 0) + 1)
      }
    }

    const scored = chunks.flatMap((chunk) =>
      sentences(chunk.text).map((sentence) => {
        const words = sentence.toLowerCase().match(/[a-z0-9']+/g) ?? []
        const score = words.reduce((sum, word) => sum + (frequency.get(word) ?? 0), 0) /
          Math.max(1, words.length)
        return { sentence, score, source: chunk.source }
      })
    )

    const top = scored.slice().sort((a, b) => b.score - a.score).slice(0, 5)
    const citations = Array.from(
      new Map(
        chunks
          .filter((chunk) => chunk.source !== undefined)
          .map((chunk) => [chunk.source!, { url: chunk.source! }])
      ).values()
    )

    const result = {
      markdown: ["## Summary", "", ...top.map((entry) => `- ${entry.sentence}`), ""].join("\n"),
      citations
    }

    return {
      content: [{ type: "text" as const, text: result.markdown }],
      structuredContent: result
    }
  }
)

server.registerTool(
  "claim_graph",
  {
    title: "Build a claim graph",
    description: "Link claim-shaped sentences to the sources that contain them.",
    inputSchema: {
      chunks: z.array(z.object({ text: z.string(), sourceId: z.string().optional() }))
    }
  },
  ({ chunks }) => {
    /*
     * Only `mentions` edges are produced. Deciding that one claim *supports* or *refutes* another
     * is an inference, and emitting one from a keyword match would manufacture exactly the
     * unfounded confidence the claim graph exists to prevent. A real supports/refutes edge needs a
     * model and an evidence check, and should arrive with its own capability version.
     */
    const edges = chunks.flatMap((chunk, index) => {
      const source = chunk.sourceId ?? `chunk_${index}`
      return sentences(chunk.text)
        // A claim needs a verb and some substance; fragments are not claims.
        .filter((sentence) => sentence.length > 30 && /\b(is|are|was|were|has|have|shows?|found)\b/i.test(sentence))
        .map((sentence) => ({
          from: sentence.slice(0, 120),
          rel: "mentions" as const,
          to: source,
          props: { length: sentence.length }
        }))
    })

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ edges }) }],
      structuredContent: { edges }
    }
  }
)

await server.connect(new StdioServerTransport())
