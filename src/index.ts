
export * as Program from "./Program.js"

/**
 * PostgreSQL connection settings (ADR-018).
 *
 * Read from `POSTGRES_*` environment variables. Replaces the `GEL_*` configuration that Gel's
 * discontinuation retired.
 */
export * as Config from "./config/Config.js"

/**
 * Column codecs for reading PostgreSQL rows into domain types.
 *
 * These exist because the wire representation of a column is not always the representation the
 * domain uses, and pretending otherwise produces bugs that only appear against a real database.
 */
export * as Columns from "./db/Columns.js"

/**
 * Plain numbered SQL migrations with a simple runner (ADR-018).
 *
 * No migration DSL. A system meant to run for years wants migrations that are readable in ten
 * years without a tool that may not exist by then, so the files are SQL and this only sequences
 * them.
 *
 * Two properties matter. Each file applies inside one transaction, so a failure leaves nothing
 * half-applied. And the checksum of every applied file is recorded and re-verified, so editing a
 * migration that already ran is an error rather than a silent divergence between what the
 * database contains and what the repository claims it contains.
 */
export * as Migrator from "./db/Migrator.js"

/**
 * `pnpm migrate` — apply any migrations the database has not seen yet.
 *
 * Safe to run repeatedly: already-applied migrations are skipped, and one whose file changed after
 * it was applied fails loudly rather than being silently re-run or ignored.
 */
export * as migrate from "./db/migrate.js"

/**
 * A typed link back to what an artifact came from (ADR-001).
 *
 * The relation vocabulary stays open — known values are `derives_from`, `produced_by`,
 * `justified_by`, `in_project` — but the shape is fixed, because an untyped blob here would make
 * the provenance rules unimplementable.
 */
export * as Artifact from "./domain/Artifact.js"

/**
 * A UUIDv7 in canonical lowercase hex form.
 *
 * The version nibble is pinned to 7 and the variant nibble to 8/9/a/b, so a UUIDv4 does not
 * decode. `Schema.UUID` would accept one, which is why it is not used here: ADR-005 wants
 * identifiers that sort lexicographically by creation time, and v4 defeats exactly that.
 */
export * as Common from "./domain/Common.js"

/**
 * Ties every event produced by one request or run together. ADR-009 requires errors to carry the
 * same correlationId as the work that failed.
 */
export * as Event from "./domain/Event.js"

/**
 * UUIDv7 generation.
 *
 * Node has `randomUUID()` but it emits v4, which ADR-005 forbids — the whole reason for the
 * convention is that identifiers sort by creation time, and v4 is random throughout. So this
 * implements RFC 9562 §5.7 directly. It is the application-side counterpart to the `uuidv7()`
 * function in `migrations/0001_initial.sql`; both must produce identifiers the `uuid_v7` domain
 * accepts, which the tests check against real generated values rather than by inspection.
 */
export * as Ids from "./domain/Ids.js"

/**
 * What a client POSTs to `/intent`.
 *
 * Carries no `id` and no `ts`: the server assigns both. ADR-005 makes the server authoritative for
 * persisted time, and a client-chosen identifier could not be trusted to be a time-sortable UUIDv7.
 */
export * as Intent from "./domain/Intent.js"

/**
 * The plan a request turns into: an ordered list of steps, plus what the planner assumed, what it
 * thinks could go wrong, and what it expects to produce.
 */
export * as Plan from "./domain/Plan.js"

/**
 * Policy rules and the decisions they produce (ADR-008, ADR-014).
 *
 * The load-bearing design choice here is that a decision always records **why** — either the rule
 * that matched, or an explicit marker saying nothing did. ADR-014 makes that field required rather
 * than optional, because an action that passed with no rule engaged is otherwise indistinguishable
 * from one that was deliberately permitted, and the difference is the entire coverage measurement.
 */
export * as Policy from "./domain/Policy.js"

/**
 * The MCP binding (ADR-017).
 *
 * Names the server logically and the tool within it. Connection details — command line, URL,
 * credentials — are deployment configuration, not contract, and deliberately do not appear.
 */
