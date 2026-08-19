#!/usr/bin/env tsx
/**
 * Applies every supabase/migrations/*.sql file, in filename order,
 * against DATABASE_URL, skipping ones already recorded in
 * _migrations_applied. Every migration is still written with
 * IF NOT EXISTS / guarded DO blocks (defense in depth), but the ledger
 * means a rerun (e.g. on every prod deploy) only executes new files
 * instead of replaying the whole history every time.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { loadRootDotenv } from "../packages/core/src/bootstrap.js";

loadRootDotenv();

// Deliberately does NOT go through loadEnv() — this script's only job is
// applying SQL against Postgres, so it shouldn't be blocked by unrelated
// Meta/OpenReply config you haven't filled in yet. Just the one var it
// actually needs.
const rawDatabaseUrl = process.env.DATABASE_URL;
if (!rawDatabaseUrl) {
  console.error("DATABASE_URL is not set in .env. Copy .env.example to .env and fill in your Supabase connection string first.");
  process.exit(1);
}
const databaseUrl: string = rawDatabaseUrl;

const migrationsDir = resolve(process.cwd(), "supabase/migrations");
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files found in ${migrationsDir}`);
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

async function main() {
  await sql`
    create table if not exists public._migrations_applied (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const appliedRows = await sql<{ filename: string }[]>`select filename from public._migrations_applied`;
  const applied = new Set(appliedRows.map((r) => r.filename));

  console.log(`Checking ${files.length} migration(s) against ${new URL(databaseUrl).host}\n`);

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  ${file} ... already applied`);
      continue;
    }
    const path = resolve(migrationsDir, file);
    const contents = readFileSync(path, "utf-8");
    process.stdout.write(`  ${file} ... `);
    try {
      await sql.unsafe(contents);
      await sql`insert into public._migrations_applied (filename) values (${file})`;
      console.log("ok");
    } catch (err) {
      console.log("FAILED");
      console.error(err instanceof Error ? err.message : err);
      await sql.end();
      process.exit(1);
    }
  }

  console.log("\nAll migrations applied.");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err);
  await sql.end();
  process.exit(1);
});
