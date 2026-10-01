/**
 * Shared helpers for the set-redis / set-database scripts: read a secret from the
 * clipboard, rewrite one variable in local .env files (with a git-ignored
 * backup), and set it on Vercel production. The value is never printed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface FileTarget {
  path: string;
  key: string;
}
export interface VercelTarget {
  project: string;
  key: string;
}

export function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

export function readClipboard(): string {
  try {
    if (process.platform === "win32") return execFileSync("powershell", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], { encoding: "utf8" });
    if (process.platform === "darwin") return execFileSync("pbpaste", { encoding: "utf8" });
    return execFileSync("xclip", ["-selection", "clipboard", "-o"], { encoding: "utf8" });
  } catch {
    return fail("Could not read the clipboard. Copy the value again and re-run, or pass --url (the value will then be visible in your shell history).");
  }
}

/** Backs up each file next to itself, then replaces (or appends) `key=value`. */
export function updateLocalFiles(value: string, files: FileTarget[]): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (const f of files) {
    const full = resolve(process.cwd(), f.path);
    if (!existsSync(full)) {
      console.log(`- ${f.path}: not present, skipped`);
      continue;
    }
    copyFileSync(full, `${full}.bak-${f.key.toLowerCase()}-${stamp}`);
    const original = readFileSync(full, "utf8");
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const line = `${f.key}=${value}`;
    const pattern = new RegExp(`^${f.key}=.*$`, "m");
    const updated = pattern.test(original) ? original.replace(pattern, () => line) : `${original.replace(/\s*$/, "")}${eol}${line}${eol}`;
    writeFileSync(full, updated);
    console.log(`✓ ${f.path}: ${f.key} updated (backup kept next to it)`);
  }
}

/** Replaces `key` on each Vercel project's production environment (marked sensitive). */
export function updateVercel(value: string, targets: VercelTarget[]): void {
  console.log("\nVercel (production):");
  const work = mkdtempSync(join(tmpdir(), "jqp-env-"));
  try {
    for (const t of targets) {
      const dir = join(work, t.project);
      mkdirSync(dir, { recursive: true });
      const run = (argv: string[], input?: string) => spawnSync("vercel", argv, { cwd: dir, input, encoding: "utf8", shell: process.platform === "win32" });
      const link = run(["link", "--project", t.project, "--yes"]);
      if (link.status !== 0) {
        console.log(`✗ ${t.project}: could not link (${(link.stderr || link.stdout).trim().split("\n").pop()}). Update ${t.key} by hand in the Vercel dashboard.`);
        continue;
      }
      run(["env", "rm", t.key, "production", "--yes"]);
      const add = run(["env", "add", t.key, "production", "--sensitive"], `${value}\n`);
      const ok = add.status === 0;
      console.log(`${ok ? "✓" : "✗"} ${t.project}: ${t.key} ${ok ? "set for production" : `FAILED (${(add.stderr || add.stdout).trim().split("\n").pop()}). Set it by hand`}`);
    }
  } finally {
    // Windows can keep the folder locked for a moment after `vercel` exits; a leftover temp dir is harmless.
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* ignore */
    }
  }
}
