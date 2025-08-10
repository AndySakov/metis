# METIS

## 1) What METIS Is

METIS (Modular Engine for Thought, Insight, and Synthesis) is a Jarvis-grade copilot that takes ideas from spark → exploration → design → execution, learns your voice and workflows, and increasingly runs on its own—with safety gates, provenance, and memory.

### Core objectives

- Conversational hub (voice/text) with real-time planning and tool use.
- Project OS for charters, tasks, ADRs, artifacts, reviews.
- Memory fabric with provenance (graph + vectors + timeline + artifacts).
- Learning engine that adapts tone, habits, and tool choices over time.
- Research & design with citations, claim graphs, specs, and diagrams.
- Execution via tools, codegen, CI hooks, notebooks, and device control.
- Polymath breadth (travel, product builds, research, car mods, etc.).
- Autonomy gears from “advise” to “scheduled autonomy” with approvals.
- Composable/upgradeable platform and self-bootstrapping modules.
- Privacy & security by default; auditability end-to-end.

---

## 2) Tenets (Design Principles)

- Always-visible plan (no hidden steps; diffs and cost/time budgets).
- Provenance everywhere (sources, claim links, artifact checksums).
- Gears for safety: S0 advise → S1 draft → S2 sandbox run → S3 gated run → S4 scheduled autonomy.
- Learning-first with nightly/weekly adaptation + shadow eval + revert.
- Local-first privacy (scoped connectors, redaction, encryption).
- Composability for years (stable capability contracts, SemVer, hot-swap).
- Self-bootstrapping (METIS builds/extends METIS under guardrails).
- Interface plurality (headless core + mobile/desktop + AR/VR).
- Long-running orchestration (durable background DAGs, pause/resume).
- Device & environment control (local agent, secure pairing).

---

## 3) Architecture (Stack-Neutral)

### Layers

1. Interface: realtime voice & chat, multimodal canvas, command palette.
2. Orchestrator: intent → plan → tool dispatch → memory writes.
3. Memory Fabric:
   - Event/relational store (timeline, plans, tasks, ADRs, artifact metadata)
   - Graph store (projects, artifacts, decisions, claims, sources; provenance)
   - Vector index (personal exemplars, project context, corpora)
   - Artifact/object store (versioned blobs, checksums)
4. Knowledge Engine: multi-corpus retrieval, claims/evidence, licensing flags.
5. Tooling/Execution: container/WASM tools, notebook runner, CI hooks.
6. Governance/Safety: capability gating, approvals, policy-as-code, audit.
7. Observability: traces, cost/latency budgets, eval dashboards.

#### Foundational capabilities

- Capability Contracts (CAP IDs) `domain.action@MAJOR.MINOR` (planner targets capabilities, not implementations).
- Plugin ABI + Hot-Swap via portable module format (containers or WASM); health checks; canary + rollback.
- State migrations for selected datastores; dry-run + revert.
- Feature flags/experiments and shadow/percent rollouts.

#### Interface layer

- Headless Core API (protocol TBD: gRPC/GraphQL/HTTP).
- Presence & handoff across clients; UI SDK for plan view, diffs, claim graph, approvals.

#### Task orchestration & personas

- DAG scheduler with retries, checkpoints, pause/resume/park.
- Persona router (Explorer/Designer/Builder/Critic/PM) with per-step overrides.
- Notifications (push/email/Matrix) and “what changed” digests.

#### Security & privacy

- Zero-trust (per-tool sandboxes), least privilege, scoped connectors.
- Key mgmt (hardware-backed optional), secrets vault, client-side encryption buckets.
- Policy-as-code, retention TTLs, license/IP guard, signed audit logs.

#### Device & environment

- Local Agent (implementation TBD) on LAN; common protocols (e.g., mDNS, MQTT, IPP, SSH, WebDAV).
- Adapters: 3D printers, printers, tablet sync, desktop control.
- Secure pairing with per-device scopes and revocation.

---

## 4) Learning & Adaptation (How METIS Personalizes)

