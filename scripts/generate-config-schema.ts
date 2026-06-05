#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";
import { JSONSchema } from "effect";
import { ConfigSchema } from "../src/schema";

const configSchema = JSONSchema.make(ConfigSchema, {
  target: "jsonSchema2020-12",
});

const schema = {
  ...configSchema,
  $id: "https://raw.githubusercontent.com/CasperEngl/dbq/main/config.schema.json",
  title: "DBQ config",
};

await writeFile("config.schema.json", `${JSON.stringify(schema, null, 2)}\n`);
