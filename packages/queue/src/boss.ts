import PgBoss from "pg-boss";
import { loadEnv, rootLogger } from "@jqp/core";

let instance: PgBoss | undefined;

/**
 * Singleton pg-boss instance, isolated in its own `pgboss` Postgres
 * schema — separate from our `public` schema (posts/campaigns/...)
 * and from OpenReply's `openreply` schema. All three coexist in the
 * same Supabase database without collision.
 */
export async function getBoss(): Promise<PgBoss> {
  if (instance) return instance;

  const env = loadEnv();
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: "pgboss",
    max: env.BOSS_POOL_MAX
  });

  boss.on("error", (err) => rootLogger.error("pgboss_error", { error: err }));

  await boss.start();
  instance = boss;
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (instance) {
    await instance.stop({ graceful: true, timeout: 10_000 });
    instance = undefined;
  }
}

export function registerQueueShutdownHooks(): void {
  const shutdown = async (signal: string) => {
    rootLogger.info("received_signal_stopping_queue", { signal });
    await stopBoss();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
