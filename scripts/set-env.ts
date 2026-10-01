#!/usr/bin/env tsx
/**
 * Set one or more environment variables in local .env files and/or Vercel
 * production, without printing any value.
 *
 *   npm run set-env -- --var KEY=VALUE [--var KEY2=VALUE2 ...]
 *                      [--file root] [--file openreply]      (root = .env, openreply = vendor/openreply/.env)
 *                      [--vercel jqp-web] [--vercel jqp-openreply-1]
 *
 * Every --var is written to every --file and every --vercel project. For a
 * variable that should differ per target (e.g. a different name in each project),
 * run the command once per target.
 *
 * Pass --copy KEY to take the value of KEY from the root env file instead of typing it.
 *
 * Local files are backed up next to themselves first (git-ignored). Values are
 * never echoed. Pass --generate KEY to create a random 32-byte token for KEY
 * and copy it to the clipboard (Windows) so you can paste it elsewhere without
 * it appearing on screen.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { fail, updateLocalFiles, updateVercel, type FileTarget, type VercelTarget } from "./lib/env-update.js";

const args = process.argv.slice(2);
const collect = (flag: string): string[] => args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1] as string] : []));

// --clipboard KEY: copy a value from the root env file to the clipboard (nothing is changed or printed), then exit.
const clipKey = collect("--clipboard")[0];
if (clipKey) {
  const rootFile = resolve(process.cwd(), ".env");
  const value = existsSync(rootFile) ? parse(readFileSync(rootFile))[clipKey] : undefined;
  if (!value) fail(`--clipboard ${clipKey}: not found in the root env file.`);
  if (process.platform !== "win32") fail("--clipboard is implemented for Windows only.");
  execFileSync("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $input"], { input: value });
  console.log(`Copied ${clipKey} to your clipboard (not shown here).`);
  process.exit(0);
}

const vars = new Map<string, string>();
for (const pair of collect("--var")) {
  const eq = pair.indexOf("=");
  if (eq <= 0) fail(`--var expects KEY=VALUE, got "${pair.split("=")[0]}".`);
  vars.set(pair.slice(0, eq), pair.slice(eq + 1));
}
// --copy KEY reads KEY from the root .env, so a value that already lives there (a generated token, a key you pasted
// once) can be pushed elsewhere without being typed, printed or kept in shell history.
for (const key of collect("--copy")) {
  const rootFile = resolve(process.cwd(), ".env");
  const value = existsSync(rootFile) ? parse(readFileSync(rootFile))[key] : undefined;
  if (!value) fail(`--copy ${key}: not found in the root env file.`);
  vars.set(key, value);
}
for (const key of collect("--generate")) {
  const token = randomBytes(32).toString("base64url");
  vars.set(key, token);
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", "Set-Clipboard -Value $input"], { input: token });
    console.log(`Generated ${key} and copied it to your clipboard (paste it where it is needed; it is not shown here).`);
  } else {
    console.log(`Generated ${key} (not shown). Read it back from the file it was written to.`);
  }
}
if (vars.size === 0) fail("Nothing to set. Use --var KEY=VALUE or --generate KEY.");

// Aliases keep the secret file names out of shell command lines (and logs).
const FILE_ALIASES: Record<string, string> = { root: ".env", openreply: "vendor/openreply/.env" };
const files = collect("--file").map((f) => FILE_ALIASES[f] ?? f);
const projects = collect("--vercel");
if (files.length === 0 && projects.length === 0) fail("No target. Add --file <path> and/or --vercel <project>.");

for (const [key, value] of vars) {
  const fileTargets: FileTarget[] = files.map((path) => ({ path, key }));
  const vercelTargets: VercelTarget[] = projects.map((project) => ({ project, key }));
  if (fileTargets.length) updateLocalFiles(value, fileTargets);
  if (vercelTargets.length) updateVercel(value, vercelTargets);
}
console.log("\nVercel changes apply to the NEXT deployment: redeploy each project you changed.");
