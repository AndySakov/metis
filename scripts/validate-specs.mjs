#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { globby } from "globby";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true,
  validateSchema: false,
});
addFormats(ajv);

const main = async () => {
  let ok = true;
  const jsonFiles = await globby(["specs/**/*.json"]);
  for (const file of jsonFiles) {
    try {
      const text = await readFile(file, "utf8");
      JSON.parse(text);
    } catch (e) {
      console.error(`JSON parse error in ${file}:`, e.message);
      ok = false;
    }
  }
  const toolSpecSchema = JSON.parse(
    await readFile("specs/ToolSpec.schema.json", "utf8")
  );
  ajv.addSchema(toolSpecSchema, "ToolSpec");
  const toolSpecs = await globby(["specs/tools/**/*.json"]);
  for (const file of toolSpecs) {
    const data = JSON.parse(await readFile(file, "utf8"));
    const validate = ajv.getSchema("ToolSpec") ?? ajv.compile(toolSpecSchema);
    const valid = validate(data);
    if (!valid) {
      ok = false;
      console.error(`ToolSpec validation failed for ${file}:`, validate.errors);
    }
    if (
      data.capability &&
      !/^[a-z][a-z0-9_.-]*\.[a-z][a-z0-9_.-]*@[0-9]+\.[0-9]+$/.test(
        data.capability
      )
    ) {
      ok = false;
      console.error(`Invalid CAP ID in ${file}: ${data.capability}`);
    }
  }
  if (!ok) process.exit(1);
  console.log("Specs OK");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
