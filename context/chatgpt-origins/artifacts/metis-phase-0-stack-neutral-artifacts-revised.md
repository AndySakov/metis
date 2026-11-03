# METIS Phase 0 — Stack‑Neutral Artifacts (Revised)

**Why this doc?** You asked to keep tech choices open. This replaces vendor-specific migrations with **interface contracts** and adds a stack-neutral **Core API & Events** spec so we can demo the core loop with in‑memory adapters first.

---

## 1) Storage Interfaces (roles, guarantees, APIs)

### 1.1 EventLogStore (timeline)
- **Purpose:** immutable log of intents, plans, tool calls, approvals, writes.
- **Guarantees:** append-only, ordered by `ts`, idempotent by `id`.
- **API (transport-agnostic; HTTP shape shown):**
  - `PUT /eventlog/{id}` body: `Event` → 201 Created (or 200 OK if idempotent)
  - `GET /eventlog?fromTs&toTs&types[]&project`
  - `POST /eventlog/_query` body: filter DSL (AND/OR on fields)
- **Retention:** per-bucket TTLs; export to object store before purge.

**Event (schema excerpt)**
```json
{
  "id": "uuid",
  "ts": 1733872000,
  "type": "PLAN_CREATED|TOOL_CALLED|ARTIFACT_WRITTEN|APPROVAL_REQUESTED|APPROVAL_GRANTED|PREFERENCE",
  "actor": "user|metis",
  "project": "string",
  "payload": {"any": "json"}
}
```

### 1.2 GraphStore (provenance & work graph)
- **Purpose:** entities (Project, Artifact, Decision, Claim, Source, Person) + relations.
- **Guarantees:** transactional writes; upsert by natural keys; traversals by pattern.
- **API (model-agnostic):**
  - `POST /graph/nodes` body: array `{type, id, props}`
  - `POST /graph/edges` body: array `{from, rel, to, props}`
  - `POST /graph/query` body: pattern DSL (match triples + predicates)
- **Migrations:** versioned shape registry; declarative transforms.

### 1.3 VectorIndex (retrieval)
- **Purpose:** ANN search on chunked artifacts/notes.
- **API:**
  - `POST /vectors/{collection}` upsert `{id, embedding:[..], meta:{...}}`
  - `POST /vectors/{collection}/search` `{embedding, k, filters}` → hits with `score` + `meta`

### 1.4 ArtifactStore (blobs)
- **Purpose:** checksummed artifacts (markdown, openapi, notebook, binary).
- **API:** `PUT/GET/HEAD /artifacts/{id}` with metadata `{checksum, kind, title, created_by}`; supports versioning.

### 1.5 In‑memory reference (dev)
Ship a dev server implementing the above **in memory** (or local files) with the same HTTP surface. This unblocks the Core Loop demo without committing to any vendor.

---

## 2) Capability Contracts & Plugin ABI (recap)
- **Capability ID (CAP ID):** `domain.action@MAJOR.MINOR` (e.g., `design.c4@1.2`). Planner targets CAP IDs, not implementation names.
- **SemVer:** MAJOR=breaking; MINOR=compatible additions; PATCH=fixed. Planner supports `N-2` MINOR.
- **Packaging:** portable module format (containers or WASM components)—final choice TBD.
- **I/O Contracts:** JSON Schemas for input/output; strict validation.
- **Hot‑Swap Loader:** health checks, canary rollouts, auto‑rollback.
- **Signing/Attestation:** modules are signed; provenance recommended.

> See ADR‑003 for rationale and responsibilities.

---

## 3) Core API (OpenAPI 3.1 — stack‑neutral)

