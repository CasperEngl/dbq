import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Schema } from "effect";
import { ConfigError } from "./errors";
import { databaseStructureCachePath, rootDirectory, urlCachePath } from "./paths";
import {
  DatabaseStructureCacheFileSchema,
  UrlCacheFileSchema,
  emptyDatabaseStructureCacheFile,
  emptyUrlCacheFile,
  type CachedDatabaseStructure,
  type CachedDatabaseUrl,
  type DatabaseStructure,
} from "./schema";

export function hashCacheKey(cacheKey: string) {
  return createHash("sha256").update(cacheKey).digest("hex");
}

export const readOptionalFile = (filePath: string) =>
  Effect.tryPromise({
    try: () => readFile(filePath, "utf8"),
    catch: () => undefined,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export const readDiskCachedDatabaseUrl = Effect.fn("readDiskCachedDatabaseUrl")(function* (
  cacheKey: string,
) {
  const contents = yield* readOptionalFile(urlCachePath);

  if (!contents) {
    return undefined;
  }

  const parsedCache = yield* parseUrlCache(contents);
  const cachedDatabaseUrl = parsedCache.entries?.[cacheKey];

  if (!cachedDatabaseUrl) {
    return undefined;
  }

  if (cachedDatabaseUrl.expiresAt !== null && cachedDatabaseUrl.expiresAt <= Date.now()) {
    return undefined;
  }

  return cachedDatabaseUrl.databaseUrl;
});

export const writeDiskCachedDatabaseUrl = Effect.fn("writeDiskCachedDatabaseUrl")(function* (
  cacheKey: string,
  databaseUrl: string,
  databaseUrlCacheDurationSeconds: number,
) {
  if (databaseUrlCacheDurationSeconds <= 0) {
    return;
  }

  const contents = yield* readOptionalFile(urlCachePath);
  const parsedCache = contents ? yield* parseUrlCache(contents) : emptyUrlCacheFile;
  const entries = { ...parsedCache.entries } satisfies Record<string, CachedDatabaseUrl>;

  entries[cacheKey] = {
    databaseUrl,
    expiresAt: Date.now() + databaseUrlCacheDurationSeconds * 1000,
  };

  yield* writeSecureJsonFile(urlCachePath, { entries });
});

export const readDiskCachedDatabaseStructure = Effect.fn("readDiskCachedDatabaseStructure")(
  function* (cacheKey: string) {
    const contents = yield* readOptionalFile(databaseStructureCachePath);

    if (!contents) {
      return undefined;
    }

    const parsedCache = yield* parseDatabaseStructureCache(contents);
    const cachedDatabaseStructure = parsedCache.entries?.[cacheKey];

    if (!cachedDatabaseStructure) {
      return undefined;
    }

    if (
      cachedDatabaseStructure.expiresAt !== null &&
      cachedDatabaseStructure.expiresAt <= Date.now()
    ) {
      return undefined;
    }

    return cachedDatabaseStructure;
  },
);

export const writeDiskCachedDatabaseStructure = Effect.fn("writeDiskCachedDatabaseStructure")(
  function* (
    cacheKey: string,
    databaseStructure: DatabaseStructure,
    databaseStructureCacheDurationSeconds: number,
  ) {
    const contents = yield* readOptionalFile(databaseStructureCachePath);
    const parsedCache = contents
      ? yield* parseDatabaseStructureCache(contents)
      : emptyDatabaseStructureCacheFile;
    const entries = {
      ...parsedCache.entries,
    } satisfies Record<string, CachedDatabaseStructure>;

    entries[cacheKey] = {
      databaseStructure,
      expiresAt:
        databaseStructureCacheDurationSeconds > 0
          ? Date.now() + databaseStructureCacheDurationSeconds * 1000
          : null,
    };

    yield* writeSecureJsonFile(databaseStructureCachePath, { entries });
  },
);

function writeSecureJsonFile(filePath: string, value: unknown) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(filePath), { recursive: true }),
      catch: (cause) => new ConfigError({ message: `Could not create ${rootDirectory}`, cause }),
    });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
          mode: 0o600,
        }),
      catch: (cause) => new ConfigError({ message: `Could not write ${filePath}`, cause }),
    });
    yield* Effect.tryPromise({
      try: () => chmod(filePath, 0o600),
      catch: (cause) => new ConfigError({ message: `Could not secure ${filePath}`, cause }),
    });
  });
}

function parseUrlCache(contents: string) {
  return Schema.parseJson(UrlCacheFileSchema)
    .pipe(Schema.decodeUnknown)(contents)
    .pipe(Effect.catchAll(() => Effect.succeed(emptyUrlCacheFile)));
}

function parseDatabaseStructureCache(contents: string) {
  return Schema.parseJson(DatabaseStructureCacheFileSchema)
    .pipe(Schema.decodeUnknown)(contents, { onExcessProperty: "error" })
    .pipe(Effect.catchAll(() => Effect.succeed(emptyDatabaseStructureCacheFile)));
}
