import { createServer } from "node:http"
import { createRequire } from "node:module"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ManagedRuntime, Option } from "effect"

import * as App from "../../src/App.js"
import { CONTENT_SECURITY_POLICY } from "../../src/ingress/Console.js"

/**
 * The console at `/`, and the read-only endpoints it is built on, served the way `pnpm start`
 * serves them.
 *
 * The endpoints are tested over HTTP. The page itself is tested in a real browser when Playwright
 * is available, because the property that matters is behavioural: a document quoting hostile
 * markup must render as text, and only a browser can say whether something ran.
 */

const PORT = 8_099
const base = `http://127.0.0.1:${PORT}`

let runtime: ManagedRuntime.ManagedRuntime<unknown, unknown> | undefined

/** Stands in for Wikipedia and arXiv, so a PRD's search step never leaves the machine. */
const indexes = createServer((req, res) => {
  res.writeHead(200, {
    "content-type": (req.url ?? "").startsWith("/w/") ? "application/json" : "application/atom+xml"
  })
  res.end((req.url ?? "").startsWith("/w/") ? JSON.stringify({ query: { search: [] } }) : "<feed></feed>")
})
const savedEnv = { ...process.env }

beforeAll(async () => {
  await new Promise<void>((done) => indexes.listen(0, "127.0.0.1", done))
  const indexesAt = `http://127.0.0.1:${(indexes.address() as AddressInfo).port}`
  process.env.METIS_WIKIPEDIA_API = `${indexesAt}/w/api.php`
  process.env.METIS_ARXIV_API = `${indexesAt}/api/query`
  const config: App.AppConfig = {
    port: PORT,
    anthropicApiKey: Option.none(),
    anthropicBaseUrl: Option.none(),
    postgres: false,
    restate: Option.none(),
    workspace: Option.none(),
    modelCli: Option.none(),
    // The reference pack, so the page is tested showing what a pack adds.
    packs: [resolve(__dirname, "../../packs/redact")]
  }
  runtime = ManagedRuntime.make(App.layer(config) as never)
  await runtime.runtime()
}, 60_000)

afterAll(async () => {
  await runtime?.dispose()
  await new Promise<void>((done) => indexes.close(() => done()))
  process.env = savedEnv
}, 20_000)

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  })

/** Plans a goal, then runs it, approving whatever it stops for. */
const planAndRun = async (goal: string) => {
  const plan = await (await post("/intent", { actor: "user:console", goal, autonomy: "S2" })).json()
  await post(`/plans/${plan.id}/execute`, {})
  await post(`/plans/${plan.id}/execute`, { approvedSteps: plan.steps.map((s: any) => s.id) })
  return plan
}

describe("the console page", () => {
  it("is served at / with a policy that keeps its requests on METIS", async () => {
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/html")
    expect(response.headers.get("content-security-policy")).toBe(CONTENT_SECURITY_POLICY)
    expect(CONTENT_SECURITY_POLICY).toContain("connect-src 'self'")
    expect(await response.text()).toContain("<title>METIS Console</title>")
  })
})

describe("what the console reads", () => {
  it("lists the tools METIS will dispatch to, and only those", async () => {
    const tools = await (await fetch(`${base}/tools`)).json()
    const capabilities = tools.map((t: any) => t.capability)
    expect(capabilities).toContain("design.prd@1.0")
    // No workspace is configured, so nothing that writes to disk is registered.
    expect(capabilities).not.toContain("build.scaffold@0.1")
    // Each descriptor carries its capability's schemas, resolved at load, so sampled verification
    // checks an output against the real contract rather than against a bare `$ref`.
    const prd = tools.find((t: any) => t.capability === "design.prd@1.0")
    expect(prd.outputSchema.$ref).toBeUndefined()
    expect(prd.outputSchema.required).toContain("markdown")
  }, 30_000)

  it("reports every registered skill's gear, and moves it as trust is earned", async () => {
    const before = await (await fetch(`${base}/trust`)).json()
    expect(before.find((r: any) => r.skill === "design.api_spec")).toMatchObject({ gear: "S0", competenceSignals: 0 })

    await planAndRun("Write an API spec for a notes app")

    const after = await (await fetch(`${base}/trust`)).json()
    expect(after.find((r: any) => r.skill === "design.api_spec")).toMatchObject({ gear: "S1" })
  }, 60_000)

  it("narrows the event log to one plan, decisions and their reasons included", async () => {
    const plan = await planAndRun("Draft a PRD for a recipe box")
    const other = await planAndRun("C4 diagrams for a recipe box")

    const events = await (await fetch(`${base}/eventlog?planId=${plan.id}`)).json()
    const types = events.map((e: any) => e.type)
    for (const type of ["PLAN_CREATED", "POLICY_EVALUATED", "TRUST_GATE", "APPROVAL_GRANTED", "ARTIFACT_WRITTEN"]) {
      expect(types, type).toContain(type)
    }
    // Nothing from the other plan's runs.
    const otherIds = new Set(
      (await (await fetch(`${base}/eventlog?planId=${other.id}`)).json()).map((e: any) => e.id)
    )
    expect(events.some((e: any) => otherIds.has(e.id))).toBe(false)

    // `types` narrows further, given once or repeated.
    const one = await (await fetch(`${base}/eventlog?planId=${plan.id}&types=TRUST_GATE`)).json()
    expect(new Set(one.map((e: any) => e.type))).toEqual(new Set(["TRUST_GATE"]))
    const two = await (await fetch(`${base}/eventlog?planId=${plan.id}&types=TRUST_GATE&types=PLAN_FINISHED`)).json()
    expect(new Set(two.map((e: any) => e.type))).toEqual(new Set(["TRUST_GATE", "PLAN_FINISHED"]))
  }, 60_000)

  it("records the order things happened in, even within one millisecond", async () => {
    const plan = await planAndRun("Draft a PRD for a plant tracker")
    const types = (await (await fetch(`${base}/eventlog?planId=${plan.id}`)).json()).map((e: any) => e.type)
    const approved = types.lastIndexOf("APPROVAL_GRANTED")
    expect(approved).toBeGreaterThan(-1)
    expect(types.indexOf("TOOL_STARTED", approved), "dispatch follows the approval").toBeGreaterThan(approved)
  }, 60_000)
})

