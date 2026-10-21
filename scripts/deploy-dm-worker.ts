// Ships the DM worker bundle to the VM and installs it. Run from your laptop; it uses the
// OpenSSH tools that come with Windows 10/11 (ssh, scp).
//
//   node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@1.2.3.4 --key ~/.ssh/oracle_key --install --push-env --push-guard-env
//   node --import tsx scripts/deploy-dm-worker.ts --host ubuntu@1.2.3.4 --restart        (later: ship a new build)
//   add --dry-run to print the steps without doing anything
//
// Secrets: the env files are copied as files. This script never prints their contents. The worker
// file is built from an allowlist (database, Redis, encryption key, Instagram app id and secret,
// Graph version) and the guard file from only the ALERT_* mail settings, so a stolen VM does not
// hold the login, cron, email or webhook-signing secrets. Nothing here starts the worker unless you pass --restart (which you only
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
    // Only what the worker reads goes to the VM. The login secret, cron secret, email key and webhook signing secret
    // stay on Vercel, so a stolen VM cannot forge dashboard sessions or call cron routes.
    const all = parse(readFileSync(file));
    const names = ["DATABASE_URL", "REDIS_URL", "ENCRYPTION_KEY", "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "META_GRAPH_API_VERSION"];
    const lines = names.filter((n) => all[n]).map((n) => `${n}=${all[n]}`);
    // Links in DMs are built from this, so it must be the public address and never the local one in the env file.
    lines.push(`NEXTAUTH_URL=${value("openreply-url") ?? "https://jqp-openreply-1.vercel.app"}`);
    // First start: look back one hour only and take few comments per sweep, so a backlog is never replayed in a burst.
    lines.push(`COMMENT_POLL_LOOKBACK_HOURS=${value("lookback-hours") ?? "1"}`, "COMMENT_POLL_MAX_PER_SWEEP=5");
    if (dry) {
      console.log(`(dry run: the worker env would contain only these names: ${lines.map((l) => l.split("=")[0]).join(", ")})`);
    } else {
      const tmp = mkdtempSync(join(tmpdir(), "jqp-worker-"));
      try {
        writeFileSync(join(tmp, "worker.env"), lines.join("\n") + "\n", { mode: 0o600 });
        scp(tmp, ["worker.env"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    // The uploaded copy is removed even if the install step fails.
    ssh(`(sudo install -m 600 -o root -g root ${remoteDir}/worker.env /etc/jqp/worker.env; rc=$?; rm -f ${remoteDir}/worker.env; exit $rc)`);
  }

  if (flag("push-guard-env")) {
    const rootEnv = join(root, ".env");
    const all = parse(readFileSync(rootEnv));
    // The combined status email needs the dashboard address and its report token. They may come from the shell
    // (so the token never has to live in the root env file) or from the root env file.
    for (const n of ["DASHBOARD_URL", "VM_REPORT_TOKEN"]) if (process.env[n]) all[n] = process.env[n]!;
    const names = ["ALERT_EMAIL_TO", "ALERT_EMAIL_FROM", "ALERT_SMTP_HOST", "ALERT_SMTP_PORT", "ALERT_SMTP_USER", "ALERT_SMTP_PASS", "DASHBOARD_URL", "VM_REPORT_TOKEN"];
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
    // Keep any GUARD_* threshold lines already set on the VM; only the mail settings are replaced. The dashboard
    // address and report token are kept too unless new values were supplied, so a plain re-run cannot silently
    // drop them and leave the status email without its system half.
    const keep = ["GUARD_", ...["DASHBOARD_URL", "VM_REPORT_TOKEN"].filter((n) => !all[n]).map((n) => `${n}=`)].join("|");
    ssh(
      `sudo sh -c "grep -E '^(${keep})' /etc/jqp/guard.env >> ${remoteDir}/guard.env 2>/dev/null; true" && ` +
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
