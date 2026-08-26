/**
 * PostgreSQL-backed `PlanStore`.
 *
 * Writes the normalised shape the schema already describes: `intent` and `intent_value`, then
 * `plan` with its steps, assumptions, risks and expected artifacts in their own tables. Storing
 * the plan as one jsonb blob would have been fewer lines and would have thrown away every
 * constraint in `migrations/0001_initial.sql` — the ordering guarantee on steps, the check that a
 * non-tool step carries no tool call, the foreign key back to the intent.
 */

// Subpath import: the `@effect/sql` barrel also loads SqlPersistedQueue, which reaches for an
// `@effect/experimental` subpath the installed version does not export.
import * as SqlClient from "@effect/sql/SqlClient"
import { Effect, Layer, Schema } from "effect"

import { EpochSecondsColumn } from "../db/Columns.js"
import { Actor, ArtifactKind, Autonomy, CapabilityId, LongText, TaggedValue } from "../domain/Common.js"
import type { IntentId } from "../domain/Intent.js"
import { Intent } from "../domain/Intent.js"
import type { PlanId } from "../domain/Plan.js"
import { ArtifactExpectation, Assumption, Plan, PlanStep, Risk, ToolCall } from "../domain/Plan.js"
import { PlanStore, PlanStoreError } from "./PlanStore.js"

const IntentRow = Schema.Struct({
  id: Schema.String,
  ts: EpochSecondsColumn,
  actor: Actor,
  goal: LongText,
  description: Schema.NullOr(LongText),
  autonomy: Autonomy
})

const IntentValueRow = Schema.Struct({
  role: Schema.Literal("input", "constraint"),
  name: Schema.NonEmptyTrimmedString,
  value: Schema.Unknown,
  tags: Schema.Array(Schema.NonEmptyTrimmedString)
})

const PlanRow = Schema.Struct({
  id: Schema.String,
  intent_id: Schema.String,
  created_at: EpochSecondsColumn
})

const StepRow = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("tool", "ask", "write", "decision"),
  description: LongText,
  requires_approval: Schema.Boolean,
  tool_capability: Schema.NullOr(CapabilityId),
  tool_name: Schema.NullOr(Schema.NonEmptyTrimmedString),
  tool_input: Schema.NullOr(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  tool_budget: Schema.NullOr(Schema.Unknown)
})

const NotedRow = Schema.Struct({
  id: Schema.String,
  description: LongText,
  tags: Schema.Array(Schema.NonEmptyTrimmedString)
})

const ExpectationRow = Schema.Struct({
  id: Schema.String,
  kind: ArtifactKind,
  description: LongText,
  tags: Schema.Array(Schema.NonEmptyTrimmedString)
})

const decode = <A, I>(schema: Schema.Schema<A, I>) => Schema.decodeUnknown(Schema.Array(schema))

