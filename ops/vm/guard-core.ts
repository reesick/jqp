// Pure logic for the VM guard: parse what Linux reports, grade it against thresholds, and
// decide which alerts to send. No I/O here so it can be unit tested. vm-guard.ts does the I/O.

export type Level = "ok" | "warn" | "crit";

export interface Reading {
  id: string;
  label: string;
  level: Level;
  detail: string;
  // True when this reading is bad enough that the DM worker must be stopped automatically.
  halt?: boolean;
}

export interface Thresholds {
  diskWarnPct: number;
  diskCritPct: number;
  // Automatic stop of the DM worker. Queued DMs wait safely in Redis until you resume.
  diskHaltPct: number;
  // Percent of Oracle's free outbound allowance (10 TB a month) at which the worker is stopped.
  transferHaltPct: number;
  memAvailWarnMb: number;
  memAvailCritMb: number;
  swapWarnPct: number;
  swapCritPct: number;
  // Outbound data per calendar month. Oracle's free allowance is 10 TB; a DM worker uses
  // well under 1 GB, so these are tripwires for something going wrong, not the real limit.
  transferWarnGb: number;
  transferCritGb: number;
  restartsWarn: number;
  restartsCrit: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  diskWarnPct: 70,
  diskCritPct: 85,
  diskHaltPct: 95,
  transferHaltPct: 95,
  memAvailWarnMb: 150,
  memAvailCritMb: 80,
  swapWarnPct: 50,
  swapCritPct: 80,
  transferWarnGb: 5,
  transferCritGb: 20,
  restartsWarn: 2,
  restartsCrit: 5
};

export const ORACLE_FREE_TRANSFER_TB = 10;

export function levelHigh(value: number, warn: number, crit: number): Level {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

export function levelLow(value: number, warn: number, crit: number): Level {
  if (value <= crit) return "crit";
  if (value <= warn) return "warn";
  return "ok";
}

// ---- parsers -------------------------------------------------------------------------

export type Meminfo = { availableMb: number; swapTotalMb: number; swapFreeMb: number };

// Null when the file is empty or has no MemAvailable line, so a failed read is never graded as "no memory".
export function parseMeminfo(text: string): Meminfo | null {
  const kb = (key: string): number | null => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  const available = kb("MemAvailable");
  if (available === null) return null;
  return {
    availableMb: available / 1024,
    swapTotalMb: (kb("SwapTotal") ?? 0) / 1024,
    swapFreeMb: (kb("SwapFree") ?? 0) / 1024
  };
}

// Sum of bytes sent on every interface except loopback and container bridges.
export function parseNetDevTx(text: string): number {
  let total = 0;
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    if (!iface || iface === "lo" || /^(docker|veth|br-|virbr)/.test(iface)) continue;
    const cols = line.slice(colon + 1).trim().split(/\s+/);
    const tx = Number(cols[8]);
    if (Number.isFinite(tx)) total += tx;
  }
  return total;
}

// `df -P /` output: Filesystem 1024-blocks Used Available Capacity Mounted
export function parseDfPercent(text: string): number | null {
  const row = text.trim().split("\n").pop() ?? "";
  const match = /(\d+)%\s+\S+\s*$/.exec(row);
  return match ? Number(match[1]) : null;
}

// ---- state ---------------------------------------------------------------------------

export interface CheckState {
  level: Level;
  since: number;
  lastAlertAt: number | null;
}

export interface GuardState {
  checks: Record<string, CheckState>;
  transfer: { month: string; bytes: number; lastCounter: number | null };
  restarts: { lastCount: number | null };
  bootId: string | null;
  // True once the "worker stopped automatically" email has gone out for the current stop.
  haltNotified: boolean;
}

