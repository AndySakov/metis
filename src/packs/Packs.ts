/**
 * Loading packs: the domains METIS is extended with, each a directory holding a `pack.json`.
 *
 * Everything a pack declares is checked here, before anything of it runs, and a pack that fails a
 * check stops METIS rather than loading in part:
 *
 * - **A pack runs its own servers, and binds only them.** A descriptor naming a server the pack
 *   does not declare would let a pack attach capabilities to core's servers, or to another pack's.
 * - **No name is taken twice.** `metis.*` server names are core's, and the manifest schema refuses
 *   them; a name another pack already uses is refused here. Either way, the second definition
 *   would otherwise silently replace the first.
 * - **Its environment is what it names.** A server gets the variables its manifest lists, from
 *   METIS's environment, and no others, the same rule core's servers follow.
 * - **Model use is declared twice.** A server asks for completions only if its manifest says
 *   `"model": true`, and every tool on such a server declares the `model.sample` scope, so policy
 *   and the event log see model use on every call rather than discovering it inside one.
 *
 * What a pack cannot do from here is run code in the orchestrator. Its templates are data, compiled
 * by the planner; its code runs in the processes it declares, as any MCP server does.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { Context, Effect, Layer, Schema } from "effect"

import { Pack } from "../domain/Pack.js"
import type { ToolSpec } from "../domain/ToolSpec.js"
import type { Template } from "../orchestrator/Planner.js"
import { fromPack } from "../orchestrator/Planner.js"
import { readDescriptor } from "../tools/Descriptors.js"
import type { ServerMap } from "../tools/McpToolRunner.js"

/** The scope a tool declares when its server may ask the model for completions. */
export const MODEL_SCOPE = "model.sample"

export class PackError extends Schema.TaggedError<PackError>()("PackError", {
  pack: Schema.String,
  message: Schema.String
}) {}

export interface LoadedPack {
  /** The pack's directory, absolute. */
  readonly dir: string
  readonly manifest: Pack
  readonly servers: ServerMap
  /** Its descriptors, with their schemas resolved. */
  readonly tools: ReadonlyArray<ToolSpec>
  /** Its servers that may ask the model for completions. */
  readonly sampling: ReadonlyArray<string>
  readonly templates: ReadonlyArray<Template>
}

/** The packs this METIS was started with: read by the API, so a viewer can see what was added. */
export class Packs extends Context.Tag("packs/Packs")<Packs, ReadonlyArray<LoadedPack>>() {}

export const layer = (packs: ReadonlyArray<LoadedPack>) => Layer.succeed(Packs, packs)

/** How a server is started: `node` is this Node, and `${pack}` is the pack's directory. */
const spawnOf = (dir: string, server: Pack["servers"][string]) => ({
  command: server.command === "node" ? process.execPath : server.command,
  args: server.args.map((arg) => arg.replaceAll("${pack}", dir)),
  env: Object.fromEntries(
    server.env.flatMap((name) => {
      const value = process.env[name]
      if (value === undefined || value === "") return []
      return [[name, server.paths.includes(name) ? resolve(value) : value]]
    })
  )
})

/** The pack in `directory`, checked. */
export const load = (directory: string): Effect.Effect<LoadedPack, PackError> =>
  Effect.gen(function*() {
    const dir = resolve(directory)
    const fail = (message: string) => new PackError({ pack: dir, message })
    const file = resolve(dir, "pack.json")
    if (!existsSync(file)) return yield* fail("no pack.json in the directory")

    const manifest = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Pack)(JSON.parse(readFileSync(file, "utf8"))),
      catch: (cause) => fail(`pack.json is not a valid pack: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
    const servers = Object.fromEntries(
      Object.entries(manifest.servers).map(([name, server]) => [name, spawnOf(dir, server)])
    )
    const tools = yield* Effect.forEach(manifest.tools, (path) =>
      Effect.try({
        try: () => readDescriptor(resolve(dir, path)),
        catch: (cause) => fail(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }))
    const sampling = Object.entries(manifest.servers).flatMap(([name, server]) => server.model ? [name] : [])
    for (const tool of tools) {
      if (!(tool.mcp.server in servers)) {
        return yield* fail(
          `${tool.name} binds ${tool.mcp.server}, which this pack does not run: a pack binds only its own servers`
        )
      }
      if (sampling.includes(tool.mcp.server) && !tool.authScopes.includes(MODEL_SCOPE)) {
        return yield* fail(
          `${tool.name} runs on ${tool.mcp.server}, which may use the model, so it must declare the ${MODEL_SCOPE} scope`
        )
      }
    }
    return { dir, manifest, servers, tools, sampling, templates: manifest.templates.map(fromPack) }
  })

/** Every pack in `directories`, in order, refusing a pack or server name used twice. */
export const loadAll = (directories: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<LoadedPack>, PackError> =>
  Effect.gen(function*() {
    const packs = yield* Effect.forEach(directories, load)
    const owners = new Map<string, string>()
    const names = new Set<string>()
    for (const pack of packs) {
      if (names.has(pack.manifest.name)) {
        return yield* new PackError({ pack: pack.dir, message: `a pack named ${pack.manifest.name} is already loaded` })
      }
      names.add(pack.manifest.name)
      for (const server of Object.keys(pack.servers)) {
        const owner = owners.get(server)
        if (owner !== undefined) {
          return yield* new PackError({ pack: pack.dir, message: `server ${server} is already pack ${owner}'s` })
        }
        owners.set(server, pack.manifest.name)
      }
    }
    return packs
  })
