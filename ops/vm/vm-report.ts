// The scheduled status email: ONE message with the system report (built by the dashboard) and this VM's own
// readings side by side. Pure functions, no I/O, so they can be tested. vm-guard.ts gathers the data and sends it.
import { ORACLE_FREE_TRANSFER_TB, type Level, type Meminfo, type Reading, type Thresholds } from "./guard-core";

/** The system half, built by the dashboard (/api/cron/digest-data) and embedded as is. */
export interface SystemSection {
  level: "ok" | "warn" | "down";
  headline: string;
  passing: number;
  total: number;
  lines: string[];
  rowsHtml: string;
  dashboardUrl: string;
  generatedAt: string;
}

export interface VmReportInput {
  /** null/undefined when the dashboard could not be reached; `systemError` then says why. */
  system?: SystemSection | null;
  systemError?: string | null;
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
const RANK = { ok: 0, warn: 1, crit: 2 } as const;

function uptimeText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function buildVmReport(i: VmReportInput): { subject: string; text: string; html: string } {
  const vmLevel: Level = i.readings.some((r) => r.level === "crit") || i.halted ? "crit" : i.readings.some((r) => r.level === "warn") ? "warn" : "ok";
  // A missing system section counts as a warning: silence about the system must never look like "all fine".
  const sysLevel: Level = !i.system ? "warn" : i.system.level === "down" ? "crit" : i.system.level === "warn" ? "warn" : "ok";
  const worst: Level = RANK[vmLevel] >= RANK[sysLevel] ? vmLevel : sysLevel;
  const workerRunning = i.serviceActive === "active";
  const workerLine = i.halted
    ? `DM worker STOPPED by the force stop (${i.halted})`
    : workerRunning
      ? "DM worker running"
      : i.serviceEnabled === "disabled"
        ? "DM worker not running (stopped on purpose or not started yet)"
        : `DM worker is "${i.serviceActive}", not running`;
  const headline = worst === "ok" ? "Everything healthy" : worst === "warn" ? "Healthy, with warnings" : "Needs attention";
  const word = worst === "ok" ? "ALL OK" : worst === "warn" ? "WARNINGS" : "ATTENTION";
  const sysShort = i.system ? `system ${i.system.passing}/${i.system.total}` : "system report unavailable";
  const subject = `[${word}] addaddy.ai: ${sysShort}, VM ${workerRunning ? "worker running" : "worker not running"}, disk ${i.diskPct ?? "?"}%`;

  const t = i.thresholds;
  const memUsedPct = i.mem && i.memTotalMb > 0 ? Math.round(((i.memTotalMb - i.mem.availableMb) / i.memTotalMb) * 100) : null;
  const swapUsedPct = i.mem && i.mem.swapTotalMb > 0 ? Math.round(((i.mem.swapTotalMb - i.mem.swapFreeMb) / i.mem.swapTotalMb) * 100) : 0;
  const gb = i.transferBytes / 1e9;
  const transferPct = (i.transferBytes / (ORACLE_FREE_TRANSFER_TB * 1e12)) * 100;
  const lvl = (id: string): Level => i.readings.find((r) => r.id === id)?.level ?? "ok";

  const gauges: { label: string; value: string; pct: number; level: Level; limit: string }[] = [
    { label: "Disk", value: i.diskPct === null ? "unknown" : `${i.diskPct}% used`, pct: i.diskPct ?? 0, level: lvl("disk"), limit: `warn ${t.diskWarnPct}%, critical ${t.diskCritPct}%, force stop ${t.diskHaltPct}%` },
    { label: "Memory", value: i.mem ? `${Math.round(i.mem.availableMb)} MB available of ${Math.round(i.memTotalMb)} MB (${memUsedPct}% in use, swap ${swapUsedPct}%)` : "unknown", pct: memUsedPct ?? 0, level: lvl("memory"), limit: `warn under ${t.memAvailWarnMb} MB available, critical under ${t.memAvailCritMb} MB` },
    { label: "Outbound data this month", value: `${gb.toFixed(2)} GB of ${ORACLE_FREE_TRANSFER_TB} TB free (${transferPct.toFixed(3)}%)`, pct: Math.max(transferPct, gb > 0 ? 1 : 0), level: lvl("transfer"), limit: `warn ${t.transferWarnGb} GB, critical ${t.transferCritGb} GB, force stop at ${t.transferHaltPct}% of the allowance` }
  ];

  const when = new Date(i.now).toISOString().slice(0, 16).replace("T", " ");
  const text = [
    `addaddy.ai: ${headline} (${when} UTC)`,
    "",
    "== SYSTEM ==",
    ...(i.system ? i.system.lines : [`System report unavailable: ${i.systemError ?? "the dashboard could not be reached"}`]),
    "",
    `== VM ${i.host} ==`,
    workerLine,
    ...gauges.map((g) => `${g.label}: ${g.value} (${g.limit})`),
    `DM worker restarts since boot: ${i.restartsSinceBoot ?? "unknown"}`,
    `Uptime: ${uptimeText(i.uptimeSec)}. Load: ${i.load1.toFixed(2)} on ${i.cpus} CPU(s)`,
    "",
    "One email every 6 hours, sent by the VM. If it stops arriving, the VM or its guard is down. Live numbers on the VM: jqp status"
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
  const label = (name: string) => `<tr><td style="background:#141414;color:#FEFAE8;padding:9px 20px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:700">${esc(name)}</td></tr>`;
  const systemBlock = i.system
    ? `${label(`System: ${i.system.passing} of ${i.system.total} checks passing`)}${i.system.rowsHtml}`
    : `${label("System")}<tr><td style="background:#fff3d6;color:#a15c00;padding:14px 20px;border:1px solid #e4e1d6;font-size:14px"><b>System report unavailable.</b> ${esc(i.systemError ?? "The dashboard could not be reached.")} The VM numbers below are still current.</td></tr>`;
  const dashboardUrl = i.system?.dashboardUrl ?? "";
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f1ea;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ea"><tr><td align="center" style="padding:18px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="background:#141414;color:#FEFAE8;padding:16px 20px;border-radius:10px 10px 0 0;font-size:15px"><b>addaddy.ai</b> &nbsp;status report</td></tr>
<tr><td style="background:${c.bg};padding:22px 20px;border-left:1px solid #e4e1d6;border-right:1px solid #e4e1d6"><div style="font-size:26px;font-weight:800;color:${c.fg}">${esc(headline)}</div>
<div style="font-size:14px;color:#141414;margin-top:6px"><b>${esc(workerLine)}</b></div>
<div style="font-size:12px;color:#4a4a4a;margin-top:4px">${esc(when)} UTC &middot; ${esc(sysShort)} &middot; VM up ${esc(uptimeText(i.uptimeSec))}</div></td></tr>
${systemBlock}
${label(`VM ${i.host}: resources against the free limits`)}
<tr><td style="background:#ffffff;padding:4px 20px 10px;border:1px solid #e4e1d6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${gauges.map(bar).join("")}
<tr><td style="padding:10px 0;font-size:13px;color:#141414">Load ${i.load1.toFixed(2)} on ${i.cpus} CPU &middot; ${i.restartsSinceBoot ?? "?"} worker restarts since boot &middot; up ${esc(uptimeText(i.uptimeSec))}</td></tr></table></td></tr>
<tr><td style="background:#ffffff;padding:18px 20px;border:1px solid #e4e1d6;border-top:0;border-radius:0 0 10px 10px;text-align:center">${dashboardUrl ? `<a href="${esc(dashboardUrl)}/system" style="display:inline-block;background:#D9070B;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 22px;border-radius:8px;font-size:14px">Open the dashboard</a>` : ""}
<div style="font-size:12px;color:#6b6b6b;margin-top:12px">The worker is stopped automatically at ${t.diskHaltPct}% disk or ${t.transferHaltPct}% of the outbound allowance. Queued comments wait safely in Redis until <code>jqp resume</code>.</div>
<div style="font-size:11px;color:#8a8a8a;margin-top:8px">One email every 6 hours, sent by the VM. If it stops arriving, the VM or its guard is down. Live numbers: <code>jqp status</code></div></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