/**
 * Playwright is not a dependency of this repo. Where it is installed (with a browser), these tests
 * run; elsewhere, including CI, they skip.
 */
interface Page {
  goto(url: string): Promise<unknown>
  fill(selector: string, value: string): Promise<void>
  click(selector: string): Promise<void>
  waitForSelector(selector: string): Promise<unknown>
  textContent(selector: string): Promise<string | null>
  title(): Promise<string>
  $$eval<R>(selector: string, fn: (nodes: Array<Element>) => R): Promise<R>
  on(event: "pageerror", fn: (error: Error) => void): void
  on(event: "dialog", fn: (dialog: { dismiss(): Promise<void> }) => void): void
  close(): Promise<void>
}
interface Browser {
  newPage(): Promise<Page>
  close(): Promise<void>
}
/** Runs the plan on the page, approving if it asks: a skill that has earned its gear does not. */
const runOnPage = async (page: Page) => {
  await page.click("#run")
  // Each approval re-runs the plan, which may stop at the next step: approve until nothing waits.
  for (let round = 0; round < 5; round++) {
    await page.waitForSelector("#run:not([disabled])")
    await page.waitForSelector("#steps .badge.s-awaiting_approval, #steps .badge.s-completed")
    if ((await page.$$eval("#steps .badge.s-awaiting_approval", (n) => n.length)) === 0) break
    await page.click("#steps button.primary")
  }
  await page.waitForSelector("#output .doc")
}

const browser: Browser | undefined = await (async () => {
  try {
    const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: { launch(): Promise<Browser> } }
    return await chromium.launch()
  } catch {
    return undefined
  }
})()
afterAll(async () => {
  await browser?.close()
})

describe.skipIf(browser === undefined)("the console in a browser", () => {
  it("plans, asks, runs on approval, and shows the document", async () => {
    const page = await browser!.newPage()
    const errors: Array<string> = []
    page.on("pageerror", (e) => errors.push(String(e)))
    await page.goto(`${base}/`)
    await page.fill("#goal", "Write an API spec for a bike-sharing app")
    await page.click("#plan")
    // One approved run so far for this skill, short of S2, so it must ask.
    await page.click("#run")
    await page.waitForSelector("#steps .badge.s-awaiting_approval")
    await page.click("#steps button.primary")
    await page.waitForSelector("#output .doc")
    expect(await page.textContent("#output")).toContain("Bike-sharing app")
    expect(await page.$$eval("#steps .badge", (n) => n.map((b) => b.textContent))).toEqual(["completed"])
    expect(await page.textContent("#timeline")).toContain("Trust gate")
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it("offers a loaded pack's example, and runs it like anything of core's", async () => {
    const page = await browser!.newPage()
    await page.goto(`${base}/`)
    await page.waitForSelector("#examples .chip")
    await page.click("#examples .chip:has-text(\"Redact the personal details in this\")")
    expect(await page.$$eval("#pasted", (n) => (n[0] as HTMLTextAreaElement).value)).toContain("amina@example.com")
    await page.click("#plan")
    await runOnPage(page)

    const output = await page.textContent("#output")
    expect(output).toContain("Call Amina on [phone] or [email]")
    expect(output).not.toContain("amina@example.com")
    await page.close()
  }, 60_000)

  it("offers a loaded pack's example, and runs it like anything of core's", async () => {
    const page = await browser!.newPage()
    await page.goto(`${base}/`)
    await page.waitForSelector("#examples .chip")
    await page.click("#examples .chip:has-text(\"Redact the personal details in this\")")
    expect(await page.$$eval("#pasted", (n) => (n[0] as HTMLTextAreaElement).value)).toContain("amina@example.com")
    await page.click("#plan")
    await runOnPage(page)

    const output = await page.textContent("#output")
    expect(output).toContain("Call Amina on [phone] or [email]")
    expect(output).not.toContain("amina@example.com")
    await page.close()
  }, 60_000)

  it("renders hostile markup in a document as text", async () => {
    const page = await browser!.newPage()
    let dialogs = 0
    page.on("dialog", (d) => {
      dialogs++
      void d.dismiss()
    })
    await page.goto(`${base}/`)
    await page.fill(
      "#goal",
      "Draft a PRD for <img src=x onerror=\"document.title='pwned'\"> and [click](javascript:alert(1))"
    )
    await page.click("#plan")
    await runOnPage(page)

    expect(await page.textContent("#output")).toContain("<img src=x")
    expect(await page.$$eval("#output img", (n) => n.length)).toBe(0)
    expect(
      await page.$$eval("#output a", (n) => n.filter((a) => !/^https?:/.test(a.getAttribute("href") ?? "")).length)
    )
      .toBe(0)
    expect(await page.title()).toBe("METIS Console")
    expect(dialogs).toBe(0)
    await page.close()
  }, 60_000)
})
