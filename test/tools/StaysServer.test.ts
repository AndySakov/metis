import { createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { ToolSpec } from "../../src/domain/ToolSpec.js"
import * as McpToolRunner from "../../src/tools/McpToolRunner.js"
import { ToolRunner } from "../../src/tools/ToolRunner.js"

/** `stays.triage` over real MCP: the paste goes in, the leads come out, against a unit profile. */

const descriptor = (file: string) =>
  Schema.decodeUnknownSync(ToolSpec)(
    JSON.parse(readFileSync(resolve(__dirname, `../../specs/tools/examples/${file}`), "utf8"))
  )
const spec = descriptor("stays.triage.tool.json")
const availabilitySpec = descriptor("stays.availability.tool.json")
const dir = mkdtempSync(join(tmpdir(), "metis-stays-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const call = (input: Record<string, unknown>, env?: Record<string, string>, tool = spec) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const runner = yield* ToolRunner
        return yield* Effect.either(runner.run(tool, input))
      })
    ).pipe(
      Effect.provide(McpToolRunner.layer({
        "metis.stays": {
          command: "node",
          args: ["--experimental-strip-types", resolve(__dirname, "../../src/tools/servers/stays.ts")],
          ...(env !== undefined ? { env } : {})
        }
      }))
    ) as Effect.Effect<any>
  )

const CHAT = [
  "[10/08/2026, 01:12:33] Wanjiru: Nahitaji keja ya one bedroom Westlands usiku wa leo",
  "[10/08/2026, 01:20:10] Host: 1 BEDROOM WESTLANDS ✅ Ksh7000/night 📞 0712345678",
  "[10/08/2026, 07:45:02] Brian: Any bnb 2 bedroom Kilimani this weekend?"
].join("\n")

describe("stays.triage", () => {
  it("finds the lead in a pasted export, against the example Westlands 1-bed", async () => {
    const outcome = await call({ messages: CHAT, group: "Nairobi Spaces", now: "2026-08-10T09:00:00+03:00" })
    expect(outcome._tag).toBe("Right")
    const { markdown, results, unit } = outcome.right.output
    expect(unit).toBe("Westlands 1-bed")
    expect(results.map((r: any) => [r.sender, r.verdict])).toEqual([
      ["Wanjiru", "lead"],
      ["Host", "noise"],
      ["Brian", "noise"]
    ])
    expect(results[0]).toMatchObject({ group: "Nairobi Spaces", checkIn: "2026-08-10", confidence: "high" })
    expect(markdown).toContain("## Leads for Westlands 1-bed (1)")
  }, 30_000)

  it("judges against the owner's own profile when one is configured", async () => {
    // A two-bedroom in Kilimani: Brian's request is now the lead, and Wanjiru's is still in range.
    const profile = JSON.parse(
      readFileSync(resolve(__dirname, "../../specs/stays/units/example-westlands-1br.json"), "utf8")
    )
    writeFileSync(
      join(dir, "kilimani-2br.json"),
      JSON.stringify({ ...profile, id: "kilimani-2br", name: "Kilimani 2-bed", bedrooms: 2 })
    )
    const outcome = await call(
      { messages: CHAT, now: "2026-08-10T09:00:00+03:00" },
      { METIS_STAYS_PROFILE: join(dir, "kilimani-2br.json") }
    )
    expect(outcome.right.output.results.map((r: any) => r.verdict)).toEqual(["lead", "noise", "lead"])
  }, 30_000)

  it("will not run against a malformed profile", async () => {
    writeFileSync(
      join(dir, "broken.json"),
      JSON.stringify({ id: "x", name: "X", timezone: "Mars/Olympus", bedrooms: 1, areas: {} })
    )
    const outcome = await call({ messages: CHAT }, { METIS_STAYS_PROFILE: join(dir, "broken.json") })
    expect(outcome._tag).toBe("Left")
  }, 30_000)
})

/** The availability vectors' sheet: open 10-13 Aug, hot 15-18, booked 20-25, data to 31 Aug. */
const SNAPSHOT =
  JSON.parse(readFileSync(resolve(__dirname, "../../specs/stays/conformance/availability.json"), "utf8")).snapshot
const NOW = "2026-08-09T09:00:00+03:00"
const LEADS = [
  "[09/08/2026, 08:00:00] Booked: Natafuta 1br Westlands tarehe 21 mpaka 23",
  "[09/08/2026, 08:01:00] Open: Anyone with a 1br in Westlands from the 10th, 2 nights?",
  "[09/08/2026, 08:02:00] Free: Need a 1 bedroom in Kilimani from the 27th, 2 nights"
].join("\n")

