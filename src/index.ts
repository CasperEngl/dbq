import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Args, Command, Options } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Console, Effect, Layer, pipe, Schema } from "effect";
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
  engine: Schema.Literal("postgres"),
  environment: Schema.Literal("development", "production"),
  readonly: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  urlCommand: Schema.optional(Schema.NonEmptyString),
  urlEnv: Schema.optional(Schema.NonEmptyString),
  databaseUrlCacheDurationSeconds: Schema.optional(NonNegativeIntegerSchema),
  urlCacheTtlSeconds: Schema.optional(NonNegativeIntegerSchema),
  databaseStructureCacheDurationSeconds: Schema.optional(NonNegativeIntegerSchema),
}).pipe(
  Schema.filter((database) => database.urlCommand !== undefined || database.urlEnv !== undefined, {
    message: () => "must define urlCommand or urlEnv",
  }),
);

const ConfigSchema = Schema.Struct({
  security: Schema.optionalWith(
    Schema.Struct({
      confirmQueries: Schema.optionalWith(Schema.Boolean, {
        default: () => true,
      }),
      confirmCommand: Schema.optional(Schema.NonEmptyString),
      databaseUrlCacheDurationSeconds: Schema.optional(NonNegativeIntegerSchema),
      urlCacheTtlSeconds: Schema.optional(NonNegativeIntegerSchema),
      databaseStructureCacheDurationSeconds: Schema.optional(NonNegativeIntegerSchema),
    }),
    {
      default: () => ({
        confirmQueries: true,
        databaseUrlCacheDurationSeconds: 0,
        databaseStructureCacheDurationSeconds: 0,
      }),
    },
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
  entries: Schema.optionalWith(
    Schema.Record({
      key: Schema.NonEmptyString,
      value: CachedDatabaseUrlSchema,
    }),
    { default: () => ({}) },
  ),
});

const emptyUrlCacheFile = Schema.decodeUnknownSync(UrlCacheFileSchema)({ entries: {} });

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
  references: Schema.optional(
    Schema.Struct({
      schema: Schema.String,
      table: Schema.String,
      column: Schema.String,
    }),
  ),
});

const DatabaseStructureForeignKeySchema = Schema.mutable(
  Schema.Struct({
    name: Schema.String,
    columns: Schema.mutable(Schema.Array(Schema.String)),
    references: Schema.mutable(
      Schema.Struct({
        schema: Schema.String,
        table: Schema.String,
        columns: Schema.mutable(Schema.Array(Schema.String)),
      }),
    ),
  }),
);

const DatabaseStructureTableSchema = Schema.Struct({
  name: Schema.String,
  columns: Schema.Array(DatabaseStructureColumnSchema),
  foreignKeys: Schema.Array(DatabaseStructureForeignKeySchema),
});

const DatabaseStructureSchemaEntrySchema = Schema.Struct({
  name: Schema.String,
  tables: Schema.Array(DatabaseStructureTableSchema),
});

const DatabaseStructureSchema = Schema.Struct({
  formatVersion: Schema.Literal(1),
  databaseId: Schema.NonEmptyString,
  generatedAt: NonNegativeIntegerSchema,
  schemas: Schema.Array(DatabaseStructureSchemaEntrySchema),
});

