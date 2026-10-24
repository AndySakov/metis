/**
 * The composition root: every service the HTTP API needs, assembled from real implementations.
 *
 * Until this existed, the loop only ever ran inside tests, each assembling its own stack. This is
 * the one assembly that runs for real, so four choices are made here and nowhere else:
 *
 * - **Tools are registered only if their server serves them.** Each MCP server is asked for its
 *   tool list at startup, and a descriptor is kept only when its server answers for its tool. The
 *   descriptors for the eight unbuilt capabilities therefore never reach the registry, and the
 *   planner, which plans against the registry, never targets them.
 * - **A model answers `design.*` when, and only when, one is configured:** a model CLI
 *   (`METIS_MODEL_CLI`, such as `claude` on a Claude Code login) or an API key. Its descriptors are
 *   registered ahead of the templates, so the registry selects them; with neither, no model server
 *   is started and the templates answer.
 * - **Nothing is written to disk unless a workspace is configured.** `metis.build` is started only
 *   when `METIS_WORKSPACE` is set, and that directory is the only one it is told about.
 * - **The live policy is `specs/policy/default.json`,** the same file the red-team suite measures.
 *
 * Building the layer starts nothing on its own. `Program.ts` launches it.
 */

import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
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
import * as Console from "./ingress/Console.js"
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
import { ledgerFromLog, sweeper } from "./policy/TrustUpdater.js"
import * as Verification from "./policy/Verification.js"
import type { ServerMap } from "./tools/McpToolRunner.js"
import * as McpToolRunner from "./tools/McpToolRunner.js"
import * as ModelCli from "./tools/ModelCli.js"
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
  /**
   * Durable execution, when `RESTATE_INGRESS_URL` is set: plans run as Restate workflows served from
   * this process and survive a restart. Otherwise they run in-process, and every execute response
   * says `mode: "direct"`.
   */
  readonly restate: Option.Option<PlanExecution.RestateOptions>
  /**
   * Where `build.scaffold` may write, from `METIS_WORKSPACE`. Handed to `metis.build` alone, and
   * without it that server is not started, so nothing is planned that writes to disk.
   */
  readonly workspace: Option.Option<string>
  /**
   * A model CLI to answer `design.*` (`ModelCli.ts`), from `METIS_MODEL_CLI`: a preset such as
   * `claude`, which uses a Claude Code login instead of an API key, or a JSON array for a command
   * of your own. Run as `metis.model-cli` and preferred over `metis.model` when both are set.
   */
  readonly modelCli: Option.Option<ModelCliConfig>
}

export interface ModelCliConfig {
  readonly cli: string
  readonly model: Option.Option<string>
  /** Extra environment variables to hand the CLI, beyond the ones its preset names. */
  readonly env: ReadonlyArray<string>
}

export const AppConfig: Config.Config<AppConfig> = Config.all({
  port: Config.port("METIS_PORT").pipe(Config.withDefault(8787)),
  anthropicApiKey: Config.option(Config.redacted("ANTHROPIC_API_KEY")),
  anthropicBaseUrl: Config.option(Config.string("METIS_ANTHROPIC_BASE_URL")),
  postgres: Config.option(Config.string("POSTGRES_DATABASE")).pipe(Config.map(Option.isSome)),
  restate: Config.option(
    Config.all({
      ingressUrl: Config.string("RESTATE_INGRESS_URL"),
      adminUrl: Config.string("RESTATE_ADMIN_URL").pipe(Config.withDefault("http://127.0.0.1:9070")),
      endpointPort: Config.port("METIS_RESTATE_PORT").pipe(Config.withDefault(9080)),
      endpointUrl: Config.option(Config.string("METIS_RESTATE_ENDPOINT_URL")).pipe(
        Config.map(Option.getOrUndefined)
      )
    })
  ),
  workspace: Config.option(Config.string("METIS_WORKSPACE")),
  modelCli: Config.option(
    Config.all({
      cli: Config.string("METIS_MODEL_CLI"),
      model: Config.option(Config.string("METIS_MODEL_CLI_MODEL")),
      env: Config.string("METIS_MODEL_CLI_ENV").pipe(
        Config.withDefault(""),
        Config.map((names) => names.split(",").map((name) => name.trim()).filter((name) => name !== ""))
      )
    })
  )
})

/**
 * What a skill must show to hold each gear (ADR-014): a score in both ledgers, each resting on at
 * least `minSignals` signals. An approved, completed run adds about two signals to each ledger, so
 * S2 takes three such runs and S4 at least twenty. A signal counts half after one half-life of
 * `decay`, so evidence that is not renewed falls below the bar and the gear goes with it. A skill with no history is at S0, and
 * every tool step asks for approval until the log shows it has earned more.
 */
export const TRUST_POLICY = Schema.decodeUnknownSync(TrustPolicy)({
  decay: { competenceHalfLifeSeconds: 30 * 86400, complianceHalfLifeSeconds: 14 * 86400 },
  thresholds: [
    { gear: "S1", minCompetence: 0.2, minCompliance: 0.2, minSignals: 2 },
    { gear: "S2", minCompetence: 0.5, minCompliance: 0.5, minSignals: 5 },
    { gear: "S3", minCompetence: 0.7, minCompliance: 0.8, minSignals: 15 },
    { gear: "S4", minCompetence: 0.8, minCompliance: 0.95, minSignals: 40 }
  ]
})

/** How often gear changes earned by decay alone are written to the log. */
const TRUST_SWEEP_INTERVAL = "1 hour"

/** A share of executed actions is checked against its declared output schema (ADR-014 §4). */
const VERIFICATION_RATE = 0.25

