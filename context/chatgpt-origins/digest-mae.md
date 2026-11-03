# Delta digest: MAE (Modular Agent Ecosystem) / Phantomgrid

Sources: the MAE spec as ChatGPT saw it (truncated; the full file is now `artifacts/mae-spec.md`) and `transcripts/2025-06-09_mae-spec-sessions.md` (159 user turns). U-numbers count Temi's turns in order.

Caveat: this digest was written from the truncated copy ChatGPT saw (it ends inside §11.10). The full spec in `artifacts/mae-spec.md` adds §12–§22 (example workflows, observability/SLOs, wallet key lifecycle, token economics, module migration, disaster recovery, DoS protection, side-channel hardening, cypherpunk compliance, the Configurator, conclusion), which are not digested here. In the full spec the OFAC line is gone. Defects: §3.1.6 "Planner DSL" heading is empty (its table sits under §3.1.7), and §11.5 still promises GDPR alignment and "OFAC screening built into Registry", contradicting Temi's cypherpunk decision (U41).

## 1. What MAE is

MAE is an open protocol spec for a permissionless network of autonomous agents. Each agent inherits a base "proto-agent" (Brain + Executor + Wallet), runs in a sandbox, and extends itself by calling third-party **modules** (concrete implementations of protocol-level **capabilities**) or other agents, paying them per call. Settlement runs on an EVM L2 through Coinbase's x402 HTTP-402 payment handshake, with a native CREDIT token, stake-weighted reputation, a registry, zk-based selective disclosure of user PII, signed and attested module images, and token governance. Temi described it as "a lot like npm", with agents as packages that depend on each other and fees "built into it from the ground up" (U2). **Phantomgrid** is the name he picked for the reference network (U67), after rejecting "Gilgamesh Network" (U63–65).

Spec outline (top-level sections in the snapshot):

1. Vision & Scope: the problem statement, who benefits, and naming (MAE is the spec, Phantomgrid the implementation).
2. Core Abstractions: Agent; Capability vs Module; the two-tier capability namespace; Module manifest with SystemSpec; ENS names.
3. Base System ("Proto-Agent"): the Brain (input adaptors, intent parser, intent→capability pipeline, capability-ID lifecycle and overlays, tiered memory, context-engine tiers, planner DSL, provenance snapshots, onError), the Executor (discovery and fallback, cost forecast and funding bond) and the Wallet.
4. Data & Knowledge Model: envelope, intent, context and memory-event layers.
5. Communication Protocol: transport tiers (gRPC → WebTransport → WebRTC → JSON-RPC/WSS), discovery, x402 hooks, event types.
6. Economic Model: CREDIT, the x402 primer, the exact/upto/stream payment schemes, account-abstraction request embedding, provider scoring.
7. Versioning & Compatibility: SemVer and the CAP (Change-Adoption Proposal) process.
8. Security & Privacy (summary list).
9. Governance & Community: token voting, proposal types, CAP lifecycle, delegates, emergencies, grants.
10. Committed Design Choices: the locked-decision table.
11. Security & Privacy Architecture: threat model, CT-721 capability tokens, authorization flow, PII vault, the flight-booking example, attestation, ZK circuits, audit flag, snapshot privacy and right-to-be-forgotten, supply chain, off-chain PII handling.

## 2. Relationship to METIS

What the evidence shows:

- **Shared origin.** The MAE chat began on 2025-06-09, the day after "Building Jarvis with current tech" (2025-06-08). There Temi asked for a "distributed system of specialized modules… controlled by a central node". In U2 he says MAE "will function aspirationally like the fictional AI JARVIS and I intend to build it as a functional brain." So MAE was the June 2025 version of the same JARVIS goal, set up as a public network.
- **METIS was started separately.** The name METIS first appears on 2025-08-10, in a new conversation ("Imagineering copilot design"). That chat describes a personal copilot with no network, token or chain, and never mentions MAE. Its roadmap is where the "Artifact/object store" storage role came from. The repo contains no MAE, Phantomgrid, wallet or chain terms.
- **The only direct link is the last exchange of the MAE thread.** In U158–159 Temi asks for self-hostable object stores and then says: "I'm vetting which to use for METIS' object/artifact store." The turn has no date of its own. It most likely came after 2025-08-10, when the METIS name and its ArtifactStore role existed, with Temi reusing an old chat. ChatGPT's reply *assumed* METIS would store "build artefacts / snapshot bundles / container layers that MAE Agents and Modules will pull" and that Kubernetes was needed for "Phantomgrid dev". **Temi did not confirm this, and the thread ends there.** The claim that METIS is the brain running on MAE comes from ChatGPT, not from anything Temi said.
- **Many ideas carried over.** Planner targets versioned capability IDs, not implementations; many implementations per capability; sandboxed tools; policy gates; provenance; deny-unvetted-by-default. MAE's `text/summarise@1` became METIS's `domain.action@MAJOR.MINOR`. Temi's ENS decision ("rely on existing infra… drop bloat", U90) follows the same reasoning as METIS ADR-017, which adopted MCP instead of a bespoke protocol.

