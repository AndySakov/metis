/**
 * The console: one page at `/`, over the same API anything else would use.
 *
 * It is a client of the HTTP API and nothing more, so it can do nothing the API does not already
 * allow, and every decision it shows is read back from the event log rather than inferred. The
 * page is static and has no build step; it is read once when the layer is built.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { HttpApiBuilder, HttpServerResponse } from "@effect/platform"
import { Effect } from "effect"

/**
 * What the page may load. Scripts and styles are inline; the one outside script is Mermaid, for
 * diagrams; requests go only back to METIS. Artifacts quote web content, and the page renders them,
 * so this is the second line behind the page's own escaping.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join("; ")

export const page = (): string => readFileSync(fileURLToPath(new URL("./console.html", import.meta.url)), "utf8")

export const layer = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function*() {
    const html = page()
    yield* router.get(
      "/",
      Effect.succeed(
        HttpServerResponse.text(html, {
          contentType: "text/html; charset=utf-8",
          headers: { "content-security-policy": CONTENT_SECURITY_POLICY, "x-content-type-options": "nosniff" }
        })
      )
    )
  })
)
