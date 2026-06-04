import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import * as z from "zod/v4";

const { Client } = pg;

const rootDirectory = process.env.DBQ_HOME ?? join(homedir(), ".dbq");
const configPath = join(rootDirectory, "config.toml");
const auditLogPath = join(rootDirectory, "audit.log");
const defaultConfirmCommand = join(rootDirectory, "bin", "DBQ");

const databaseSchema = z.object({
  engine: z.literal("postgres"),
  environment: z.enum(["development", "production"]),
  readonly: z.boolean().default(true),
  urlCommand: z.string().min(1).optional(),
  urlEnv: z.string().min(1).optional(),
});

const configSchema = z.object({
  security: z
    .object({
      confirmQueries: z.boolean().default(true),
      confirmCommand: z.string().min(1).optional(),
    })
    .default({
      confirmQueries: true,
    }),
  databases: z.record(z.string().min(1), databaseSchema),
});

const queryDatabaseSchema = z.object({
  databaseId: z.string().min(1),
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(1000).default(100),
});

const describeDatabaseSchema = z.object({
  databaseId: z.string().min(1),
});

const server = new McpServer({
  name: "dbq",
  version: "0.1.0",
});

server.registerTool(
  "list_databases",
  {
    description:
      "List configured database targets. Connection URLs are never returned.",
    inputSchema: z.object({}),
  },
  async () => {
    const config = await loadConfig();
    const databases = Object.entries(config.databases).map(
      ([id, database]) => ({
        id,
        engine: database.engine,
        environment: database.environment,
        readonly: database.readonly,
        secretResolver: database.urlCommand ? "urlCommand" : "urlEnv",
      }),
    );

    return jsonResponse({ databases });
  },
);

server.registerTool(
  "describe_database",
  {
    description:
      "Describe schemas, tables, and columns for a configured Postgres database.",
    inputSchema: describeDatabaseSchema,
  },
  async ({ databaseId }) => {
    const config = await loadConfig();
    const database = getDatabase(config, databaseId);
    const databaseUrl = await resolveDatabaseUrl(database);
    const client = new Client({ connectionString: databaseUrl });
    const startedAt = Date.now();
    const auditId = randomUUID();

    try {
      await client.connect();
      await client.query("begin read only");
      await client.query("set local statement_timeout = '5s'");
      const result = await client.query(`
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
      `);
      await client.query("rollback");

      await writeAuditEntry({
        auditId,
        databaseId,
        operation: "describe_database",
        startedAt,
        durationMs: Date.now() - startedAt,
        success: true,
        rowCount: result.rowCount ?? 0,
      });

      return jsonResponse({
        databaseId,
        columns: result.rows,
      });
    } catch (error) {
      await rollbackQuietly(client);
      await writeAuditEntry({
        auditId,
        databaseId,
        operation: "describe_database",
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await client.end();
    }
  },
);

server.registerTool(
  "query_database",
  {
    description:
      "Run a guarded read-only SQL query against a configured Postgres database.",
    inputSchema: queryDatabaseSchema,
  },
  async (input) => {
    const { databaseId, sql, maxRows } = queryDatabaseSchema.parse(input);
    validateReadOnlySql(sql);

    const config = await loadConfig();
    const database = getDatabase(config, databaseId);
    const startedAt = Date.now();
    const auditId = randomUUID();

    try {
      await confirmQuery(config.security, databaseId, sql);
    } catch (error) {
      await writeAuditEntry({
        auditId,
        databaseId,
        operation: "query_database",
        sql,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const databaseUrl = await resolveDatabaseUrl(database);
    const client = new Client({ connectionString: databaseUrl });

    try {
      await client.connect();
      await client.query("begin read only");
      await client.query("set local statement_timeout = '5s'");
      const result = await client.query(
        `select * from (${sql}) as dbq_result limit ${maxRows}`,
      );
      await client.query("rollback");

      await writeAuditEntry({
        auditId,
        databaseId,
        operation: "query_database",
        sql,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: true,
        rowCount: result.rowCount ?? 0,
      });

      return jsonResponse({
        databaseId,
        rowCount: result.rowCount ?? 0,
        rows: result.rows,
      });
    } catch (error) {
      await rollbackQuietly(client);
      await writeAuditEntry({
        auditId,
        databaseId,
        operation: "query_database",
        sql,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      await client.end();
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

async function loadConfig() {
  const contents = await readFile(configPath, "utf8");
  return configSchema.parse(Bun.TOML.parse(contents));
}

async function confirmQuery(
  security: z.infer<typeof configSchema>["security"],
  databaseId: string,
  sql: string,
) {
  if (!security.confirmQueries) {
    return;
  }

  const reason = `Allow DBQ to query ${databaseId}: ${summarizeSql(sql)}`;
  const confirmCommand = security.confirmCommand ?? defaultConfirmCommand;
  const processResult = Bun.spawn(
    ["sh", "-lc", `${confirmCommand} "$DBQ_CONFIRM_REASON"`],
    {
      env: {
        ...process.env,
        DBQ_CONFIRM_REASON: reason,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stderr, exitCode] = await Promise.all([
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);

  if (exitCode !== 0) {
    const message = stderr.trim() || "Query authentication denied";
    throw new Error(message);
  }
}

function summarizeSql(sql: string) {
  const singleLineSql = sql.replaceAll(/\s+/g, " ").trim();

  if (singleLineSql.length <= 160) {
    return singleLineSql;
  }

  return `${singleLineSql.slice(0, 157)}...`;
}

function getDatabase(config: z.infer<typeof configSchema>, databaseId: string) {
  const database = config.databases[databaseId];

  if (!database) {
    throw new Error(`Unknown database: ${databaseId}`);
  }

  if (!database.urlCommand && !database.urlEnv) {
    throw new Error(`Database ${databaseId} must define urlCommand or urlEnv`);
  }

  return database;
}

async function resolveDatabaseUrl(database: z.infer<typeof databaseSchema>) {
  if (database.urlEnv) {
    const value = process.env[database.urlEnv];

    if (!value) {
      throw new Error(`Missing environment variable: ${database.urlEnv}`);
    }

    return value;
  }

  if (!database.urlCommand) {
    throw new Error("Missing urlCommand");
  }

  const processResult = Bun.spawn(["sh", "-lc", database.urlCommand], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processResult.stdout).text(),
    new Response(processResult.stderr).text(),
    processResult.exited,
  ]);

  if (exitCode !== 0) {
    const message = stderr.trim() || `urlCommand exited with code ${exitCode}`;
    throw new Error(message);
  }

  const databaseUrl = stdout.trim();

  if (!databaseUrl) {
    throw new Error("urlCommand returned an empty database URL");
  }

  return databaseUrl;
}

function validateReadOnlySql(sql: string) {
  const normalizedSql = stripLeadingComments(sql).trim().toLowerCase();

  if (
    !normalizedSql.startsWith("select ") &&
    !normalizedSql.startsWith("with ")
  ) {
    throw new Error("Only SELECT and WITH queries are allowed");
  }

  if (sql.includes(";")) {
    throw new Error("Semicolons are not allowed");
  }
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

async function rollbackQuietly(client: pg.Client) {
  try {
    await client.query("rollback");
  } catch {
    return;
  }
}

async function writeAuditEntry(entry: Record<string, unknown>) {
  await mkdir(dirname(auditLogPath), { recursive: true });
  await appendFile(
    auditLogPath,
    `${JSON.stringify({ ...entry, recordedAt: new Date().toISOString() })}\n`,
  );
}

function jsonResponse(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
