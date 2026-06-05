import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Console, Effect, Layer, Schema } from "effect";
import pg from "pg";
import * as z from "zod/v4";

const { Client } = pg;

const version = "0.1.0";
const rootDirectory = process.env.DBQ_HOME ?? join(homedir(), ".dbq");
const configPath = join(rootDirectory, "config.toml");
const auditLogPath = join(rootDirectory, "audit.log");
const urlCachePath = join(rootDirectory, "url-cache.json");
const databaseStructureCachePath = join(rootDirectory, "database-structure-cache.json");
const defaultConfirmCommand = join(rootDirectory, "bin", "dbq-confirm");

const NonNegativeIntegerSchema = Schema.Number.pipe(
  Schema.int(),
  Schema.filter((value) => value >= 0),
);

const DatabaseSchema = Schema.Struct({
  engine: Schema.NonEmptyString,
  environment: Schema.Literal("development", "production"),
  readonly: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  urlCommand: Schema.NonEmptyString.pipe(Schema.optional),
  urlEnv: Schema.NonEmptyString.pipe(Schema.optional),
  queryCommand: Schema.NonEmptyString.pipe(Schema.optional),
  databaseUrlCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  urlCacheTtlSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  databaseStructureCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
}).pipe(
  Schema.filter((database) => database.urlCommand !== undefined || database.urlEnv !== undefined, {
    message: () => "must define urlCommand or urlEnv",
  }),
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

const DatabaseColumnRowSchema = Schema.Struct({
  table_schema: Schema.String,
  table_name: Schema.String,
  column_name: Schema.String,
  data_type: Schema.String,
  is_nullable: Schema.String,
});

const DatabaseForeignKeyRowSchema = Schema.Struct({
  constraint_name: Schema.String,
  table_schema: Schema.String,
  table_name: Schema.String,
  column_name: Schema.String,
  foreign_table_schema: Schema.String,
  foreign_table_name: Schema.String,
  foreign_column_name: Schema.String,
});

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

const DatabaseStructureReferenceSchema = Schema.Struct({
  name: Schema.String,
  columns: Schema.Array(Schema.String).pipe(Schema.mutable),
  references: Schema.Struct({
    namespace: Schema.String,
    relation: Schema.String,
    columns: Schema.Array(Schema.String).pipe(Schema.mutable),
  }).pipe(Schema.mutable),
}).pipe(Schema.mutable);

const DatabaseStructureRelationSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("table", "view", "relation"),
  columns: Schema.Array(DatabaseStructureColumnSchema),
  references: Schema.Array(DatabaseStructureReferenceSchema),
});

const DatabaseStructureNamespaceSchema = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("schema", "catalog", "namespace"),
  relations: Schema.Array(DatabaseStructureRelationSchema),
});

const DatabaseStructureSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  databaseId: Schema.NonEmptyString,
  engine: Schema.NonEmptyString,
  generatedAt: NonNegativeIntegerSchema,
  metadataSource: Schema.Literal("dbq-adapter", "agent-query"),
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

const queryDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
  sql: z.string().min(1),
});

const describeDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
  refresh: z.boolean().default(false),
  format: z.enum(["compact", "json"]).default("compact"),
  namespace: z.string().min(1).optional(),
  relations: z.array(z.string().min(1)).optional(),
});

type Config = typeof ConfigSchema.Type;
type Database = typeof DatabaseSchema.Type;
type Security = NonNullable<Config["security"]>;
type QueryDatabaseInput = z.infer<typeof queryDatabaseInputSchema>;
type DescribeDatabaseInput = z.infer<typeof describeDatabaseInputSchema>;
type CachedDatabaseUrl = typeof CachedDatabaseUrlSchema.Type;
type DatabaseColumnRow = typeof DatabaseColumnRowSchema.Type;
type DatabaseForeignKeyRow = typeof DatabaseForeignKeyRowSchema.Type;
type DatabaseStructureColumn = typeof DatabaseStructureColumnSchema.Type;
type DatabaseStructureReference = typeof DatabaseStructureReferenceSchema.Type;
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

