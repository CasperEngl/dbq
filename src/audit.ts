import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { AuditError } from "./errors";
import { auditLogPath, rootDirectory } from "./paths";

export const writeAuditEntry = Effect.fn("writeAuditEntry")(function* (
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
