import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

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

let runtime: ManagedRuntime.ManagedRuntime<EventLogStore, unknown>

beforeAll(async () => {
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done))
  const config: App.AppConfig = {
    port: PORT,
    anthropicApiKey: Option.some(Redacted.make("test-key")),
    anthropicBaseUrl: Option.some(`http://127.0.0.1:${(api.address() as AddressInfo).port}`),
    postgres: false
  }
  // One `backing` value for both, so the test reads the very event log the server writes to.
  const backing = App.services(config)
  runtime = ManagedRuntime.make(Layer.merge(App.layer(config, backing), backing) as never)
  await runtime.runtime()
}, 60_000)

afterAll(async () => {
  await runtime?.dispose()
  await new Promise<void>((done) => api.close(() => done()))
}, 20_000)

const post = (path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("pnpm start", () => {
  it("plans only what can run, and says what it left out", async () => {
    const response = await post("/intent", {
      actor: "user:andysakov",
      goal: "Draft a PRD for offline-first notes",
      autonomy: "S2"
    })
    expect(response.status).toBe(201)
    const plan = await response.json()

    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["design.prd@1.0"])
    expect(plan.risks.map((r: any) => r.description).join("\n")).toContain("research.search@0.1")
  }, 30_000)

  it("asks rather than plans when nothing the goal needs is registered", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Research the state of the art in RAG",
      autonomy: "S2"
    })).json()
    expect(plan.steps.map((s: any) => s.kind)).toEqual(["ask"])
  }, 30_000)

  it("waits for approval on a skill with no history, then runs it through Claude", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Draft a PRD for offline-first notes",
      autonomy: "S2"
    })).json()
    const stepId = plan.steps[0].id

    // A skill with no history is at S0 on the ledger, so even an S2 run stops for a human.
    const first = await (await post(`/plans/${plan.id}/execute`, {})).json()
    expect(first).toMatchObject({ mode: "direct", status: "awaiting_approval" })

    requests.length = 0
    const approved = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [stepId] })).json()
    expect(approved).toMatchObject({ mode: "direct", status: "completed" })

    // The document comes back over HTTP, byte for byte what the model wrote.
    const artifactId = approved.steps[0].artifactId
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

  it("answers a missing plan with the 404 the spec declares", async () => {
    const response = await fetch(`http://127.0.0.1:${PORT}/plans/01890a5d-0000-7000-8000-000000000000`)
    expect(response.status).toBe(404)
  }, 30_000)
})
