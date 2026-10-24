import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ManagedRuntime, Option } from "effect"

import { redact } from "../../packs/redact/src/Redact.js"
import * as App from "../../src/App.js"

/**
 * The redact pack: its rules against their vectors, then the whole pack loaded into METIS the way
 * `METIS_PACKS` loads it, planned and run over HTTP like anything core does.
 */

const PACK = resolve(__dirname, "../../packs/redact")

const vectors = JSON.parse(readFileSync(resolve(PACK, "conformance/redact.json"), "utf8")) as {
  cases: Array<{ name: string; text: string; kinds?: Array<"email" | "card" | "phone" | "ip">; expect: unknown }>
}

describe("redaction conformance", () => {
  for (const vector of vectors.cases) {
    it(vector.name, () => {
      expect(redact(vector.text, vector.kinds)).toEqual(vector.expect)
    })
  }
})

const PORT = 8_093
const base = `http://127.0.0.1:${PORT}`
let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined

beforeAll(async () => {
  const config: App.AppConfig = {
    port: PORT,
    anthropicApiKey: Option.none(),
    anthropicBaseUrl: Option.none(),
    postgres: false,
    restate: Option.none(),
    workspace: Option.none(),
    modelCli: Option.none(),
    packs: [PACK]
  }
  runtime = ManagedRuntime.make(App.layer(config) as never)
  await runtime.runtime()
}, 60_000)

afterAll(async () => {
  await runtime?.dispose()
}, 20_000)

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

describe("the redact pack, loaded into METIS", () => {
  it("is listed, with what it adds and the example it offers", async () => {
    expect(await (await fetch(`${base}/packs`)).json()).toEqual([{
      name: "redact",
      version: "0.1.0",
      description: "Strips personal details from pasted text before it goes anywhere else.",
      capabilities: ["text.redact@0.1"],
      examples: [{
        goal: "Redact the personal details in this",
        pasted: "Call Amina on +254 712 345 678 or amina@example.com"
      }]
    }])
    const tools = await (await fetch(`${base}/tools`)).json()
    expect(tools.map((t: any) => t.capability)).toContain("text.redact@0.1")
  }, 30_000)

  it("plans its goal, runs under policy and the trust gate, and stores the result", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Redact the personal details in this",
      autonomy: "S2",
      inputs: [{ name: "pasted", value: "Mail amina@example.com or call 0712345678", tags: ["untrusted", "pasted"] }]
    })).json()
    expect(plan.steps.map((s: any) => s.toolCall?.capability)).toEqual(["text.redact@0.1"])

    // A skill with no history is at S0, so the trust gate asks before it runs.
    const first = await (await post(`/plans/${plan.id}/execute`, {})).json()
    expect(first.status).toBe("awaiting_approval")
    const done = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [plan.steps[0].id] })).json()
    expect(done.status).toBe("completed")
    const content = await (await fetch(`${base}/artifacts/${done.steps[0].artifactId}/content`)).text()
    expect(content).toContain("Mail [email] or call [phone]")

    // The paste's labels reached policy at dispatch, as they do for core's tools.
    const events = await (await fetch(`${base}/eventlog?planId=${plan.id}&types=POLICY_EVALUATED`)).json()
    const dispatch = events.find((e: any) => e.payload.at === "tool_dispatch")
    expect(dispatch.payload.tags).toEqual(["untrusted", "pasted"])
  }, 30_000)
})
