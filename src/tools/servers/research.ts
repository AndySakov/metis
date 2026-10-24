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
    // Script and style bodies are not content, and leaving them in would poison a summary. Nor
    // are footnote markers, which would otherwise end up mid-sentence as "[3]".
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|sup)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Block elements separate words; inline ones (links, emphasis) sit inside them and must not
    // leave a space before the punctuation that follows.
    .replace(
      /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|nav|blockquote)\b[^>]*>/gi,
      " "
    )
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The readable text of a page: its paragraphs, one per line, when it has enough of them to be an
 * article, otherwise everything. Menus, headers and footers are rarely in `<p>`, so on most pages
 * this is the difference between the article and the article buried in its navigation.
 */
export const readableText = (html: string): string => {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripHtml(match[1]!))
    .filter((text) => text.length > 0)
  return paragraphs.join("").length >= 500 ? paragraphs.join("\n") : stripHtml(html)
}

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
        text: readableText(body),
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

/** Splits on sentence boundaries and line breaks, keeping the terminator. */
const sentences = (text: string): Array<string> =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

/** A sentence worth quoting: long enough to say something, short enough to read, and prose. */
const quotable = (sentence: string): boolean => {
  const words = sentence.split(/\s+/).length
  return words >= 8 && words <= 60 && /[.!?]["')\]]?$/.test(sentence) && /[a-z]/.test(sentence)
}

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

    // Earlier sentences count for more: most writing states its point first, and a summary built
    // only on vocabulary overlap picks whatever repeats the subject's name most.
    let position = 0
    const scored = chunks.flatMap((chunk) =>
      sentences(chunk.text).filter(quotable).map((sentence) => {
        const words = sentence.toLowerCase().match(/[a-z0-9']+/g) ?? []
        const overlap = words.reduce((sum, word) => sum + (frequency.get(word) ?? 0), 0) /
          Math.max(1, words.length)
        return { sentence, score: overlap * (1 + 2 / (1 + position / 3)), order: position++, source: chunk.source }
      })
    )

    // The best five, each said once, in the order the source said them.
    const seen = new Set<string>()
    const top = scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .filter((entry) => !seen.has(entry.sentence) && seen.add(entry.sentence))
      .slice(0, 5)
      .sort((a, b) => a.order - b.order)
    const citations = Array.from(
      new Map(
        chunks
          .filter((chunk) => chunk.source !== undefined)
          .map((chunk) => [chunk.source!, { url: chunk.source! }])
      ).values()
    )

    const result = {
      markdown: [
        "## Summary",
        "",
        ...(top.length > 0
          ? top.map((entry) => `- ${entry.sentence}`)
          : ["Nothing in the text reads as a full sentence, so there is nothing to quote."]),
        ...(citations.length > 0 ? ["", `Source: ${citations.map((c) => c.url).join(", ")}`] : []),
        ""
      ].join("\n"),
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
