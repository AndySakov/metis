#!/usr/bin/env node
/**
 * A test server that asks its client for completions: `ask` asks `times` times and reports what
 * came back, or the first refusal. Stands in for a pack server that uses the model.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

const server = new McpServer({ name: "asker.tools", version: "0.1.0" })

server.registerTool(
  "ask",
  { title: "Ask", description: "Ask for completions.", inputSchema: { times: z.number().int().positive() } },
  async ({ times }) => {
    const answers: Array<string> = []
    try {
      for (let i = 0; i < times; i++) {
        const result = await server.server.createMessage({
          systemPrompt: "Answer briefly.",
          messages: [{ role: "user", content: { type: "text", text: `question ${i + 1}` } }],
          maxTokens: 100
        })
        answers.push(result.content.type === "text" ? result.content.text : "(not text)")
      }
      const output = { answers }
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { isError: true, content: [{ type: "text" as const, text: `after ${answers.length}: ${message}` }] }
    }
  }
)

await server.connect(new StdioServerTransport())
