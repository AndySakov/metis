#!/usr/bin/env node
/**
 * The redact pack's MCP server: `text.redact` over `Redact.ts`.
 *
 * A pack's code runs here, in its own process, and nowhere else: METIS reaches it over MCP, as it
 * reaches its own servers, so the same registry, policy and event log stand between it and a plan.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

import { KINDS, redact } from "./Redact.ts"

const server = new McpServer({ name: "redact.tools", version: "0.1.0" })

server.registerTool(
  "redact",
  {
    title: "Redact personal details",
    description: "Replace emails, card numbers, phone numbers and IP addresses in text with a marker naming each.",
    inputSchema: {
      text: z.string(),
      kinds: z.array(z.enum(KINDS)).min(1).optional()
    }
  },
  async ({ kinds, text }) => {
    const result = redact(text, kinds)
    const counts = KINDS.filter((kind) => result.found[kind] > 0).map((kind) => `${result.found[kind]} ${kind}`)
    const markdown = [
      "## Redacted",
      "",
      counts.length > 0 ? `Replaced ${counts.join(", ")}.` : "Nothing found to redact.",
      "",
      "```text",
      result.text,
      "```",
      ""
    ].join("\n")
    const output = { ...result, markdown }
    return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output }
  }
)

await server.connect(new StdioServerTransport())