export * as ToolSpec from "./domain/ToolSpec.js"

/**
 * The two-ledger trust model (ADR-014).
 *
 * The design exists to fix a specific failure in the original: trust was promoted on "low edit
 * ratio, high success" — that is, on METIS being *useful*. A skill that drafts excellent documents
 * would have ratcheted toward scheduled autonomy on the strength of its prose, with no evidence
 * whatsoever that its constraints hold.
 *
 * So there are two scores, and they move for different reasons. Competence cannot substitute for
 * compliance at any price.
 */
export * as Trust from "./domain/Trust.js"

/**
 * The result of submitting a plan.
 *
 * `mode` is not decoration: `direct` means the run is **not** durable, and a caller that cannot
 * tell the two apart cannot know whether its plan survives a restart.
 */
export * as IntentApi from "./ingress/IntentApi.js"

/**
 * Handlers for the intent surface.
 *
 * `POST /intent` turns a draft into a recorded Intent and a Plan. The server assigns the intent's
 * id and timestamp — that is why the endpoint takes an `IntentDraft` and not an `Intent` (ADR-005).
 *
 * Both the intent and the plan are written to the event log before the plan is returned, so the
 * audit trail exists whether or not anyone ever executes it. A plan that was proposed and declined
 * is as much part of the record as one that ran.
 */
export * as IntentApiLive from "./ingress/IntentApiLive.js"

/**
 * Versioned, checksummed blobs.
 *
 * Payload and metadata are separate throughout, per ADR-007: `head` returns metadata without
 * moving bytes, which is what makes listing and referencing artifacts cheap. The store is
 * responsible for verifying that the bytes it returns hash to the checksum it recorded.
 */
export * as ArtifactStore from "./mneme/ArtifactStore.js"

/**
 * The append-only timeline.
 *
 * `append` is idempotent by event id (ADR-007): appending the same id twice is one event, and the
 * second call returns the record that is already there rather than failing. Ordering is by `ts`,
 * with the identifier breaking ties — UUIDv7 sorts by creation time, which is the reason ADR-005
 * requires it.
 */
export * as EventLogStore from "./mneme/EventLogStore.js"

/**
 * In-memory `ArtifactStore`.
 *
 * Holds payloads in a map, but enforces the same invariant the durable adapter must: the checksum
 * recorded is the checksum of the bytes stored, verified on the way in and again on the way out.
 */
export * as InMemoryArtifactStore from "./mneme/InMemoryArtifactStore.js"

/**
 * In-memory `EventLogStore`.
 *
 * Not a toy: it is the reference against which the Postgres adapter is compared. Both run the same
 * conformance vectors, so "the database does something the interface does not promise" shows up as
 * a failing test rather than as behaviour someone depends on by accident.
 */
export * as InMemoryEventLogStore from "./mneme/InMemoryEventLogStore.js"

/**
 * In-memory `PlanStore`.
 *
 * The test double for the Postgres adapter. It does not persist across a restart and is not meant
 * to — anything that needs durability must be wired to `PostgresPlanStore`.
 */
export * as InMemoryPlanStore from "./mneme/InMemoryPlanStore.js"

/**
 * Persistence for intents and the plans made from them.
 *
 * The two are stored together because a plan without its intent is a foreign-key violation and,
 * more to the point, an unanswerable record: "what was this plan for" is the first question anyone
 * asks of an audit trail.
 */
export * as PlanStore from "./mneme/PlanStore.js"

/**
 * PostgreSQL-backed `ArtifactStore`.
 *
 * Metadata lives in `artifact`, provenance links in `artifact_provenance`, and bytes in
 * `artifact_payload`. Reading metadata never touches the payload table, which is the whole reason
 * ADR-007 gives `head` and `get` separate operations.
 */
export * as PostgresArtifactStore from "./mneme/PostgresArtifactStore.js"

/**
 * PostgreSQL-backed `EventLogStore`.
 *
 * Access goes through `@effect/sql` (ADR-018): SQL stays SQL, and the wrapper provides resource
 * management, typed errors and schema-validated rows rather than an abstraction over the query
 * language. Rows are decoded with the same Effect Schema the API uses, so a row that would not
 * survive the process boundary does not silently become an `Event` here.
 */
