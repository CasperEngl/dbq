import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { Console, Effect, Layer, Schema } from "effect";
import { parse as parseJsonc } from "jsonc-parser";
import packageJson from "../package.json" with { type: "json" };

const version = packageJson.version;
const rootDirectory = process.env.DBQ_HOME ?? join(homedir(), ".dbq");
const configPath = join(rootDirectory, "config.jsonc");
const auditLogPath = join(rootDirectory, "audit.log");
const urlCachePath = join(rootDirectory, "url-cache.json");
const databaseStructureCachePath = join(rootDirectory, "database-structure-cache.json");
const defaultConfirmCommand = join(rootDirectory, "bin", "dbq-confirm");

const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.filter((value) => value >= 0),
);

const DatabaseBaseSchema = Schema.Struct({
  engine: Schema.NonEmptyString,
  readonly: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  queryCommand: Schema.NonEmptyString.pipe(Schema.optional),
  describeCommand: Schema.NonEmptyString.pipe(Schema.optional),
  databaseUrlCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  urlCacheTtlSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  databaseStructureCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
});

const DatabaseSchema = DatabaseBaseSchema.pipe(
  Schema.extend(
    Schema.Union(
      Schema.Struct({
        url: Schema.NonEmptyString,
      }),
      Schema.Struct({
        urlCommand: Schema.NonEmptyString,
      }),
      Schema.Struct({
        urlEnv: Schema.NonEmptyString,
      }),
    ),
  ),
);

const ConfigSchema = Schema.Struct({
  security: Schema.Struct({
    confirmQueries: Schema.Boolean.pipe(
      Schema.optionalWith({
        default: () => true,
      }),
    ),
    confirmCommand: Schema.NonEmptyString.pipe(Schema.optional),
    databaseUrlCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
    urlCacheTtlSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
    databaseStructureCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  }).pipe(
    Schema.optionalWith({
      default: () => ({
        confirmQueries: true,
        databaseUrlCacheDurationSeconds: 0,
        databaseStructureCacheDurationSeconds: 0,
      }),
    }),
  ),
  databases: Schema.Record({
    key: Schema.NonEmptyString,
    value: DatabaseSchema,
  }),
});

const CachedDatabaseUrlSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

const UrlCacheFileSchema = Schema.Struct({
  entries: Schema.Record({
    key: Schema.NonEmptyString,
    value: CachedDatabaseUrlSchema,
  }).pipe(Schema.optionalWith({ default: () => ({}) })),
});

const emptyUrlCacheFile = UrlCacheFileSchema.pipe(Schema.decodeUnknownSync)({ entries: {} });

const DatabaseStructureColumnSchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  nullable: Schema.Boolean,
  references: Schema.Struct({
    namespace: Schema.String,
    relation: Schema.String,
    column: Schema.String,
  }).pipe(Schema.optional),
});

const DatabaseStructureRelationSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("table", "view", "relation"),
  columns: Schema.Array(DatabaseStructureColumnSchema),
});

const DatabaseStructureNamespaceSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("schema", "catalog", "namespace"),
  relations: Schema.Array(DatabaseStructureRelationSchema),
});

const DatabaseStructureSchema = Schema.Struct({
  databaseId: Schema.NonEmptyString,
  engine: Schema.NonEmptyString,
  generatedAt: NonNegativeIntegerSchema,
  namespaces: Schema.Array(DatabaseStructureNamespaceSchema),
});

const CachedDatabaseStructureSchema = Schema.Struct({
  databaseStructure: DatabaseStructureSchema,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

const DatabaseStructureCacheFileSchema = Schema.Struct({
  entries: Schema.Record({
    key: Schema.NonEmptyString,
    value: CachedDatabaseStructureSchema,
  }).pipe(Schema.optionalWith({ default: () => ({}) })),
});

const emptyDatabaseStructureCacheFile = DatabaseStructureCacheFileSchema.pipe(
  Schema.decodeUnknownSync,
)({
  entries: {},
});

type Config = typeof ConfigSchema.Type;
type Database = typeof DatabaseSchema.Type;
type Security = NonNullable<Config["security"]>;
type QueryDatabaseInput = {
  databaseId: string;
  sql: string;
};
type DescribeDatabaseInput = {
  databaseId: string;
  refresh: boolean;
  format: "compact" | "json";
  namespace?: string;
  relations?: ReadonlyArray<string>;
};
type CachedDatabaseUrl = typeof CachedDatabaseUrlSchema.Type;
type DatabaseStructureColumn = typeof DatabaseStructureColumnSchema.Type;
type DatabaseStructure = typeof DatabaseStructureSchema.Type;
type CachedDatabaseStructure = typeof CachedDatabaseStructureSchema.Type;

const defaultSecurity = {
  confirmQueries: true,
  databaseUrlCacheDurationSeconds: 0,
  databaseStructureCacheDurationSeconds: 0,
};

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.Unknown.pipe(Schema.optional),
}) {}

