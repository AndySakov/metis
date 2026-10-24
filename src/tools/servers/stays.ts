#!/usr/bin/env node
/**
 * An MCP server for the short-let: `stays.*` capabilities over one unit's profile.
 *
 * `triage` reads a pasted group chat and says which messages are people looking for a place this
 * unit could fill. The rules are in `src/stays/Triage.ts` and held by conformance vectors; this
 * server only parses the paste, applies them, and writes the report.
 *
 * The unit is described by a profile (`specs/stays/UnitProfile.schema.json`) read once at startup
 * from `METIS_STAYS_PROFILE`, or the example Westlands 1-bed in the repository when unset. A
 * malformed profile stops the server, rather than producing confident verdicts against nonsense.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Schema } from "effect"
import { z } from "zod"

import { UnitProfile } from "../../domain/Stays.ts"
import { parseChat, report, triage } from "../../stays/Triage.ts"

const EXAMPLE = fileURLToPath(new URL("../../../specs/stays/units/example-westlands-1br.json", import.meta.url))

const profile = Schema.decodeUnknownSync(UnitProfile)(
  JSON.parse(readFileSync(process.env.METIS_STAYS_PROFILE || EXAMPLE, "utf8"))
)

const server = new McpServer({ name: "metis.stays", version: "0.1.0" })

server.registerTool(
  "triage",
  {
    title: "Triage leads",
    description: `Find the messages in a pasted group chat that are looking for a place ${profile.name} could fill.`,
    inputSchema: {
      messages: z.string().min(1),
      group: z.string().optional(),
      now: z.string().datetime({ offset: true }).optional()
    }
  },
  ({ group, messages, now }) => {
    const at = now === undefined ? new Date() : new Date(now)
    const results = parseChat(messages, group).map((message) => triage(message, profile, at))
    const result = { unit: profile.name, results, markdown: report(results, profile) }
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result }
  }
)

await server.connect(new StdioServerTransport())