export * as PostgresEventLogStore from "./mneme/PostgresEventLogStore.js"

/**
 * PostgreSQL-backed `PlanStore`.
 *
 * Writes the normalised shape the schema already describes: `intent` and `intent_value`, then
 * `plan` with its steps, assumptions, risks and expected artifacts in their own tables. Storing
 * the plan as one jsonb blob would have been fewer lines and would have thrown away every
 * constraint in `migrations/0001_initial.sql` — the ordering guarantee on steps, the check that a
 * non-tool step carries no tool call, the foreign key back to the intent.
 */
export * as PostgresPlanStore from "./mneme/PostgresPlanStore.js"


export * as SuperMemory from "./mneme/SuperMemory.js"

/**
 * Plan execution.
 *
 * ADR-016 draws the line: "Restate owns retries, backoff, checkpointing, suspension and
 * resumption. METIS owns planning, policy, tool dispatch and memory." This is the METIS side. It
 * walks a plan's steps, evaluates policy at the three points, dispatches tools and writes
 * artifacts.
 *
 * It deliberately contains **no durability machinery** — no retry loop, no backoff, no checkpoint
 * writing, no suspension primitive. Those are Restate's, and hand-rolling them is the specific
 * failure ADR-016 exists to prevent, because they fail silently and at the worst moment.
 *
 * Approval is handled by *stopping*, not by suspending: an un-approved gated step ends the run with
 * `awaiting_approval` and the caller re-invokes with the approval granted. That is why policy is
 * re-evaluated from scratch on every invocation and no decision is ever carried across one — a
 * cached allow from before an approval is invalid, since both the policy and the trust ledger may
 * have moved in between (ADR-016).
 */
export * as Executor from "./orchestrator/Executor.js"

/**
 * Submitting a plan for execution.
 *
 * Two implementations, and the difference between them is the whole durability story:
 *
 * - **`restate`** hands the plan to a Restate workflow. Retries, checkpointing and suspension are
 *   Restate's; the run survives a process restart and an approval parks it rather than ending it.
 * - **`direct`** runs the executor in-process. Identical policy behaviour, no durability at all —
 *   killing the process loses the run.
 *
 * Both are offered because the honest alternative to "Restate is running" is not "silently
 * degrade": it is a caller that knows which mode it got. `submit` reports the mode it used, so a
 * plan run without durability cannot be mistaken for one that has it.
 */
export * as PlanExecution from "./orchestrator/PlanExecution.js"

/**
 * Plan execution as a Restate workflow (ADR-016).
 *
 * The division of labour ADR-016 sets out: **Restate owns retries, backoff, checkpointing,
 * suspension and resumption. METIS owns planning, policy, tool dispatch and memory.** This file is
 * the seam. Each plan step becomes a durable step; everything inside one is the existing executor
 * logic, unchanged.
 *
 * Two properties this must preserve, both easy to lose while adding checkpoints:
 *
 * 1. **Policy is re-evaluated on resume, never restored from a checkpoint.** A workflow suspended
 *    for an approval may resume hours later under a policy that has since changed and a trust
 *    ledger that has since moved. A cached allow from before the suspension is invalid. So the
 *    policy evaluation deliberately happens *inside* the durable step rather than having its
 *    result memoised across one.
 * 2. **Restate's journal is not METIS's event log.** The journal is execution mechanics and may be
 *    discarded on migration; the event log is the tamper-evident audit record. They stay separate.
 *
 * Suspension here is real: `ctx.promise` parks the workflow until an approval is signalled from
 * outside, and the process may be killed and restarted in between.
 */
export * as PlanWorkflow from "./orchestrator/PlanWorkflow.js"

