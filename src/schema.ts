import { Schema } from "effect";

export const NonNegativeIntegerSchema = Schema.NonNegativeInt;

const DatabaseBaseSchema = Schema.Struct({
  engine: Schema.NonEmptyString,
  readonly: Schema.Boolean.pipe(Schema.optionalWith({ default: () => true })),
  queryCommand: Schema.NonEmptyString.pipe(Schema.optional),
  describeCommand: Schema.NonEmptyString.pipe(Schema.optional),
  databaseUrlCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  urlCacheTtlSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
  databaseStructureCacheDurationSeconds: NonNegativeIntegerSchema.pipe(Schema.optional),
});

export const DatabaseSchema = DatabaseBaseSchema.pipe(
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

export const ConfigSchema = Schema.Struct({
  $schema: Schema.String.pipe(Schema.optional),
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

export const CachedDatabaseUrlSchema = Schema.Struct({
  databaseUrl: Schema.NonEmptyString,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

export const UrlCacheFileSchema = Schema.Struct({
  entries: Schema.Record({
    key: Schema.NonEmptyString,
    value: CachedDatabaseUrlSchema,
  }).pipe(Schema.optionalWith({ default: () => ({}) })),
});

export const emptyUrlCacheFile = UrlCacheFileSchema.pipe(Schema.decodeUnknownSync)({ entries: {} });

export const DatabaseStructureColumnSchema = Schema.Struct({
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

export const DatabaseStructureSchema = Schema.Struct({
  databaseId: Schema.NonEmptyString,
  engine: Schema.NonEmptyString,
  generatedAt: NonNegativeIntegerSchema,
  namespaces: Schema.Array(DatabaseStructureNamespaceSchema),
});

export const CachedDatabaseStructureSchema = Schema.Struct({
  databaseStructure: DatabaseStructureSchema,
  expiresAt: Schema.NullOr(NonNegativeIntegerSchema),
});

export const DatabaseStructureCacheFileSchema = Schema.Struct({
  entries: Schema.Record({
    key: Schema.NonEmptyString,
    value: CachedDatabaseStructureSchema,
  }).pipe(Schema.optionalWith({ default: () => ({}) })),
});

export const emptyDatabaseStructureCacheFile = DatabaseStructureCacheFileSchema.pipe(
  Schema.decodeUnknownSync,
)({
  entries: {},
});

export type Config = typeof ConfigSchema.Type;
export type Database = typeof DatabaseSchema.Type;
export type Security = NonNullable<Config["security"]>;
export type CachedDatabaseUrl = typeof CachedDatabaseUrlSchema.Type;
export type DatabaseStructureColumn = typeof DatabaseStructureColumnSchema.Type;
export type DatabaseStructure = typeof DatabaseStructureSchema.Type;
export type CachedDatabaseStructure = typeof CachedDatabaseStructureSchema.Type;

export const defaultSecurity = {
  confirmQueries: true,
  databaseUrlCacheDurationSeconds: 0,
  databaseStructureCacheDurationSeconds: 0,
};
