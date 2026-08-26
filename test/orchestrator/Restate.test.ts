import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as restate from "@restatedev/restate-sdk"
import type { ChildProcess } from "node:child_process"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { Schema } from "effect"
import { Intent } from "../../src/domain/Intent.js"
import type { PlanStepId } from "../../src/domain/Plan.js"
import { Plan } from "../../src/domain/Plan.js"
import type { ExecutionReport } from "../../src/orchestrator/Executor.js"
import { planWorkflow } from "../../src/orchestrator/PlanWorkflow.js"

/**
 * Plan execution against a **real Restate server** (ADR-016).
 *
 * These are the claims that cannot be demonstrated without the durable engine: a gated step
 * genuinely *suspends* rather than returning, the workflow stays parked across time, and — the
 * property ADR-016 cares most about — execution is re-run on resume rather than its result being
 * restored from a checkpoint.
 *
 * The executor is stubbed deliberately. What is under test is the durability seam, not the
 * executor (which has its own end-to-end test over real MCP). Stubbing is what makes the crucial
 * assertion possible: counting how many times execution actually ran distinguishes a real resume
 * from a memoised answer.
 */

const RESTATE_BIN = resolve(__dirname, "../../node_modules/.bin/restate-server")

// Non-default ports so a developer's own Restate instance is not disturbed.
const INGRESS = 8_081
const ADMIN = 9_071
const NODE_PORT = 5_123
const SERVICE_PORT = 9_081

let server: ChildProcess | undefined
let dataDir: string | undefined

/** Every call to the stub, so a resume can be told apart from a cached result. */
const executions: Array<ReadonlyArray<string>> = []

const intent = Schema.decodeUnknownSync(Intent)({
  id: "01890a5d-ac96-774b-bcce-b302099a8057",
  ts: 1735872000,
  actor: "user:andysakov",
  goal: "Draft a PRD",
  autonomy: "S3"
})

const STEP = "01890a5d-ae11-7a01-8c02-3d4e5f607182" as PlanStepId

const plan = Schema.decodeUnknownSync(Plan)({
  id: "01890a5d-ae10-7c22-9b31-2f5a6d7e8f90",
  intentId: intent.id,
  createdAt: 1735872001,
  steps: [{ id: STEP, kind: "tool", description: "Draft the PRD", requiresApproval: true }]
})

const execute = async (
  _intent: Intent,
  _plan: Plan,
  approved: ReadonlyArray<PlanStepId>
): Promise<ExecutionReport> => {
  executions.push([...approved])
  const cleared = approved.includes(STEP)
  return {
    planId: plan.id,
    status: cleared ? "completed" : "awaiting_approval",
    steps: [{ stepId: STEP, status: cleared ? "completed" : "awaiting_approval" }],
    correlationId: "01890a5d-af1f-7d10-8b21-a2b3c4d5e6f7" as never
  }
}

const waitFor = async (check: () => Promise<boolean>, label: string, attempts = 120): Promise<void> => {
  for (let i = 0; i < attempts; i++) {
    if (await check().catch(() => false)) return
    await new Promise((done) => setTimeout(done, 500))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const restateAvailable = await (async () => {
  try {
    const { execFileSync } = await import("node:child_process")
    execFileSync(RESTATE_BIN, ["--version"], { stdio: "ignore", timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

if (!restateAvailable) {
  describe.skip("Restate durable execution (server binary unavailable)", () => {
    it("skipped", () => {})
  })
} else {
  describe("durable plan execution", () => {
    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), "metis-restate-"))

      server = spawn(RESTATE_BIN, [], {
        env: {
          ...process.env,
          RESTATE_BASE_DIR: dataDir,
          RESTATE_INGRESS__BIND_ADDRESS: `127.0.0.1:${INGRESS}`,
          RESTATE_ADMIN__BIND_ADDRESS: `127.0.0.1:${ADMIN}`,
          RESTATE_BIND_ADDRESS: `127.0.0.1:${NODE_PORT}`,
          // Without this the node advertises whatever address its hostname resolves to — on a
          // machine with a VPN interface that is an address it cannot reach, and it hangs forever
          // trying to join its own cluster. Pinning it to loopback is what makes this startable
          // on a developer laptop at all.
          RESTATE_ADVERTISED_ADDRESS: `http://127.0.0.1:${NODE_PORT}/`,
          RESTATE_NODE_NAME: "metis-test"
        },
        stdio: "ignore"
      })

      await waitFor(
        async () => (await fetch(`http://127.0.0.1:${ADMIN}/health`)).ok,
        "restate admin health"
      )

      // `listen` resolves to the bound port, not a server handle — there is nothing to close, so
      // the endpoint is torn down with the process.
      await restate.endpoint().bind(planWorkflow({ execute })).listen(SERVICE_PORT)

      // Register the service endpoint with the running server.
      await waitFor(async () => {
        const response = await fetch(`http://127.0.0.1:${ADMIN}/deployments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ uri: `http://127.0.0.1:${SERVICE_PORT}`, force: true })
        })
        return response.ok
      }, "deployment registration")
    }, 180_000)

    afterAll(async () => {
      server?.kill("SIGKILL")
      if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
    }, 60_000)

    it("suspends on an approval gate and resumes when it is granted", async () => {
      executions.length = 0
      const key = `run-${Date.now()}`

      // Submit asynchronously: a synchronous call would block, since the workflow is about to park.
      const submitted = await fetch(`http://127.0.0.1:${INGRESS}/plan/${key}/run/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, plan })
      })
      expect(submitted.ok, "workflow submitted").toBe(true)

      // It runs, finds the gate, and parks.
      await waitFor(async () => executions.length >= 1, "first execution")

      // Still suspended after a beat — it has not completed on its own.
      await new Promise((done) => setTimeout(done, 1_500))
      expect(executions.length, "must not proceed without approval").toBe(1)
      expect(executions[0]).toEqual([])

      // Grant the approval from outside the workflow.
      const approved = await fetch(`http://127.0.0.1:${INGRESS}/plan/${key}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: STEP, granted: true })
      })
      expect(approved.ok, "approval accepted").toBe(true)

      // Attach for the final result.
      const output = await fetch(`http://127.0.0.1:${INGRESS}/restate/workflow/plan/${key}/attach`, {
        method: "GET"
      })
      expect(output.ok).toBe(true)
      const report = await output.json() as ExecutionReport

      expect(report.status).toBe("completed")

      // The decisive assertion: execution ran a *second* time after the resume. If the workflow had
      // restored a checkpointed decision instead, this would still be 1 — and the policy
      // re-evaluation ADR-016 requires would silently not be happening.
      expect(executions.length, "must re-execute on resume, not restore a cached result").toBe(2)
      expect(executions[1]).toEqual([STEP])
    }, 180_000)

    it("a refused approval leaves the plan un-executed", async () => {
      executions.length = 0
      const key = `refused-${Date.now()}`

      await fetch(`http://127.0.0.1:${INGRESS}/plan/${key}/run/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, plan })
      })
      await waitFor(async () => executions.length >= 1, "first execution")

      await fetch(`http://127.0.0.1:${INGRESS}/plan/${key}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stepId: STEP, granted: false })
      })

      const output = await fetch(`http://127.0.0.1:${INGRESS}/restate/workflow/plan/${key}/attach`)
      const report = await output.json() as ExecutionReport

      expect(report.status).toBe("awaiting_approval")
      // Refusing must not run the step anyway.
      expect(executions.length).toBe(1)
    }, 180_000)
  })
}