```yaml
openapi: 3.1.0
info:
  title: METIS Core API (stack-neutral)
  version: 0.1.0
servers:
  - url: http://localhost:8080
paths:
  /intent:
    post:
      summary: Submit an intent; returns a planned execution
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: https://metis/specs/Intent.schema.json
      responses:
        '201':
          description: Plan created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Plan'
  /plans/{id}:
    get:
      summary: Get a plan by id
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Plan'
  /plans/{id}/execute:
    post:
      summary: Execute a plan (or step range) in the runner
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: false
        content:
          application/json:
            schema:
              type: object
              properties:
                steps: { type: array, items: { type: string } }
                dryRun: { type: boolean, default: false }
      responses:
        '202':
          description: Accepted; execution started
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ExecutionReport'
  /artifacts/{id}:
    get:
      summary: Get artifact metadata
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Artifact'
  /eventlog/{id}:
    put:
      summary: Append (idempotent) event to log
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Event'
      responses:
        '201': { description: Created }
        '200': { description: OK }
  /eventlog:
    get:
      summary: Query events by time and type
      parameters:
        - name: fromTs
          in: query
          schema: { type: integer }
        - name: toTs
          in: query
          schema: { type: integer }
        - name: types
          in: query
          schema: { type: array, items: { type: string } }
        - name: project
          in: query
          schema: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/Event' }
  /tools:
    get:
      summary: List registered capabilities
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: array
                items: { $ref: '#/components/schemas/ToolSpec' }
  /tools/validate:
    post:
      summary: Validate a ToolSpec against its schemas and tests
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ToolSpec'
      responses:
        '200':
          description: Validation report
          content:
            application/json:
              schema:
                type: object
                properties:
                  valid: { type: boolean }
                  errors: { type: array, items: { type: string } }
components:
  schemas:
    Intent:
      $ref: https://metis/specs/Intent.schema.json
    Plan:
      $ref: https://metis/specs/Plan.schema.json
    ToolSpec:
      $ref: https://metis/specs/ToolSpec.schema.json
    Event:
      type: object
      required: [id, ts, type, actor, payload]
      properties:
        id: { type: string }
        ts: { type: integer }
        type: { type: string }
        actor: { type: string, enum: [user, metis] }
        project: { type: string }
        payload: { }
    Artifact:
      type: object
      required: [id, kind, title, uri, checksum, created_at, created_by]
      properties:
        id: { type: string }
        kind: { type: string }
        title: { type: string }
        uri: { type: string }
        checksum: { type: string }
        created_at: { type: string, format: date-time }
        created_by: { type: string, enum: [user, metis] }
        metadata: { }
        provenance: { }
    ExecutionReport:
      type: object
      properties:
        executionId: { type: string }
        status: { type: string, enum: [accepted, running, completed, failed] }
        startedAt: { type: string, format: date-time }
        stepResults:
          type: array
          items:
            type: object
            properties:
              stepId: { type: string }
              status: { type: string, enum: [pending, running, completed, failed] }
              output: { }
```

---

## 4) Event Bus (AsyncAPI 2.6 — stack‑neutral)

```yaml
asyncapi: '2.6.0'
info:
  title: METIS Events (stack-neutral)
  version: 0.1.0
channels:
  plan/created:
    subscribe:
      message:
        name: PlanCreated
        payload:
          $ref: '#/components/schemas/Event'
  tool/started:
    subscribe:
      message:
        name: ToolStarted
        payload: { $ref: '#/components/schemas/Event' }
  tool/completed:
    subscribe:
      message:
        name: ToolCompleted
        payload: { $ref: '#/components/schemas/Event' }
  artifact/written:
    subscribe:
      message:
        name: ArtifactWritten
        payload: { $ref: '#/components/schemas/Event' }
  approval/requested:
    subscribe:
      message:
        name: ApprovalRequested
        payload: { $ref: '#/components/schemas/Event' }
  approval/granted:
    subscribe:
      message:
        name: ApprovalGranted
        payload: { $ref: '#/components/schemas/Event' }
  preference/recorded:
    subscribe:
      message:
        name: PreferenceRecorded
        payload: { $ref: '#/components/schemas/Event' }
components:
  schemas:
    Event:
      type: object
      required: [id, ts, type, actor, payload]
      properties:
        id: { type: string }
        ts: { type: integer }
        type: { type: string }
        actor: { type: string, enum: [user, metis] }
        project: { type: string }
        payload: { }
```

---

## 5) Tool Registry — Conformance (stack‑neutral)

**Validation rules**
- JSON Schema validation passes for ToolSpec, inputSchema, outputSchema.
- `capability` matches `^[a-z]+\.[a-z0-9_]+@\d+\.\d+$`.
- Tests (if provided) run in sandbox with given input → output matches `expect` (exact or schema).
- Module package is signed (dev mode can allow unsigned with warning).

**Test vectors**
```json
[
  {
    "name": "design.prd basic",
    "tool": {
      "name": "design-prd",
      "version": "0.1.0",
      "capability": "design.prd@1.0",
      "implementation": {"kind": "container-or-wasm", "entrypoint": "main"},
      "inputSchema": {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]},
      "outputSchema": {"type": "object", "properties": {"markdown": {"type": "string"}}}
    },
    "tests": [
      {"name": "minimal", "input": {"title": "Hello"}, "expect": {"markdown": "*"}}
    ]
  }
]
```

---

## 6) Core Loop (Dev demo with in‑memory stores)
1. `POST /intent` → planner returns `Plan` and emits `plan/created`.
2. `POST /plans/{id}/execute` → tool steps are dispatched; `tool/started`/`tool/completed` events are emitted; artifacts written via `ArtifactStore` emit `artifact/written`.
3. All state changes append an `Event` to `EventLogStore`.

**Exit criteria for Phase 1 demo**
- Idea → PRD artifact (markdown) stored in `ArtifactStore` and listed via `/artifacts/{id}`.
- Event log shows the full trace; plan can be resumed mid‑way.

---

## 7) Next Actions
- Approve these stack‑neutral interfaces.
- I’ll generate the **in‑memory dev server** + **Tool Registry** skeleton (validation only) using these contracts (language for reference impl is still TBD—can be swapped later).