class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

class ConfirmationError extends Schema.TaggedError<ConfirmationError>()("ConfirmationError", {
  message: Schema.String,
  cause: Schema.Unknown.pipe(Schema.optional),
}) {}

class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.Unknown.pipe(Schema.optional),
}) {}

class AuditError extends Schema.TaggedError<AuditError>()("AuditError", {
  message: Schema.String,
  cause: Schema.Unknown.pipe(Schema.optional),
}) {}

const getDatabaseUrlResolver = (database: Database) => {
  if ("url" in database) {
    return "url";
  }

  if ("urlCommand" in database) {
    return "urlCommand";
  }

  return "urlEnv";
};

class Dbq extends Effect.Service<Dbq>()("Dbq", {
  sync: () => {
    const databaseUrlCache = new Map<string, CachedDatabaseUrl>();
    const databaseStructureCache = new Map<string, CachedDatabaseStructure>();

    const loadConfig = Effect.fn("Dbq.loadConfig")(function* () {
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

    const writeAuditEntry = Effect.fn("Dbq.writeAuditEntry")(function* (
      entry: Record<string, unknown>,
    ) {
      yield* Effect.tryPromise({
        try: () => mkdir(dirname(auditLogPath), { recursive: true }),
        catch: (cause) =>
          new AuditError({
            message: `Could not create ${rootDirectory}`,
            cause,
          }),
      });
      yield* Effect.tryPromise({
        try: () =>
          appendFile(
            auditLogPath,
            `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
          ),
        catch: (cause) => new AuditError({ message: `Could not write ${auditLogPath}`, cause }),
      });
    });

    const getDatabase = Effect.fn("Dbq.getDatabase")(function* (
      config: Config,
      databaseId: string,
    ) {
      const database = config.databases[databaseId];

      if (!database) {
        return yield* new ValidationError({
          message: `Unknown database: ${databaseId}`,
        });
      }

      return database;
    });

    const getCachedDatabaseUrl = (cacheKey: string) => {
      const cachedDatabaseUrl = databaseUrlCache.get(cacheKey);

      if (!cachedDatabaseUrl) {
        return undefined;
      }

      if (cachedDatabaseUrl.expiresAt !== null && cachedDatabaseUrl.expiresAt <= Date.now()) {
        databaseUrlCache.delete(cacheKey);
        return undefined;
      }

      return cachedDatabaseUrl.databaseUrl;
    };

    const setCachedDatabaseUrl = (
      cacheKey: string,
      databaseUrl: string,
      databaseUrlCacheDurationSeconds: number,
    ) => {
      databaseUrlCache.set(cacheKey, {
        databaseUrl,
        expiresAt:
          databaseUrlCacheDurationSeconds > 0
            ? Date.now() + databaseUrlCacheDurationSeconds * 1000
            : null,
      });
    };

    const getCachedDatabaseStructure = (cacheKey: string) => {
      const cachedDatabaseStructure = databaseStructureCache.get(cacheKey);

      if (!cachedDatabaseStructure) {
        return undefined;
      }

      if (
        cachedDatabaseStructure.expiresAt !== null &&
        cachedDatabaseStructure.expiresAt <= Date.now()
      ) {
        databaseStructureCache.delete(cacheKey);
        return undefined;
      }

      return cachedDatabaseStructure.databaseStructure;
    };

    const setCachedDatabaseStructure = (
      cacheKey: string,
      databaseStructure: DatabaseStructure,
      databaseStructureCacheDurationSeconds: number,
    ) => {
      databaseStructureCache.set(cacheKey, {
        databaseStructure,
        expiresAt:
          databaseStructureCacheDurationSeconds > 0
            ? Date.now() + databaseStructureCacheDurationSeconds * 1000
            : null,
      });
    };

    const readOptionalFile = (filePath: string) =>
      Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

    const readDiskCachedDatabaseUrl = Effect.fn("Dbq.readDiskCachedDatabaseUrl")(function* (
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

    const writeDiskCachedDatabaseUrl = Effect.fn("Dbq.writeDiskCachedDatabaseUrl")(function* (
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

      yield* Effect.tryPromise({
        try: () => mkdir(dirname(urlCachePath), { recursive: true }),
        catch: (cause) => new ConfigError({ message: `Could not create ${rootDirectory}`, cause }),
      });
      yield* Effect.tryPromise({
        try: () =>
          writeFile(urlCachePath, `${JSON.stringify({ entries }, null, 2)}\n`, {
            mode: 0o600,
          }),
        catch: (cause) => new ConfigError({ message: `Could not write ${urlCachePath}`, cause }),
      });
      yield* Effect.tryPromise({
        try: () => chmod(urlCachePath, 0o600),
        catch: (cause) => new ConfigError({ message: `Could not secure ${urlCachePath}`, cause }),
      });
    });

    const readDiskCachedDatabaseStructure = Effect.fn("Dbq.readDiskCachedDatabaseStructure")(
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

    const writeDiskCachedDatabaseStructure = Effect.fn("Dbq.writeDiskCachedDatabaseStructure")(
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

        yield* Effect.tryPromise({
          try: () => mkdir(dirname(databaseStructureCachePath), { recursive: true }),
          catch: (cause) =>
            new ConfigError({ message: `Could not create ${rootDirectory}`, cause }),
        });
        yield* Effect.tryPromise({
          try: () =>
            writeFile(databaseStructureCachePath, `${JSON.stringify({ entries }, null, 2)}\n`, {
              mode: 0o600,
            }),
          catch: (cause) =>
            new ConfigError({ message: `Could not write ${databaseStructureCachePath}`, cause }),
        });
        yield* Effect.tryPromise({
          try: () => chmod(databaseStructureCachePath, 0o600),
          catch: (cause) =>
            new ConfigError({ message: `Could not secure ${databaseStructureCachePath}`, cause }),
        });
      },
    );

    const resolveDatabaseUrl = Effect.fn("Dbq.resolveDatabaseUrl")(function* (
      databaseId: string,
      database: Database,
      security: Security,
    ) {
      const databaseUrlCacheDurationSeconds =
        database.databaseUrlCacheDurationSeconds ??
        database.urlCacheTtlSeconds ??
        security.databaseUrlCacheDurationSeconds ??
        security.urlCacheTtlSeconds ??
        0;
      if ("url" in database) {
        return database.url;
      }

      if ("urlCommand" in database) {
        const urlCommand = database.urlCommand;
        const cacheKey = `${databaseId}::${urlCommand}`;
        const cachedDatabaseUrl = getCachedDatabaseUrl(cacheKey);

        if (cachedDatabaseUrl) {
          return cachedDatabaseUrl;
        }

        const diskCacheKey = hashCacheKey(cacheKey);
        const diskCachedDatabaseUrl =
          databaseUrlCacheDurationSeconds > 0
            ? yield* readDiskCachedDatabaseUrl(diskCacheKey)
            : undefined;

        if (diskCachedDatabaseUrl) {
          setCachedDatabaseUrl(cacheKey, diskCachedDatabaseUrl, databaseUrlCacheDurationSeconds);
          return diskCachedDatabaseUrl;
        }

        const processResult = Bun.spawn(["sh", "-lc", urlCommand], {
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => new Response(processResult.stdout).text(),
              catch: (cause) =>
                new ConfigError({
                  message: "Could not read urlCommand stdout",
                  cause,
                }),
            }),
            Effect.tryPromise({
              try: () => new Response(processResult.stderr).text(),
              catch: (cause) =>
                new ConfigError({
                  message: "Could not read urlCommand stderr",
                  cause,
                }),
            }),
            Effect.tryPromise({
              try: () => processResult.exited,
              catch: (cause) =>
                new ConfigError({
                  message: "urlCommand did not exit cleanly",
                  cause,
                }),
            }),
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          return yield* new ConfigError({
            message: stderr.trim() || `urlCommand exited with code ${exitCode}`,
          });
        }

        const databaseUrl = stdout.trim();

        if (!databaseUrl) {
          return yield* new ConfigError({
            message: "urlCommand returned an empty database URL",
          });
        }

        setCachedDatabaseUrl(cacheKey, databaseUrl, databaseUrlCacheDurationSeconds);
        yield* writeDiskCachedDatabaseUrl(
          diskCacheKey,
          databaseUrl,
          databaseUrlCacheDurationSeconds,
        );
        return databaseUrl;
      }

      const urlEnv = database.urlEnv;
      const cacheKey = `${databaseId}:${urlEnv}:`;
      const cachedDatabaseUrl = getCachedDatabaseUrl(cacheKey);

      if (cachedDatabaseUrl) {
        return cachedDatabaseUrl;
      }

      const value = process.env[urlEnv];

      if (!value) {
        return yield* new ConfigError({
          message: `Missing environment variable: ${urlEnv}`,
        });
      }

      setCachedDatabaseUrl(cacheKey, value, databaseUrlCacheDurationSeconds);
      return value;
    });

    const confirmQuery = Effect.fn("Dbq.confirmQuery")(function* (
      security: Security,
      database: Database,
      databaseId: string,
      sql: string,
    ) {
      if (database.readonly || !security.confirmQueries) {
        return;
      }

      const reason = `Allow DBQ to query ${databaseId}: ${summarizeSql(sql)}`;
      const confirmCommand = security.confirmCommand ?? defaultConfirmCommand;
      const processResult = Bun.spawn(["sh", "-lc", `${confirmCommand} "$DBQ_CONFIRM_REASON"`], {
        env: {
          ...process.env,
          DBQ_CONFIRM_REASON: reason,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stderr, exitCode] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => new Response(processResult.stderr).text(),
            catch: (cause) =>
              new ConfirmationError({
                message: "Could not read confirmation stderr",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => processResult.exited,
            catch: (cause) => new ConfirmationError({ message: "Confirmation failed", cause }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new ConfirmationError({
          message: stderr.trim() || "Query authentication denied",
        });
      }
    });

    const runQueryCommand = Effect.fn("Dbq.runQueryCommand")(function* (
      databaseUrl: string,
      queryCommand: string,
      sql: string,
    ) {
      const processResult = Bun.spawn(["sh", "-lc", queryCommand], {
        env: {
          ...process.env,
          DBQ_HOME: rootDirectory,
          DBQ_DATABASE_URL: databaseUrl,
          DBQ_SQL: sql,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => new Response(processResult.stdout).text(),
            catch: (cause) =>
              new DatabaseError({
                message: "Could not read queryCommand stdout",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => new Response(processResult.stderr).text(),
            catch: (cause) =>
              new DatabaseError({
                message: "Could not read queryCommand stderr",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => processResult.exited,
            catch: (cause) =>
              new DatabaseError({
                message: "queryCommand did not exit cleanly",
                cause,
              }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new DatabaseError({
          message: stderr.trim() || `queryCommand exited with code ${exitCode}`,
        });
      }

      return stdout;
    });

    const runDescribeCommand = Effect.fn("Dbq.runDescribeCommand")(function* (
      databaseUrl: string,
      databaseId: string,
      database: Database,
      describeCommand: string,
    ) {
      const processResult = Bun.spawn(["sh", "-lc", describeCommand], {
        env: {
          ...process.env,
          DBQ_HOME: rootDirectory,
          DBQ_DATABASE_URL: databaseUrl,
          DBQ_DATABASE_ID: databaseId,
          DBQ_DATABASE_ENGINE: database.engine,
          DBQ_DATABASE_READONLY: String(database.readonly),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => new Response(processResult.stdout).text(),
            catch: (cause) =>
              new DatabaseError({
                message: "Could not read describeCommand stdout",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => new Response(processResult.stderr).text(),
            catch: (cause) =>
              new DatabaseError({
                message: "Could not read describeCommand stderr",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => processResult.exited,
            catch: (cause) =>
              new DatabaseError({
                message: "describeCommand did not exit cleanly",
                cause,
              }),
          }),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        return yield* new DatabaseError({
          message: stderr.trim() || `describeCommand exited with code ${exitCode}`,
        });
      }

      const databaseStructure = yield* parseDatabaseStructure(stdout);

      if (databaseStructure.databaseId !== databaseId) {
        return yield* new DatabaseError({
          message: `describeCommand returned databaseId ${databaseStructure.databaseId}, expected ${databaseId}`,
        });
      }

      if (databaseStructure.engine !== database.engine) {
        return yield* new DatabaseError({
          message: `describeCommand returned engine ${databaseStructure.engine}, expected ${database.engine}`,
        });
      }

      return databaseStructure;
    });

    const listDatabases = Effect.fn("Dbq.listDatabases")(function* () {
      const config = yield* loadConfig();
      const databases = Object.entries(config.databases).map(([id, database]) => ({
        id,
        engine: database.engine,
        readonly: database.readonly,
        secretResolver: getDatabaseUrlResolver(database),
      }));

      return { databases };
    });

    const describeDatabase = Effect.fn("Dbq.describeDatabase")(function* (
      input: DescribeDatabaseInput,
    ) {
      const { databaseId, refresh, format, namespace, relations } = input;
      const config = yield* loadConfig();
      const database = yield* getDatabase(config, databaseId);

      const databaseUrl = yield* resolveDatabaseUrl(databaseId, database, config.security);
      const databaseStructureCacheDurationSeconds =
        database.databaseStructureCacheDurationSeconds ??
        config.security.databaseStructureCacheDurationSeconds ??
        0;
      const databaseStructureCacheKey = hashCacheKey(`${databaseId}:${databaseUrl}`);
      const startedAt = Date.now();
      const auditId = randomUUID();
      const formatDescribeResponse = (
        databaseStructure: DatabaseStructure,
        databaseStructureCacheStatus: "hit" | "miss" | "refreshed",
      ) =>
        formatDatabaseStructure(
          filterDatabaseStructure(databaseStructure, { namespace, relations }),
          databaseStructureCacheStatus,
          format,
        );

      if (!refresh) {
        const memoryCachedDatabaseStructure = getCachedDatabaseStructure(databaseStructureCacheKey);

        if (memoryCachedDatabaseStructure) {
          yield* writeAuditEntry({
            auditId,
            databaseId,
            operation: "describe",
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            rowCount: countDatabaseStructureColumns(memoryCachedDatabaseStructure),
            cacheHit: true,
          });
          return formatDescribeResponse(memoryCachedDatabaseStructure, "hit");
        }

        const diskCachedDatabaseStructure =
          yield* readDiskCachedDatabaseStructure(databaseStructureCacheKey);

        if (diskCachedDatabaseStructure) {
          databaseStructureCache.set(databaseStructureCacheKey, diskCachedDatabaseStructure);
          yield* writeAuditEntry({
            auditId,
            databaseId,
            operation: "describe",
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            rowCount: countDatabaseStructureColumns(diskCachedDatabaseStructure.databaseStructure),
            cacheHit: true,
          });
          return formatDescribeResponse(diskCachedDatabaseStructure.databaseStructure, "hit");
        }
      }

      const describeCommand = database.describeCommand;

      if (!describeCommand) {
        yield* writeAuditEntry({
          auditId,
          databaseId,
          operation: "describe",
          startedAt,
          durationMs: Date.now() - startedAt,
          success: false,
          cacheHit: false,
          errorMessage:
            "No cached database structure is available and database is missing describeCommand",
        });
        return yield* new ValidationError({
          message:
            "No cached database structure is available and database is missing describeCommand. DBQ resolves the database URL and passes it to the configured describe client through DBQ_DATABASE_URL.",
        });
      }

      const databaseStructure = yield* runDescribeCommand(
        databaseUrl,
        databaseId,
        database,
        describeCommand,
      ).pipe(
        Effect.tap((describedDatabaseStructure) =>
          writeAuditEntry({
            auditId,
            databaseId,
            operation: "describe",
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            rowCount: countDatabaseStructureColumns(describedDatabaseStructure),
            cacheHit: false,
          }),
        ),
        Effect.tapError((error) =>
          writeAuditEntry({
            auditId,
            databaseId,
            operation: "describe",
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            cacheHit: false,
            errorMessage: error.message,
          }),
        ),
      );

      setCachedDatabaseStructure(
        databaseStructureCacheKey,
        databaseStructure,
        databaseStructureCacheDurationSeconds,
      );
      yield* writeDiskCachedDatabaseStructure(
        databaseStructureCacheKey,
        databaseStructure,
        databaseStructureCacheDurationSeconds,
      );

      return formatDescribeResponse(databaseStructure, refresh ? "refreshed" : "miss");
    });

    const queryDatabase = Effect.fn("Dbq.queryDatabase")(function* (input: QueryDatabaseInput) {
      const { databaseId, sql } = input;

      const config = yield* loadConfig();
      const database = yield* getDatabase(config, databaseId);
      const startedAt = Date.now();
      const auditId = randomUUID();

      yield* confirmQuery(config.security, database, databaseId, sql).pipe(
        Effect.tapError((error) =>
          writeAuditEntry({
            auditId,
            databaseId,
            operation: "query",
            sql,
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: error.message,
          }),
        ),
      );

      const databaseUrl = yield* resolveDatabaseUrl(databaseId, database, config.security);

      const queryCommand = database.queryCommand;

      if (!queryCommand) {
        yield* writeAuditEntry({
          auditId,
          databaseId,
          operation: "query",
          sql,
          startedAt,
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: "Database is missing queryCommand",
        });
        return yield* new ValidationError({
          message:
            "Database is missing queryCommand. DBQ resolves the database URL and passes it to the configured client through DBQ_DATABASE_URL.",
        });
      }

      const output = yield* runQueryCommand(databaseUrl, queryCommand, sql).pipe(
        Effect.tap((queryOutput) =>
          writeAuditEntry({
            auditId,
            databaseId,
            operation: "query",
            sql,
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            outputBytes: queryOutput.length,
          }),
        ),
        Effect.tapError((error) =>
          writeAuditEntry({
            auditId,
            databaseId,
            operation: "query",
            sql,
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: error.message,
          }),
        ),
      );

      return {
        databaseId,
        output,
      };
    });

    return {
      listDatabases,
      describeDatabase,
      queryDatabase,
    };
  },
}) {}

const listCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const dbq = yield* Dbq;
    const result = yield* dbq.listDatabases();
    yield* Console.log(JSON.stringify(result, null, 2));
  }),
).pipe(Command.withDescription("List configured databases"));

const describeCommand = Command.make(
  "describe",
  {
    databaseId: Args.text({ name: "databaseId" }),
    refresh: Options.boolean("refresh").pipe(
      Options.withDescription(
        "Bypass cached database structure and update it with describeCommand",
      ),
    ),
    format: Options.choice("format", ["compact", "json"] as const).pipe(
      Options.withDefault("compact"),
      Options.withDescription("Output compact token-efficient text or grouped JSON"),
    ),
    namespace: Options.text("namespace").pipe(
      Options.withDefault(""),
      Options.withDescription("Only output one namespace from the cached database structure"),
    ),
    relation: Options.text("relation").pipe(
      Options.repeated,
      Options.withDescription(
        "Only output this relation from the cached database structure; repeat to include multiple relations",
      ),
    ),
  },
  ({ databaseId, refresh, format, namespace, relation }) =>
    Effect.gen(function* () {
      const dbq = yield* Dbq;
      const result = yield* dbq.describeDatabase({
        databaseId,
        refresh,
        format,
        namespace: namespace || undefined,
        relations: relation.length > 0 ? relation : undefined,
      });
      yield* Console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Describe namespaces, relations, and columns"));

const queryCommand = Command.make(
  "query",
  {
    databaseId: Args.text({ name: "databaseId" }),
    sql: Args.text({ name: "sql" }),
  },
  ({ databaseId, sql }) =>
    Effect.gen(function* () {
      const dbq = yield* Dbq;
      const result = yield* dbq.queryDatabase({
        databaseId,
        sql,
      });
      yield* Console.log(JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Run a confirmed SQL query"));

const rootCommand = Command.make("dbq", {}, () => Effect.void).pipe(
  Command.withDescription("Local CLI for named databases"),
  Command.withSubcommands([listCommand, describeCommand, queryCommand]),
);

const runCli = rootCommand.pipe(
  Command.run({
    name: "DBQ",
    version,
  }),
);

const MainLive = Layer.mergeAll(Dbq.Default, BunContext.layer);

const cliEffect = runCli(Bun.argv).pipe(
  Effect.provide(MainLive),
  Effect.tapError((error) => Console.error(formatError(error))),
);

const exit = await Effect.runPromiseExit(cliEffect);

if (exit._tag === "Failure") {
  process.exitCode = 1;
}

function summarizeSql(sql: string) {
  const singleLineSql = sql.replaceAll(/\s+/g, " ").trim();

  if (singleLineSql.length <= 160) {
    return singleLineSql;
  }

  return `${singleLineSql.slice(0, 157)}...`;
}

function hashCacheKey(cacheKey: string) {
  return createHash("sha256").update(cacheKey).digest("hex");
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

function parseDatabaseStructure(contents: string) {
  return Schema.parseJson(DatabaseStructureSchema)
    .pipe(Schema.decodeUnknown)(contents, { onExcessProperty: "error" })
    .pipe(
      Effect.mapError(
        (cause) =>
          new DatabaseError({
            message: "Could not decode describeCommand output",
            cause,
          }),
      ),
    );
}

function countDatabaseStructureColumns(databaseStructure: DatabaseStructure) {
  return databaseStructure.namespaces.reduce(
    (namespaceCount, namespace) =>
      namespaceCount +
      namespace.relations.reduce(
        (relationCount, relation) => relationCount + relation.columns.length,
        0,
      ),
    0,
  );
}

function filterDatabaseStructure(
  databaseStructure: DatabaseStructure,
  scope: { namespace?: string; relations?: ReadonlyArray<string> },
) {
  if (!scope.namespace && scope.relations === undefined) {
    return databaseStructure;
  }

  const relationNames = scope.relations === undefined ? undefined : new Set(scope.relations);

  return {
    ...databaseStructure,
    namespaces: databaseStructure.namespaces
      .filter((namespace) => scope.namespace === undefined || namespace.name === scope.namespace)
      .map((namespace) => ({
        ...namespace,
        relations: namespace.relations.filter(
          (relation) => relationNames === undefined || relationNames.has(relation.name),
        ),
      }))
      .filter((namespace) => namespace.relations.length > 0),
  } satisfies DatabaseStructure;
}

function formatDatabaseStructure(
  databaseStructure: DatabaseStructure,
  databaseStructureCacheStatus: "hit" | "miss" | "refreshed",
  format: DescribeDatabaseInput["format"],
) {
  const databaseStructureGeneratedAt = new Date(databaseStructure.generatedAt).toISOString();

  if (format === "json") {
    return {
      databaseId: databaseStructure.databaseId,
      engine: databaseStructure.engine,
      databaseStructureCacheStatus,
      databaseStructureGeneratedAt,
      namespaces: databaseStructure.namespaces,
    };
  }

  return renderCompactDatabaseStructure(databaseStructure, databaseStructureGeneratedAt);
}

function renderCompactDatabaseStructure(
  databaseStructure: DatabaseStructure,
  databaseStructureGeneratedAt: string,
) {
  const lines = [
    `database ${databaseStructure.databaseId}`,
    `engine ${databaseStructure.engine}`,
    `generated_at ${databaseStructureGeneratedAt}`,
  ];

  for (const namespace of databaseStructure.namespaces) {
    lines.push("", `${namespace.kind} ${namespace.name}`);

    for (const relation of namespace.relations) {
      lines.push(
        `${relation.kind} ${relation.name}: ${relation.columns.map(renderCompactColumn).join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}

function renderCompactColumn(column: DatabaseStructureColumn) {
  const reference = column.references
    ? ` -> ${column.references.namespace}.${column.references.relation}.${column.references.column}`
    : "";

  return `${column.name} ${normalizeDatabaseType(column.type)}${column.nullable ? "?" : ""}${reference}`;
}

function normalizeDatabaseType(type: string) {
  switch (type) {
    case "boolean":
      return "bool";
    case "character varying":
      return "varchar";
    case "double precision":
      return "float8";
    case "integer":
      return "int";
    case "timestamp without time zone":
      return "ts";
    case "timestamp with time zone":
      return "tstz";
    case "USER-DEFINED":
      return "enum";
    default:
      return type;
  }
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return String(error);
}
