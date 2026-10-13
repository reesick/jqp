// Ships the DM worker bundle to the VM and installs it. Run from your laptop; it uses the
// OpenSSH tools that come with Windows 10/11 (ssh, scp).
//
//   node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@1.2.3.4 --key ~/.ssh/oracle_key --install --push-env --push-guard-env
//   node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@1.2.3.4 --restart        (later: ship a new build)
//   add --dry-run to print the steps without doing anything
//
// Secrets: the env files are copied as files. This script never prints their contents, and the
// guard file is built from only the ALERT_* mail settings, so the VM guard cannot see database
// or Instagram keys. Nothing here starts the worker unless you pass --restart (which you only
// want once `jqp check` on the VM passes).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

const host = value("host");
const key = value("key");
const dry = flag("dry-run");
if (!host || !/^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$/i.test(host)) {
  console.error("Usage: node --import tsx scripts/deploy-dm-worker.ts --host user@ip [--key path] [--install] [--push-env] [--push-guard-env] [--restart] [--dry-run]");
  process.exit(1);
}
const sshOpts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=30", ...(key ? ["-i", key] : [])];
const remoteDir = "/tmp/jqp-upload";

function run(cmd: string, args: string[], cwd = root): void {
  console.log(`$ ${cmd} ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  if (!dry) execFileSync(cmd, args, { cwd, stdio: "inherit" });
}
const ssh = (remote: string): void => run("ssh", [...sshOpts, host, remote]);
// scp reads "D:" as a host name, so files are always sent by relative name from their own folder.
const scp = (cwd: string, names: string[], target = `${host}:${remoteDir}/`, recursive = false): void =>
  run("scp", [...sshOpts, ...(recursive ? ["-r"] : []), ...names, target], cwd);

function envHas(file: string, name: string): string | undefined {
  return parse(readFileSync(file))[name];
}

function checkWorkerEnv(file: string): void {
  const db = envHas(file, "DATABASE_URL");
  const redis = envHas(file, "REDIS_URL");
  const problems: string[] = [];
  if (!db) problems.push("DATABASE_URL is missing");
  else if (!/:6543\//.test(db)) problems.push("DATABASE_URL should use port 6543 (the transaction pooler OpenReply uses)");
  if (!redis) problems.push("REDIS_URL is missing");
  if (!envHas(file, "ENCRYPTION_KEY")) problems.push("ENCRYPTION_KEY is missing");
  if (problems.length) {
    console.error(`Worker env problems:\n- ${problems.join("\n- ")}\nFix with npm run sync-openreply-env, then try again.`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  run(process.execPath, ["--import", "tsx", "scripts/bundle-dm-worker.ts"]);
  ssh(`mkdir -p ${remoteDir} && chmod 700 ${remoteDir}`);
  scp(join(root, "dist", "dm-host"), ["."], `${host}:${remoteDir}/`, true);

  if (flag("install")) ssh(`sudo bash ${remoteDir}/install.sh`);

  if (flag("push-env")) {
    const dir = join(root, "vendor", "openreply");
    const file = join(dir, ".env");
    if (!existsSync(file)) {
      console.error("vendor/openreply/.env not found. Run: npm run sync-openreply-env");
      process.exit(1);
    }
    checkWorkerEnv(file);
    scp(dir, [".env"], `${host}:${remoteDir}/worker.env`);
    // The uploaded copy is removed even if the install step fails.
    ssh(
      `(sudo install -m 600 -o root -g root ${remoteDir}/worker.env /etc/jqp/worker.env; rc=$?; rm -f ${remoteDir}/worker.env; exit $rc) && ` +
        `(sudo grep -q '^COMMENT_POLL_LOOKBACK_HOURS=' /etc/jqp/worker.env || echo 'COMMENT_POLL_LOOKBACK_HOURS=72' | sudo tee -a /etc/jqp/worker.env >/dev/null)`
    );
  }

  if (flag("push-guard-env")) {
    const rootEnv = join(root, ".env");
    const all = parse(readFileSync(rootEnv));
    const names = ["ALERT_EMAIL_TO", "ALERT_EMAIL_FROM", "ALERT_SMTP_HOST", "ALERT_SMTP_PORT", "ALERT_SMTP_USER", "ALERT_SMTP_PASS"];
    const missing = ["ALERT_EMAIL_TO", "ALERT_EMAIL_FROM", "ALERT_SMTP_HOST", "ALERT_SMTP_USER", "ALERT_SMTP_PASS"].filter((n) => !all[n]);
    if (missing.length) {
      console.error(`Cannot build the guard mail settings, missing in the root env file: ${missing.join(", ")}`);
      process.exit(1);
    }
    if (dry) {
      console.log("(dry run: the guard mail settings are not written to a file or sent)");
    } else {
      const tmp = mkdtempSync(join(tmpdir(), "jqp-guard-"));
      try {
        writeFileSync(join(tmp, "guard.env"), names.filter((n) => all[n]).map((n) => `${n}=${all[n]}`).join("\n") + "\n", { mode: 0o600 });
        scp(tmp, ["guard.env"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    // Keep any GUARD_* threshold lines already set on the VM; only the mail settings are replaced.
    ssh(
      `sudo sh -c "grep '^GUARD_' /etc/jqp/guard.env >> ${remoteDir}/guard.env 2>/dev/null; true" && ` +
        `(sudo install -m 600 -o root -g root ${remoteDir}/guard.env /etc/jqp/guard.env; rc=$?; rm -f ${remoteDir}/guard.env; exit $rc)`
    );
  }

  // Restart only a worker that is meant to be running. One you stopped on purpose, or never started,
  // stays stopped (use `jqp start` or `jqp resume` on the VM for that).
  if (flag("restart")) {
    ssh(
      "sudo bash " + remoteDir + "/install.sh >/dev/null && " +
        "(if systemctl is-enabled --quiet jqp-dm-worker && [ ! -e /var/lib/jqp-guard/halt ]; then sudo systemctl restart jqp-dm-worker && systemctl --no-pager --lines=5 status jqp-dm-worker; " +
        "else echo 'Worker is not enabled or is halted, so it was not restarted. Use: jqp start / jqp resume'; fi)"
    );
  }

  console.log("\nDone. On the VM:  jqp check   then   jqp start   (jqp status shows the readings)");
}

void main();
