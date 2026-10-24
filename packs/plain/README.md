# plain: a reference pack that uses the model

`text.plain@0.1` rewrites pasted text in plain English. It is here to show the pattern for any pack
that writes with a model: **the model drafts, code checks**.

- The draft comes from whatever model METIS is configured with, asked for over MCP sampling
  (`server.createMessage` in `src/server.ts`). The manifest grants it with `"model": true`, and
  the descriptor declares the `model.sample` scope. The pack holds no key and runs no CLI.
- `src/Facts.ts` checks the draft: every number, date, time, amount, link and email of the
  original must appear in it exactly as written, and it must not be longer. The model's word is
  never taken for that.
- A failing draft goes back to the model once, with what it dropped. A second failure is returned
  with `check.passed: false` and said plainly in the document, never passed off as clean.

Run it with a model configured: `METIS_MODEL_CLI=claude METIS_PACKS=packs/plain pnpm start`, then
"Rewrite this in plain English" with some text pasted.
