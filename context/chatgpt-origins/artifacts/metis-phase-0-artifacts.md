# METIS Phase 0 — Artifacts

This package includes:
- ADR-000 Architecture
- ADR-001 Memory Model
- ADR-002 Autonomy Gears & Approvals
- ADR-003 Capability Contracts & Plugin ABI
- JSON Schemas (ToolSpec, Intent, Plan)
- PostgreSQL initial migrations
- Neo4j bootstrap (constraints + types)

---

## ADR-000: Architecture
**Status:** Proposed → (accept in PR #1)

**Context**
METIS must plan→execute→remember→learn across domains, with composability, safety, and self-bootstrapping.

**Decision**
Adopt a layered architecture:
1) **Interface** (Web/Voice/CLI/AR): real-time chat, command palette, canvas.  
2) **Orchestrator **: intent→plan→dispatch→memory writes; streams traces.  
3) **Tooling/Execution**: per-tool sandboxes; jobs on K8s; OCI/WASM packaging.  
4) **Memory Fabric**: Postgres (events/meta), Neo4j (graph), Vector DB (embeds), Object store (artifacts).  
5) **Knowledge Engine**: retrieval + claim/evidence extraction with licensing.  
6) **Governance/Safety**: gears, approvals, policy store, audit log.  
7) **Observability**: OpenTelemetry traces; budgets; dashboards.

**Consequences**
- Clear seams for hot-swapping and upgrades.  
- Slight complexity from multi-store memory and sandbox orchestration.

**Links**
- ADR-001 (Memory), ADR-002 (Gears), ADR-003 (Capability Contracts).

---

## ADR-001: Memory Model
**Status:** Proposed

**Context**
We need recall of decisions, claims, artifacts, and context across long-running projects with provenance and privacy.

**Decision**
Adopt a **three-tier memory**:
- **Graph** (Neo4j): entities (Project, Artifact, Decision, Claim, Source, Person), relations (DERIVED_FROM, JUSTIFIED_BY, RELATES_TO, OWNED_BY, IN_PROJECT).  
- **Vectors**: chunked embeddings of artifacts/notes with collection tags (personal.exemplars, project.context, docs.corpus).  
- **Timeline** (Postgres): immutable event log (intents, plans, tool calls, approvals, writes).

**Rules**
- Every artifact has a checksum, creator, and provenance links.  
- Context packs are assembled per request (graph slice + vectors + timeline windows).  
- Client-side encryption optional for sensitive buckets; redaction at ingest.

**Consequences**
- Powerful cross-project reasoning; requires disciplined ingestion and IDs.

---

## ADR-002: Autonomy Gears & Approvals
**Status:** Proposed

**Context**
We want rising autonomy with safety.

**Decision**
Define gears:
- **S0 (Advise)**: analysis only.  
- **S1 (Draft)**: write artifacts, no external effects.  
- **S2 (Sandbox Run)**: execute tools in isolated env; requires post-run review.  
- **S3 (Gated Run)**: actions that touch external systems (repos/cloud/devices) require pre-approval with diff & budget.  
- **S4 (Scheduled Autonomy)**: recurring/background actions within caps; periodic summaries.

**Policy**
- Trust is per-skill, in [0,1], decays over time; promotions require metrics (low edit ratio, high success).  
- All S3/S4 actions produce auditable plans/diffs; dual-key available for high-risk ops.  
- Red lines (e.g., IP/PII exfiltration) are enforced by policy-as-code deny rules.

**Consequences**
- Predictable control; overhead for approvals mitigated via good previews.

---

## ADR-003: Capability Contracts & Plugin ABI
**Status:** Proposed

**Context**
Composability and self-bootstrapping require stable, versioned contracts between planner and tools.

**Decision**
- **Capability ID (CAP ID):** `domain.action@MAJOR.MINOR` (e.g., `design.c4@1.2`). Planner targets CAP IDs, not implementation names.  
- **Semantic Versioning:** Breaking changes → MAJOR bump; compatible additions → MINOR; fixes → PATCH. Planner supports `N-2` MINOR.  
- **Packaging:** Tools ship as **OCI images** (container) or **WASM modules** with a standard entrypoint.  
- **IO Contracts:** JSON Schemas for inputs/outputs; strict validation at runtime.  
- **Hot-Swap Loader:** health checks, canary/percent rollouts, auto-rollback on failures.  
- **State Migrations:** declarative migrations for PG/Neo4j/Vector; dry-run + revert.  
- **Signing & Attestation:** modules are signed; optional SLSA provenance; registry enforces signatures.

**Consequences**
- Modules can evolve safely; METIS v1 can build/upgrade v2 modules under guardrails.

---

## JSON Schemas (Draft 2020-12)

