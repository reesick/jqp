// Runs on the VM every minute (systemd timer) and emails you the moment something crosses a
// threshold: disk, memory, outbound data, the DM worker service, or a reboot.
//
//   node vm-guard.mjs               one check (what the timer runs)
//   node vm-guard.mjs --dry-run     print the readings, send nothing, change nothing
//   node vm-guard.mjs --test-email  send one test message and exit
//
// It is deliberately independent of the database and Redis, so it still emails you when
// those are the thing that is broken. It only needs the ALERT_* mail settings.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import {
  DEFAULT_THRESHOLDS,
  type Alert,
  type GuardState,
  type Reading,
  type Thresholds,
  accumulateTransfer,
  bodyFor,
  decide,
  emptyState,
  gradeDisk,
  gradeMemory,
  gradeService,
  gradeTransfer,
  parseDfPercent,
  parseMeminfo,
  parseNetDevTx,
  subjectFor
} from "./guard-core";

const SERVICE = process.env.GUARD_SERVICE ?? "jqp-dm-worker";
const STATE_DIR = process.env.GUARD_STATE_DIR ?? "/var/lib/jqp-guard";
const STATE_FILE = join(STATE_DIR, "state.json");
const HALT_FILE = join(STATE_DIR, "halt");
const args = new Set(process.argv.slice(2));

function thresholds(): Thresholds {
  const t = { ...DEFAULT_THRESHOLDS };
  for (const key of Object.keys(t) as (keyof Thresholds)[]) {
    const envName = `GUARD_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
    const raw = process.env[envName];
    if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw))) t[key] = Number(raw);
  }
  return t;
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function run(cmd: string, argv: string[]): string {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (error) {
    // `systemctl is-active` prints the state on stdout but exits non-zero when not active.
    const out = (error as { stdout?: string | Buffer }).stdout;
    return out ? String(out).trim() : "";
  }
}

function loadState(): GuardState {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<GuardState>;
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

function saveState(state: GuardState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  renameSync(tmp, STATE_FILE);
}

function mailConfig() {
  const host = process.env.ALERT_SMTP_HOST ?? "";
  const to = process.env.ALERT_EMAIL_TO ?? "";
  const from = process.env.ALERT_EMAIL_FROM ?? "";
  if (!host || !to || !from) return null;
  return {
    to,
    from,
    transport: nodemailer.createTransport({
      host,
      port: Number(process.env.ALERT_SMTP_PORT ?? 587),
      secure: false,
      requireTLS: true,
      auth: process.env.ALERT_SMTP_USER ? { user: process.env.ALERT_SMTP_USER, pass: process.env.ALERT_SMTP_PASS ?? "" } : undefined,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000
    })
  };
}

async function sendMail(subject: string, text: string): Promise<boolean> {
  const cfg = mailConfig();
  if (!cfg) {
    console.error("mail not configured (ALERT_SMTP_HOST, ALERT_EMAIL_TO, ALERT_EMAIL_FROM); cannot send");
    return false;
  }
  try {
    await cfg.transport.sendMail({ from: cfg.from, to: cfg.to, subject, text });
    return true;
  } catch (error) {
    console.error("mail failed:", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

async function main(): Promise<void> {
  const host = os.hostname();
  const now = Date.now();

  if (args.has("--test-email")) {
    const ok = await sendMail(`[jqp VM ${host}] test message`, `The VM guard can send mail.\nHost: ${host}\nTime (UTC): ${new Date(now).toISOString()}`);
    console.log(ok ? "test email sent" : "test email FAILED");
    process.exit(ok ? 0 : 1);
  }

  const t = thresholds();
  const state = loadState();

  const transfer = accumulateTransfer(state.transfer, parseNetDevTx(readText("/proc/net/dev")), now);
  const restartCount = Number(run("systemctl", ["show", "-p", "NRestarts", "--value", SERVICE])) || 0;
  const restartDelta = state.restarts.lastCount === null ? 0 : Math.max(0, restartCount - state.restarts.lastCount);
  const dfOut = run("df", ["-P", "/"]);

  const readings: Reading[] = [
    gradeService(run("systemctl", ["is-active", SERVICE]) || "unknown", restartDelta, t),
    gradeDisk(parseDfPercent(dfOut), t),
    gradeMemory(parseMeminfo(readText("/proc/meminfo")), t),
    gradeTransfer(transfer.bytes, t)
  ];

  if (args.has("--dry-run")) {
    for (const r of readings) console.log(`${r.level.padEnd(4)} ${r.label}: ${r.detail}`);
    console.log(`state dir: ${existsSync(STATE_DIR) ? STATE_DIR : `${STATE_DIR} (not created yet)`}`);
    if (existsSync(HALT_FILE)) console.log(`HALTED: ${readText(HALT_FILE).trim()}. Run \`jqp resume\` once the cause is fixed.`);
    return;
  }

  const { alerts, checks } = decide(state.checks, readings, now);

  // Force stop. Writing this file is the whole mechanism: jqp-halt.path notices it and a root
  // service stops the worker, and the worker unit refuses to start while the file exists (so
  // a reboot does not bring it back). Queued comments stay in Redis; `jqp resume` undoes it.
  // Safety first: the file is written before any mail is attempted.
  const haltReasons = readings.filter((r) => r.halt);
  if (haltReasons.length > 0 && !existsSync(HALT_FILE)) {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(HALT_FILE, `${new Date(now).toISOString()} ${haltReasons.map((r) => r.id).join(",")}\n`, { mode: 0o644 });
    alerts.push({
      kind: "problem",
      reading: {
        id: "halt",
        label: "DM worker STOPPED automatically",
        level: "crit",
        detail: `${haltReasons.map((r) => `${r.label}: ${r.detail}`).join("; ")}. Queued comments are safe in Redis and will be answered after \`jqp resume\`.`
      }
    });
  }
  const bootId = readText("/proc/sys/kernel/random/boot_id").trim() || null;
  if (state.bootId && bootId && bootId !== state.bootId) {
    const uptimeMin = Math.round(os.uptime() / 60);
    alerts.push({ kind: "info", reading: { id: "reboot", label: "VM rebooted", level: "warn", detail: `up for ${uptimeMin} minute(s)` } } satisfies Alert);
  }

  const next: GuardState = {
    checks,
    transfer,
    restarts: { lastCount: restartCount },
    bootId: bootId ?? state.bootId
  };

  if (alerts.length === 0) {
    saveState(next);
    return;
  }
  const sent = await sendMail(subjectFor(alerts, host), bodyFor(alerts, host, now));
  // If the mail did not go out, keep the old check states so the same alerts are tried again
  // next minute. The counters still move forward.
  saveState(sent ? next : { ...next, checks: state.checks, bootId: state.bootId });
  if (!sent) process.exitCode = 1;
}

void main();
