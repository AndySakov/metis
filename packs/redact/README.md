# redact: the reference pack

A pack adds a domain to METIS without touching core. This one adds `text.redact@0.1`, which
replaces emails, phone numbers, Luhn-valid card numbers and IP addresses in pasted text. It is
small on purpose: it is here to show the shape of a pack.

```text
redact/
  pack.json                 the manifest (specs/packs/Pack.schema.json)
  src/server.ts             the MCP server: the only place the pack's code runs
  src/Redact.ts             the rules, free of MCP so they can be tested directly
  capabilities/             the capability's input and output contracts
  tools/                    the descriptor binding the server's tool to the capability
  conformance/redact.json   the vectors the rules are held to
```

Run METIS with it: `METIS_PACKS=packs/redact pnpm start`, then "Redact the personal details in
this" with some text pasted.

## Writing a pack

- **Servers.** Name them outside `metis.*`, which is core's. `command: "node"` is the Node running
  METIS, and `${pack}` in an argument is the pack's directory. A server gets only the environment
  variables listed in its `env`.
- **Descriptors.** Each binds a tool on one of the pack's own servers to a capability, and
  declares `idempotent` and `isolation` like any of core's. Their schema `$ref`s are relative to
  the descriptor, and are resolved at load, so sampled verification checks outputs against them.
- **The model.** A server whose manifest entry says `"model": true` may ask METIS for completions
  with MCP sampling (`server.createMessage`). The configured model answers, so the pack needs no
  key; each of its tools must declare the `model.sample` scope; and one tool call may ask at most
  eight times. Check what comes back in code before returning it: `packs/plain` shows how.
- **Templates.** A `match` pattern (case-insensitive), an optional `unless`, and steps whose
  input strings may use `{{goal}}` and `{{pasted}}`. With `needsPasted`, a goal with nothing pasted
  plans a question instead. Templates are tried after core's specific ones and before its broad
  ones.
- **Contracts are tested.** Packs in this repository are held by `test/specs/` like `specs/` is:
  the manifest must decode, every descriptor must conform, and every `$ref` must resolve.

A pack outside this repository needs its own dependencies for its servers; this one borrows
METIS's (`@modelcontextprotocol/sdk`, `zod`).
