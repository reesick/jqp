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
  // When the last scheduled status report email went out (ms since epoch), so one is sent every REPORT_INTERVAL_MS.
  lastReportAt: number | null;
}

export function emptyState(): GuardState {
  return {
    checks: {},
    transfer: { month: "", bytes: 0, lastCounter: null },
    restarts: { lastCount: null },
    bootId: null,
    haltNotified: false,
    lastReportAt: null
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
  if (isNum(raw.lastReportAt)) base.lastReportAt = raw.lastReportAt;
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

// ---- scheduled status report ---------------------------------------------------------
// A plain "how is the VM" email on a schedule, even when nothing is wrong. Alerts above only fire on trouble, so
// without this a silent guard and a healthy VM look the same. If these stop arriving, the guard or the VM is down.

export const REPORT_INTERVAL_MS = 6 * 3_600_000;

export function reportDue(lastReportAt: number | null, now: number, intervalMs: number = REPORT_INTERVAL_MS): boolean {
  return lastReportAt === null || now - lastReportAt >= intervalMs || now < lastReportAt;
}

export interface VmReportInput {
  host: string;
  now: number;
  readings: Reading[];
  thresholds: Thresholds;
  diskPct: number | null;
  memTotalMb: number;
  mem: Meminfo | null;
  transferBytes: number;
  serviceActive: string;
  serviceEnabled: string;
  halted: string | null;
  restartsSinceBoot: number | null;
  uptimeSec: number;
  load1: number;
  cpus: number;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TONE = {
  ok: { fg: "#177a3c", bg: "#e6f4ea", bar: "#2e9e57", word: "OK" },
  warn: { fg: "#a15c00", bg: "#fff3d6", bar: "#e0a100", word: "WARNING" },
  crit: { fg: "#b3140f", bg: "#fde4e2", bar: "#d9322c", word: "CRITICAL" }
} as const;

function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function buildVmReport(i: VmReportInput): { subject: string; text: string; html: string } {
  const worst: Level = i.readings.some((r) => r.level === "crit") || i.halted ? "crit" : i.readings.some((r) => r.level === "warn") ? "warn" : "ok";
  const workerRunning = i.serviceActive === "active";
  const workerLine = i.halted
    ? `DM worker STOPPED by the force stop (${i.halted})`
    : workerRunning
      ? "DM worker running"
      : i.serviceEnabled === "disabled"
        ? "DM worker not running (stopped on purpose or not started yet)"
        : `DM worker is "${i.serviceActive}", not running`;
  const headline = worst === "ok" ? "VM healthy" : worst === "warn" ? "VM healthy, with warnings" : "VM needs attention";
  const subject = `[VM ${worst === "ok" ? "OK" : worst === "warn" ? "WARNING" : "ATTENTION"}] ${i.host}: ${workerRunning ? "worker running" : "worker not running"}, disk ${i.diskPct ?? "?"}%`;

  const t = i.thresholds;
  const memUsedPct = i.mem && i.memTotalMb > 0 ? Math.round(((i.memTotalMb - i.mem.availableMb) / i.memTotalMb) * 100) : null;
  const swapUsedPct = i.mem && i.mem.swapTotalMb > 0 ? Math.round(((i.mem.swapTotalMb - i.mem.swapFreeMb) / i.mem.swapTotalMb) * 100) : 0;
  const gb = i.transferBytes / 1e9;
  const transferPct = (i.transferBytes / (ORACLE_FREE_TRANSFER_TB * 1e12)) * 100;
  const lvl = (id: string): Level => i.readings.find((r) => r.id === id)?.level ?? "ok";

  const gauges: { label: string; value: string; pct: number; level: Level; limit: string }[] = [
    { label: "Disk", value: i.diskPct === null ? "unknown" : `${i.diskPct}% used`, pct: i.diskPct ?? 0, level: lvl("disk"), limit: `warn ${t.diskWarnPct}%, critical ${t.diskCritPct}%, force stop ${t.diskHaltPct}%` },
    { label: "Memory", value: i.mem ? `${Math.round(i.mem.availableMb)} MB free of ${Math.round(i.memTotalMb)} MB, swap ${swapUsedPct}%` : "unknown", pct: memUsedPct ?? 0, level: lvl("memory"), limit: `warn under ${t.memAvailWarnMb} MB free, critical under ${t.memAvailCritMb} MB` },
    { label: "Outbound data this month", value: `${gb.toFixed(2)} GB of ${ORACLE_FREE_TRANSFER_TB} TB free (${transferPct.toFixed(3)}%)`, pct: Math.max(transferPct, gb > 0 ? 1 : 0), level: lvl("transfer"), limit: `warn ${t.transferWarnGb} GB, critical ${t.transferCritGb} GB, force stop at ${t.transferHaltPct}% of the allowance` }
  ];

  const text = [
    `${headline}: ${i.host}`,
    `${new Date(i.now).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    workerLine,
    ...gauges.map((g) => `${g.label}: ${g.value} (${g.limit})`),
    `DM worker restarts since boot: ${i.restartsSinceBoot ?? "unknown"}`,
    `Uptime: ${uptimeText(i.uptimeSec)}. Load: ${i.load1.toFixed(2)} on ${i.cpus} CPU(s)`,
    "",
    "Run `jqp status` on the VM for live numbers. This report is sent every 6 hours; if it stops arriving, the VM or its guard is down."
  ].join("\n");

  const bar = (g: (typeof gauges)[number]) => {
    const k = TONE[g.level];
    const w = Math.min(100, Math.max(0, Math.round(g.pct)));
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eeebe0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px;color:#141414"><b>${esc(g.label)}</b></td><td align="right"><span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${k.bg};color:${k.fg};font-size:11px;font-weight:700">${k.word}</span></td></tr></table>
<div style="font-size:13px;color:#141414;margin:4px 0 6px">${esc(g.value)}</div>
<div style="background:#eeebe0;border-radius:5px;height:9px;overflow:hidden"><div style="background:${k.bar};width:${w}%;height:9px"></div></div>
<div style="font-size:11px;color:#8a8a8a;margin-top:5px">${esc(g.limit)}</div></td></tr>`;
  };
  const c = TONE[worst];
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f1ea;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ea"><tr><td align="center" style="padding:18px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="background:#141414;color:#FEFAE8;padding:16px 20px;border-radius:10px 10px 0 0;font-size:15px"><b>addaddy.ai</b> &nbsp;VM report &nbsp;<span style="opacity:.7">${esc(i.host)}</span></td></tr>
<tr><td style="background:${c.bg};padding:22px 20px;border-left:1px solid #e4e1d6;border-right:1px solid #e4e1d6"><div style="font-size:26px;font-weight:800;color:${c.fg}">${esc(headline)}</div>
<div style="font-size:14px;color:#141414;margin-top:6px"><b>${esc(workerLine)}</b></div>
<div style="font-size:12px;color:#4a4a4a;margin-top:4px">${esc(new Date(i.now).toISOString().slice(0, 16).replace("T", " "))} UTC &middot; up ${esc(uptimeText(i.uptimeSec))} &middot; load ${i.load1.toFixed(2)} on ${i.cpus} CPU &middot; ${i.restartsSinceBoot ?? "?"} worker restarts</div></td></tr>
<tr><td style="background:#ffffff;padding:8px 20px 14px;border:1px solid #e4e1d6"><div style="font-size:12px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.05em;margin:10px 0 0">Resources against the free limits</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${gauges.map(bar).join("")}</table></td></tr>
<tr><td style="background:#ffffff;padding:14px 20px;border:1px solid #e4e1d6;border-top:0;border-radius:0 0 10px 10px"><div style="font-size:12px;color:#6b6b6b">The worker is stopped automatically at ${t.diskHaltPct}% disk or ${t.transferHaltPct}% of the outbound allowance. Queued comments wait safely in Redis until <code>jqp resume</code>.</div>
<div style="font-size:11px;color:#8a8a8a;margin-top:10px">Sent every 6 hours by the VM itself. If these stop arriving, the VM or its guard is down. Live numbers: <code>jqp status</code></div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
