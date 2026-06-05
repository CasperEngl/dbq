import { Args, Command, Options } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import packageJson from "../package.json" with { type: "json" };
import { formatError } from "./errors";
import { Dbq } from "./index";

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
    version: packageJson.version,
  }),
);

const MainLive = Layer.mergeAll(Dbq.Default, BunContext.layer);

const cliEffect = runCli(Bun.argv).pipe(
  Effect.provide(MainLive),
  Effect.tapError((error) => Console.error(formatError(error))),
) satisfies Effect.Effect<void, unknown, never>;

const exit = await Effect.runPromiseExit(cliEffect);

if (exit._tag === "Failure") {
  process.exitCode = 1;
}
