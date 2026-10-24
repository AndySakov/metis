import { describe, expect, it } from "@effect/vitest"
import { Either, Schema } from "effect"

import * as Pointer from "../../src/domain/JsonPointer.js"
import { Plan } from "../../src/domain/Plan.js"

/**
 * Step-to-step bindings: the pointers they are written in, and the plans they are allowed in.
 *
 * A binding the executor could never resolve is rejected when the plan is decoded, at the API edge
 * and on the way out of storage, rather than discovered halfway through a run.
 */

describe("JSON Pointer", () => {
  const doc = { a: { "b/c": [10, { "~d": "x" }] }, e: null }

  it("reads keys, array indices and escaped tokens", () => {
    expect(Pointer.get(doc, "")).toBe(doc)
    expect(Pointer.get(doc, "/a/b~1c/0")).toBe(10)
    expect(Pointer.get(doc, "/a/b~1c/1/~0d")).toBe("x")
    expect(Pointer.get(doc, "/e")).toBeNull()
  })

  it("finds nothing where nothing is, including inherited properties", () => {
    expect(Pointer.get(doc, "/missing")).toBeUndefined()
    expect(Pointer.get(doc, "/a/b~1c/2")).toBeUndefined()
    expect(Pointer.get(doc, "/a/b~1c/01")).toBeUndefined()
    expect(Pointer.get(doc, "/e/x")).toBeUndefined()
    expect(Pointer.get({}, "/constructor")).toBeUndefined()
    expect(Pointer.get({}, "/__proto__")).toBeUndefined()
  })

  it("sets into a copy, never the original", () => {
    const input = { chunks: [{ source: "u" }] }
    const filled = Pointer.set(input, "/chunks/0/text", "page")
    expect(filled).toEqual({ chunks: [{ source: "u", text: "page" }] })
    expect(input).toEqual({ chunks: [{ source: "u" }] })
  })

  it("only sets where the parent exists, and never the prototype", () => {
    expect(Pointer.settable({ a: {} }, "/a/b")).toBe(true)
    expect(Pointer.settable({ list: [1] }, "/list/1")).toBe(true)
    expect(Pointer.settable({ list: [1] }, "/list/3")).toBe(false)
    expect(Pointer.settable({}, "/a/b")).toBe(false)
    expect(Pointer.settable({ a: "text" }, "/a/b")).toBe(false)
    expect(Pointer.settable({}, "/__proto__")).toBe(false)
    expect(Pointer.settable({}, "")).toBe(false)
  })

  it("rejects strings that are not pointers", () => {
    const decode = Schema.decodeUnknownEither(Pointer.JsonPointer)
    for (const valid of ["", "/", "/a", "/a~0b/~1"]) expect(Either.isRight(decode(valid)), valid).toBe(true)
    for (const invalid of ["a", "/a~2", "/~"]) expect(Either.isLeft(decode(invalid)), invalid).toBe(true)
  })
})

describe("a plan's bindings must be resolvable", () => {
  const FETCH = "01890a5d-ae21-7a01-8c02-3d4e5f607183"
  const SUMMARIZE = "01890a5d-ae22-7a01-8c02-3d4e5f607184"
  const ASK = "01890a5d-ae23-7a01-8c02-3d4e5f607185"

  const fetchStep = {
    id: FETCH,
    kind: "tool",
    description: "Fetch",
    toolCall: { capability: "research.fetch@0.1", input: { url: "https://example.com" } }
  }
  const summarize = (bindings: ReadonlyArray<unknown>, input: unknown = { chunks: [{ source: "u" }] }) => ({
    id: SUMMARIZE,
    kind: "tool",
    description: "Summarize",
    toolCall: { capability: "research.summarize@0.1", input, bindings }
  })
  const plan = (steps: ReadonlyArray<unknown>) =>
    Schema.decodeUnknownEither(Plan)({
      id: "01890a5d-ae20-7c22-9b31-2f5a6d7e8f91",
      intentId: "01890a5d-ac96-774b-bcce-b302099a8057",
      createdAt: 1735872001,
      steps
    })
  const binding = { to: "/chunks/0/text", fromStep: FETCH, from: "/text" }

  it("accepts a binding from an earlier tool step into an open place", () => {
    expect(Either.isRight(plan([fetchStep, summarize([binding])]))).toBe(true)
  })

  it("rejects a binding from a later step, or from itself", () => {
    expect(Either.isLeft(plan([summarize([binding]), fetchStep]))).toBe(true)
    expect(Either.isLeft(plan([fetchStep, summarize([{ ...binding, fromStep: SUMMARIZE }])]))).toBe(true)
  })

  it("rejects a binding from a step that runs no tool", () => {
    const ask = { id: ASK, kind: "ask", description: "Ask" }
    expect(Either.isLeft(plan([ask, summarize([{ ...binding, fromStep: ASK }])]))).toBe(true)
  })

  it("rejects a binding with nowhere to go, or onto a value the planner wrote", () => {
    expect(Either.isLeft(plan([fetchStep, summarize([{ ...binding, to: "/missing/text" }])]))).toBe(true)
    expect(Either.isLeft(plan([fetchStep, summarize([binding], { chunks: [{ source: "u", text: "mine" }] })])))
      .toBe(true)
  })

  it("rejects two bindings to the same place", () => {
    expect(Either.isLeft(plan([fetchStep, summarize([binding, { ...binding, from: "" }])]))).toBe(true)
  })
})
