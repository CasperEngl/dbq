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
  urlCacheTtlSeconds: Schema.optional(NonNegativeIntegerSchema),
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
      urlCacheTtlSeconds: Schema.optionalWith(NonNegativeIntegerSchema, {
        default: () => 0,
      }),
    }),
    {
      default: () => ({
        confirmQueries: true,
        urlCacheTtlSeconds: 0,
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

const queryDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(1000).default(100),
});

const describeDatabaseInputSchema = z.object({
  databaseId: z.string().min(1),
});

type Config = typeof ConfigSchema.Type;
type Database = typeof DatabaseSchema.Type;
type Security = NonNullable<Config["security"]>;
type QueryDatabaseInput = z.infer<typeof queryDatabaseInputSchema>;
type CachedDatabaseUrl = typeof CachedDatabaseUrlSchema.Type;

const defaultSecurity = {
  confirmQueries: true,
  urlCacheTtlSeconds: 0,
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
      urlCacheTtlSeconds: number,
    ) => {
      databaseUrlCache.set(cacheKey, {
        databaseUrl,
        expiresAt: urlCacheTtlSeconds > 0 ? Date.now() + urlCacheTtlSeconds * 1000 : null,
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
      urlCacheTtlSeconds: number,
    ) {
      if (urlCacheTtlSeconds <= 0) {
        return;
      }

      const contents = yield* readOptionalFile(urlCachePath);
      const parsedCache = contents ? yield* parseUrlCache(contents) : emptyUrlCacheFile;
      const entries = { ...parsedCache.entries } satisfies Record<string, CachedDatabaseUrl>;

      entries[cacheKey] = {
        databaseUrl,
        expiresAt: Date.now() + urlCacheTtlSeconds * 1000,
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

    const resolveDatabaseUrl = Effect.fn("Dbq.resolveDatabaseUrl")(function* (
      databaseId: string,
      database: Database,
      security: Security,
    ) {
      const urlCacheTtlSeconds = database.urlCacheTtlSeconds ?? security.urlCacheTtlSeconds;
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

        setCachedDatabaseUrl(cacheKey, value, urlCacheTtlSeconds);
        return value;
      }

      if (!database.urlCommand) {
        return yield* new ConfigError({ message: "Missing urlCommand" });
      }

      const diskCacheKey = hashCacheKey(cacheKey);
      const diskCachedDatabaseUrl =
        urlCacheTtlSeconds > 0 ? yield* readDiskCachedDatabaseUrl(diskCacheKey) : undefined;

      if (diskCachedDatabaseUrl) {
        setCachedDatabaseUrl(cacheKey, diskCachedDatabaseUrl, urlCacheTtlSeconds);
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

      setCachedDatabaseUrl(cacheKey, databaseUrl, urlCacheTtlSeconds);
      yield* writeDiskCachedDatabaseUrl(diskCacheKey, databaseUrl, urlCacheTtlSeconds);
      return databaseUrl;
    });

    const confirmQuery = Effect.fn("Dbq.confirmQuery")(function* (
      security: Security,
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

    const describeDatabase = Effect.fn("Dbq.describeDatabase")(function* (databaseId: string) {
      const config = yield* loadConfig();
      const database = yield* getDatabase(config, databaseId);
      const databaseUrl = yield* resolveDatabaseUrl(databaseId, database, config.security);
      const startedAt = Date.now();
      const auditId = randomUUID();

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
                  limit 1000
                `,
              );
              yield* pgQuery(client, "rollback");
              return queryResult;
            }),
            Effect.tap((queryResult) =>
              writeAuditEntry({
                auditId,
                databaseId,
                operation: "describe_database",
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

          return {
            databaseId,
            columns: result.rows,
          };
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

      yield* confirmQuery(config.security, databaseId, sql).pipe(
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
      description: "Describe schemas, tables, and columns for a configured Postgres database.",
      inputSchema: describeDatabaseInputSchema,
    },
    ({ databaseId }) =>
      runDbqForMcp(dbq.describeDatabase(databaseId).pipe(Effect.map(jsonResponse))),
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
  { databaseId: Args.text({ name: "databaseId" }) },
  ({ databaseId }) =>
    Effect.gen(function* () {
      const dbq = yield* Dbq;
      const result = yield* dbq.describeDatabase(databaseId);
      yield* Console.log(JSON.stringify(result, null, 2));
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
