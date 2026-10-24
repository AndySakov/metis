#!/usr/bin/env node
/**
 * An MCP server for the short-let: `stays.*` capabilities over one unit's profile.
 *
 * `triage` reads a pasted group chat and says which messages are people looking for a place this
 * unit could fill; `availability` says whether the unit can take a stay. The rules are in
 * `src/stays/` and held by conformance vectors; this server parses, applies them, and reports.
 *
 * The unit is described by a profile (`specs/stays/UnitProfile.schema.json`) read once at startup
 * from `METIS_STAYS_PROFILE`, or the example Westlands 1-bed in the repository when unset. A
 * malformed profile stops the server, rather than producing confident verdicts against nonsense.
 *
 * Availability comes from the unit's booking sheet, read fresh for each call: with
 * `METIS_GOOGLE_CREDENTIALS` and the profile's `availability.spreadsheetId`, from Google Sheets, or
 * from a saved snapshot of it at `METIS_STAYS_AVAILABILITY_SNAPSHOT`. Without either, triage says
 * "not checked" rather than guessing, and `availability` is a tool error.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Schema } from "effect"
import { z } from "zod"

import { UnitProfile } from "../../domain/Stays.ts"
import type { Calendar, SheetSnapshot } from "../../stays/Availability.ts"
import { answer, calendarFrom } from "../../stays/Availability.ts"
import { fetchSheet } from "../../stays/Sheets.ts"
import { dates, parseChat, report, todayIn, triage, withAvailability } from "../../stays/Triage.ts"

const EXAMPLE = fileURLToPath(new URL("../../../specs/stays/units/example-westlands-1br.json", import.meta.url))

const profile = Schema.decodeUnknownSync(UnitProfile)(
  JSON.parse(readFileSync(process.env.METIS_STAYS_PROFILE || EXAMPLE, "utf8"))
)

/** The booking calendar, or why there is none: unconfigured, or the sheet could not be read. */
const calendar = async (now: Date): Promise<{ calendar: Calendar } | { unavailable: string }> => {
  const snapshot = process.env.METIS_STAYS_AVAILABILITY_SNAPSHOT
  const credentials = process.env.METIS_GOOGLE_CREDENTIALS
  try {
    if (snapshot !== undefined && snapshot !== "") {
      return { calendar: calendarFrom(JSON.parse(readFileSync(snapshot, "utf8")) as SheetSnapshot) }
    }
    if (profile.availability !== undefined && credentials !== undefined && credentials !== "") {
      return { calendar: calendarFrom(await fetchSheet(profile.availability.spreadsheetId, credentials, now)) }
    }
  } catch (cause) {
    return {
      unavailable: `the booking sheet could not be read: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
  return {
    unavailable:
      "no booking sheet configured: set availability.spreadsheetId in the profile and METIS_GOOGLE_CREDENTIALS"
  }
}

const reply = <A extends Record<string, unknown>>(result: A) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  structuredContent: result
})

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
  async ({ group, messages, now }) => {
    const at = now === undefined ? new Date() : new Date(now)
    const triaged = parseChat(messages, group).map((message) => triage(message, profile, at))
    // Read only when there is a dated lead to check: most sweeps find none.
    const dated = triaged.some((t) => t.verdict === "lead" && t.checkIn !== undefined)
    const source = dated ? await calendar(at) : undefined
    const results = source !== undefined && "calendar" in source ? withAvailability(triaged, source.calendar) : triaged
    const notes = source !== undefined && "unavailable" in source ? [source.unavailable] : []
    return reply({ unit: profile.name, results, markdown: report(results, profile, notes) })
  }
)

server.registerTool(
  "availability",
  {
    title: "Check availability",
    description: `Whether ${profile.name} can take a stay, from its booking sheet.`,
    inputSchema: {
      checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      when: z.string().optional(),
      now: z.string().datetime({ offset: true }).optional()
    }
  },
  async ({ checkIn, checkOut, now, when }) => {
    const at = now === undefined ? new Date() : new Date(now)
    // Words ("15 to 18 November", "this weekend") are read the way triage reads a lead's dates.
    const asked = checkIn !== undefined
      ? { checkIn, checkOut }
      : dates((when ?? "").toLowerCase(), todayIn(profile.timezone, at))
    if (asked.checkIn === undefined) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: "no dates to check: give checkIn, or say when" }]
      }
    }
    const source = await calendar(at)
    if ("unavailable" in source) {
      return { isError: true, content: [{ type: "text" as const, text: source.unavailable }] }
    }
    // Only an arrival given means one night.
    const out = asked.checkOut ??
      new Date(Date.parse(`${asked.checkIn}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const result = answer(source.calendar, asked.checkIn, out)
    const markdown = [
      `## ${profile.name}: ${asked.checkIn} to ${out}`,
      "",
      `**${result.verdict}**: ${result.detail}.`,
      ...(result.nextWindow !== undefined
        ? ["", `Next free window of the same length: ${result.nextWindow.checkIn} to ${result.nextWindow.checkOut}.`]
        : []),
      ""
    ].join("\n")
    return reply({ unit: profile.name, checkIn: asked.checkIn, checkOut: out, ...result, markdown })
  }
)

await server.connect(new StdioServerTransport())
