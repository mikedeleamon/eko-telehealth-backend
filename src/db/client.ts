import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env';
import { ServiceNotConfiguredError } from '../lib/errors';
import * as schema from './schema';

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;
let sql: ReturnType<typeof postgres> | null = null;

/**
 * Lazily open the Supabase connection. Throws a 503 (not a crash) when
 * DATABASE_URL is unset, so the server still boots and /health still answers
 * while you're wiring Supabase up.
 */
export function getDb() {
  if (!env.databaseUrl) {
    throw new ServiceNotConfiguredError('Database (set DATABASE_URL to your Supabase connection string)');
  }
  if (!db) {
    // `prepare: false` keeps us compatible with Supabase's transaction pooler.
    sql = postgres(env.databaseUrl, { ssl: 'require', max: 10, prepare: false });
    db = drizzle(sql, { schema });
  }
  return db;
}

/** Close the pool (used by the seed script and graceful shutdown). */
export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    db = null;
  }
}