/**
 * Intent → Plan.
 *
 * Deliberately dumb: templates matched on the goal text, as REBUILD-PLAN Stage 2 specifies. The
 * requirement is that it produces a *valid* Plan, not a smart one — everything downstream (policy
 * evaluation, approval gating, execution, provenance) is exercised by a plan that is structurally
 * correct, and none of it gets better by making the planner clever first.
 *
 * The one piece of real judgement here is `requiresApproval`, which is derived from the autonomy
 * gear rather than hardcoded per template. Getting that wrong would mean approval gates that do not
 * fire, so it is computed in one place and tested directly.
 */
export * as Planner from "./orchestrator/Planner.js"

/**
 * Policy coverage (ADR-014 §2).
 *
 * This answers the question the system could not previously answer: *did any rule have an opinion
 * about what just happened?* It is computed from the event log rather than from counters kept
 * alongside the engine, so the number is derived from the same tamper-evident record an auditor
 * would read, and cannot drift from it.
 *
 * Three quantities, each of which is uncomfortable on purpose:
 *
 * - **Unmatched fraction** — the share of evaluations where no rule engaged. This is the honest
 *   measure of ungoverned behaviour, and it will be high at first. Resist writing rules purely to
 *   move it: a rule that fires on everything improves coverage and constrains nothing, which is
 *   why vacuous rules are tracked too.
 * - **Dead rules** — never fired. Either the risk never materialised or the rule does not work.
 *   Both need investigation; they are not the same finding.
 * - **Vacuous rules** — fired on effectively everything, and therefore constrain nothing.
 *
 * The external evidence ADR-014 cites is worth keeping in mind here: a fixed set of rules has a
 * hard ceiling on what it can catch, and re-deriving rules from the failures they missed does not
 * raise it. Coverage is a property to be *measured*, not a target to be reached.
 */
export * as Coverage from "./policy/Coverage.js"

/**
 * Policy evaluation (ADR-008, ADR-014).
 *
 * Deliberately boring: matching is pure, total, and has no I/O. Anything a rule needs is on the
 * `PolicyRequest`, so a decision can be re-made from scratch at any time — which is what ADR-016
 * requires on workflow resume, where a cached allow from before a suspension is invalid because
 * both the policy and the trust ledger may have moved underneath it.
 */
export * as PolicyEngine from "./policy/PolicyEngine.js"

/**
 * Policy in the execution path.
 *
 * `PolicyEngine` decides; this writes the decision to the event log and returns it. The separation
 * matters: the engine is pure and re-runnable, and everything that makes a decision *durable and
 * auditable* lives here.
 *
 * **Every evaluation is recorded, including the ones no rule matched.** That is not incidental
 * bookkeeping — it is the entire input to the coverage report (ADR-014). If unmatched evaluations
 * went unwritten, the unmatched fraction would read as zero and the system would appear fully
 * governed precisely when it is least governed.
 */
export * as PolicyGate from "./policy/PolicyGate.js"

/**
 * The trust ledger (ADR-014).
 *
 * Read-only at this stage, per REBUILD-PLAN Stage 1: it can report a skill's standing and answer
 * whether a gear is permitted, but nothing updates the scores yet. Stage 4 wires the compliance
 * ledger to real policy evaluations and the competence ledger to approvals and edit ratios.
 *
 * The promotion rules are implemented now rather than later because they are the part worth being
 * careful about, and because a gear check in the execution path needs something to call.
 */
export * as TrustLedger from "./policy/TrustLedger.js"

/**
 * Deriving the trust ledgers from the event log (ADR-014 §3).
 *
 * The scores are *derived*, not accumulated in place. Reading them out of the same tamper-evident
 * record an auditor would read means a score cannot drift from the evidence for it, and a
 * disagreement between "what the ledger says" and "what actually happened" is not representable.
 *
 * The two ledgers move on disjoint evidence, which is the entire point:
 *
 * - **Competence** rises when METIS does the job well — tools completing, approvals granted rather
 *   than withheld. It falls on failure.
 * - **Compliance** rises only on *safety* evidence: policy evaluations survived, gates cleared
 *   without override. It falls hard on a denial.
 *
 * Nothing that raises competence can raise compliance. A skill that writes beautifully and trips a
 * red line repeatedly must end up untrusted, and that only works if the good work is invisible to
 * the compliance ledger.
 */