export const make = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  const fail = (id: string) => (cause: unknown) => new PlanStoreError({ id, message: String(cause) })

  /**
   * A `text[]` parameter.
   *
   * `@effect/sql` has no array helper in this version, and building a Postgres array literal by
   * string concatenation would be an injection waiting for the first tag containing a comma or a
   * quote. Passing the values as a single bound jsonb parameter and unnesting them server-side
   * keeps the whole thing parameterised.
   */
  const textArray = (values: ReadonlyArray<string>) =>
    sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(values)}::jsonb))`

  return PlanStore.of({
    put: (intent, plan) =>
      sql.withTransaction(
        Effect.gen(function*() {
          yield* sql`
            INSERT INTO intent (id, ts, actor, goal, description, autonomy)
            VALUES (
              ${intent.id}, ${intent.ts}, ${intent.actor}, ${intent.goal},
              ${intent.description ?? null}, ${intent.autonomy}::autonomy
            )
            ON CONFLICT (id) DO NOTHING
          `

          // Ordinal preserves the caller's ordering, which a map would lose.
          for (const [ordinal, input] of intent.inputs.entries()) {
            yield* sql`
              INSERT INTO intent_value (intent_id, role, ordinal, name, value, tags)
              VALUES (${intent.id}, 'input', ${ordinal}, ${input.name},
                      ${JSON.stringify(input.value ?? null)}::jsonb, ${textArray(input.tags)})
              ON CONFLICT DO NOTHING
            `
          }
          for (const [ordinal, constraint] of intent.constraints.entries()) {
            yield* sql`
              INSERT INTO intent_value (intent_id, role, ordinal, name, value, tags)
              VALUES (${intent.id}, 'constraint', ${ordinal}, ${constraint.name},
                      ${JSON.stringify(constraint.value ?? null)}::jsonb, ${textArray(constraint.tags)})
              ON CONFLICT DO NOTHING
            `
          }

          yield* sql`
            INSERT INTO plan (id, intent_id, created_at)
            VALUES (${plan.id}, ${plan.intentId}, ${plan.createdAt})
            ON CONFLICT (id) DO NOTHING
          `

          for (const [ordinal, step] of plan.steps.entries()) {
            yield* sql`
              INSERT INTO plan_step (
                id, plan_id, ordinal, kind, description, requires_approval,
                tool_capability, tool_name, tool_input, tool_budget
              )
              VALUES (
                ${step.id}, ${plan.id}, ${ordinal}, ${step.kind}::plan_step_kind,
                ${step.description}, ${step.requiresApproval},
                ${step.toolCall?.capability ?? null},
                ${step.toolCall?.tool ?? null},
                ${step.toolCall === undefined ? null : JSON.stringify(step.toolCall.input)}::jsonb,
                ${step.toolCall?.budget === undefined ? null : JSON.stringify(step.toolCall.budget)}::jsonb
              )
              ON CONFLICT (id) DO NOTHING
            `
          }

          for (const [ordinal, assumption] of plan.assumptions.entries()) {
            yield* sql`
              INSERT INTO plan_assumption (id, plan_id, ordinal, description, tags)
              VALUES (${assumption.id}, ${plan.id}, ${ordinal}, ${assumption.description},
                      ${textArray(assumption.tags)})
              ON CONFLICT (id) DO NOTHING
            `
          }
          for (const [ordinal, risk] of plan.risks.entries()) {
            yield* sql`
              INSERT INTO plan_risk (id, plan_id, ordinal, description, tags)
              VALUES (${risk.id}, ${plan.id}, ${ordinal}, ${risk.description}, ${textArray(risk.tags)})
              ON CONFLICT (id) DO NOTHING
            `
          }
          for (const [ordinal, expectation] of plan.expectedArtifacts.entries()) {
            yield* sql`
              INSERT INTO plan_artifact_expectation (id, plan_id, ordinal, kind, description, tags)
              VALUES (${expectation.id}, ${plan.id}, ${ordinal}, ${expectation.kind}::artifact_kind,
                      ${expectation.description}, ${textArray(expectation.tags)})
              ON CONFLICT (id) DO NOTHING
            `
          }

          for (const artifactId of plan.artifacts) {
            yield* sql`
              INSERT INTO plan_artifact (plan_id, artifact_id) VALUES (${plan.id}, ${artifactId})
              ON CONFLICT DO NOTHING
            `
          }
        })
      ).pipe(Effect.catchAll((cause) => Effect.fail(fail(plan.id)(cause)))),

    getPlan: (id) =>
      Effect.gen(function*() {
        const planRows = yield* decode(PlanRow)(
          yield* sql`SELECT id, intent_id, created_at FROM plan WHERE id = ${id}`
        )
        const row = planRows[0]
        if (row === undefined) return undefined

        // Ordered by ordinal, not by id: the plan's step sequence is the caller's, and relying on
        // identifier order would only work by accident.
        const steps = yield* decode(StepRow)(
          yield* sql`
            SELECT id, kind, description, requires_approval, tool_capability, tool_name, tool_input, tool_budget
            FROM plan_step WHERE plan_id = ${id} ORDER BY ordinal ASC
          `
        )
        const assumptions = yield* decode(NotedRow)(
          yield* sql`SELECT id, description, tags FROM plan_assumption WHERE plan_id = ${id} ORDER BY ordinal ASC`
        )
        const risks = yield* decode(NotedRow)(
          yield* sql`SELECT id, description, tags FROM plan_risk WHERE plan_id = ${id} ORDER BY ordinal ASC`
        )
        const expectations = yield* decode(ExpectationRow)(
          yield* sql`
            SELECT id, kind, description, tags FROM plan_artifact_expectation
            WHERE plan_id = ${id} ORDER BY ordinal ASC
          `
        )
        const artifactRows = yield* sql`
          SELECT artifact_id FROM plan_artifact WHERE plan_id = ${id} ORDER BY artifact_id ASC
        `

        return new Plan({
          id: row.id as PlanId,
          intentId: row.intent_id as IntentId,
          createdAt: row.created_at,
          steps: steps.map((step) =>
            new PlanStep({
              id: step.id as PlanStep["id"],
              kind: step.kind,
              description: step.description,
              requiresApproval: step.requires_approval,
              ...(step.tool_capability !== null
                ? {
                  toolCall: new ToolCall({
                    capability: step.tool_capability,
                    input: step.tool_input ?? {},
                    ...(step.tool_name !== null ? { tool: step.tool_name } : {})
                  })
                }
                : {})
            })
          ) as unknown as Plan["steps"],
          assumptions: assumptions.map((a) =>
            new Assumption({ id: a.id as Assumption["id"], description: a.description, tags: a.tags })
          ),
          risks: risks.map((r) => new Risk({ id: r.id as Risk["id"], description: r.description, tags: r.tags })),
          expectedArtifacts: expectations.map((e) =>
            new ArtifactExpectation({
              id: e.id as ArtifactExpectation["id"],
              kind: e.kind,
              description: e.description,
              tags: e.tags
            })
          ),
          artifacts: artifactRows.map((a) =>
            String((a as { artifact_id: unknown }).artifact_id)
          ) as unknown as Plan["artifacts"]
        })
      }).pipe(Effect.catchAll((cause) => Effect.fail(fail(id)(cause)))),

    getIntent: (id) =>
      Effect.gen(function*() {
        const rows = yield* decode(IntentRow)(
          yield* sql`SELECT id, ts, actor, goal, description, autonomy FROM intent WHERE id = ${id}`
        )
        const row = rows[0]
        if (row === undefined) return undefined

        const values = yield* decode(IntentValueRow)(
          yield* sql`
            SELECT role, name, value, tags FROM intent_value
            WHERE intent_id = ${id} ORDER BY role ASC, ordinal ASC
          `
        )

        const pick = (role: "input" | "constraint") =>
          values
            .filter((v) => v.role === role)
            .map((v) => new TaggedValue({ name: v.name, value: v.value, tags: v.tags }))

        return new Intent({
          id: row.id as IntentId,
          ts: row.ts,
          actor: row.actor,
          goal: row.goal,
          autonomy: row.autonomy,
          inputs: pick("input"),
          constraints: pick("constraint"),
          ...(row.description !== null ? { description: row.description } : {})
        })
      }).pipe(Effect.catchAll((cause) => Effect.fail(fail(id)(cause))))
  })
})

export const layer = Layer.effect(PlanStore, make)