describe("availability from the booking sheet", () => {
  const snapshotFile = join(dir, "sheet.json")
  beforeAll(() => writeFileSync(snapshotFile, JSON.stringify(SNAPSHOT)))

  it("answers each dated lead, and puts the unsold slot first", async () => {
    const outcome = await call({ messages: LEADS, now: NOW }, { METIS_STAYS_AVAILABILITY_SNAPSHOT: snapshotFile })
    const verdicts = Object.fromEntries(
      outcome.right.output.results.map((r: any) => [r.sender, r.availability?.verdict])
    )
    expect(verdicts).toEqual({ Booked: "BOOKED", Open: "OPEN", Free: "FREE" })
    const markdown: string = outcome.right.output.markdown
    expect(markdown.indexOf("Open")).toBeLessThan(markdown.indexOf("Free"))
    expect(markdown.indexOf("Free")).toBeLessThan(markdown.indexOf("Booked"))
    expect(markdown).toContain(
      "Availability: BOOKED, clashes with 20 Aug-25 Aug (Airbnb); next free 2026-08-25 to 2026-08-27."
    )
  }, 30_000)

  it("says availability was not checked, and why, when there is no sheet", async () => {
    const outcome = await call({ messages: LEADS, now: NOW })
    expect(outcome.right.output.results.every((r: any) => r.availability === undefined)).toBe(true)
    expect(outcome.right.output.markdown).toContain("no booking sheet configured")
    expect(outcome.right.output.markdown).toContain("Availability: not checked.")
  }, 30_000)

  it("answers a stay asked in words, read in the unit's time zone", async () => {
    const outcome = await call(
      { when: "Is it free from 15 to 18 August?", now: NOW },
      { METIS_STAYS_AVAILABILITY_SNAPSHOT: snapshotFile },
      availabilitySpec
    )
    expect(outcome.right.output).toMatchObject({ checkIn: "2026-08-15", checkOut: "2026-08-18", verdict: "CONTESTED" })
    expect(outcome.right.output.markdown).toContain("**CONTESTED**")
  }, 30_000)

  it("refuses to answer without dates or without a sheet, rather than guessing", async () => {
    const env = { METIS_STAYS_AVAILABILITY_SNAPSHOT: snapshotFile }
    expect((await call({ when: "is it free?", now: NOW }, env, availabilitySpec))._tag).toBe("Left")
    expect((await call({ checkIn: "2026-08-03" }, undefined, availabilitySpec))._tag).toBe("Left")
  }, 30_000)
})

describe("reading the sheet from Google, as a read-only service account", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const seen: Array<{ path: string; query: URLSearchParams; auth?: string | undefined }> = []
  let shared = true
  const google = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://local")
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      if (url.pathname === "/token") {
        const assertion = new URLSearchParams(body).get("assertion") ?? ""
        const [header, claims, signature] = assertion.split(".")
        const valid = createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(
          publicKey,
          signature!,
          "base64url"
        )
        const scope = JSON.parse(Buffer.from(claims!, "base64url").toString()).scope
        if (!valid || scope !== "https://www.googleapis.com/auth/spreadsheets.readonly") {
          res.writeHead(401).end()
          return
        }
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "read-token" }))
        return
      }
      seen.push({ path: url.pathname, query: url.searchParams, auth: req.headers.authorization })
      if (!shared || req.headers.authorization !== "Bearer read-token") {
        res.writeHead(403).end()
        return
      }
      const listing = url.searchParams.get("fields") === "sheets(properties(title))"
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(
        listing
          ? {
            sheets: [...SNAPSHOT.sheets, { properties: { title: "January 2025" } }].map((s: any) => ({
              properties: s.properties
            }))
          }
          : SNAPSHOT
      ))
    })
  })
  let env: Record<string, string> = {}
  beforeAll(async () => {
    await new Promise<void>((done) => google.listen(0, "127.0.0.1", done))
    const at = `http://127.0.0.1:${(google.address() as AddressInfo).port}`
    writeFileSync(
      join(dir, "key.json"),
      JSON.stringify({
        client_email: "metis@example.iam.gserviceaccount.com",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        token_uri: `${at}/token`
      })
    )
    const profile = JSON.parse(
      readFileSync(resolve(__dirname, "../../specs/stays/units/example-westlands-1br.json"), "utf8")
    )
    writeFileSync(
      join(dir, "with-sheet.json"),
      JSON.stringify({ ...profile, availability: { spreadsheetId: "sheet-1808" } })
    )
    env = {
      METIS_STAYS_PROFILE: join(dir, "with-sheet.json"),
      METIS_GOOGLE_CREDENTIALS: join(dir, "key.json"),
      METIS_SHEETS_API: at
    }
  })
  afterAll(() => new Promise<void>((done) => google.close(() => done())))

  it("signs in, fetches only recent month tabs, and answers from their colours", async () => {
    seen.length = 0
    const outcome = await call({ messages: LEADS, now: NOW }, env)
    expect(outcome.right.output.results.map((r: any) => r.availability?.verdict)).toEqual(["BOOKED", "OPEN", "FREE"])

    expect(seen.every((r) => r.path === "/v4/spreadsheets/sheet-1808" && r.auth === "Bearer read-token")).toBe(true)
    const grid = seen.find((r) => r.query.get("includeGridData") === "true")!
    // From last month to six ahead: August, not June, May, January 2025 or the Summary tab.
    expect(grid.query.getAll("ranges")).toEqual(["'August 2026'!A1:L80"])
    expect(grid.query.get("fields")).toContain("effectiveFormat(backgroundColor)")
  }, 30_000)

  it("reports a sheet that is not shared with the account, instead of failing the sweep", async () => {
    shared = false
    try {
      const outcome = await call({ messages: LEADS, now: NOW }, env)
      expect(outcome._tag).toBe("Right")
      expect(outcome.right.output.markdown).toContain("not shared with metis@example.iam.gserviceaccount.com")
    } finally {
      shared = true
    }
  }, 30_000)
})