type DbqError = ConfigError | ValidationError | ConfirmationError | DatabaseError | AuditError;

class Dbq extends Effect.Service<Dbq>()("Dbq", {
  sync: () => {
    const databaseUrlCache = new Map<string, CachedDatabaseUrl>();
    const databaseStructureCache = new Map<string, CachedDatabaseStructure>();

    const loadConfig = Effect.fn("Dbq.loadConfig")(function* () {
      const contents = yield* Effect.tryPromise({
        try: () => readFile(configPath, "utf8"),
        catch: (cause) => new ConfigError({ message: `Could not read ${configPath}`, cause }),
      });

      const parsedToml = yield* Effect.try({
        try: () => Bun.TOML.parse(contents),
        catch: (cause) => new ConfigError({ message: `Could not parse ${configPath}`, cause }),
      });

      const config = yield* ConfigSchema.pipe(Schema.decodeUnknown)(parsedToml).pipe(
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

      if (!database.urlCommand && !database.urlEnv) {
        return yield* new ValidationError({
          message: `Database ${databaseId} must define urlCommand or urlEnv`,
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
      const cacheKey = `${databaseId}:${database.urlEnv ?? ""}:${database.urlCommand ?? ""}`;
      const cachedDatabaseUrl = getCachedDatabaseUrl(cacheKey);

      if (cachedDatabaseUrl) {
        return cachedDatabaseUrl;
      }

      if (database.urlEnv) {
        const value = process.env[database.urlEnv];

        if (!value) {
          return yield* new ConfigError({
            message: `Missing environment variable: ${database.urlEnv}`,
          });
        }

        setCachedDatabaseUrl(cacheKey, value, databaseUrlCacheDurationSeconds);
        return value;
      }

      if (!database.urlCommand) {
        return yield* new ConfigError({ message: "Missing urlCommand" });
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

      const processResult = Bun.spawn(["sh", "-lc", database.urlCommand], {
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
      yield* writeDiskCachedDatabaseUrl(diskCacheKey, databaseUrl, databaseUrlCacheDurationSeconds);
      return databaseUrl;
    });

    const confirmQuery = Effect.fn("Dbq.confirmQuery")(function* (
      security: Security,
      database: Database,
      databaseId: string,
      sql: string,
    ) {
      if (!security.confirmQueries) {
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

    const withClient = <A, E>(
      databaseUrl: string,
      use: (client: pg.Client) => Effect.Effect<A, E>,
    ) =>
      Effect.acquireRelease(
        Effect.gen(function* () {
          const client = new Client({ connectionString: databaseUrl });
          yield* Effect.tryPromise({
            try: () => client.connect(),
            catch: (cause) =>
              new DatabaseError({
                message: "Could not connect to database",
                cause,
              }),
          });
          return client;
        }),
        (client) => Effect.promise(() => client.end()).pipe(Effect.catchAll(() => Effect.void)),
      ).pipe(Effect.flatMap(use), Effect.scoped);

    const rollbackQuietly = (client: pg.Client) =>
      Effect.tryPromise({
        try: () => client.query("rollback"),
        catch: () => undefined,
      }).pipe(Effect.catchAll(() => Effect.void));

    const pgQuery = Effect.fn("Dbq.pgQuery")(function* (client: pg.Client, sql: string) {
      return yield* Effect.tryPromise({
        try: () => client.query(sql),
        catch: (cause) => new DatabaseError({ message: "Database query failed", cause }),
      });
    });

    const runQueryCommand = Effect.fn("Dbq.runQueryCommand")(function* (
      databaseUrl: string,
      queryCommand: string,
      sql: string,
    ) {
      const processResult = Bun.spawn(["sh", "-lc", queryCommand], {
        env: {
          ...process.env,
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

    const listDatabases = Effect.fn("Dbq.listDatabases")(function* () {
      const config = yield* loadConfig();
      const databases = Object.entries(config.databases).map(([id, database]) => ({
        id,
        engine: database.engine,
        environment: database.environment,
        readonly: database.readonly,
        secretResolver: database.urlCommand ? "urlCommand" : "urlEnv",
      }));

      return { databases };
    });

    const describeDatabase = Effect.fn("Dbq.describeDatabase")(function* (
      input: DescribeDatabaseInput,
    ) {
      const { databaseId, refresh, format, namespace, relations } = input;
      const config = yield* loadConfig();
      const database = yield* getDatabase(config, databaseId);

      if (database.queryCommand) {
        return yield* new ValidationError({
          message: `No DBQ metadata adapter is available for ${databaseId}; run a metadata query with query_database instead.`,
        });
      }

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
            operation: "describe_database",
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
            operation: "describe_database",
            startedAt,
            durationMs: Date.now() - startedAt,
            success: true,
            rowCount: countDatabaseStructureColumns(diskCachedDatabaseStructure.databaseStructure),
            cacheHit: true,
          });
          return formatDescribeResponse(diskCachedDatabaseStructure.databaseStructure, "hit");
        }
      }

      return yield* withClient(databaseUrl, (client) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            yield* pgQuery(client, "begin read only");
            yield* pgQuery(client, "set local statement_timeout = '5s'");
            const queryResult = yield* pgQuery(
              client,
              `
                  select
                    table_schema,
                    table_name,
                    column_name,
                    data_type,
                    is_nullable
                  from information_schema.columns
                  where table_schema not in ('pg_catalog', 'information_schema')
                  order by table_schema, table_name, ordinal_position
                `,
            );
            const foreignKeyResult = yield* pgQuery(
              client,
              `
                  select
                    tc.constraint_name,
                    tc.table_schema,
                    tc.table_name,
                    kcu.column_name,
                    ccu.table_schema as foreign_table_schema,
                    ccu.table_name as foreign_table_name,
                    ccu.column_name as foreign_column_name
                  from information_schema.table_constraints tc
                  join information_schema.key_column_usage kcu
                    on tc.constraint_schema = kcu.constraint_schema
                    and tc.constraint_name = kcu.constraint_name
                    and tc.table_schema = kcu.table_schema
                    and tc.table_name = kcu.table_name
                  join information_schema.constraint_column_usage ccu
                    on ccu.constraint_schema = tc.constraint_schema
                    and ccu.constraint_name = tc.constraint_name
                  where tc.constraint_type = 'FOREIGN KEY'
                    and tc.table_schema not in ('pg_catalog', 'information_schema')
                  order by
                    tc.table_schema,
                    tc.table_name,
                    tc.constraint_name,
                    kcu.ordinal_position
                `,
            );
            yield* pgQuery(client, "rollback");
            return { columns: queryResult, foreignKeys: foreignKeyResult };
          }).pipe(
            Effect.tap(({ columns }) =>
              writeAuditEntry({
                auditId,
                databaseId,
                operation: "describe_database",
                startedAt,
                durationMs: Date.now() - startedAt,
                success: true,
                rowCount: columns.rowCount ?? 0,
              }),
            ),
            Effect.tapError((error) =>
              rollbackQuietly(client).pipe(
                Effect.zipRight(
                  writeAuditEntry({
                    auditId,
                    databaseId,
                    operation: "describe_database",
                    startedAt,
                    durationMs: Date.now() - startedAt,
                    success: false,
                    errorMessage: error.message,
                  }),
                ),
              ),
            ),
          );
          const columns = yield* Schema.Array(DatabaseColumnRowSchema)
            .pipe(Schema.decodeUnknown)(result.columns.rows)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DatabaseError({
                    message: "Could not decode database structure",
                    cause,
                  }),
              ),
            );
          const foreignKeys = yield* Schema.Array(DatabaseForeignKeyRowSchema)
            .pipe(Schema.decodeUnknown)(result.foreignKeys.rows)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DatabaseError({
                    message: "Could not decode database foreign keys",
                    cause,
                  }),
              ),
            );
          const databaseStructure = buildDatabaseStructure(
            databaseId,
            database.engine,
            columns,
            foreignKeys,
            Date.now(),
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
        }),
      );
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
            operation: "query_database",
            sql,
            startedAt,
            durationMs: Date.now() - startedAt,
            success: false,
            errorMessage: error.message,
          }),
        ),
      );

      const databaseUrl = yield* resolveDatabaseUrl(databaseId, database, config.security);

      if (database.queryCommand) {
        const output = yield* runQueryCommand(databaseUrl, database.queryCommand, sql).pipe(
          Effect.tap((queryOutput) =>
            writeAuditEntry({
              auditId,
              databaseId,
              operation: "query_database",
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
              operation: "query_database",
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
      }

      return yield* withClient(databaseUrl, (client) =>
        Effect.gen(function* () {
          const result = yield* Effect.gen(function* () {
            yield* pgQuery(client, "set statement_timeout = '5s'");
            const queryResult = yield* pgQuery(client, sql);
            return queryResult;
          }).pipe(
            Effect.tap((queryResult) =>
              writeAuditEntry({
                auditId,
                databaseId,
                operation: "query_database",
                sql,
                startedAt,
                durationMs: Date.now() - startedAt,
                success: true,
                rowCount: queryResult.rowCount ?? 0,
              }),
            ),
            Effect.tapError((error) =>
              rollbackQuietly(client).pipe(
                Effect.zipRight(
                  writeAuditEntry({
                    auditId,
                    databaseId,
                    operation: "query_database",
                    sql,
                    startedAt,
                    durationMs: Date.now() - startedAt,
                    success: false,
                    errorMessage: error.message,
                  }),
                ),
              ),
            ),
          );

          return {
            databaseId,
            rowCount: result.rowCount ?? 0,
            rows: result.rows,
          };
        }),
      );
    });

    return {
      listDatabases,
      describeDatabase,
      queryDatabase,
    };
  },
}) {}

const startMcpServer = Effect.fn("startMcpServer")(function* () {
  const dbq = yield* Dbq;
  const server = new McpServer({ name: "dbq", version });

  server.registerTool(
    "list_databases",
    {
      description: "List configured database targets. Connection URLs are never returned.",
      inputSchema: z.object({}),
    },
    () => runDbqForMcp(dbq.listDatabases().pipe(Effect.map(jsonResponse))),
  );

  server.registerTool(
    "describe_database",
    {
      description:
        "Describe namespaces, relations, and columns for a configured database when DBQ has a metadata adapter. Set refresh to true to bypass cached database structure. Use format compact for token-efficient text or json for grouped structured output. Use namespace and relations to scope large database output.",
      inputSchema: describeDatabaseInputSchema,
    },
    (input) => {
      const parsedInput = describeDatabaseInputSchema.parse(input);
      const response = parsedInput.format === "compact" ? compactResponse : jsonResponse;

      return runDbqForMcp(dbq.describeDatabase(parsedInput).pipe(Effect.map(response)));
    },
  );

  server.registerTool(
    "query_database",
    {
      description: "Run a confirmed SQL query against a configured database.",
      inputSchema: queryDatabaseInputSchema,
    },
    (input) =>
      runDbqForMcp(
        dbq.queryDatabase(queryDatabaseInputSchema.parse(input)).pipe(Effect.map(jsonResponse)),
      ),
  );

  const transport = new StdioServerTransport();
  yield* Effect.tryPromise({
    try: () => server.connect(transport),
    catch: (cause) => new DatabaseError({ message: "Could not start MCP server", cause }),
  });
});

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
      Options.withDescription("Bypass cached database structure and update the cache"),
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
      const result = yield* dbq.describeDatabase(
        describeDatabaseInputSchema.parse({
          databaseId,
          refresh,
          format,
          namespace: namespace || undefined,
          relations: relation.length > 0 ? relation : undefined,
        }),
      );
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
      const input = queryDatabaseInputSchema.parse({
        databaseId,
        sql,
      });
      const result = yield* dbq.queryDatabase(input);
      yield* Console.log(JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Run a confirmed SQL query"));

const mcpCommand = Command.make("mcp", {}, () => startMcpServer()).pipe(
  Command.withDescription("Start the stdio MCP server"),
);

const rootCommand = Command.make("dbq", {}, () => startMcpServer()).pipe(
  Command.withDescription("Local MCP server and CLI for named databases"),
  Command.withSubcommands([mcpCommand, listCommand, describeCommand, queryCommand]),
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
    .pipe(Schema.decodeUnknown)(contents)
    .pipe(Effect.catchAll(() => Effect.succeed(emptyDatabaseStructureCacheFile)));
}

function buildDatabaseStructure(
  databaseId: string,
  engine: string,
  rows: ReadonlyArray<DatabaseColumnRow>,
  foreignKeyRows: ReadonlyArray<DatabaseForeignKeyRow>,
  generatedAt: number,
) {
  const namespaces = new Map<string, Map<string, Array<DatabaseStructureColumn>>>();
  const referencesByRelation = new Map<string, Array<DatabaseStructureReference>>();
  const referencesByColumn = new Map<
    string,
    { namespace: string; relation: string; column: string }
  >();

  for (const row of rows) {
    let relations = namespaces.get(row.table_schema);

    if (!relations) {
      relations = new Map();
      namespaces.set(row.table_schema, relations);
    }

    let columns = relations.get(row.table_name);

    if (!columns) {
      columns = [];
      relations.set(row.table_name, columns);
    }

    columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    });
  }

  for (const row of foreignKeyRows) {
    const tableKey = getTableKey(row.table_schema, row.table_name);
    const relationReferences = referencesByRelation.get(tableKey) ?? [];
    const existingReference = relationReferences.find(
      (reference) => reference.name === row.constraint_name,
    );

    referencesByColumn.set(getColumnKey(row.table_schema, row.table_name, row.column_name), {
      namespace: row.foreign_table_schema,
      relation: row.foreign_table_name,
      column: row.foreign_column_name,
    });

    if (existingReference) {
      existingReference.columns.push(row.column_name);
      existingReference.references.columns.push(row.foreign_column_name);
      continue;
    }

    relationReferences.push({
      name: row.constraint_name,
      columns: [row.column_name],
      references: {
        namespace: row.foreign_table_schema,
        relation: row.foreign_table_name,
        columns: [row.foreign_column_name],
      },
    });
    referencesByRelation.set(tableKey, relationReferences);
  }

  return {
    formatVersion: 1,
    databaseId,
    engine,
    generatedAt,
    metadataSource: "dbq-adapter",
    namespaces: Array.from(namespaces, ([namespaceName, relations]) => ({
      name: namespaceName,
      kind: "schema",
      relations: Array.from(relations, ([relationName, columns]) => ({
        name: relationName,
        kind: "table",
        columns: columns.map((column) => ({
          ...column,
          references: referencesByColumn.get(
            getColumnKey(namespaceName, relationName, column.name),
          ),
        })),
        references: referencesByRelation.get(getTableKey(namespaceName, relationName)) ?? [],
      })),
    })),
  } satisfies DatabaseStructure;
}

function getTableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}

function getColumnKey(schema: string, table: string, column: string) {
  return `${schema}.${table}.${column}`;
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
      formatVersion: databaseStructure.formatVersion,
      metadataSource: databaseStructure.metadataSource,
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

function runDbqForMcp<A>(effect: Effect.Effect<A, DbqError>) {
  return effect.pipe(Effect.provide(MainLive), Effect.runPromise);
}

function jsonResponse(value: unknown) {
  const content = [
    {
      type: "text",
      text: JSON.stringify(value, null, 2),
    },
  ] satisfies Array<{ type: "text"; text: string }>;

  return {
    content,
  };
}

function compactResponse(value: unknown) {
  const content = [
    {
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ] satisfies Array<{ type: "text"; text: string }>;

  return {
    content,
  };
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
