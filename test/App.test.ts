import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, ManagedRuntime, Option, Redacted } from "effect"

import * as App from "../src/App.js"
import { EventLogStore } from "../src/mneme/EventLogStore.js"

/**
 * The composition root, run the way `pnpm start` runs it, over real HTTP.
 *
 * Nothing is stubbed on METIS's side: the live policy, the probed registry, real MCP server
 * processes and the trust ledger are the ones the entrypoint builds. The only stand-in is the far
 * end of the Messages API, so `metis.model` makes real HTTP requests without spending money.
 */

const PORT = 8_097

const requests: Array<Record<string, any>> = []
const api = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    requests.push(JSON.parse(raw))
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id: "msg_local",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "# Offline-first notes\n\nA PRD." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }))
  })
})

/** Wikipedia and arXiv, as far as `research.search` can tell: one hit each. */
const indexes = createServer((req, res) => {
  if ((req.url ?? "").startsWith("/w/api.php")) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ query: { search: [{ title: "Note-taking", snippet: "Notes, kept" }] } }))
    return
  }
  res.writeHead(200, { "content-type": "application/atom+xml" })
  res.end(
    "<feed><entry><id>http://arxiv.org/abs/2401.00001v1</id><published>2024-01-01T00:00:00Z</published>" +
      "<title>Offline-first sync</title><summary>CRDTs for notes.</summary></entry></feed>"
  )
})
const savedEnv = { ...process.env }

let runtime: ManagedRuntime.ManagedRuntime<EventLogStore, unknown>
const workspace = mkdtempSync(join(tmpdir(), "metis-app-workspace-"))

beforeAll(async () => {
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done))
  await new Promise<void>((done) => indexes.listen(0, "127.0.0.1", done))
  const indexesAt = `http://127.0.0.1:${(indexes.address() as AddressInfo).port}`
  // Read by `serversFor`, so the search server asks the stand-in, never the real indexes.
  process.env.METIS_WIKIPEDIA_API = `${indexesAt}/w/api.php`
  process.env.METIS_ARXIV_API = `${indexesAt}/api/query`
  const config: App.AppConfig = {
    port: PORT,
    anthropicApiKey: Option.some(Redacted.make("test-key")),
    anthropicBaseUrl: Option.some(`http://127.0.0.1:${(api.address() as AddressInfo).port}`),
    postgres: false,
    restate: Option.none(),
    workspace: Option.some(workspace),
    modelCli: Option.none(),
    packs: []
  }
  // One `backing` value for both, so the test reads the very event log the server writes to.
  const backing = App.services(config)
  runtime = ManagedRuntime.make(Layer.merge(App.layer(config, backing), backing) as never)
  await runtime.runtime()
}, 60_000)

