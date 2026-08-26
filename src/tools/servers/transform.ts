#!/usr/bin/env node
/**
 * An MCP server exposing the `transform.*` capabilities.
 *
 * Separate from `design` because they are separate logical servers in the registry, and keeping
 * them apart is what lets one be replaced, sandboxed or moved to another host without touching the
 * other — the property ADR-017's server indirection exists to provide.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "metis.transform", version: "0.1.0" })

server.registerTool(
  "extract",
  {
    title: "Extract matches",
    description: "Return every match of a regular expression, with its offset.",
    inputSchema: { text: z.string(), pattern: z.string().min(1) }
  },
  ({ pattern, text }) => {
    // The capability declares `{ matches: [{ match, index }] }`, and this is a tool boundary:
    // a caller-supplied pattern is untrusted input. A malformed regex must come back as a tool
    // error rather than crashing the server and taking every other in-flight call with it.
    let regex: RegExp
    try {
      regex = new RegExp(pattern, "g")
    } catch (cause) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `invalid pattern: ${String(cause)}` }]
      }
    }

    const matches: Array<{ match: string; index: number }> = []
    for (const found of text.matchAll(regex)) {
      if (found.index === undefined) continue
      matches.push({ match: found[0], index: found.index })
      // A zero-length match would spin forever otherwise.
      if (found[0].length === 0) break
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ matches }) }],
      structuredContent: { matches }
    }
  }
)

await server.connect(new StdioServerTransport())
