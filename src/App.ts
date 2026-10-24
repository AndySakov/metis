/**
 * The composition root: every service the HTTP API needs, assembled from real implementations.
 *
 * Until this existed, the loop only ever ran inside tests, each assembling its own stack. This is
 * the one assembly that runs for real, so three choices are made here and nowhere else:
 *
 * - **Tools are registered only if their server serves them.** Each MCP server is asked for its
 *   tool list at startup, and a descriptor is kept only when its server answers for its tool. The
 *   descriptors for the nine unbuilt capabilities therefore never reach the registry, and the
 *   planner, which plans against the registry, never targets them.
 * - **Claude answers `design.*` when, and only when, a key is configured.** Its descriptors are
 *   registered ahead of the templates, so the registry selects them; without a key `metis.model`
 *   is not started at all and the templates answer.
 * - **The live policy is `specs/policy/default.json`,** the same file the red-team suite measures.
 *
 * Building the layer starts nothing on its own. `Program.ts` launches it.
 */

import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

import { HttpApiBuilder } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { Config, Effect, Layer, Option, Redacted, Schema } from "effect"

import { PostgresConfig } from "./config/Config.js"
import { Policy } from "./domain/Policy.js"
import { ToolSpec } from "./domain/ToolSpec.js"
import { TrustPolicy } from "./domain/Trust.js"
import { ApiLive } from "./ingress/IntentApiLive.js"
import * as InMemoryArtifactStore from "./mneme/InMemoryArtifactStore.js"
import * as InMemoryEventLogStore from "./mneme/InMemoryEventLogStore.js"
import * as InMemoryPlanStore from "./mneme/InMemoryPlanStore.js"
import * as PostgresArtifactStore from "./mneme/PostgresArtifactStore.js"
import * as PostgresEventLogStore from "./mneme/PostgresEventLogStore.js"
import * as PostgresPlanStore from "./mneme/PostgresPlanStore.js"
import * as PlanExecution from "./orchestrator/PlanExecution.js"
import * as Planner from "./orchestrator/Planner.js"
import * as PolicyEngine from "./policy/PolicyEngine.js"
import * as PolicyGate from "./policy/PolicyGate.js"
import * as TrustLedger from "./policy/TrustLedger.js"
import { deriveFromLog, skillOf } from "./policy/TrustUpdater.js"
import * as Verification from "./policy/Verification.js"
import type { ServerMap } from "./tools/McpToolRunner.js"
import * as McpToolRunner from "./tools/McpToolRunner.js"
import * as ToolRegistry from "./tools/ToolRegistry.js"

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))

const SPECS = path("../specs/")
const SERVERS = path("./tools/servers/")

export interface AppConfig {
  readonly port: number
  /** Enables `metis.model`. Handed to that server's process and to no other. */
  readonly anthropicApiKey: Option.Option<Redacted.Redacted<string>>
  /**
   * Where `metis.model` sends requests, for a proxy or a local stand-in. Deliberately not read from
   * `ANTHROPIC_BASE_URL`: a shell that sets that variable for another Anthropic client would
   * otherwise redirect METIS's calls without anyone asking it to.
   */
  readonly anthropicBaseUrl: Option.Option<string>
  /** Postgres when `POSTGRES_DATABASE` is set, otherwise memory, which a restart empties. */
  readonly postgres: boolean
}

export const AppConfig: Config.Config<AppConfig> = Config.all({
  port: Config.port("METIS_PORT").pipe(Config.withDefault(8787)),
  anthropicApiKey: Config.option(Config.redacted("ANTHROPIC_API_KEY")),
  anthropicBaseUrl: Config.option(Config.string("METIS_ANTHROPIC_BASE_URL")),
  postgres: Config.option(Config.string("POSTGRES_DATABASE")).pipe(Config.map(Option.isSome))
})

/**
 * Thresholds a skill's two ledgers must clear for each gear (ADR-014). A skill with no history is
 * at S0, so every tool step asks for approval until the log shows it has earned more.
 */
export const TRUST_POLICY = Schema.decodeUnknownSync(TrustPolicy)({
  decay: { competenceHalfLifeSeconds: 30 * 86400, complianceHalfLifeSeconds: 14 * 86400 },
  thresholds: [
    { gear: "S1", minCompetence: 0.2, minCompliance: 0.2 },
    { gear: "S2", minCompetence: 0.5, minCompliance: 0.5 },
    { gear: "S3", minCompetence: 0.7, minCompliance: 0.8 },
    { gear: "S4", minCompetence: 0.8, minCompliance: 0.95 }
  ]
})

/** A share of executed actions is checked against its declared output schema (ADR-014 §4). */
const VERIFICATION_RATE = 0.25

export const livePolicy = (): Policy =>
  Schema.decodeUnknownSync(Policy)(JSON.parse(readFileSync(`${SPECS}policy/default.json`, "utf8")))

const node = (file: string) => ({
  command: process.execPath,
  args: ["--experimental-strip-types", `${SERVERS}${file}`]
})

export const serversFor = (config: AppConfig): ServerMap => ({
  ...(Option.isSome(config.anthropicApiKey)
    ? {
      "metis.model": {
        ...node("model.ts"),
        env: {
          ANTHROPIC_API_KEY: Redacted.value(config.anthropicApiKey.value),
          ...Option.match(config.anthropicBaseUrl, {
            onNone: () => ({}),
            onSome: (url) => ({ ANTHROPIC_BASE_URL: url })
          })
        }
      }
    }
    : {}),
  "metis.design": node("design.ts"),
  "metis.research": node("research.ts"),
  "metis.transform": node("transform.ts")
})

