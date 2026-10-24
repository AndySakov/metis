import type { ChildProcess } from "node:child_process"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ManagedRuntime, Option } from "effect"

import * as App from "../src/App.js"

/**
 * `pnpm start` with `RESTATE_INGRESS_URL` set, against a real Restate server.
 *
 * The plan runs as a Restate workflow served from METIS's own process: the execute request returns
 * before anything has run, the workflow parks on the approval, the approval arrives through the
 * same endpoint a direct run uses, and the outcome is read back from the event log. No model key is
 * set, so the design templates answer; what is under test is the durable path, not the document.
 */

const RESTATE_BIN = resolve(__dirname, "../node_modules/.bin/restate-server")

// Distinct from test/orchestrator/Restate.test.ts, so the two can run side by side.
const PORT = 8_095
const INGRESS = 8_282
const ADMIN = 9_272
const NODE_PORT = 5_323
const ENDPOINT = 9_283

const available = (() => {
  try {
    execFileSync(RESTATE_BIN, ["--version"], { stdio: "ignore", timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

let server: ChildProcess | undefined
let dataDir: string | undefined
let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined

const base = `http://127.0.0.1:${PORT}`
const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

/** Polls the execution record until it reaches `status`, since a durable run finishes on its own time. */
const executionReaching = async (planId: string, status: string) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${base}/plans/${planId}/execution`)
    if (response.ok) {
      const record = await response.json()
      if (record.status === status) return record
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error(`execution of ${planId} never reached ${status}`)
}

describe.skipIf(!available)("pnpm start on Restate", () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "metis-durable-"))
    server = spawn(RESTATE_BIN, [], {
      env: {
        ...process.env,
        RESTATE_BASE_DIR: dataDir,
        RESTATE_INGRESS__BIND_ADDRESS: `127.0.0.1:${INGRESS}`,
        RESTATE_ADMIN__BIND_ADDRESS: `127.0.0.1:${ADMIN}`,
        RESTATE_BIND_ADDRESS: `127.0.0.1:${NODE_PORT}`,
        RESTATE_ADVERTISED_ADDRESS: `http://127.0.0.1:${NODE_PORT}/`,
        RESTATE_NODE_NAME: "metis-durable-test"
      },
      stdio: "ignore"
    })

    const config: App.AppConfig = {
      port: PORT,
      anthropicApiKey: Option.none(),
      anthropicBaseUrl: Option.none(),
      postgres: false,
      restate: Option.some({
        ingressUrl: `http://127.0.0.1:${INGRESS}`,
        adminUrl: `http://127.0.0.1:${ADMIN}`,
        endpointPort: ENDPOINT
      }),
      workspace: Option.none()
    }
    // Building the layer registers the workflow, retrying until the Restate server is up.
    runtime = ManagedRuntime.make(App.layer(config) as never)
    await runtime.runtime()
  }, 120_000)

  afterAll(async () => {
    await runtime?.dispose()
    server?.kill()
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  }, 30_000)

  it("submits, parks on the approval, resumes when approved, and the document can be read", async () => {
    const plan = await (await post("/intent", {
      actor: "user:andysakov",
      goal: "Write an API spec for a notes app",
      autonomy: "S2"
    })).json()
    const stepId = plan.steps[0].id

    // Accepted, not run: the response returns before the workflow does anything.
    const submitted = await post(`/plans/${plan.id}/execute`, {})
    expect(submitted.status).toBe(202)
    expect(await submitted.json()).toMatchObject({ mode: "restate", status: "accepted" })

    // A skill with no history is at S0, so the workflow parks on its approval.
    await executionReaching(plan.id, "awaiting_approval")

    const approved = await (await post(`/plans/${plan.id}/execute`, { approvedSteps: [stepId] })).json()
    expect(approved).toMatchObject({ mode: "restate" })

    const done = await executionReaching(plan.id, "completed")
    const content = await fetch(`${base}/artifacts/${done.steps[0].artifactId}/content`)
    expect(content.status).toBe(200)
    expect(await content.text()).toMatch(/^# API: /)
  }, 120_000)
})
