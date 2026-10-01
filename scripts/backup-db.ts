#!/usr/bin/env tsx
/**
 * Dumps every table in the `public` schema to local files, so there is a restore
 * point even though the Supabase plan has no automatic backups.
 *
 *   npm run backup
 *
 * Output: backups/<UTC timestamp>/<table>.jsonl  (one JSON row per line)
 *         backups/<UTC timestamp>/MANIFEST.json   (row counts, sizes, schema columns)
 * Read-only: runs in a single repeatable-read, read-only transaction, so the files
 * are one consistent snapshot and nothing in the database is touched.
 *
 * The job queue schema (pgboss) is skipped: those rows are transient.
 *
 * SENSITIVE: the dump contains commenter names and comment text, and encrypted
 * Instagram tokens. `backups/` is git-ignored. Keep the folder private, and delete
 * old snapshots (see KEEP below). Restoring is manual and deliberate: see docs/RECOVERY.md.
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { config as loadDotenv } from "dotenv";
import postgres from "postgres";

const KEEP = 7; // snapshots to keep; older ones are deleted after a successful run

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) loadDotenv({ path: envFile });
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = resolve(process.cwd(), "backups");
  const dir = join(root, stamp);
  mkdirSync(dir, { recursive: true });

  const sql = postgres(url!, { ssl: "require", max: 1, connect_timeout: 15, onnotice: () => undefined });
  const manifest: { createdAt: string; tables: { name: string; rows: number; bytes: number }[]; columns: Record<string, string[]> } = {
    createdAt: new Date().toISOString(),
    tables: [],
    columns: {}
  };

  try {
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      const tables = await tx<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;

      for (const { table_name: name } of tables) {
        const cols = await tx<{ column_name: string }[]>`
          select column_name from information_schema.columns where table_schema = 'public' and table_name = ${name} order by ordinal_position`;
        manifest.columns[name] = cols.map((c) => c.column_name);

        const file = join(dir, `${name}.jsonl`);
        const out = createWriteStream(file, { encoding: "utf8" });
        let rows = 0;
        const cursor = tx.unsafe(`select * from public."${name.replace(/"/g, '""')}"`).cursor(500);
        for await (const batch of cursor) {
          for (const row of batch) {
            if (!out.write(JSON.stringify(row) + "\n")) await once(out, "drain");
            rows += 1;
          }
        }
        out.end();
        await once(out, "finish");
        manifest.tables.push({ name, rows, bytes: statSync(file).size });
        console.log(`  ${name.padEnd(28)} ${String(rows).padStart(7)} rows`);
      }
    });
  } finally {
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }

  writeFileSync(join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
  const total = manifest.tables.reduce((n, t) => n + t.rows, 0);
  console.log(`\n✓ ${manifest.tables.length} tables, ${total} rows written to ${dir}`);

  // Rotation: keep the newest KEEP snapshots.
  const snapshots = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - KEEP))) {
    rmSync(join(root, old), { recursive: true, force: true });
    console.log(`  removed old snapshot ${old}`);
  }
}

main().catch((err) => {
  console.error("Backup failed:", err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/gi, "[db-url]") : err);
  process.exit(1);
});