/** What each server actually serves, asked of the server itself rather than written down twice. */
const servedTools = (servers: ServerMap) =>
  Effect.forEach(Object.entries(servers), ([server, spawn]) =>
    Effect.acquireUseRelease(
      Effect.tryPromise(async () => {
        const client = new Client({ name: "metis-probe", version: "0.1.0" })
        await client.connect(
          new StdioClientTransport({
            command: spawn.command,
            args: [...spawn.args],
            env: { ...getDefaultEnvironment(), ...spawn.env }
          })
        )
        return client
      }),
      (client) =>
        Effect.tryPromise(() => client.listTools()).pipe(
          Effect.map(({ tools }) => tools.map((t) => `${server}/${t.name}`))
        ),
      (client) => Effect.promise(() => client.close().catch(() => {}))
    ).pipe(Effect.orDie)).pipe(Effect.map((lists) => new Set(lists.flat())))

/** Every descriptor whose server serves its tool, model-backed ones first. */
export const registrySpecs = (servers: ServerMap) =>
  Effect.gen(function*() {
    const served = yield* servedTools(servers)
    const dir = `${SPECS}tools/examples/`
    const specs = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => Schema.decodeUnknownSync(ToolSpec)(JSON.parse(readFileSync(`${dir}${file}`, "utf8"))))
      .filter((spec) => served.has(`${spec.mcp.server}/${spec.mcp.tool}`))
    return [
      ...specs.filter((spec) => spec.mcp.server === "metis.model"),
      ...specs.filter((spec) => spec.mcp.server !== "metis.model")
    ]
  })

const stores = (config: AppConfig) =>
  config.postgres
    ? Layer.mergeAll(PostgresEventLogStore.layer, PostgresArtifactStore.layer, PostgresPlanStore.layer).pipe(
      Layer.provide(
        PgClient.layerConfig({
          host: PostgresConfig.pipe(Config.map((c) => c.host)),
          port: PostgresConfig.pipe(Config.map((c) => c.port)),
          username: PostgresConfig.pipe(Config.map((c) => c.username)),
          password: PostgresConfig.pipe(Config.map((c) => c.password)),
          database: PostgresConfig.pipe(Config.map((c) => c.database))
        })
      )
    )
    : Layer.mergeAll(InMemoryEventLogStore.layer, InMemoryArtifactStore.layer, InMemoryPlanStore.layer)

/** Trust as the event log has it at startup, for every skill the registry can run. */
const trustFromLog = Layer.effect(
  TrustLedger.TrustLedger,
  Effect.gen(function*() {
    const registry = yield* ToolRegistry.ToolRegistry
    const skills = [...new Set((yield* registry.all).map((spec) => skillOf(spec.capability)))]
    const records = yield* Effect.forEach(skills, (skill) => deriveFromLog(skill, TRUST_POLICY))
    return TrustLedger.make(TRUST_POLICY, records.map((derived) => derived.record))
  })
)

const plannerFromRegistry = Layer.effect(
  Planner.Planner,
  Effect.gen(function*() {
    const capabilities = new Set((yield* (yield* ToolRegistry.ToolRegistry).all).map((spec) => spec.capability))
    return Planner.makeFor((capability) => capabilities.has(capability as never))
  })
)

/** Everything behind the API, without the HTTP listener. */
export const services = (config: AppConfig) => {
  const servers = serversFor(config)
  const tools = Layer.mergeAll(
    Layer.effect(
      ToolRegistry.ToolRegistry,
      Effect.flatMap(registrySpecs(servers), ToolRegistry.make).pipe(Effect.orDie)
    ),
    McpToolRunner.layer(servers)
  )
  const base = Layer.mergeAll(
    stores(config),
    tools,
    PolicyEngine.layer(livePolicy()),
    Verification.randomSampler(VERIFICATION_RATE)
  )
  const middle = Layer.mergeAll(PolicyGate.layer, trustFromLog, plannerFromRegistry).pipe(Layer.provideMerge(base))
  return PlanExecution.directLayer.pipe(Layer.provideMerge(middle))
}

const announce = (config: AppConfig) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const registry = yield* ToolRegistry.ToolRegistry
      const specs = yield* registry.all
      yield* Effect.log(`METIS listening on http://localhost:${config.port}`)
      yield* Effect.log(`storage: ${config.postgres ? "postgres" : "memory (a restart empties it)"}`)
      yield* Effect.log(
        Option.isSome(config.anthropicApiKey)
          ? "design.* answered by Claude (metis.model)"
          : "design.* answered by templates: set ANTHROPIC_API_KEY for Claude"
      )
      yield* Effect.log(`capabilities: ${[...new Set(specs.map((spec) => spec.capability))].sort().join(", ")}`)
    })
  )

/**
 * The HTTP API on `config.port`, over `backing`. Pass the same `backing` value to anything else that
 * needs the services, so both resolve to one build rather than two sets of stores.
 */
export const layer = (config: AppConfig, backing = services(config)) =>
  HttpApiBuilder.serve().pipe(
    Layer.provide(ApiLive),
    Layer.provide(backing),
    Layer.provide(NodeHttpServer.layer(createServer, { port: config.port })),
    Layer.merge(announce(config).pipe(Layer.provide(backing)))
  )

/** `layer`, configured from the environment. */
export const layerFromEnv = Layer.unwrapEffect(Effect.map(AppConfig, layer))
