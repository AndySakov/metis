/**
 * Reading a unit's booking sheet from Google Sheets, as a service account.
 *
 * Read-only by construction: the token asked for carries only the `spreadsheets.readonly` scope, so
 * nothing here could write to the sheet even if asked. The owner shares the sheet with the service
 * account's email and points `METIS_GOOGLE_CREDENTIALS` at its key file; the key reaches only the
 * `metis.stays` process.
 *
 * Only the month tabs near now are fetched, and only the two cell fields availability reads (the
 * value and the background colour), so a sheet with years of history stays a small request.
 */

import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"

import type { SheetSnapshot } from "./Availability.ts"

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly"

interface ServiceAccount {
  readonly client_email: string
  readonly private_key: string
  readonly token_uri?: string
}

const base64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url")

/** An access token for the service account, from a signed JWT (RFC 7523). */
const accessToken = async (account: ServiceAccount): Promise<string> => {
  const tokenUri = account.token_uri ?? "https://oauth2.googleapis.com/token"
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${
    base64url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 600 }))
  }`
  const signature = createSign("RSA-SHA256").update(unsigned).sign(account.private_key)
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${base64url(signature)}`
    }),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Google refused the service account (HTTP ${response.status})`)
  const body = await response.json() as { access_token?: string }
  if (body.access_token === undefined) throw new Error("Google returned no access token")
  return body.access_token
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]

/** Month tabs from last month to six months ahead: what a lead today can ask about. */
const wanted = (title: string, now: Date): boolean => {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(title.trim())
  const month = match === null ? -1 : MONTHS.indexOf(match[1]!.toLowerCase())
  if (month < 0) return false
  const offset = (Number(match![2]) - now.getUTCFullYear()) * 12 + month - now.getUTCMonth()
  return offset >= -1 && offset <= 6
}

/** The booking sheet, as availability reads it: recent month tabs, values and colours only. */
export const fetchSheet = async (
  spreadsheetId: string,
  credentialsPath: string,
  now = new Date()
): Promise<SheetSnapshot> => {
  const account = JSON.parse(readFileSync(credentialsPath, "utf8")) as ServiceAccount
  const token = await accessToken(account)
  const api = `${process.env.METIS_SHEETS_API ?? "https://sheets.googleapis.com"}/v4/spreadsheets/${
    encodeURIComponent(spreadsheetId)
  }`
  const get = async (query: URLSearchParams) => {
    const response = await fetch(`${api}?${query}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) {
      throw new Error(
        response.status === 403 || response.status === 404
          ? `the sheet is not shared with ${account.client_email} (HTTP ${response.status})`
          : `Google Sheets answered HTTP ${response.status}`
      )
    }
    return response.json() as Promise<SheetSnapshot>
  }

  const listing = await get(new URLSearchParams({ fields: "sheets(properties(title))" }))
  const tabs = (listing.sheets ?? []).map((s) => s.properties?.title ?? "").filter((t) => wanted(t, now))
  if (tabs.length === 0) return { sheets: [] }
  const query = new URLSearchParams({
    includeGridData: "true",
    fields: "sheets(properties(title),data(rowData(values(formattedValue,effectiveFormat(backgroundColor)))))"
  })
  // Quoted, since tab names have spaces; the bookings block sits at the top of each tab.
  for (const tab of tabs) query.append("ranges", `'${tab.replaceAll("'", "''")}'!A1:L80`)
  return get(query)
}