afterAll(async () => {
  await runtime?.dispose()
  await new Promise<void>((done) => api.close(() => done()))
  await new Promise<void>((done) => indexes.close(() => done()))
  process.env = savedEnv
  rmSync(workspace, { recursive: true, force: true })
}, 20_000)

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("pnpm start", () => {
  it("plans every step of a PRD now that search is real, and skips none", async () => {
    const response = await post("/intent", {
      actor: "user:andysakov",
      goal: "Draft a PRD for offline-first notes",
      autonomy: "S2"
    })
    expect(response.status).toBe(201)
    const plan = await response.json()

    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["research.search@0.1", "design.prd@1.0"])
    expect(plan.risks.map((r: any) => r.description).join("\n")).not.toContain("Skipped")
  }, 30_000)

  it("chains a fetch into a summary, binding what is fetched", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Summarize https://example.com/notes",
      autonomy: "S2"
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall.capability)).toEqual(["research.fetch@0.1", "research.summarize@0.1"])
    expect(plan.steps[1].toolCall.bindings).toEqual([{
      to: "/chunks/0/text",
      fromStep: plan.steps[0].id,
      from: "/text"
    }])

    // Served back as written, bindings included.
    const stored = await (await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}`)).json()
    expect(stored.steps[1].toolCall.bindings).toEqual(plan.steps[1].toolCall.bindings)
  }, 30_000)

  it("researches through the open indexes, and says which ones", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Research offline-first sync for notes apps",
      autonomy: "S2"
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["research.search@0.1"])

    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(done.status).toBe("completed")
    const sources = await (await fetch(`http://127.0.0.1:${PORT}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(sources).toContain("Searched Wikipedia and arXiv only")
    expect(sources).toContain("[Offline-first sync](https://arxiv.org/abs/2401.00001v1)")
  }, 30_000)

  it("waits for approval on a skill with no history, then runs it through Claude", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Draft a PRD for offline-first notes",
      autonomy: "S2"
    })).json()
    // A skill with no history is at S0 on the ledger, so even an S2 run stops for a human.
    const first = await (await post(`/plans/${plan.id}/execute`, {})).json()
    expect(first).toMatchObject({ mode: "direct", status: "awaiting_approval" })

    requests.length = 0
    const approved = await (await post(`/plans/${plan.id}/execute`, {
      approvedSteps: plan.steps.map((s: any) => s.id)
    })).json()
    expect(approved).toMatchObject({ mode: "direct", status: "completed" })

    // The document comes back over HTTP, byte for byte what the model wrote.
    const artifactId = approved.steps[1].artifactId
    const content = await fetch(`http://127.0.0.1:${PORT}/artifacts/${artifactId}/content`)
    expect(content.status).toBe(200)
    expect(await content.text()).toBe("# Offline-first notes\n\nA PRD.")
    const metadata = await (await fetch(`http://127.0.0.1:${PORT}/artifacts/${artifactId}`)).json()
    expect(metadata).toMatchObject({ id: artifactId, kind: "text" })

    expect(requests).toHaveLength(1)
    expect(requests[0]!.model).toBe("claude-opus-5-5")
    expect(requests[0]!.messages[0].content).toContain("Draft a PRD for offline-first notes")

    const events = await runtime.runPromise(Effect.flatMap(EventLogStore, (log) => Effect.orDie(log.read({}))))
    const written = events.filter((e) => e.type === "ARTIFACT_WRITTEN")
    expect(written.length).toBeGreaterThan(0)
  }, 60_000)

  it("earns autonomy from the event log as it runs: three approved runs, then S2 unattended", async () => {
    // A skill no other test touches, so its evidence starts at zero.
    const run = async (approve: boolean) => {
      const plan = await (await post("/intent", {
        actor: "user:andysakov",
        goal: "C4 diagrams for an offline-first notes app",
        autonomy: "S2"
      })).json()
      const first = await (await post(`/plans/${plan.id}/execute`, {})).json()
      if (!approve) return first.status
      expect(first.status, "a skill short of S2's evidence still asks").toBe("awaiting_approval")
      return (await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()).status
    }

    for (let i = 0; i < 3; i++) expect(await run(true)).toBe("completed")

    // Six signals in each ledger now, against S2's five: no approval asked, no restart needed.
    expect(await run(false)).toBe("completed")

    const events = await runtime.runPromise(Effect.flatMap(EventLogStore, (log) => Effect.orDie(log.read({}))))
    const promotions = events
      .filter((e) => e.type === "TRUST_PROMOTED")
      .map((e) => e.payload as { skill: string; from: string; to: string })
      .filter((p) => p.skill === "design.c4")
    expect(promotions.map((p) => `${p.from}->${p.to}`)).toEqual(["S0->S1", "S1->S2"])
  }, 120_000)

  it("reports a plan's latest run from the event log, whichever path ran it", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Write an API spec for a notes app",
      autonomy: "S2"
    })).json()

    // Never run: there is nothing to report yet.
    expect((await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}/execution`)).status).toBe(404)

    await post(`/plans/${plan.id}/execute`, {})
    const waiting = await (await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}/execution`)).json()
    expect(waiting).toMatchObject({ status: "awaiting_approval", steps: [{ status: "awaiting_approval" }] })

    await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })
    const done = await (await fetch(`http://127.0.0.1:${PORT}/plans/${plan.id}/execution`)).json()
    expect(done.status).toBe("completed")
    const content = await fetch(`http://127.0.0.1:${PORT}/artifacts/${done.steps[0].artifactId}/content`)
    expect(content.status).toBe(200)
  }, 60_000)

  it("scaffolds a project into the workspace, and asks first at any gear because it cannot be undone", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Scaffold a TypeScript project called notes-api",
      autonomy: "S4"
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall)).toEqual([
      { capability: "build.scaffold@0.1", input: { name: "notes-api", stack: "node-ts" } }
    ])

    // Even at S4: the tool is declared non-idempotent, and a replay would write twice.
    const first = await (await post(`/plans/${plan.id}/execute`, {})).json()
    expect(first.status).toBe("awaiting_approval")
    expect(existsSync(join(workspace, "notes-api"))).toBe(false)

    const approved = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(approved.status).toBe("completed")
    expect(JSON.parse(readFileSync(join(workspace, "notes-api", "package.json"), "utf8")).name).toBe("notes-api")

    const summary = await fetch(`http://127.0.0.1:${PORT}/artifacts/${approved.steps[0].artifactId}/content`)
    expect(await summary.text()).toContain("`package.json`")
  }, 60_000)

  it("starts no server that writes to disk unless a workspace is configured", () => {
    const base: App.AppConfig = {
      port: PORT,
      anthropicApiKey: Option.none(),
      anthropicBaseUrl: Option.none(),
      postgres: false,
      restate: Option.none(),
      workspace: Option.none(),
      modelCli: Option.none(),
      packs: []
    }
    expect(Object.keys(App.serversFor(base))).not.toContain("metis.build")
    // The workspace reaches that server alone, as an absolute path.
    const servers = App.serversFor({ ...base, workspace: Option.some("relative/ws") })
    expect(servers["metis.build"]!.env!.METIS_WORKSPACE).toBe(join(process.cwd(), "relative/ws"))
    for (const [name, spawn] of Object.entries(servers)) {
      if (name !== "metis.build") expect(spawn.env?.METIS_WORKSPACE, name).toBeUndefined()
    }
  })

  it("hands a model CLI its own settings and only the credentials its preset reads", () => {
    const base: App.AppConfig = {
      port: PORT,
      anthropicApiKey: Option.none(),
      anthropicBaseUrl: Option.none(),
      postgres: false,
      restate: Option.none(),
      workspace: Option.none(),
      modelCli: Option.none(),
      packs: []
    }
    expect(Object.keys(App.serversFor(base))).not.toContain("metis.model-cli")

    const saved = { ...process.env }
    process.env.OPENAI_API_KEY = "openai-secret"
    process.env.ANTHROPIC_API_KEY = "anthropic-secret"
    process.env.EXTRA_SETTING = "extra"
    try {
      const codex = App.serversFor({
        ...base,
        modelCli: Option.some({ cli: "codex", model: Option.some("gpt-5"), env: ["EXTRA_SETTING"] })
      })
      expect(codex["metis.model-cli"]!.env).toEqual({
        METIS_MODEL_CLI: "codex",
        METIS_MODEL_CLI_MODEL: "gpt-5",
        OPENAI_API_KEY: "openai-secret",
        EXTRA_SETTING: "extra"
      })
      // Given an API key, Claude Code would bill the API instead of the signed-in plan.
      const claude = App.serversFor({
        ...base,
        modelCli: Option.some({ cli: "claude", model: Option.none(), env: [] })
      })
      expect(claude["metis.model-cli"]!.env).toEqual({ METIS_MODEL_CLI: "claude" })
    } finally {
      process.env = saved
    }
  })

  it("will not start on a model CLI it cannot use", () => {
    expect(App.modelCliOf({ cli: "chatgpt", model: Option.none(), env: [] })).toHaveProperty("error")
    expect(App.modelCliOf({ cli: "ollama", model: Option.none(), env: [] })).toMatchObject({
      error: expect.stringContaining("METIS_MODEL_CLI_MODEL")
    })
    expect(App.modelCliOf({ cli: "ollama", model: Option.some("llama3.3"), env: [] })).toHaveProperty("name", "ollama")
  })

  it("triages a pasted group chat, and policy sees the paste as untrusted", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Any leads in this group chat?",
      autonomy: "S2",
      inputs: [{
        name: "pasted",
        value: "[10/08/2026, 01:12:33] Wanjiru: Anyone with a 1br in Westlands tonight?\n" +
          "[10/08/2026, 01:20:10] Host: 1 BEDROOM WESTLANDS ✅ Ksh7000/night",
        tags: ["untrusted", "pasted"]
      }]
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["stays.triage@0.1"])

    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(done.status).toBe("completed")
    const leads = await (await fetch(`http://127.0.0.1:${PORT}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(leads).toContain("(1)")
    expect(leads).toContain("Wanjiru")

    const events = await (await fetch(`http://127.0.0.1:${PORT}/eventlog?planId=${plan.id}&types=POLICY_EVALUATED`))
      .json()
    const dispatch = events.find((e: any) => e.payload.at === "tool_dispatch")
    expect(dispatch.payload.tags).toEqual(["untrusted", "pasted"])
  }, 30_000)

  it("drafts a reply to a pasted enquiry, in its language, and sends nothing", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Draft a reply to this enquiry",
      autonomy: "S2",
      inputs: [{
        name: "pasted",
        value: "Naomba 1 bedroom Westlands tarehe 15 mpaka 18",
        tags: ["untrusted", "pasted"]
      }]
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["stays.reply@0.1"])

    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    const reply = await (await fetch(`http://127.0.0.1:${PORT}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(reply).toContain("Habari! Nina 1-bedroom Westlands")
    expect(reply).toContain("Fill before sending: [nightly rate], [photos link].")
  }, 30_000)

  it("answers a missing plan with the 404 the spec declares", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/plans/01890a5d-0000-7000-8000-000000000000`)
    expect(response.status).toBe(404)
  }, 30_000)
})
