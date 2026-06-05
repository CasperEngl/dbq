import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { writeAuditEntry } from "./audit";
import { loadConfig } from "./config";
import {
  countDatabaseStructureColumns,
  filterDatabaseStructure,
  formatDatabaseStructure,
  parseDatabaseStructure,
  type DescribeFormat,
} from "./database-structure";
import { ConfigError, ConfirmationError, DatabaseError, ValidationError } from "./errors";
import { defaultConfirmCommand, rootDirectory } from "./paths";
import {
  hashCacheKey,
  readDiskCachedDatabaseStructure,
  readDiskCachedDatabaseUrl,
  writeDiskCachedDatabaseStructure,
  writeDiskCachedDatabaseUrl,
} from "./disk-cache";
import {
  type CachedDatabaseStructure,
  type CachedDatabaseUrl,
  type Config,
  type Database,
  type DatabaseStructure,
  type Security,
} from "./schema";

export type QueryDatabaseInput = {
  databaseId: string;
  sql: string;
};
export type DescribeDatabaseInput = {
  databaseId: string;
  refresh: boolean;
  format: DescribeFormat;
  namespace?: string;
  relations?: ReadonlyArray<string>;
};

const getDatabaseUrlResolver = (database: Database) => {
  if ("url" in database) {
    return "url";
  }

  if ("urlCommand" in database) {
    return "urlCommand";
  }

  return "urlEnv";
};

export class Dbq extends Effect.Service<Dbq>()("Dbq", {
  sync: () => {
    const databaseUrlCache = new Map<string, CachedDatabaseUrl>();
    const databaseStructureCache = new Map<string, CachedDatabaseStructure>();

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

function summarizeSql(sql: string) {
  const singleLineSql = sql.replaceAll(/\s+/g, " ").trim();

  if (singleLineSql.length <= 160) {
    return singleLineSql;
  }

  return `${singleLineSql.slice(0, 157)}...`;
}
