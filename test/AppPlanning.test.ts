import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ManagedRuntime, Option, Redacted } from "effect"

import * as App from "../src/App.js"

/**
 * A goal no template matches, planned by the model through the app as `pnpm start` builds it: the
 * planner reaches the model through METIS's own model server, the plan runs under policy, and a
 * structured result is stored like a document. The Messages API is a stand-in.
 */

const PASTE = "Write to amina@example.com or billing@example.org."
const requests: Array<Record<string, any>> = []
const api = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    const body = JSON.parse(raw)
    requests.push(body)
    const planning = String(body.system).startsWith("You are the planner of METIS")
    const text = planning
      ? JSON.stringify({
        steps: [{
          description: "Find every email address",
          capability: "transform.extract@0.1",
          input: { text: "{{pasted}}", pattern: "[\\w.]+@[\\w.]+\\.\\w+" }
        }]
      })
      : "# A document"
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({
      id: "msg_local",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }))
  })
})

const PORT = 8_087
const base = `http://127.0.0.1:${PORT}`
let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined

beforeAll(async () => {
  await new Promise<void>((done) => api.listen(0, "127.0.0.1", done))
  runtime = ManagedRuntime.make(App.layer({
    port: PORT,
    anthropicApiKey: Option.some(Redacted.make("test-key")),
    anthropicBaseUrl: Option.some(`http://127.0.0.1:${(api.address() as AddressInfo).port}`),
    postgres: false,
    restate: Option.none(),
    workspace: Option.none(),
    modelCli: Option.none(),
    packs: []
  }) as never)
  await runtime.runtime()
}, 60_000)

afterAll(async () => {
  await runtime?.dispose()
  await new Promise<void>((done) => api.close(() => done()))
}, 20_000)

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("a goal no template matches, with a model configured", () => {
  it("is planned by the model, runs, and keeps its structured result", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Pull every email address out of this",
      autonomy: "S2",
      inputs: [{ name: "pasted", value: PASTE, tags: ["untrusted", "pasted"] }]
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["transform.extract@0.1"])
    expect(plan.steps[0].toolCall.input.text).toBe(PASTE)
    expect(plan.risks.map((r: any) => r.description)).toContain(
      "Planned by the model from the goal: read the steps before approving them"
    )
    // The planner asked the model, and the paste was not in what it asked.
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0])).not.toContain("amina@example.com")

    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(done.status).toBe("completed")
    const content = await (await fetch(`${base}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(content).toMatch(/^```json\n/)
    expect(content).toContain("amina@example.com")
    expect(content).toContain("billing@example.org")
  }, 60_000)
})
