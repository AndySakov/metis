import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "./execute.js";

const ajv = new Ajv.default({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateSchema: false,
});
addFormats.default(ajv);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../");

async function derefMaybe(schema: any): Promise<any> {
  if (!schema) return undefined;
  if (typeof schema === "string") {
    // If schema is a string path, try to load it (relative inside specs)
    try {
      const normalized = schema.replace(/^(\.{2}\/)+/, "");
      const filePath = resolve(repoRoot, "specs", normalized);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (schema.$ref && typeof schema.$ref === "string") {
    try {
      const normalizedRef = schema.$ref.replace(/^(\.{2}\/)+/, "");
      const filePath = resolve(repoRoot, "specs", normalizedRef);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw);
    } catch {
      // fallthrough to use as-is
    }
  }
  return schema;
}

export async function validateToolSpec(spec: any): Promise<{
  valid: boolean;
  errors: string[];
  testResults?: Array<{ name: string; ok: boolean; error?: string }>;
}> {
  const errors: string[] = [];
  try {
    // Validate ToolSpec structure against ToolSpec.schema.json
    const toolSpecSchemaPath = resolve(repoRoot, "specs/ToolSpec.schema.json");
    const toolSpecSchema = JSON.parse(
      await readFile(toolSpecSchemaPath, "utf8")
    );
    const toolSpecId =
      typeof toolSpecSchema?.$id === "string" ? toolSpecSchema.$id : undefined;
    const v =
      toolSpecId && ajv.getSchema(toolSpecId)
        ? ajv.getSchema(toolSpecId)!
        : ajv.compile(toolSpecSchema);
    const ok = v(spec);
    if (!ok)
      errors.push(
        ...(v.errors || []).map((e) => `${e.instancePath || "/"} ${e.message}`)
      );
  } catch (e: any) {
    errors.push(
      `ToolSpec schema validation failed: ${String(e?.message || e)}`
    );
  }

  // Resolve and compile input/output schemas if provided
  let validateIn: ((d: any) => boolean) | undefined;
  let validateOut: ((d: any) => boolean) | undefined;
  try {
    const inSchema = await derefMaybe(spec?.inputSchema);
    if (inSchema) {
      const inId = typeof inSchema?.$id === "string" ? inSchema.$id : undefined;
      const vin =
        inId && ajv.getSchema(inId)
          ? ajv.getSchema(inId)!
          : ajv.compile(inSchema);
      validateIn = (d: any) => !!vin(d);
    }
  } catch (e: any) {
    errors.push(`inputSchema invalid: ${String(e?.message || e)}`);
  }
  try {
    const outSchema = await derefMaybe(spec?.outputSchema);
    if (outSchema) {
      const outId =
        typeof outSchema?.$id === "string" ? outSchema.$id : undefined;
      const vout =
        outId && ajv.getSchema(outId)
          ? ajv.getSchema(outId)!
          : ajv.compile(outSchema);
      validateOut = (d: any) => !!vout(d);
    }
  } catch (e: any) {
    errors.push(`outputSchema invalid: ${String(e?.message || e)}`);
  }

  // Execute tests against the mocked runner, if provided
  const testResults: Array<{ name: string; ok: boolean; error?: string }> = [];
  if (Array.isArray(spec?.tests)) {
    for (const t of spec.tests) {
      const name = String(t?.name || "test");
      try {
        const output = await runTool(spec, t.input ?? {});
        if (validateOut) {
          const ok = validateOut(output);
          testResults.push({
            name,
            ok,
            error: ok ? undefined : "output does not match outputSchema",
          });
        } else if (t.expect) {
          // If expect provided as a JSON Schema, compile and validate
          if (t.expect && typeof t.expect === "object") {
            const vexp = ajv.compile(t.expect);
            const ok = vexp(output);
            testResults.push({
              name,
              ok,
              error: ok ? undefined : "output does not satisfy expect",
            });
          } else {
            testResults.push({ name, ok: true });
          }
        } else {
          testResults.push({ name, ok: true });
        }
      } catch (e: any) {
        testResults.push({ name, ok: false, error: String(e?.message || e) });
      }
    }
  }

  const valid = errors.length === 0 && testResults.every((t) => t.ok);
  return { valid, errors, testResults };
}
