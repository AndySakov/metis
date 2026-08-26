# ADR-009: Errors & Audit Envelopes

Status: Accepted

## Context

We need consistent error payloads and minimal audit fields across APIs and stores to simplify debugging, correlation, and forensics. V1 requires predictable envelopes without constraining implementation details.

## Decision

- Error envelope (API/tool execution):
  - shape: `{ code: string, message: string, details?: object, correlationId?: string }`
  - `code` taxonomy: `VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`, `UNAVAILABLE`, `INTERNAL`.
  - The orchestrator sets/propagates `correlationId` per request/run.
- Audit fields (writes):
  - include `actor` and `ts` (UNIX epoch seconds) on all `Event` writes.
  - artifact metadata includes `created_at`, `created_by`, `checksum`.
- Logging:
  - errors emit an `Event` with `type=ERROR` and the same `correlationId` (payload may be redacted by policy).

## Consequences

- Easier cross-service correlation and incident analysis.
- Minimal overhead; compatible with current schemas.

## References

- `specs/Event.schema.json`, `specs/Artifact.schema.json`
- `specs/api/openapi.yaml` (execution report may include error envelopes)
