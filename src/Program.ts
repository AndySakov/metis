/**
 * Runs METIS: `pnpm start`.
 *
 * Launches `App.layerFromEnv` only when this file is the process's entry point. Every file under
 * `src/` is re-exported from `src/index.ts`, and importing the package must not start a server.
 */

import { NodeRuntime } from "@effect/platform-node"
import { Layer } from "effect"
import { pathToFileURL } from "node:url"

import * as App from "./App.js"

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  NodeRuntime.runMain(Layer.launch(App.layerFromEnv))
}
