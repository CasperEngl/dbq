import { Effect, Schema } from "effect";
import { DatabaseError } from "./errors";
import {
  DatabaseStructureSchema,
  type DatabaseStructure,
  type DatabaseStructureColumn,
} from "./schema";

export type DescribeFormat = "compact" | "json";

export function parseDatabaseStructure(contents: string) {
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

export function countDatabaseStructureColumns(databaseStructure: DatabaseStructure) {
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

export function filterDatabaseStructure(
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

export function formatDatabaseStructure(
  databaseStructure: DatabaseStructure,
  databaseStructureCacheStatus: "hit" | "miss" | "refreshed",
  format: DescribeFormat,
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