- Signals: explicit feedback (“shorter,” “more formal”), edit diffs, tool approvals, dwell/reuse, outcomes (PR merged/tests pass).
- Memory: persona profile (tone/structure), style kit (lexicon + exemplars), working habits, decision priors, trust ledger by domain.
- Learners: nightly style distillation → Style Kit; weekly lightweight adapters (e.g., LoRA) + bandit policy for plan/tool choice.
- Questioning policy: ask only on high-uncertainty, high-value slots; infer when trust + familiarity high.
- Autonomy ramp: per-skill trust drives S0→S4; decays over time; promotions gated by metrics.
- Controls: sliders/toggles (concision, rigor); “What did you learn?” changelog; one-click revert.

---

## 5) Self-Bootstrapping (METIS builds METIS)

- Builder personas: `@metis-build` (scaffold), `@metis-refactor` (upgrade), `@metis-test` (eval).
- Pipeline: spec → codegen → tests → sandbox run → PR → approval → rollout → ADR.
- Guardrails: signed modules, supply-chain attestation (optional), mutation budgets, reproducible builds.

---

## 6) Interfaces & Multi-Client

- Headless Core enables: quick-capture mobile, rich desktop canvas, and AR/VR viewers.
- Seamless session handoff and background task notifications.
- Command palette (⌘K) to run tools with arg inference (“simulate `@nozzle v3` for 30s `@12psi`”).

---

## 7) Background Orchestration & Persona Swaps

- Multiple long-running tasks; mid-stream pause/resume/park.
- Persona switching within a plan step or project (“switch to Critic for this step”).
- METIS can notify when results are ready, or park deprioritized projects.

---

## 8) Security, Privacy, IP

- Local indexing where possible; connector-scoped permissions; redaction at ingest.
- License/IP checker; copyleft contamination guard; export-control flags.
- Dual-key approvals for high-risk actions; tamper-evident event log.

---

## 9) Repo & Project Structure (Monorepo)

```text
/metis
  /apps
    /api-orchestrator           (tech TBD)
    /realtime-gateway           (protocol TBD)
    /canvas-app                 (tech TBD)
  /packages
    /planner-core               (library)
    /tool-registry              (schemas + adapters)
    /memory-client              (SDK)
    /connectors                 (docs, drive, arXiv, github, jira, etc.)
    /evaluation                 (harness + metrics)
  /infra
    /k8s                        (jobs, services, secrets)
    /db                         (migrations: stores TBD)
  /docs
    /adrs
    /charters
```

---

## 10) Storage Interfaces (Stack-Neutral)

EventLogStore (append-only timeline), GraphStore (provenance & work graph), VectorIndex (ANN retrieval), ArtifactStore (versioned blobs).

In dev, ship in-memory references with the same HTTP surface to unblock the Core Loop.

Full API shapes are drafted (OpenAPI/AsyncAPI); copy from your “Stack-Neutral Artifacts” doc when you wire up the dev server.

---

## 11) Contracts & Schemas (Essentials)

- Capability Contracts: `domain.action@MAJOR.MINOR` (SemVer; planner supports N-2 MINOR).
- ToolSpec: name, version, capability, implementation (container/WASM TBD), input/output schemas, scopes, sandboxed, tests.
- Intent: `{ id, ts, actor, goal, inputs?, constraints?, autonomy? }`
- Plan: `{ id, intentId, steps[], assumptions[], risks[], expectedArtifacts[] }`
- PlanStep: `{ id, kind: tool|ask|write|decision, description, requiresApproval?, toolCall? }`

---

## 12) Roadmap (Phases & Exit Criteria)

- Phase 0 – Groundwork & guardrails (monorepo, CI, Tool Registry validation, ADR-000/001/002).
- Phase 1 – Core Loop (intent → plan → execute → memory; PRD demo).
- Phase 2 – Project OS v1 (charter/ADR/tasks + views).
- Phase 3 – Memory + Persona v1 (context packs; preference events; Persona Pack).
- Phase 4 – Research v1 (retrieval, citations, claim graphs, licensing flags).
- Phase 5 – Design Studio v1 (PRD, C4, API, trade studies).
- Phase 6 – Execution v1 (codegen, notebooks, CI; job runner TBD; secrets mgr TBD).
- Phase 7 – Autonomy & Safety v1 (gears, approvals, license/IP checker).
- Phase 8 – UX & Voice v1 (STT/TTS; barge-in; palette; digest; protocol TBD).
- Phase 9 – Connectors v1 (public + private; scopes; redaction).
- Phase 10 – Evaluation & Launch (dashboards; red-team; rollback).

