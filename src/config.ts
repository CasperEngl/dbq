import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import { ConfigError } from "./errors";
import { configPath } from "./paths";
import { ConfigSchema, defaultSecurity } from "./schema";

export const loadConfig = Effect.fn("loadConfig")(function* () {
  const contents = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: (cause) => new ConfigError({ message: `Could not read ${configPath}`, cause }),
  });

  const parsedConfig = yield* Effect.try({
    try: () => parseJsonc(contents),
    catch: (cause) => new ConfigError({ message: `Could not parse ${configPath}`, cause }),
  });

  const config = yield* ConfigSchema.pipe(Schema.decodeUnknown)(parsedConfig).pipe(
    Effect.mapError((cause) => new ConfigError({ message: `Invalid ${configPath}`, cause })),
  );

  const security = config.security ?? defaultSecurity;

  return { ...config, security };
});