export * as TrustUpdater from "./policy/TrustUpdater.js"

/**
 * Sampled verification (ADR-014 §4).
 *
 * A random sample of executed actions is checked against expectation, **independent of whether any
 * rule flagged them**. This exists because rules only catch what they were written for. Random
 * sampling is the only mechanism in the system that can find the failure nobody anticipated, and it
 * is how every serious auditing discipline outside software has handled volume for a century.
 *
 * The limitation, stated plainly because ADR-014 requires it to be: sampling bounds how *often*
 * things go wrong. It will not reliably find a single rare catastrophic action. Do not conflate the
 * two — not in this code, and not in any claim made about the system.
 *
 * What "verified against expectation" means concretely: a tool's output is checked against the
 * output schema its capability declares. A tool that returns something its own contract does not
 * describe is a real finding, and one no policy rule would have caught, because policy governs
 * whether an action is permitted rather than whether its result is well-formed.
 */
export * as Verification from "./policy/Verification.js"

/**
 * `ToolRunner` over MCP (ADR-017).
 *
 * Connects to the server named in a ToolSpec's `mcp.server`, calls the named tool, and returns its
 * output. Connection details are deployment configuration and live here rather than in the
 * descriptor — the contract says *which* server logically, this says where to find it.
 *
 * Clients are cached per server and closed with the scope, so a plan calling three tools on one
 * server spawns one process rather than three.
 */
export * as McpToolRunner from "./tools/McpToolRunner.js"

/**
 * The tool registry (ADR-006, ADR-017).
 *
 * Maps a capability id to the implementations that satisfy it. This indirection is the thing that
 * makes hot-swap, versioning and the graduation loop coherent — the planner names
 * `design.prd@1.0` and never learns which server answers it, so an implementation can be replaced
 * without touching a plan.
 *
 * Validation is enforced here rather than trusted: ADR-006 requires schema-valid descriptors,
 * declared scopes, and at least one conformance vector per capability version. A registry that
 * accepts anything is not governance.
 */
export * as ToolRegistry from "./tools/ToolRegistry.js"

/**
 * Tool dispatch.
 *
 * The seam between METIS and whatever actually runs a tool. ADR-016 puts tool dispatch on METIS's
 * side of the line, so this is ours; ADR-017 makes MCP the transport, so the real implementation
 * speaks MCP. The interface exists separately from either so an executor can be tested without
 * spawning processes.
 */
export * as ToolRunner from "./tools/ToolRunner.js"

/**
 * An MCP server exposing the `design.*` capabilities.
 *
 * A real MCP server over stdio, not a stand-in: METIS's client speaks the protocol to it exactly as
 * it would to a third-party server, which is the point of ADR-017. If this were an in-process
 * function call the transport would never be exercised and the first genuine MCP server would find
 * all the integration bugs at once.
 *
 * The generation itself is a deterministic template. Producing good PRD text is a model's job and
 * belongs behind a capability, not inside the transport demo — what is being proved here is that a
 * capability id resolves to a server, the call crosses a process boundary, and the output comes
 * back in the shape the capability declares.
 */
export * as design from "./tools/servers/design.js"

/**
 * An MCP server exposing the `research.*` capabilities that can be implemented honestly.
 *
 * `fetch` performs real HTTP. `summarize` and `claim_graph` are deterministic extractive
 * algorithms over supplied chunks — no model in the loop, which means their output is reproducible
 * and their citations are guaranteed to point at text that was actually provided rather than
 * plausibly generated.
 *
 * `research.search@0.1` is deliberately **not** here. It needs a search backend, and implementing
 * it against canned results would put a capability in the registry that does not do what its
 * contract says — worse than leaving it unimplemented, because the planner would then target it.
 */
export * as research from "./tools/servers/research.js"

/**
 * An MCP server exposing the `transform.*` capabilities.
 *
 * Separate from `design` because they are separate logical servers in the registry, and keeping
 * them apart is what lets one be replaced, sandboxed or moved to another host without touching the
 * other — the property ADR-017's server indirection exists to provide.
 */
export * as transform from "./tools/servers/transform.js"