Assessment: MAE is a **predecessor and sibling** of METIS. It is the multi-party, paid, on-chain version of the same "brain with pluggable abilities". METIS is the single-user, local version, with the network, economics and chain removed. Nothing shows METIS was designed as an MAE agent. Nothing shows MAE was formally abandoned either. The spec work stopped at "anything else before I send this to a friend" (U156) plus a table of contents, and no later conversation in the package picks it up. Whether MAE is parked, dropped, or meant as a later outer layer **is unclear; only Temi can say.** The one hook in METIS is CLAUDE.md's "multi-user seams left open but not built."

## 3. Owner decisions

Only decisions Temi originated or explicitly chose are listed. ChatGPT-originated material that he accepted with "next/onward/lgtm" is grouped at the end.

Tags: **[in-repo: where]**, **[partial: where]**, **[not-in-repo]**, **[conflicts: with which locked decision]**, **[out-of-scope]** (out of scope for single-user METIS).

**Framing and abstractions**

1. A versioned, backward-compatible spec that a community extends; agents depend on each other like npm packages (U2). **[partial: ADR-006 SemVer capability contracts; packs (`specs/packs/`, `METIS_PACKS`) are extension from outside core. The community and marketplace parts are out-of-scope.]**
2. Base system = Brain + Executor + Purse (U2). The Brain parses intent and enriches it with memory, user-set "maxims" and live system state. The Executor is "a subpart of the brain" and manages modules, timing and coordination. The Purse costs tasks and pays or receives funds. **[partial: planner and executor in `src/orchestrator/`. The Purse is not-in-repo.]**
3. "Agents is to human as module is to tool" (U2). Later sharpened (U137): capabilities are protocol-level, like "opcodes"; modules are implementations, like "smart contracts". Temi said the spec "seems to use these two terms interchangeably in a very confusing manner." **[in-repo: capability IDs in `specs/capabilities/` vs ToolSpec/MCP server implementations (ADR-003, ADR-017); `ToolRegistry.resolve` returns every implementation of a capability.]**
4. Two-tier capability governance (U138–139). He asked "isn't it limiting… to have to vote on every single action on capabilities?" and chose experimental `dev.<owner>/<action>@0` (staked, expires after 180 days) alongside canonical IDs set by vote. **[partial: core capabilities live in `specs/`, and packs bring their own capabilities from outside core, though with no namespace tier, expiry or promotion path. The voting part is out-of-scope.]**
5. Global IDs: he first wanted them to work "exactly like IP addresses", then accepted that a semantic ID is not a network address (U83). **[in-repo: the planner targets CAP IDs and never names an MCP server (ADR-017).]**
6. Module discovery when a user wants to extend their agent (U84–85). **[not-in-repo: packs are loaded explicitly through `METIS_PACKS`.]**

**Network, chain, economics**

