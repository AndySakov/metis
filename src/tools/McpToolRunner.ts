/**
 * `ToolRunner` over MCP (ADR-017).
 *
 * Connects to the server named in a ToolSpec's `mcp.server`, calls the named tool, and returns its
 * output. Connection details are deployment configuration and live here rather than in the
 * descriptor — the contract says *which* server logically, this says where to find it.
 *
 * Clients are cached per server and closed with the scope, so a plan calling three tools on one
 * server spawns one process rather than three.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Effect, Layer } from "effect"

import type { ToolSpec } from "../domain/ToolSpec.js"
import { ToolRunError, ToolRunner } from "./ToolRunner.js"

/** How to start each logical server. */
export interface ServerCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
}

export type ServerMap = Readonly<Record<string, ServerCommand>>

/**
 * The output of an MCP tool call.
 *
 * MCP carries two channels: `structuredContent`, which is the tool's actual typed result, and
 * `content`, a list of human-readable blocks. A capability declaring `{ edges: [...] }` or
 * `{ matches: [...] }` puts it in the structured channel, so that is preferred whenever present.
 *
 * Falling back to concatenated text under `markdown` is only right for the capabilities whose
 * declared output *is* markdown. Treating every tool that way — as an earlier version of this did
 * — silently discarded structured results and would have made sampled verification report a
 * missing required field for every non-markdown capability.
 */
const toOutput = (content: unknown, structured: unknown): unknown => {
  if (structured !== null && structured !== undefined && typeof structured === "object") {
    return structured
  }
  return textOutput(content)
}

const textOutput = (content: unknown): unknown => {
  if (!Array.isArray(content)) return {}
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      block !== null && typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    )
    .map((block) => block.text)
    .join("\n")
  return { markdown: text }
}

export const make = (servers: ServerMap) =>
  Effect.gen(function*() {
    const clients = new Map<string, Client>()

    const connect = (serverId: string) =>
      Effect.gen(function*() {
        const existing = clients.get(serverId)
        if (existing !== undefined) return existing

        const spawn = servers[serverId]
        if (spawn === undefined) {
          return yield* new ToolRunError({
            tool: serverId,
            message: `no connection configured for MCP server "${serverId}"`
          })
        }

        const client = new Client({ name: "metis", version: "0.1.0" })
        yield* Effect.tryPromise({
          try: () =>
            client.connect(
              new StdioClientTransport({ command: spawn.command, args: [...spawn.args] })
            ),
          catch: (cause) => new ToolRunError({ tool: serverId, message: `cannot start server: ${String(cause)}` })
        })

        clients.set(serverId, client)
        return client
      })

    // Closed when the layer's scope closes, so servers do not outlive the runtime that started them.
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const client of clients.values()) {
          await client.close().catch(() => {})
        }
        clients.clear()
      })
    )

    return ToolRunner.of({
      run: (spec: ToolSpec, input) =>
        Effect.gen(function*() {
          const client = yield* connect(spec.mcp.server)
          const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          const result = yield* Effect.tryPromise({
            try: () => client.callTool({ name: spec.mcp.tool, arguments: input }),
            catch: (cause) => new ToolRunError({ tool: spec.name, message: `call failed: ${String(cause)}` })
          })

          const finishedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          if (result.isError === true) {
            return yield* new ToolRunError({
              tool: spec.name,
              message: `tool reported an error: ${JSON.stringify(result.content)}`
            })
          }

          return {
            output: toOutput(result.content, result.structuredContent),
            durationMs: finishedAt - startedAt
          }
        })
    })
  })

export const layer = (servers: ServerMap) => Layer.scoped(ToolRunner, make(servers))
