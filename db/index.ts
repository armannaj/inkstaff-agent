import "server-only";
import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { DATABASE_PATH } from "@/lib/config";
import * as schema from "./schema";

function createDb() {
  const file = path.resolve(DATABASE_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  // WAL lets the pages read while the runner writes; the runner and the pages share this one process.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle({ client: sqlite, schema });
  // Creates or updates the tables (drizzle/, made by `npm run db:generate` from db/schema.ts).
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}

const global = globalThis as typeof globalThis & { inkstaffDb?: ReturnType<typeof createDb> };

/** Opens the database on first use (so `next build` doesn't need it), once per process, dev reloads included. */
export function getDb() {
  global.inkstaffDb ??= createDb();
  return global.inkstaffDb;
}