export function emptyState(): GuardState {
  return {
    checks: {},
    transfer: { month: "", bytes: 0, lastCounter: null },
    restarts: { lastCount: null },
    bootId: null,
    haltNotified: false
  };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Reads whatever is in state.json and returns a safe state. A corrupt or hand-edited file must
// never stop the guard from running (a crash here would also stop the force stop from working).
export function normalizeState(raw: unknown): GuardState {
  const base = emptyState();
  if (!isObj(raw)) return base;
  if (isObj(raw.checks)) {
    for (const [id, c] of Object.entries(raw.checks)) {
      if (isObj(c) && (c.level === "ok" || c.level === "warn" || c.level === "crit") && isNum(c.since)) {
        base.checks[id] = { level: c.level, since: c.since, lastAlertAt: isNum(c.lastAlertAt) ? c.lastAlertAt : null };
      }
    }
  }
  if (isObj(raw.transfer) && typeof raw.transfer.month === "string" && isNum(raw.transfer.bytes) && raw.transfer.bytes >= 0) {
    base.transfer = { month: raw.transfer.month, bytes: raw.transfer.bytes, lastCounter: isNum(raw.transfer.lastCounter) ? raw.transfer.lastCounter : null };
  }
  if (isObj(raw.restarts) && isNum(raw.restarts.lastCount)) base.restarts.lastCount = raw.restarts.lastCount;
  if (typeof raw.bootId === "string") base.bootId = raw.bootId;
  base.haltNotified = raw.haltNotified === true;
  return base;
}

export function monthKey(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

// Adds what was sent since the last run. The kernel counter restarts from zero on reboot, so
// a counter lower than the last one means "start again from this value".
export function accumulateTransfer(
  prev: GuardState["transfer"],
  counter: number,
  now: number
): GuardState["transfer"] {
  const month = monthKey(now);
  const base = prev.month === month ? prev.bytes : 0;
  const delta = prev.lastCounter === null ? 0 : counter >= prev.lastCounter ? counter - prev.lastCounter : counter;
  return { month, bytes: base + delta, lastCounter: counter };
}

// ---- grading -------------------------------------------------------------------------

export function gradeDisk(usedPct: number | null, t: Thresholds): Reading {
  if (usedPct === null) return { id: "disk", label: "Disk", level: "warn", detail: "could not read disk usage" };
  return {
    id: "disk",
    label: "Disk",
    level: levelHigh(usedPct, t.diskWarnPct, t.diskCritPct),
    detail: `${usedPct}% of the boot disk used`,
    halt: usedPct >= t.diskHaltPct
  };
}

export function gradeMemory(mem: Meminfo | null, t: Thresholds): Reading {
  if (!mem) return { id: "memory", label: "Memory", level: "warn", detail: "could not read memory usage" };
  const avail = Math.round(mem.availableMb);
  const swapUsedPct = mem.swapTotalMb > 0 ? Math.round(((mem.swapTotalMb - mem.swapFreeMb) / mem.swapTotalMb) * 100) : 0;
  const a = levelLow(mem.availableMb, t.memAvailWarnMb, t.memAvailCritMb);
  const s = levelHigh(swapUsedPct, t.swapWarnPct, t.swapCritPct);
  const level: Level = a === "crit" || s === "crit" ? "crit" : a === "warn" || s === "warn" ? "warn" : "ok";
  return { id: "memory", label: "Memory", level, detail: `${avail} MB available, swap ${swapUsedPct}% used` };
}

export function gradeTransfer(bytes: number, t: Thresholds): Reading {
  const gb = bytes / 1e9;
  const pct = (bytes / (ORACLE_FREE_TRANSFER_TB * 1e12)) * 100;
  return {
    id: "transfer",
    label: "Outbound data",
    level: levelHigh(gb, t.transferWarnGb, t.transferCritGb),
    detail: `${gb.toFixed(2)} GB sent this month (${pct.toFixed(3)}% of Oracle's ${ORACLE_FREE_TRANSFER_TB} TB free allowance)`,
    halt: pct >= t.transferHaltPct
  };
}

/**
 * `active` is systemd's answer to is-active and `enabled` is its answer to is-enabled.
 *  - "activating" is the 10 second restart window after a crash. Not an alarm by itself: a crash loop shows up
 *    through the restart count below.
 *  - A worker that is not enabled was stopped on purpose (jqp stop) or has not been started yet. That is a fact
 *    to report, not an emergency to email about every six hours.
 *  - A worker that is enabled but not running died, or was stopped by the guard's halt. That is critical.
 */
export function gradeService(active: string, restartDelta: number, t: Thresholds, enabled?: string): Reading {
  if (active === "activating") {
    return { id: "service", label: "DM worker service", level: "ok", detail: "restarting" };
  }
  if (active !== "active") {
    if (enabled === "disabled") {
      return { id: "service", label: "DM worker service", level: "ok", detail: "not running: it is not enabled (stopped on purpose or not started yet). DMs are not being sent" };
    }
    return { id: "service", label: "DM worker service", level: "crit", detail: `service is "${active}", not running` };
  }
  const level = levelHigh(restartDelta, t.restartsWarn, t.restartsCrit);
  return {
    id: "service",
    label: "DM worker service",
    level,
    detail: restartDelta > 0 ? `running, but restarted ${restartDelta} time(s) since the last check` : "running"
  };
}

// ---- alert decisions -----------------------------------------------------------------

export interface Alert {
  kind: "problem" | "still" | "recovered" | "info";
  reading: Reading;
}

const REPEAT_MS: Record<Level, number> = { ok: Infinity, warn: 24 * 3600_000, crit: 6 * 3600_000 };

export function decide(
  prev: GuardState["checks"],
  readings: Reading[],
  now: number
): { alerts: Alert[]; checks: GuardState["checks"] } {
  const alerts: Alert[] = [];
  const checks: GuardState["checks"] = { ...prev };
  for (const reading of readings) {
    const before = prev[reading.id];
    if (!before) {
      // First sighting. Only a non-ok reading is worth an email.
      checks[reading.id] = { level: reading.level, since: now, lastAlertAt: reading.level === "ok" ? null : now };
      if (reading.level !== "ok") alerts.push({ kind: "problem", reading });
      continue;
    }
    if (reading.level !== before.level) {
      const recovered = reading.level === "ok";
      checks[reading.id] = { level: reading.level, since: now, lastAlertAt: recovered ? null : now };
      alerts.push({ kind: recovered ? "recovered" : "problem", reading });
    } else if (reading.level !== "ok" && now - (before.lastAlertAt ?? 0) >= REPEAT_MS[reading.level]) {
      checks[reading.id] = { ...before, lastAlertAt: now };
      alerts.push({ kind: "still", reading });
    }
  }
  return { alerts, checks };
}

export function subjectFor(alerts: Alert[], host: string): string {
  const worst = alerts.some((a) => a.reading.level === "crit" && a.kind !== "recovered")
    ? "CRITICAL"
    : alerts.some((a) => a.kind === "problem" || a.kind === "still")
      ? "WARNING"
      : alerts.every((a) => a.kind === "recovered")
        ? "OK again"
        : "Notice";
  const first = alerts[0]?.reading;
  const more = alerts.length > 1 ? ` (+${alerts.length - 1} more)` : "";
  return `[jqp VM ${host}] ${worst}: ${first?.label ?? "check"}${more}`;
}

const ADVICE: Record<string, string> = {
  disk: "Free space: run `sudo journalctl --vacuum-size=50M` and `sudo apt-get clean`. Check `du -xh / --max-depth=2 | sort -h | tail`.",
  memory: "Check `ps aux --sort=-rss | head`. If the worker is the cause, `sudo systemctl restart jqp-dm-worker`.",
  transfer: "Far more outbound data than a DM worker should send. Check `sudo journalctl -u jqp-dm-worker --since today`, then consider stopping the service and rotating secrets.",
  service: "Run `sudo systemctl status jqp-dm-worker` and `sudo journalctl -u jqp-dm-worker -n 80`. A crash loop is usually a wrong DATABASE_URL or REDIS_URL.",
  reboot: "The VM restarted (Oracle maintenance or a crash). The worker comes back on its own; confirm with `npm run smoke`.",
  halt: "The worker was stopped automatically and stays stopped, even after a reboot. Queued DMs are safe in Redis. Fix the cause, then run `jqp resume`. Resume within 72 hours: comments the webhook already queued are kept longer, but the catch-up sweep only reaches back 72 hours.",
  mail: "Test mail path on the VM: sudo -u jqp node /opt/jqp/bin/vm-guard.mjs --test-email"
};

export function bodyFor(alerts: Alert[], host: string, now: number): string {
  const lines = alerts.map((a) => {
    const tag = a.kind === "recovered" ? "RECOVERED" : a.kind === "info" ? "INFO" : a.reading.level.toUpperCase();
    const advice = a.kind === "recovered" ? "" : `\n    What to do: ${ADVICE[a.reading.id] ?? "see docs/ORACLE-WORKER.md"}`;
    return `- ${tag}: ${a.reading.label}: ${a.reading.detail}${advice}`;
  });
  return [
    `Host: ${host}`,
    `Time (UTC): ${new Date(now).toISOString()}`,
    "",
    ...lines,
    "",
    "Details and recovery steps: docs/ORACLE-WORKER.md in the jqp repository."
  ].join("\n");
}