### ToolSpec.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://metis/specs/ToolSpec.schema.json",
  "title": "ToolSpec",
  "type": "object",
  "required": ["name", "version", "capability", "implementation", "inputSchema", "outputSchema", "authScopes", "sandboxed"],
  "properties": {
    "name": {"type": "string", "pattern": "^[a-z0-9_.-]+$"},
    "version": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$"},
    "capability": {"type": "string", "pattern": "^[a-z]+\\.[a-z0-9_]+@\\d+\\.\\d+$"},
    "implementation": {
      "type": "object",
      "oneOf": [
        {"properties": {"kind": {"const": "oci"}, "image": {"type": "string"}, "entrypoint": {"type": "string"}}, "required": ["kind", "image"]},
        {"properties": {"kind": {"const": "wasm"}, "module": {"type": "string"}, "entrypoint": {"type": "string"}}, "required": ["kind", "module"]}
      ]
    },
    "inputSchema": {"type": ["object", "boolean"]},
    "outputSchema": {"type": ["object", "boolean"]},
    "authScopes": {"type": "array", "items": {"type": "string"}},
    "sandboxed": {"type": "boolean"},
    "costs": {"type": "object", "properties": {"fixed": {"type": "number"}, "perUnit": {"type": "number"}}},
    "tests": {
      "type": "array",
      "items": {"type": "object", "properties": {"name": {"type": "string"}, "input": {}, "expect": {}}, "required": ["name", "input", "expect"]}
    },
    "metadata": {"type": "object"}
  }
}
```

### Intent.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://metis/specs/Intent.schema.json",
  "title": "Intent",
  "type": "object",
  "required": ["id", "ts", "actor", "goal"],
  "properties": {
    "id": {"type": "string"},
    "ts": {"type": "integer"},
    "actor": {"enum": ["user", "system"]},
    "goal": {"type": "string"},
    "inputs": {"type": "object"},
    "constraints": {"type": "array", "items": {"type": "string"}},
    "autonomy": {"type": "integer", "minimum": 0, "maximum": 4}
  }
}
```

### Plan.schema.json
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://metis/specs/Plan.schema.json",
  "title": "Plan",
  "type": "object",
  "required": ["id", "intentId", "steps", "assumptions", "risks", "expectedArtifacts"],
  "properties": {
    "id": {"type": "string"},
    "intentId": {"type": "string"},
    "steps": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "kind", "description"],
        "properties": {
          "id": {"type": "string"},
          "kind": {"enum": ["tool", "ask", "write", "decision"]},
          "description": {"type": "string"},
          "requiresApproval": {"type": "boolean", "default": false},
          "toolCall": {
            "type": "object",
            "required": ["tool", "version", "input"],
            "properties": {
              "tool": {"type": "string"},
              "version": {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+$"},
              "input": {"type": "object"},
              "budget": {
                "type": "object",
                "properties": {
                  "seconds": {"type": "number", "minimum": 0},
                  "dollars": {"type": "number", "minimum": 0},
                  "tokens": {"type": "number", "minimum": 0}
                }
              }
            }
          }
        }
      }
    },
    "assumptions": {"type": "array", "items": {"type": "string"}},
    "risks": {"type": "array", "items": {"type": "string"}},
    "expectedArtifacts": {"type": "array", "items": {"type": "string"}}
  }
}
```

---

## PostgreSQL — Initial Migrations
**File:** `infra/db/migrations/0001_init.sql`
```sql
-- UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Timeline events (preference + orchestration)
CREATE TABLE IF NOT EXISTS events_preference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  project TEXT,
  domain TEXT,
  input_fingerprint TEXT,
  proposed JSONB NOT NULL,
  chosen INTEGER,
  edit_ratio REAL,
  feedback JSONB,
  outcome TEXT CHECK (outcome IN ('accepted','rejected','revised','scheduled')),
  costs JSONB
);

CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  plan JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT,
  kind TEXT NOT NULL, -- e.g., 'markdown','openapi','notebook','binary'
  title TEXT,
  uri TEXT, -- object-store path or external URL
  checksum TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL, -- 'user' or 'metis'
  metadata JSONB,
  provenance JSONB -- edges to sources/claims etc.
);

-- Project OS (minimal for v1)
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  charter YAML, -- if YAML not supported, store as TEXT; else JSONB
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adrs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed','accepted','superseded')),
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  alternatives JSONB NOT NULL,
  consequences JSONB NOT NULL,
  links JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('todo','doing','done')),
  depends_on JSONB,
  produces JSONB,
  owner TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_events_preference_ts ON events_preference(ts);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id);
```

> **Note:** If your Postgres lacks a `YAML` type, set `charter` to `JSONB` or `TEXT`. Replace above accordingly.

---

## Neo4j — Bootstrap (Constraints & Types)
**File:** `infra/db/neo4j/bootstrap.cypher`
```cypher
// Uniqueness constraints
CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT artifact_id IF NOT EXISTS FOR (a:Artifact) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT decision_id IF NOT EXISTS FOR (d:Decision) REQUIRE d.id IS UNIQUE;
CREATE CONSTRAINT claim_id IF NOT EXISTS FOR (c:Claim) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT source_id IF NOT EXISTS FOR (s:Source) REQUIRE s.id IS UNIQUE;

// Suggested relationship types (documentation)
// (:Project)-[:HAS]->(:Artifact)
// (:Artifact)-[:DERIVED_FROM]->(:Artifact|:Source)
// (:Decision)-[:JUSTIFIED_BY]->(:Claim)
// (:Claim)-[:SUPPORTED_BY]->(:Source)
// (:Artifact)-[:IN_PROJECT]->(:Project)
// (:Person)-[:OWNS]->(:Project)

// Example: seed a system node
MERGE (m:System {name:'METIS'})
ON CREATE SET m.createdAt = timestamp();
```

---

## Repo Paths
- `docs/adrs/ADR-000-architecture.md`
- `docs/adrs/ADR-001-memory-model.md`
- `docs/adrs/ADR-002-autonomy-gears.md`
- `docs/adrs/ADR-003-capability-contracts.md`
- `specs/ToolSpec.schema.json`
- `specs/Intent.schema.json`
- `specs/Plan.schema.json`
- `infra/db/migrations/0001_init.sql`
- `infra/db/neo4j/bootstrap.cypher`

---

## Next Actions (suggested)
1) Accept ADR-000..003 (or propose edits).  
2) Generate the repo scaffold with these files/paths.  
3) Implement Tool Registry loader with JSON Schema validation and tests.  
4) Wire Postgres + Neo4j; run migrations & bootstrap.  
5) Expose `/intent` and `/plan/:id/execute` endpoints stubbed against schemas.