const CachedDatabaseStructureSchema = Schema.Struct({
  databaseStructure: DatabaseStructureSchema,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

const DatabaseStructureCacheFileSchema = Schema.Struct({
  entries: Schema.optionalWith(
    Schema.Record({
      key: Schema.NonEmptyString,
      value: CachedDatabaseStructureSchema,
    }),
    { default: () => ({}) },
  ),
});

const emptyDatabaseStructureCacheFile = Schema.decodeUnknownSync(DatabaseStructureCacheFileSchema)({
  entries: {},
});

const LegacyDatabaseStructureSchema = Schema.Struct({
  databaseId: Schema.NonEmptyString,
  generatedAt: NonNegativeIntegerSchema,
  columns: Schema.Array(DatabaseColumnRowSchema),
});

const LegacyCachedDatabaseStructureSchema = Schema.Struct({
  databaseStructure: LegacyDatabaseStructureSchema,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

const LegacyDatabaseStructureCacheFileSchema = Schema.Struct({
  entries: Schema.optionalWith(
    Schema.Record({
      key: Schema.NonEmptyString,
      value: LegacyCachedDatabaseStructureSchema,
    }),
    { default: () => ({}) },
  ),
});

const queryDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(1000).default(100),
});

const describeDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
  refresh: z.boolean().default(false),
  format: z.enum(["compact", "json"]).default("compact"),
  schema: z.string().min(1).optional(),
  table: z.string().min(1).optional(),
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
type DatabaseStructureForeignKey = typeof DatabaseStructureForeignKeySchema.Type;
type DatabaseStructure = typeof DatabaseStructureSchema.Type;
type CachedDatabaseStructure = typeof CachedDatabaseStructureSchema.Type;

const defaultSecurity = {
  confirmQueries: true,
  databaseUrlCacheDurationSeconds: 0,
  databaseStructureCacheDurationSeconds: 0,
};

class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

class ConfirmationError extends Schema.TaggedError<ConfirmationError>()("ConfirmationError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

class AuditError extends Schema.TaggedError<AuditError>()("AuditError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
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

      const config = yield* Schema.decodeUnknown(ConfigSchema)(parsedToml).pipe(
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
      if (!security.confirmQueries || database.readonly) {
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
      const { databaseId, refresh, format, schema, table } = input;
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
          filterDatabaseStructure(databaseStructure, { schema, table }),
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
          const result = yield* pipe(
            Effect.gen(function* () {
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
            }),
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
          const columns = yield* Schema.decodeUnknown(Schema.Array(DatabaseColumnRowSchema))(
            result.columns.rows,
          ).pipe(
            Effect.mapError(
              (cause) =>
                new DatabaseError({
                  message: "Could not decode database structure",
                  cause,
                }),
            ),
          );
          const foreignKeys = yield* Schema.decodeUnknown(
            Schema.Array(DatabaseForeignKeyRowSchema),
          )(result.foreignKeys.rows).pipe(
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
      const { databaseId, sql, maxRows } = input;
      yield* validateReadOnlySql(sql);

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

      return yield* withClient(databaseUrl, (client) =>
        Effect.gen(function* () {
          const result = yield* pipe(
            Effect.gen(function* () {
              yield* pgQuery(client, "begin read only");
              yield* pgQuery(client, "set local statement_timeout = '5s'");
              const queryResult = yield* pgQuery(
                client,
                `select * from (${sql}) as dbq_result limit ${maxRows}`,
              );
              yield* pgQuery(client, "rollback");
              return queryResult;
            }),
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
        "Describe schemas, tables, and columns for a configured Postgres database. Set refresh to true to bypass cached database structure. Use format compact for token-efficient text or json for grouped structured output. Use schema and table to scope large database output.",
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
      description: "Run a guarded read-only SQL query against a configured Postgres database.",
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
    schema: Options.text("schema").pipe(
      Options.withDefault(""),
      Options.withDescription("Only output one schema from the cached database structure"),
    ),
    table: Options.text("table").pipe(
      Options.withDefault(""),
      Options.withDescription("Only output one table from the cached database structure"),
    ),
  },
  ({ databaseId, refresh, format, schema, table }) =>
    Effect.gen(function* () {
      const dbq = yield* Dbq;
      const result = yield* dbq.describeDatabase(
        describeDatabaseInputSchema.parse({
          databaseId,
          refresh,
          format,
          schema: schema || undefined,
          table: table || undefined,
        }),
      );
      yield* Console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Describe schemas, tables, and columns"));

const maxRowsOption = Options.integer("max-rows").pipe(Options.withDefault(100));

const queryCommand = Command.make(
  "query",
  {
    databaseId: Args.text({ name: "databaseId" }),
    sql: Args.text({ name: "sql" }),
    maxRows: maxRowsOption,
  },
  ({ databaseId, sql, maxRows }) =>
    Effect.gen(function* () {
      const dbq = yield* Dbq;
      const input = queryDatabaseInputSchema.parse({
        databaseId,
        sql,
        maxRows,
      });
      const result = yield* dbq.queryDatabase(input);
      yield* Console.log(JSON.stringify(result, null, 2));
    }),
).pipe(Command.withDescription("Run a guarded read-only SQL query"));

const mcpCommand = Command.make("mcp", {}, () => startMcpServer()).pipe(
  Command.withDescription("Start the stdio MCP server"),
);

const rootCommand = Command.make("dbq", {}, () => startMcpServer()).pipe(
  Command.withDescription("Local MCP server and CLI for named Postgres databases"),
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

function validateReadOnlySql(sql: string) {
  return Effect.gen(function* () {
    const normalizedSql = stripLeadingComments(sql).trim().toLowerCase();

    if (!normalizedSql.startsWith("select ") && !normalizedSql.startsWith("with ")) {
      return yield* new ValidationError({
        message: "Only SELECT and WITH queries are allowed",
      });
    }

    if (sql.includes(";")) {
      return yield* new ValidationError({
        message: "Semicolons are not allowed",
      });
    }
  });
}

function stripLeadingComments(sql: string) {
  let remainingSql = sql.trimStart();

  while (remainingSql.startsWith("--") || remainingSql.startsWith("/*")) {
    if (remainingSql.startsWith("--")) {
      const lineBreakIndex = remainingSql.indexOf("\n");

      if (lineBreakIndex === -1) {
        return "";
      }

      remainingSql = remainingSql.slice(lineBreakIndex + 1).trimStart();
      continue;
    }

    const blockCommentEndIndex = remainingSql.indexOf("*/");

    if (blockCommentEndIndex === -1) {
      return "";
    }

    remainingSql = remainingSql.slice(blockCommentEndIndex + 2).trimStart();
  }

  return remainingSql;
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
  return Schema.decodeUnknown(Schema.parseJson(UrlCacheFileSchema))(contents).pipe(
    Effect.catchAll(() => Effect.succeed(emptyUrlCacheFile)),
  );
}

function parseDatabaseStructureCache(contents: string) {
  return Schema.decodeUnknown(Schema.parseJson(DatabaseStructureCacheFileSchema))(contents).pipe(
    Effect.catchAll(() =>
      Schema.decodeUnknown(Schema.parseJson(LegacyDatabaseStructureCacheFileSchema))(contents).pipe(
        Effect.map((legacyCache) => ({
          entries: Object.fromEntries(
            Object.entries(legacyCache.entries).map(([cacheKey, cachedStructure]) => [
              cacheKey,
              {
                databaseStructure: buildDatabaseStructure(
                  cachedStructure.databaseStructure.databaseId,
                  cachedStructure.databaseStructure.columns,
                  [],
                  cachedStructure.databaseStructure.generatedAt,
                ),
                expiresAt: cachedStructure.expiresAt,
              },
            ]),
          ),
        })),
        Effect.catchAll(() => Effect.succeed(emptyDatabaseStructureCacheFile)),
      ),
    ),
  );
}

function buildDatabaseStructure(
  databaseId: string,
  rows: ReadonlyArray<DatabaseColumnRow>,
  foreignKeyRows: ReadonlyArray<DatabaseForeignKeyRow>,
  generatedAt: number,
) {
  const schemas = new Map<string, Map<string, Array<DatabaseStructureColumn>>>();
  const foreignKeysByTable = new Map<string, Array<DatabaseStructureForeignKey>>();
  const referencesByColumn = new Map<string, { schema: string; table: string; column: string }>();

  for (const row of rows) {
    let tables = schemas.get(row.table_schema);

    if (!tables) {
      tables = new Map();
      schemas.set(row.table_schema, tables);
    }

    let columns = tables.get(row.table_name);

    if (!columns) {
      columns = [];
      tables.set(row.table_name, columns);
    }

    columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === "YES",
    });
  }

  for (const row of foreignKeyRows) {
    const tableKey = getTableKey(row.table_schema, row.table_name);
    const foreignKeys = foreignKeysByTable.get(tableKey) ?? [];
    const existingForeignKey = foreignKeys.find(
      (foreignKey) => foreignKey.name === row.constraint_name,
    );

    referencesByColumn.set(getColumnKey(row.table_schema, row.table_name, row.column_name), {
      schema: row.foreign_table_schema,
      table: row.foreign_table_name,
      column: row.foreign_column_name,
    });

    if (existingForeignKey) {
      existingForeignKey.columns.push(row.column_name);
      existingForeignKey.references.columns.push(row.foreign_column_name);
      continue;
    }

    foreignKeys.push({
      name: row.constraint_name,
      columns: [row.column_name],
      references: {
        schema: row.foreign_table_schema,
        table: row.foreign_table_name,
        columns: [row.foreign_column_name],
      },
    });
    foreignKeysByTable.set(tableKey, foreignKeys);
  }

  return {
    formatVersion: 1,
    databaseId,
    generatedAt,
    schemas: Array.from(schemas, ([schemaName, tables]) => ({
      name: schemaName,
      tables: Array.from(tables, ([tableName, columns]) => ({
        name: tableName,
        columns: columns.map((column) => ({
          ...column,
          references: referencesByColumn.get(getColumnKey(schemaName, tableName, column.name)),
        })),
        foreignKeys: foreignKeysByTable.get(getTableKey(schemaName, tableName)) ?? [],
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
  return databaseStructure.schemas.reduce(
    (schemaCount, schemaEntry) =>
      schemaCount +
      schemaEntry.tables.reduce((tableCount, table) => tableCount + table.columns.length, 0),
    0,
  );
}

function filterDatabaseStructure(
  databaseStructure: DatabaseStructure,
  scope: { schema?: string; table?: string },
) {
  if (!scope.schema && !scope.table) {
    return databaseStructure;
  }

  return {
    ...databaseStructure,
    schemas: databaseStructure.schemas
      .filter((schemaEntry) => scope.schema === undefined || schemaEntry.name === scope.schema)
      .map((schemaEntry) => ({
        ...schemaEntry,
        tables: schemaEntry.tables.filter(
          (table) => scope.table === undefined || table.name === scope.table,
        ),
      }))
      .filter((schemaEntry) => schemaEntry.tables.length > 0),
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
      databaseStructureCacheStatus,
      databaseStructureGeneratedAt,
      formatVersion: databaseStructure.formatVersion,
      schemas: databaseStructure.schemas,
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
    `generated_at ${databaseStructureGeneratedAt}`,
  ];

  for (const schemaEntry of databaseStructure.schemas) {
    lines.push("", `schema ${schemaEntry.name}`);

    for (const table of schemaEntry.tables) {
      lines.push(`table ${table.name}: ${table.columns.map(renderCompactColumn).join(", ")}`);
    }
  }

  return lines.join("\n");
}

function renderCompactColumn(column: DatabaseStructureColumn) {
  const reference = column.references
    ? ` -> ${column.references.schema}.${column.references.table}.${column.references.column}`
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
