#!/usr/bin/env node
/**
 * An MCP server exposing the `design.*` capabilities.
 *
 * A real MCP server over stdio, not a stand-in: METIS's client speaks the protocol to it exactly as
 * it would to a third-party server, which is the point of ADR-017. If this were an in-process
 * function call the transport would never be exercised and the first genuine MCP server would find
 * all the integration bugs at once.
 *
 * The generation itself is a deterministic template. Producing good PRD text is a model's job and
 * belongs behind a capability, not inside the transport demo — what is being proved here is that a
 * capability id resolves to a server, the call crosses a process boundary, and the output comes
 * back in the shape the capability declares.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "metis.design", version: "1.0.0" })

server.registerTool(
  "prd",
  {
    title: "Draft a PRD",
    description: "Generate a product requirements document from a title and optional context.",
    inputSchema: {
      title: z.string().min(1),
      context: z.string().optional()
    }
  },
  ({ context, title }) => {
    const markdown = [
      `# ${title}`,
      "",
      "## Problem",
      context ?? "_Not specified._",
      "",
      "## Goals",
      "- State the outcome, not the implementation",
      "- Make success measurable",
      "",
      "## Non-goals",
      "- Anything that cannot be evaluated",
      "",
      "## Risks",
      "- Requirements drift once implementation starts",
      ""
    ].join("\n")

    return { content: [{ type: "text" as const, text: markdown }] }
  }
)

server.registerTool(
  "c4",
  {
    title: "Generate C4 diagrams",
    description: "Produce C4 context and container diagrams as Mermaid.",
    inputSchema: { title: z.string().min(1), description: z.string().optional() }
  },
  ({ description, title }) => ({
    content: [{
      type: "text" as const,
      text: [
        `# C4: ${title}`,
        "",
        description ?? "",
        "",
        "## Context",
        "```mermaid",
        "C4Context",
        `  title System Context for ${title}`,
        "  Person(user, \"User\")",
        `  System(sys, "${title}")`,
        "  Rel(user, sys, \"Uses\")",
        "```",
        ""
      ].join("\n")
    }]
  })
)

server.registerTool(
  "api_spec",
  {
    title: "Generate an API spec",
    description: "Produce an OpenAPI-shaped outline from endpoint descriptions.",
    inputSchema: {
      title: z.string().min(1),
      endpoints: z
        .array(z.object({ method: z.string(), path: z.string(), summary: z.string().optional() }))
        .optional()
    }
  },
  ({ endpoints, title }) => {
    const rows = (endpoints ?? []).map((e) => `| \`${e.method.toUpperCase()}\` | \`${e.path}\` | ${e.summary ?? ""} |`)
    return {
      content: [{
        type: "text" as const,
        text: [
          `# API: ${title}`,
          "",
          "| Method | Path | Summary |",
          "| ------ | ---- | ------- |",
          ...(rows.length > 0 ? rows : ["| — | — | _No endpoints supplied._ |"]),
          ""
        ].join("\n")
      }]
    }
  }
)

server.registerTool(
  "trade_study",
  {
    title: "Weighted trade study",
    description: "Score options against weighted criteria and recommend one.",
    inputSchema: {
      options: z.array(z.string()).optional(),
      criteria: z.array(z.string()).optional(),
      weights: z.record(z.string(), z.number()).optional()
    }
  },
  ({ criteria, options, weights }) => {
    const opts = options ?? []
    const crit = criteria ?? []
    const w = weights ?? {}

    // Deterministic scoring: a real study needs judgement per cell, and inventing numbers that
    // look considered would be worse than showing the structure and leaving the cells to a human.
    const header = `| Option | ${crit.join(" | ")} | Weighted total |`
    const divider = `| --- | ${crit.map(() => "---").join(" | ")} | --- |`
    const rows = opts.map((option) => {
      const total = crit.reduce((sum, c) => sum + (w[c] ?? 1), 0)
      return `| ${option} | ${crit.map((c) => String(w[c] ?? 1)).join(" | ")} | ${total} |`
    })

    return {
      content: [{
        type: "text" as const,
        text: [
          "# Trade study",
          "",
          opts.length > 0 && crit.length > 0 ? header : "_Supply options and criteria._",
          ...(opts.length > 0 && crit.length > 0 ? [divider, ...rows] : []),
          "",
          "## Sensitivity",
          "Weights are the input's; no judgement has been applied to individual cells.",
          ""
        ].join("\n")
      }]
    }
  }
)

await server.connect(new StdioServerTransport())
