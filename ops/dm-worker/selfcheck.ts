// Read-only pre-flight for the DM worker. Bundled next to the worker and run on the host
// before the service is started:  node selfcheck.mjs
//
// It goes through the same database and Redis code the worker uses, so a pass means the
// bundle itself works on this machine (Prisma runtime, TLS, DNS, env). It sends nothing
// and changes nothing. It also reports how many DM jobs are waiting, which is what the
// worker will start sending the moment it runs.
import { prisma } from "../../vendor/openreply/lib/db/client";
import { getDMQueue, getRedisConnection } from "../../vendor/openreply/lib/queue/client";
import { getEncryptionKeyHex } from "../../vendor/openreply/lib/env";

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    steps.push({ name, ok: true, detail: await fn() });
  } catch (error) {
    steps.push({ name, ok: false, detail: error instanceof Error ? error.message.split("\n").pop() ?? "failed" : "failed" });
  }
}

async function main(): Promise<void> {
  await step("env", async () => {
    const missing = ["DATABASE_URL", "REDIS_URL", "ENCRYPTION_KEY", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"].filter(
      (name) => !process.env[name]
    );
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
    getEncryptionKeyHex();
    return `node ${process.version}`;
  });
  await step("database", async () => {
    const [{ ok }] = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    const accounts = await prisma.instagramAccount.count();
    return `reachable (${ok === 1 ? "query ok" : "odd result"}), ${accounts} Instagram account(s)`;
  });
  await step("redis", async () => {
    const pong = await getRedisConnection().ping();
    const counts = await getDMQueue().getJobCounts("waiting", "active", "delayed", "failed");
    return `${pong}; jobs waiting ${counts.waiting}, active ${counts.active}, delayed ${counts.delayed}, failed ${counts.failed}`;
  });

  let failed = 0;
  for (const s of steps) {
    if (!s.ok) failed += 1;
    console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name}: ${s.detail}`);
  }
  console.log(failed ? "\nNot ready. Fix the lines marked FAIL, then run this again." : "\nReady. Starting the service will begin sending waiting DMs.");
  await Promise.allSettled([prisma.$disconnect(), getRedisConnection().quit()]);
  process.exit(failed ? 1 : 0);
}

void main();
