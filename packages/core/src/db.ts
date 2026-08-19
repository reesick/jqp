import postgres from "postgres";
import type { Sql } from "postgres";
import { loadEnv } from "./env.js";

let client: Sql | undefined;

/**
 * Singleton postgres.js client against DATABASE_URL. Reused across
 * the process — do not create a new client per request/job, Postgres
 * connection limits on the free tier are tight.
 */
export function getDb(): Sql {
  if (client) return client;

  const env = loadEnv();
  client = postgres(env.DATABASE_URL, {
    max: env.DB_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: "require",
    onnotice: () => {
      // Silence routine Postgres NOTICE messages (e.g. from "do $$ ... exception when duplicate_object" blocks in migrations).
    }
  });
  return client;
}

/** Closes the pooled connection. Call on SIGTERM/SIGINT so the process exits cleanly instead of hanging on open sockets. */
export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = undefined;
  }
}

export function registerDbShutdownHooks(): void {
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ level: "info", msg: `received ${signal}, closing db pool`, ts: new Date().toISOString() }));
    await closeDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

export type { Sql };
