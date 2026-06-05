import { homedir } from "node:os";
import { join } from "node:path";

export const rootDirectory = process.env.DBQ_HOME ?? join(homedir(), ".dbq");
export const configPath = join(rootDirectory, "config.jsonc");
export const auditLogPath = join(rootDirectory, "audit.log");
export const urlCachePath = join(rootDirectory, "url-cache.json");
export const databaseStructureCachePath = join(rootDirectory, "database-structure-cache.json");
export const defaultConfirmCommand = join(rootDirectory, "bin", "dbq-confirm");