### Add-ons

4a Self-Bootstrap Toolchain · 6a Background Orchestration & Personas · 8a Interface SDK & Multi-Client · 7a Security Hardening · 9a Device & Environment Orchestration.

---

## 13) Acceptance Tests (Golden Demos)

1. Idea → PRD → Scaffold: “Build a research summarizer service.” → PRD + C4 + API + service scaffolding + CI passing.
2. Literature Map: RAG state-of-the-art → ~10 sources, claim graph, related-work with citations.
3. Learning Adaptation: After 10 tasks, METIS shortens intros, prefers numbered steps; one-click revert.
4. Voice Loop: Mid-plan voice change; S3 action requires approval with diff; audit logged.

---

## 14) Risks & Mitigations

- Hallucination → strict citations, claim graphs, critic pass, refuse when uncertain.
- Privacy/leakage → local indexing, scopes, redaction, encryption; no training on sensitive buckets by default.
- Tool drift/cost → budget caps, cost-aware planner, observability alerts.
- Overfitting to style → cross-domain checks; cap adapter updates; easy revert.

---

## 15) Current Artifacts You Already Have

- ADRs:
  - ADR-000 Architecture (layered design; composability; observability)
  - ADR-001 Memory Model (graph + vectors + timeline + artifacts; provenance rules)
  - ADR-002 Autonomy Gears & Approvals (S0–S4; trust ledger; dual-key; policy-as-code)
  - ADR-003 Capability Contracts & Plugin ABI (CAP IDs; SemVer; portable modules; hot-swap; signing)
- Schemas: ToolSpec, Intent, Plan (JSON Schema; 2020-12 draft).
- Core API: OpenAPI 3.1 (stack-neutral) with `/intent`, `/plans/{id}`, `/plans/{id}/execute`, `/artifacts/{id}`, `/eventlog`, `/tools`, `/tools/validate`.
- Events: AsyncAPI 2.6 channels (`plan/created`, `tool/started|completed`, `artifact/written`, `approval/requested|granted`, `preference/recorded`).
- Storage interfaces: EventLogStore, GraphStore, VectorIndex, ArtifactStore (HTTP shapes + guarantees).
- Tool Registry: conformance rules + example test vectors.

### Repo paths (proposed)

```text
docs/adrs/ADR-000-architecture.md
docs/adrs/ADR-001-memory-model.md
docs/adrs/ADR-002-autonomy-gears.md
docs/adrs/ADR-003-capability-contracts.md
specs/ToolSpec.schema.json
specs/Intent.schema.json
specs/Plan.schema.json
```

---

## 16) What’s TBD (on purpose) & How We’ll Choose

- Datastores (graph, event/relational, vector, artifact), API protocol (gRPC/GraphQL/HTTP), module packaging (containers/WASM), job runner, secrets manager, Local Agent impl.
- Selection gate (after Phase 3): draft options → scorecard → spike top-2 → ADR to lock choice (with migration plan).

---

## 17) Immediate Next Actions

- ✅ Confirm this brief.
- Build the in-memory dev server implementing EventLogStore, GraphStore, VectorIndex, ArtifactStore + Core API endpoints.
- Scaffold Tool Registry (validation + test harness), then register the first must-have tools:
  - `research.search`, `research.fetch`, `research.summarize`, `design.prd`.

---

## 18) Quick Glossary

- ADR — Architecture Decision Record, one decision per doc.
- CAP ID — Capability ID (`domain.action@MAJOR.MINOR`).
- Persona Pack — Style kit + tool policy + questioning rules + trust ledger.
- Field Kit — Domain bundle (templates, tools, metrics, acceptance criteria).
- Gears — Autonomy levels S0–S4.

---

## 19) Example Natural Commands

- “`@metis` create a project Atlas and draft a PRD for a research summarizer.”
- “Compare options for vector DBs; give a trade study with latency/cost and a recommendation.”
- “Pause the long-running literature map; resume tonight; send me the digest at 9pm.”
- “Adopt the tone and structure of this paragraph for future abstracts.”
- “Print `nozzle_v3.stl` on the Voron at 0.2mm; notify me when done.”