7. EVM L2; agents and modules run off-chain in Docker; several fee models; ENS-style names; stake-weighted reputation; zk-attestations (U4). **[out-of-scope]**. The Docker part **[conflicts in part: ADR-017 and REBUILD-PLAN dropped container-packaged tools. ADR-020 names `container` as a tier, but none above `process` exists, and WASM is the stated destination.]**
8. x402 fees as a first-class feature (U2). **[out-of-scope; ADR-010's `Budget.dollars` is the nearest thing.]**
9. EIP-7702 instead of "the limited and outdated eip-4337" (U31). **[out-of-scope]**
10. "Cypherpunk project through and through": compliance was rewritten as optional modules with no central block-lists (U41). The review criteria were "100% factual… cypherpunk ethos to the letter… congruent… not too wordy" (U44). **[out-of-scope]** The snapshot's §11.5 still contradicts this.
11. Agents and modules act as clients and servers "kinda like the internet", with ENS-style domains and any TLD (U69–70). This was superseded by the next decision.
12. ENS piggyback with no `mae` namespace: "since it's cosmetic i'd like to reduce overhead and just rely on existing infra. plus it'll drop bloat" (U90). **[out-of-scope; the same reasoning as ADR-017.]**
13. The Wallet's StreamMonitor is native to the agent rather than an ERC-1620 change; "agents must always have enough to run their activities over a forecasted period" (U131). **[out-of-scope]**
14. Spend forecasting and a local fund bond: "forecast spending for all module uses for a plan and ensure that the wallet has enough before even enacting the plan… bond the funds locally" (U132). **[not-in-repo: ADR-010 `Budget` (seconds/dollars/tokens) exists in the schemas, but the orchestrator never reads it.]** This applies directly to METIS's model and API costs.
15. Third-party inference on more powerful hardware is allowed, replacing ChatGPT's "local inference mandate" (U51). **[in-repo: `metis.model` uses the Anthropic API; `metis.model-cli` uses an existing CLI login.]**

**Security**

16. Agents must be able to act for users "without nuking user privacy or leaking user info", using zk (U5, U8). **[partial: redaction at ingest (ADR-001), the `packs/redact` pack, `untrusted` labels with egress deny. zk is out-of-scope.]**
17. One uniform sandbox VM for all agents, local and remote, "with all the security provisions built in". Pick the "simplest, most performant and easy to integrate" TEE option (U22). **[partial: the ADR-020 isolation ladder is a policy input; runtime isolation is process-only.]**
18. A relying agent must be able to confirm a module "will perform exactly as advertised", and modules advertise system specs so the executor can favour more powerful hardware (U25). **[partial: ADR-014 sampled verification checks outputs against the declared schema (`src/policy/Verification.ts`). SystemSpec is not-in-repo.]**
19. Secure by default with opt-ins (U118). Security measures cheap in "cost, ux or system resources" are on by default; the rest are opt-in, with the configurator recommending some. Plugins get "an independent review step" before wide use. The manifest carries an audit flag, and unaudited plugins are not allowed by default: "users can still do whatever they want, just at their own risk." **[partial: policy fails safe; the registry rejects bad descriptors at construction; the README says "load only packs you trust". No audit flag, no default deny on unreviewed packs, no configurator.]**
20. OOM handling when a module omits `resourceHint` (U142). Temi raised the problem; ChatGPT's safe cgroup caps plus a probe run were accepted. **[not-in-repo; only relevant once a container tier exists.]**

**Brain (section 3)**

21. Configurator: "let each person configure their agent based on a configurator that asks questions about key things and then builds the base brain image" (U94). At first run the user picks which local modules (input adaptors, capability modules) to pre-install, "suggestions… based on the kinds of things they've selected they want the agent to be able to do" (U123). **[not-in-repo: METIS is configured through env vars (`METIS_PACKS`, `METIS_MODEL_CLI`, ...).]**
22. Intent parser kept separate from input modules. It takes raw semi-structured input plus preferences, memory and network context and turns it into "a meaningful intent that the planner can understand" (U76). Input adaptors also accept automated events from tasks and other modules (U74). **[partial: the `IntentDraft`→`Intent`→planner flow. There are no input adaptors and no event-triggered intents, and by design the model never sees pasted text.]**
23. Hot working memory vs cold memory: "fast access working memory for quick and often used/accessed tasks/intents and then a longer term cold memory… model the short/long term memory model the human brain uses" (U97). **[not-in-repo: ADR-013's two tiers split by kind (structured store, artifact blobs, external retrieval), not by age or latency. `vector.upsert` is still a descriptor only.]**
24. Three data groups (U104): (a) user-set prefs and config in a KV store; (b) data that changes unpredictably as KV plus derived views, with hooks and an `ephemeral` tag so it is "fetched when needed"; (c) a reactive context service "bundle[d]… by default with opt out", as "a base daemon that can be extended with third-party modules for things like price watching". **[not-in-repo. The persona-pack preferences are designed but not built.]**
25. Hybrid planner: "a hybrid between the dag+control tags and a full blown dsl but we will constrain the complexity so that it doesn't spiral into its own project". It should know "what follow up questions to ask if it spots ambiguity" and draw on context and memory (U107). It should parse errors "with context provided by the source of the error to come back to the user with options if there's no clear next line of action" (U108). **[partial: the planner asks one question when a goal is unclear (`Planner.ts`, `ModelPlanner.ts`); step bindings chain outputs; approval gates pause execution. No if/foreach/parallel and no "options" reply. Conflicts: retry, timeout and parallel built as a hand-made scheduler would break ADR-016 (Restate), so map them onto Restate.]**
26. Provenance only where needed: "only service agents and modules even require this provenance and replay ability". A local agent "can still opt in" for an audit trail or debugging, and non-service agents need it when they act together for their users (U111). **[conflicts: METIS tenet "Provenance everywhere" and ADR-014, whose trust and coverage are computed from an always-on event log. MAE made snapshots default-off for personal agents; METIS is a personal agent and records always.]**
27. Privacy-preserving provenance: "how do we achieve provenance while maintaining the standard of privacy first and policy adherence?" (U113). Temi accepted ChatGPT's split into public and sealed-private bundles with field-level `public/hashed/sealed/zkproof`. **[partial: redaction at ingest and labels. The split bundles are not-in-repo.]**

**ChatGPT-originated, accepted with "next":** CREDIT token and 70/30 burn; governance quorums, CAP lifecycle, emission curve, dispute DAO; CT-721 and Noir circuits; transport tiers; Bloom registry cache; provider scoring weights; geoTags; right-to-be-forgotten cron; 12-month deprecation window; capability overlays; the DistilBERT+rules classifier (Temi side-stepped it for the configurator, U94). He had the developer toolkit removed (U43). All out-of-scope except overlays (§4).

## 4. Brain spec (section 3) ideas relevant to METIS today

- **Capability overlay = a selection policy.** `ToolRegistry.select` currently "takes the first registered, deterministically" until a selection policy exists. MAE §3.1.3.a already defines one: a per-profile map of capability → pinned implementation, wildcards, exact-beats-wildcard precedence, `providerBias`, and a warning when a pin outlives a deprecation. It fits METIS directly if written as policy-visible data.
- **Intent provenance.** The parser records each enrichment step and a hash of its source data on the Intent. METIS could log which context fed a plan. Byte-identical determinism is not achievable with a model planner, but METIS already records "planned by the model" as a risk.
- **Tiered memory (U97) and three context groups (U104).** These are the natural shape for the missing memory server: hot recent state, cold long-term recall hydrated back on a miss, and revocation that purges hot memory at once and tombstones cold memory. The context provider (reactive daemon plus third-party watchers) should be a **pack extension point**, not core code, to keep the rule that core stays general. The open CLAUDE.md item, storing the `untrusted` tag with each memory record, belongs in the same design.
- **onError actions.** `retry` and `timeout` belong to Restate. `switchProvider` needs several implementations and the overlay. `fallback` to another capability and `askUser` with options (U108) are planner features METIS lacks. MAE's error taxonomy (`NETWORK/AUTH/VALIDATION/RESOURCE`) and ADR-009's codes would need reconciling.
- **Bounded control constructs.** MAE's limits (fan-out ≤32, retries ≤5, `if` depth ≤3, `foreach` ≤256) are a ready guard-rail set if METIS plans gain branching. They should compile to Restate, not a custom DAG runner.
- **Cost forecast and reserve before execution (U132).** This means summing step budgets before the first dispatch and refusing or asking when the sum exceeds the cap. ADR-010's `Budget` exists for exactly this and is unused.
- **Secure-by-default plus an audit flag (U118).** A pack manifest could declare a review status, and policy could deny unreviewed packs unless the user opts in. That matches ADR-020's style of honest declarations that policy can act on.
- **Adaptor security classes** (`stateless`/`buffer-10s`/`stateful`) map onto ToolSpec scopes plus the isolation ladder.
- **Provenance split.** Public/private bundles and field-level sealing matter only if METIS ever shares an audit trail with another party. For now its event log stays always on.

## 5. Open questions for Temi

1. Is MAE/Phantomgrid parked, dropped, or meant as a later outer layer, with METIS as one agent on the network? Nothing in the sources settles this.
2. When you asked about "METIS' object/artifact store" (U159), did you mean METIS would host MAE snapshots and OCI layers, as ChatGPT assumed? Artifact bytes now live in Postgres `bytea` (`migrations/0002_artifact_payload.sql`). Do you still want an S3-compatible store (MinIO, SeaweedFS, Garage), and at what size threshold?
3. MAE made provenance opt-in for personal agents (U111); METIS records everything. Confirm METIS keeps always-on recording. ADR-014 depends on it.
4. Should the working/cold memory split (U97) and the three context groups (U104) become the design for the memory server and a context-provider pack extension point?
5. Should MAE's capability overlay become `ToolRegistry`'s selection policy?
6. Should packs get an experimental capability namespace that can later be promoted into `specs/` (your two-tier idea, U139)?
7. Do you want plan-level cost forecasting and a hard cap on model and API spend (U132), using ADR-010 budgets?
8. Do you want the planner's constrained DSL (`if`/`foreach`/`parallel`, `onError` with fallback and options to the user), with execution delegated to Restate?
9. Is there a later `mae/README.md` than this snapshot? It cuts off at §11.10, lacks §§12–21, and contradicts the cypherpunk decision in §11.5.
