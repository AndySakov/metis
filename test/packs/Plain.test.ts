import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ManagedRuntime, Option, Redacted } from "effect"

import { check, factsOf } from "../../packs/plain/src/Facts.js"
import * as App from "../../src/App.js"

/**
 * The plain pack: a model drafts, code checks. Its check against its vectors, then the pack loaded
 * into METIS with a model configured, where the pack's server reaches the model only through
 * METIS. The Messages API is a stand-in, so the drafts are fixed and the retry can be watched.
 */

const PACK = resolve(__dirname, "../../packs/plain")

const vectors = JSON.parse(readFileSync(resolve(PACK, "conformance/plain.json"), "utf8")) as {
  facts: Array<{ name: string; text: string; expect: Array<string> }>
  checks: Array<{ name: string; original: string; rewrite: string; expect: unknown }>
}

describe("the facts a rewrite must keep", () => {
  for (const vector of vectors.facts) {
    it(vector.name, () => expect(factsOf(vector.text)).toEqual(vector.expect))
  }
  for (const vector of vectors.checks) {
    it(vector.name, () => expect(check(vector.original, vector.rewrite)).toEqual(vector.expect))
  }
})

const ORIGINAL = "Pursuant to the agreement dated 2026-10-24, the outstanding balance of Ksh 1,250,000 shall be " +
  "remitted within 30 days."
/** Each request's drafts, in order: the first rounds the amount, the second keeps it. */
const DRAFTS = ["Pay about Ksh 1.25m within 30 days of 2026-10-24.", "Pay Ksh 1,250,000 within 30 days of 2026-10-24."]
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
      content: [{ type: "text", text: DRAFTS[Math.min(requests.length - 1, DRAFTS.length - 1)] }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 }
    }))
  })
})

const PORT = 8_089
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
    packs: [PACK]
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

describe("the plain pack, with a model configured", () => {
  it("drafts through METIS's model, catches the dropped fact, and retries once with it", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Rewrite this in plain English",
      autonomy: "S2",
      inputs: [{ name: "pasted", value: ORIGINAL, tags: ["untrusted", "pasted"] }]
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["text.plain@0.1"])

    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(done.status).toBe("completed")
    const content = await (await fetch(`${base}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(content).toContain("Pay Ksh 1,250,000 within 30 days of 2026-10-24.")
    expect(content).toContain("on the second attempt")

    // The pack's prompt reached the model with the paste as data, and the retry named what was dropped.
    expect(requests[0]!.system).toContain("You rewrite text in plain English")
    expect(requests[0]!.messages).toEqual([{ role: "user", content: `<text>\n${ORIGINAL}\n</text>` }])
    expect(requests[1]!.messages.at(-1).content).toContain(`"1,250,000"`)

    // Both completions are on the record, against the step that asked for them.
    const events = await (await fetch(`${base}/eventlog?planId=${plan.id}&types=TOOL_COMPLETED`)).json()
    expect(events.map((e: any) => e.payload.samples)).toEqual([2])
  }, 60_000)
})
