/**
 * `ToolRunner` over MCP (ADR-017).
 *
 * Connects to the server named in a ToolSpec's `mcp.server`, calls the named tool, and returns its
 * output. Connection details are deployment configuration and live here rather than in the
 * descriptor — the contract says *which* server logically, this says where to find it.
 *
 * Clients are cached per server and closed with the scope, so a plan calling three tools on one
 * server spawns one process rather than three.
 *
 * It also answers MCP sampling: a server asking its client for a completion. Only servers granted
 * it may ask (a pack's manifest says `"model": true`); the answer comes from the configured model
 * server's `complete` tool, so the asking server never holds a credential or a CLI; and one tool
 * call may ask only so many times, so a looping server cannot spend the user's model without limit.
 * How many it asked for is reported with the result, and so reaches the event log.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { CreateMessageRequest, CreateMessageResult } from "@modelcontextprotocol/sdk/types.js"
import { CreateMessageRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { Effect, Layer } from "effect"

import type { ToolSpec } from "../domain/ToolSpec.js"
import { ToolRunError, ToolRunner } from "./ToolRunner.js"

/** How to start each logical server. */
export interface ServerCommand {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /**
   * Variables added to the server's environment. A server otherwise gets only the MCP SDK's
   * minimal default environment, so a credential reaches exactly the servers it is listed for and
   * no other tool process can read it.
   */
  readonly env?: Readonly<Record<string, string>>
}

export type ServerMap = Readonly<Record<string, ServerCommand>>

/** Which servers may ask for a completion, and who answers. */
export interface Sampling {
  /** Servers allowed to ask. Any other server's request is refused. */
  readonly granted: ReadonlySet<string>
  /** The model server whose `complete` tool answers, or none when no model is configured. */
  readonly via: string | undefined
  /** How many completions one tool call may ask for. */
  readonly perCall: number
}

/** The most tokens a sampled completion may ask for: the model server's own ceiling. */
const MAX_SAMPLE_TOKENS = 16000

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

export const make = (servers: ServerMap, sampling?: Sampling) =>
  Effect.gen(function*() {
    const clients = new Map<string, Client>()
    /** Completions asked for by each server's current tool call. */
    const sampled = new Map<string, number>()

    /** A completion for `serverId`, from the model server, within its call's allowance. */
    const answer = async (serverId: string, request: CreateMessageRequest): Promise<CreateMessageResult> => {
      const used = sampled.get(serverId) ?? 0
      if (used >= sampling!.perCall) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${serverId} asked for more than ${sampling!.perCall} completions in one tool call`
        )
      }
      sampled.set(serverId, used + 1)
      const messages = request.params.messages.map((message) => {
        const blocks = Array.isArray(message.content) ? message.content : [message.content]
        if (blocks.some((block) => block.type !== "text")) {
          throw new McpError(ErrorCode.InvalidParams, "only text can be sampled")
        }
        return { role: message.role, text: blocks.map((block) => (block as { text: string }).text).join("\n") }
      })
      if (sampling!.via === undefined) {
        throw new McpError(
          ErrorCode.InternalError,
          "no model is configured: set METIS_MODEL_CLI or ANTHROPIC_API_KEY"
        )
      }
      const model = await Effect.runPromise(connect(sampling!.via))
      const result = await model.callTool(
        {
          name: "complete",
          arguments: {
            system: request.params.systemPrompt ?? "",
            messages,
            maxTokens: Math.min(request.params.maxTokens, MAX_SAMPLE_TOKENS)
          }
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS }
      )
      const text = (textOutput(result.content) as { markdown: string }).markdown
      if (result.isError === true) throw new McpError(ErrorCode.InternalError, text)
      return { model: sampling!.via, role: "assistant", content: { type: "text", text }, stopReason: "endTurn" }
    }

    const connect = (serverId: string): Effect.Effect<Client, ToolRunError> =>
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

        const granted = sampling?.granted.has(serverId) === true
        const client = new Client(
          { name: "metis", version: "0.1.0" },
          granted ? { capabilities: { sampling: {} } } : undefined
        )
        if (granted) client.setRequestHandler(CreateMessageRequestSchema, (request) => answer(serverId, request))
        yield* Effect.tryPromise({
          try: () =>
            client.connect(
              new StdioClientTransport({
                command: spawn.command,
                args: [...spawn.args],
                ...(spawn.env !== undefined ? { env: { ...getDefaultEnvironment(), ...spawn.env } } : {})
              })
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
          sampled.set(spec.mcp.server, 0)
          const startedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          const result = yield* Effect.tryPromise({
            try: () =>
              client.callTool({ name: spec.mcp.tool, arguments: input }, undefined, { timeout: CALL_TIMEOUT_MS }),
            catch: (cause) => new ToolRunError({ tool: spec.name, message: `call failed: ${String(cause)}` })
          })

          const finishedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)

          if (result.isError === true) {
            return yield* new ToolRunError({
              tool: spec.name,
              message: `tool reported an error: ${JSON.stringify(result.content)}`
            })
          }

          const samples = sampled.get(spec.mcp.server) ?? 0
          return {
            output: toOutput(result.content, result.structuredContent),
            durationMs: finishedAt - startedAt,
            ...(samples > 0 ? { samples } : {})
          }
        })
    })
  })

/**
 * How long one tool call may take. The MCP SDK's default is a minute, which a model writing a whole
 * document can exceed; a call cut off at a minute fails a step that was about to succeed. Tools with
 * their own limits (a model CLI stops at ten minutes) report those first.
 */
export const CALL_TIMEOUT_MS = 15 * 60 * 1000

export const layer = (servers: ServerMap, sampling?: Sampling) => Layer.scoped(ToolRunner, make(servers, sampling))
