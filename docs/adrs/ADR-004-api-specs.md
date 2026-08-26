# ADR-004: API & Event Spec Canon

Status: Accepted

## Context

We need a single source of truth for the Core API and Event Bus that is language- and stack-neutral, versionable, and consumable by clients and generators. JSON Schema compatibility should be first-class to validate payloads and ToolSpecs.

## Decision

- Adopt OpenAPI 3.1 for the Core API surface in `specs/api/openapi.yaml`.
- Adopt AsyncAPI 2.6 for event channels in `specs/events/asyncapi.yaml`.
- Adopt JSON Schema 2020-12 for shared payload schemas in `specs/*.schema.json` and capability I/O.
- Reference shared schemas via `$ref` from OpenAPI/AsyncAPI to avoid duplication.
- Treat these spec files as canonical contracts; code must conform, not vice versa.
- Establish CI checks: lint OpenAPI/AsyncAPI; validate examples against schemas; fail on broken `$ref`s.

## Consequences

- Enables contract-first development, client stubs, and conformance tests.
- Requires spec review discipline and CI wiring.
- Decouples protocol details from implementation; multiple languages can implement the same contracts.

## References

- `specs/api/openapi.yaml`, `specs/events/asyncapi.yaml`
- `specs/Intent.schema.json`, `specs/Plan.schema.json`, `specs/Event.schema.json`, `specs/Artifact.schema.json`
