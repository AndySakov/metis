import { Schema } from "effect"

import { Actor, Autonomy, EpochSeconds, LongText, TaggedValue, Uuid7 } from "./Common.js"

export const IntentId = Uuid7.pipe(Schema.brand("IntentId"))
export type IntentId = typeof IntentId.Type

/**
 * What a client POSTs to `/intent`.
 *
 * Carries no `id` and no `ts`: the server assigns both. ADR-005 makes the server authoritative for
 * persisted time, and a client-chosen identifier could not be trusted to be a time-sortable UUIDv7.
 */
export class IntentDraft extends Schema.Class<IntentDraft>("IntentDraft")({
  actor: Actor,
  goal: LongText,
  description: Schema.optional(LongText),
  inputs: Schema.optionalWith(Schema.Array(TaggedValue), { default: () => [] }),
  constraints: Schema.optionalWith(Schema.Array(TaggedValue), { default: () => [] }),
  /** Omitted means S0 — advise only. The fail-safe default is the one that cannot cause a side effect. */
  autonomy: Schema.optionalWith(Autonomy, { default: () => "S0" as const })
}) {}

/** A recorded intent, after the server has assigned identity and time. */
export class Intent extends Schema.Class<Intent>("Intent")({
  id: IntentId,
  ts: EpochSeconds,
  actor: Actor,
  goal: LongText,
  description: Schema.optional(LongText),
  inputs: Schema.optionalWith(Schema.Array(TaggedValue), { default: () => [] }),
  constraints: Schema.optionalWith(Schema.Array(TaggedValue), { default: () => [] }),
  autonomy: Autonomy
}) {}