export const livePolicy = (): Policy =>
  Schema.decodeUnknownSync(Policy)(JSON.parse(readFileSync(`${SPECS}policy/default.json`, "utf8")))

const node = (file: string) => ({
  command: process.execPath,
  args: ["--experimental-strip-types", `${SERVERS}${file}`]
})

/**
 * The CLI `config` names, or why it cannot be used. Checked at startup, so a typo stops METIS
 * rather than failing every design step later.
 */
export const modelCliOf = (config: ModelCliConfig): ModelCli.ModelCli | { readonly error: string } => {
  const cli = ModelCli.resolve(config.cli)
  if ("error" in cli) return cli
  if (cli.requiresModel && Option.isNone(config.model)) {
    return { error: `${cli.name} needs a model: set METIS_MODEL_CLI_MODEL` }
  }
  return cli
}

/** The CLI's own settings, and only the credentials it reads, taken from this process's environment. */
const cliEnvironment = (config: ModelCliConfig): Record<string, string> => {
  const cli = ModelCli.resolve(config.cli)
  const names = [...("error" in cli ? [] : cli.env), ...config.env]
  return {
    METIS_MODEL_CLI: config.cli,
    ...Option.match(config.model, { onNone: () => ({}), onSome: (model) => ({ METIS_MODEL_CLI_MODEL: model }) }),
    ...Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]))
  }
}

export const serversFor = (config: AppConfig): ServerMap => ({
  ...(Option.isSome(config.modelCli)
    ? { "metis.model-cli": { ...node("model.ts"), env: cliEnvironment(config.modelCli.value) } }
    : {}),
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
  ...(Option.isSome(config.workspace)
    ? { "metis.build": { ...node("build.ts"), env: { METIS_WORKSPACE: resolve(config.workspace.value) } } }
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

/** Model-backed servers in the order the registry prefers them: a configured CLI, then the API. */
const MODEL_SERVERS = ["metis.model-cli", "metis.model"]

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
      ...MODEL_SERVERS.flatMap((server) => specs.filter((spec) => spec.mcp.server === server)),
      ...specs.filter((spec) => !MODEL_SERVERS.includes(spec.mcp.server))
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
      Effect.gen(function*() {
        if (Option.isSome(config.modelCli)) {
          const cli = modelCliOf(config.modelCli.value)
          if ("error" in cli) return yield* Effect.dieMessage(cli.error)
        }
        return yield* Effect.orDie(Effect.flatMap(registrySpecs(servers), ToolRegistry.make))
      })
    ),
    McpToolRunner.layer(servers)
  )
  const base = Layer.mergeAll(
    stores(config),
    tools,
    PolicyEngine.layer(livePolicy()),
    Verification.randomSampler(VERIFICATION_RATE)
  )
  const middle = Layer.mergeAll(
    PolicyGate.layer,
    ledgerFromLog(TRUST_POLICY),
    sweeper(TRUST_POLICY, TRUST_SWEEP_INTERVAL),
    plannerFromRegistry
  ).pipe(
    Layer.provideMerge(base)
  )
  const execution = Option.match(config.restate, {
    onNone: () => PlanExecution.directLayer,
    onSome: (options) => PlanExecution.servedRestateLayer(options)
  })
  return execution.pipe(Layer.provideMerge(middle))
}

const announce = (config: AppConfig) =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const registry = yield* ToolRegistry.ToolRegistry
      const specs = yield* registry.all
      yield* Effect.log(`METIS listening on http://localhost:${config.port} (console at /)`)
      yield* Effect.log(`storage: ${config.postgres ? "postgres" : "memory (a restart empties it)"}`)
      yield* Effect.log(
        Option.match(config.restate, {
          onNone: () => "execution: direct (in-process, not durable): set RESTATE_INGRESS_URL for Restate",
          onSome: (options) => `execution: restate via ${options.ingressUrl} (durable)`
        })
      )
      if (Option.isSome(config.restate) && !config.postgres) {
        // Restate would resume the workflow after a restart, but the plans, artifacts and event log
        // it resumes against would be gone.
        yield* Effect.logWarning("restate without postgres: a run survives a restart, but its plan and record do not")
      }
      const cli = Option.map(config.modelCli, modelCliOf)
      if (Option.isSome(cli) && !("error" in cli.value)) {
        yield* Effect.log(`design.* answered by the ${cli.value.name} CLI (metis.model-cli)`)
        if (!ModelCli.toolless(cli.value.tools)) {
          // metis.model's guarantee is a model with no tools. This CLI does not give that.
          yield* Effect.logWarning(
            `${cli.value.name} keeps tools of its own: ${cli.value.toolsNote} Design inputs reach it, and they can quote the web.`
          )
        }
      } else {
        yield* Effect.log(
          Option.isSome(config.anthropicApiKey)
            ? "design.* answered by Claude (metis.model)"
            : "design.* answered by templates: set METIS_MODEL_CLI=claude to use a Claude Code login, or ANTHROPIC_API_KEY"
        )
      }
      yield* Effect.log(
        Option.match(config.workspace, {
          onNone: () => "build.scaffold off: set METIS_WORKSPACE to let METIS write projects",
          onSome: (dir) => `build.scaffold writes under ${resolve(dir)}`
        })
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
    Layer.provide(Console.layer),
    Layer.provide(ApiLive),
    Layer.provide(backing),
    Layer.provide(NodeHttpServer.layer(createServer, { port: config.port })),
    Layer.merge(announce(config).pipe(Layer.provide(backing)))
  )

/** `layer`, configured from the environment. */
export const layerFromEnv = Layer.unwrapEffect(Effect.map(AppConfig, layer))
