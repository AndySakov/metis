#!/usr/bin/env node
/**
 * An MCP server exposing the `research.*` capabilities that can be implemented honestly.
 *
 * `fetch` performs real HTTP. `summarize` and `claim_graph` are deterministic extractive
 * algorithms over supplied chunks — no model in the loop, which means their output is reproducible
 * and their citations are guaranteed to point at text that was actually provided rather than
 * plausibly generated.
 *
 * `search` queries two open, keyless indexes, Wikipedia and arXiv, and says so: it is not a web-wide
 * search engine, and its results name where they came from. A general web index needs a provider
 * and a key; until one is chosen, these two are what METIS can search honestly.
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

/** Where `search` looks. Overridable so tests can stand in for both; never set from a request. */
const WIKIPEDIA = process.env.METIS_WIKIPEDIA_API ?? "https://en.wikipedia.org/w/api.php"
const ARXIV = process.env.METIS_ARXIV_API ?? "https://export.arxiv.org/api/query"
/** Wikipedia asks API clients to identify themselves. */
const USER_AGENT = "METIS/0.1 (personal research copilot; https://github.com/AndySakov/metis)"

interface Found {
  readonly url: string
  readonly title: string
  readonly snippet: string
  readonly license?: string
  readonly date?: string
}

const decodeEntities = (text: string): string => stripHtml(text)

const wikipedia = async (query: string, limit: number): Promise<Array<Found>> => {
  const url = new URL(WIKIPEDIA)
  for (
    const [key, value] of Object.entries({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: String(limit),
      format: "json",
      utf8: "1"
    })
  ) url.searchParams.set(key, value)
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`Wikipedia answered HTTP ${response.status}`)
  const body = await response.json() as { query?: { search?: Array<{ title: string; snippet: string }> } }
  return (body.query?.search ?? []).map((hit) => ({
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replaceAll(" ", "_"))}`,
    title: hit.title,
    snippet: decodeEntities(hit.snippet),
    license: "CC BY-SA 4.0"
  }))
}

/** arXiv's query language treats quotes, brackets and colons as syntax, so terms are plain words. */
const arxivTerms = (query: string): string =>
  query.replace(/[^\p{L}\p{N}\s-]/gu, " ").split(/\s+/).filter((t) => t !== "").map((t) => `all:${t}`).join(" AND ")

const arxiv = async (query: string, limit: number, from?: string, to?: string): Promise<Array<Found>> => {
  const terms = arxivTerms(query)
  if (terms === "") return []
  const range = from !== undefined || to !== undefined
    ? ` AND submittedDate:[${(from ?? "1991-01-01").replaceAll("-", "")}0000 TO ${
      (to ?? "2999-12-31").replaceAll("-", "")
    }2359]`
    : ""
  const url = new URL(ARXIV)
  url.searchParams.set("search_query", terms + range)
  url.searchParams.set("start", "0")
  url.searchParams.set("max_results", String(limit))
  url.searchParams.set("sortBy", "relevance")
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`arXiv answered HTTP ${response.status}`)
  const feed = await response.text()
  const field = (entry: string, tag: string) =>
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(entry)?.[1]?.replace(/\s+/g, " ").trim()
  return [...feed.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].flatMap((match) => {
    const entry = match[1]!
    const id = field(entry, "id")
    const title = field(entry, "title")
    if (id === undefined || title === undefined) return []
    const summary = decodeEntities(field(entry, "summary") ?? "")
    return [{
      url: id.replace(/^http:/, "https:"),
      title: decodeEntities(title),
      snippet: summary.length > 300 ? `${summary.slice(0, 297)}…` : summary,
      ...(field(entry, "published") !== undefined ? { date: field(entry, "published")!.slice(0, 10) } : {})
    }]
  })
}

const host = (url: string) => new URL(url).hostname

server.registerTool(
  "search",
  {
    title: "Search Wikipedia and arXiv",
    description: "Search two open indexes, Wikipedia and arXiv, for a query. Not a web-wide search.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      filters: z.object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        domains: z.array(z.string()).optional(),
        license: z.string().optional()
      }).optional()
    }
  },
  async ({ filters = {}, limit = 10, query }) => {
    const notes: Array<string> = []
    const wants = (domain: string) =>
      filters.domains === undefined || filters.domains.some((d) => domain === d || domain.endsWith(`.${d}`))
    const dated = filters.from !== undefined || filters.to !== undefined
    // Wikipedia articles have no publication date, so a date range leaves them out rather than guessing.
    const useWikipedia = wants("en.wikipedia.org") && !dated
    if (wants("en.wikipedia.org") && dated) notes.push("Wikipedia left out: its articles have no publication date.")
    const useArxiv = wants("arxiv.org")
    if (!useWikipedia && !useArxiv && !dated) notes.push("Neither Wikipedia nor arXiv is among the requested domains.")

    const each = Math.max(1, Math.ceil(limit / (useWikipedia && useArxiv ? 2 : 1)))
    const [wiki, papers] = await Promise.all([
      useWikipedia ? wikipedia(query, each).then((r) => ({ r }), (e: unknown) => ({ e })) : { r: [] as Array<Found> },
      useArxiv
        ? arxiv(query, each, filters.from, filters.to).then((r) => ({ r }), (e: unknown) => ({ e }))
        : { r: [] as Array<Found> }
    ])
    const failed = [["Wikipedia", wiki], ["arXiv", papers]] as const
    for (const [name, outcome] of failed) {
      if ("e" in outcome) notes.push(`${name} could not be searched: ${String(outcome.e)}`)
    }
    if (
      failed.every(([, outcome]) => "e" in outcome) || (failed.some(([, o]) => "e" in o) && !useWikipedia !== !useArxiv)
    ) {
      return { isError: true, content: [{ type: "text" as const, text: notes.join(" ") }] }
    }

    // Interleaved by rank, so neither index crowds out the other; score falls with rank.
    const lists = ["r" in wiki ? wiki.r : [], "r" in papers ? papers.r : []]
    const merged: Array<Found & { score: number }> = []
    for (let rank = 0; merged.length < limit && lists.some((list) => rank < list.length); rank++) {
      for (const list of lists) {
        const hit = list[rank]
        if (hit !== undefined && merged.length < limit) {
          merged.push({ ...hit, score: Number((1 / (rank + 1)).toFixed(3)) })
        }
      }
    }
    const results = merged.filter((hit) =>
      wants(host(hit.url)) &&
      (filters.license === undefined || hit.license === filters.license) &&
      (filters.from === undefined || (hit.date !== undefined && hit.date >= filters.from)) &&
      (filters.to === undefined || (hit.date !== undefined && hit.date <= filters.to))
    )

    const markdown = [
      `## Sources for "${query}"`,
      "",
      "Searched Wikipedia and arXiv only, not the whole web.",
      ...notes.map((note) => `> ${note}`),
      "",
      ...(results.length === 0
        ? ["Nothing found."]
        : results.map((hit) =>
          `- [${hit.title.replaceAll(/[[\]]/g, "")}](${hit.url}) (${
            host(hit.url) === "arxiv.org" ? `arXiv${hit.date !== undefined ? `, ${hit.date}` : ""}` : "Wikipedia"
          }): ${hit.snippet}`
        )),
      ""
    ].join("\n")

    const result = { results, markdown }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
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
