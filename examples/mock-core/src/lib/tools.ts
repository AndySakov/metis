import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { createLogger } from "./logger.js";
const log = createLogger("tools");

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../");
const resolveRepo = (...p: string[]) => resolve(repoRoot, ...p);

export async function listExampleToolSpecFiles(): Promise<string[]> {
  const dir = resolveRepo("specs/tools/examples");
  log.debug("discover_tools_dir", { dir });
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(dir, e.name));
}

export async function loadToolSpecs(): Promise<any[]> {
  const files = await listExampleToolSpecFiles();
  log.info("load_tool_specs", { files: files.length });
  const specs = await Promise.all(
    files.map(async (f) => {
      const raw = await readFile(f, "utf8");
      try {
        const parsed = JSON.parse(raw);
        log.debug("tool_spec_loaded", {
          file: f,
          capability: parsed?.capability,
        });
        return parsed;
      } catch (e: any) {
        log.error("tool_spec_parse_error", {
          file: f,
          error: String(e?.message || e),
        });
        return null;
      }
    })
  );
  return specs.filter(Boolean);
}

export function selectToolForCapability(
  tools: any[],
  capability: string
): any | undefined {
  const exact = tools.find((t) => t.capability === capability);
  if (exact) return exact;
  const [capName, ver] = capability.split("@");
  const major = ver?.split(".")[0];
  const selected = tools.find((t) =>
    t.capability?.startsWith(`${capName}@${major}.`)
  );
  log.debug("select_tool", { capability, found: Boolean(selected) });
  return selected;
}
