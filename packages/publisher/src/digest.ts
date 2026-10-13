import { getDb, loadEnv } from "@jqp/core";
import { sendAlertEmail } from "./alerts.js";
import { scrubText } from "./events.js";
import { getSystemSnapshot, type SystemSnapshot } from "./system.js";

/**
 * A periodic "how is everything" email, separate from the alert emails. Alerts only fire when a check changes state;
 * this one arrives on a schedule even when nothing is wrong, so silence from it means the scheduler itself has stopped.
 * Nothing personal goes in: counts, check names and already-scrubbed event messages only.
 */

export interface DigestActivity {
  postsLive: number;
  postsWaiting: number;
  campaignsOn: number;
  commentsMatched24h: number | null;
}

const ICON = { ok: "OK  ", warn: "WARN", down: "DOWN" } as const;

const stamp = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const h = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLOR = {
  ok: { fg: "#177a3c", bg: "#e6f4ea", label: "OK" },
  warn: { fg: "#a15c00", bg: "#fff3d6", label: "WARNING" },
  down: { fg: "#b3140f", bg: "#fde4e2", label: "DOWN" }
} as const;

/** Email-safe HTML (tables and inline styles only) with the same facts as the plain text. */
export function digestHtml(snap: SystemSnapshot, activity: DigestActivity, dashboardUrl: string, now: Date, level: "ok" | "warn" | "down", headline: string): string {
  const c = COLOR[level];
  const dm = snap.dm.last24h;
  const stat = (value: string | number, label: string) =>
    `<td style="padding:12px 8px;text-align:center;background:#ffffff;border:1px solid #e4e1d6;border-radius:8px"><div style="font-size:22px;font-weight:700;color:#141414">${h(String(value))}</div><div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.04em">${h(label)}</div></td>`;
  const row = (s: SystemSnapshot["services"][number]) => {
    const k = COLOR[s.state];
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #eeebe0;width:84px"><span style="display:inline-block;padding:2px 9px;border-radius:10px;background:${k.bg};color:${k.fg};font-size:11px;font-weight:700">${k.label}</span></td><td style="padding:8px 0 8px 8px;border-bottom:1px solid #eeebe0;font-size:14px;color:#141414"><b>${h(s.label)}</b><br><span style="color:#6b6b6b;font-size:13px">${h(s.detail)}</span></td></tr>`;
  };
  const recent = snap.events.filter((e) => e.level !== "info").slice(0, 6);
  const failures = snap.dm.topFailures.slice(0, 5);
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f1ea;font-family:Segoe UI,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1ea"><tr><td align="center" style="padding:18px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
<tr><td style="background:#141414;color:#FEFAE8;padding:16px 20px;border-radius:10px 10px 0 0;font-size:15px"><b>addaddy.ai</b> &nbsp;system report</td></tr>
<tr><td style="background:${c.bg};padding:22px 20px;border-left:1px solid #e4e1d6;border-right:1px solid #e4e1d6">
<div style="font-size:26px;font-weight:800;color:${c.fg}">${h(headline)}</div>
<div style="font-size:13px;color:#4a4a4a;margin-top:4px">${h(now.toISOString().slice(0, 16).replace("T", " "))} UTC &middot; ${snap.services.length - snap.services.filter((s) => s.state !== "ok").length} of ${snap.services.length} checks passing</div></td></tr>
<tr><td style="background:#f8f6ee;padding:16px 14px;border-left:1px solid #e4e1d6;border-right:1px solid #e4e1d6">
<div style="font-size:12px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.05em;margin:0 6px 8px">Activity, last 24 hours</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="6"><tr>${stat(dm.sent, "DMs sent")}${stat(dm.failed, "Failed")}${stat(dm.skipped, "Skipped")}${stat(`${snap.dm.lastHourSent}/${snap.dm.hourlyLimit}`, "This hour")}</tr>
<tr>${stat(activity.postsLive, "Live posts")}${stat(activity.postsWaiting, "Waiting")}${stat(activity.campaignsOn, "Campaigns on")}${stat(snap.failedPosts, "Failed posts")}</tr></table>
<div style="font-size:12px;color:#6b6b6b;margin:8px 6px 0">Last webhook from Meta: ${h(snap.lastWebhookAt ? stamp(snap.lastWebhookAt) : "none recorded")} &middot; Queue: ${snap.queue ? `${snap.queue.waiting} waiting, ${snap.queue.active} sending, ${snap.queue.delayed} delayed, ${snap.queue.failed} failed` : "not readable"}</div></td></tr>
<tr><td style="background:#ffffff;padding:16px 20px;border:1px solid #e4e1d6"><div style="font-size:12px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">All checks</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${snap.services.map(row).join("")}</table></td></tr>
${failures.length ? `<tr><td style="background:#ffffff;padding:14px 20px;border:1px solid #e4e1d6;border-top:0"><div style="font-size:12px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Top DM failure reasons</div>${failures.map((f) => `<div style="font-size:13px;color:#141414;padding:2px 0">${f.count} &times; ${h(scrubText(f.reason))}</div>`).join("")}</td></tr>` : ""}
${recent.length ? `<tr><td style="background:#ffffff;padding:14px 20px;border:1px solid #e4e1d6;border-top:0"><div style="font-size:12px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Recent problems</div>${recent.map((e) => `<div style="font-size:13px;color:#141414;padding:3px 0"><span style="color:#6b6b6b">${h(stamp(e.created_at).slice(0, 16).replace("T", " "))}</span> &nbsp;<b>${h(e.level)}</b> ${h(e.source)}: ${h(scrubText(e.message))}</div>`).join("")}</td></tr>` : ""}
<tr><td style="background:#ffffff;padding:18px 20px;border:1px solid #e4e1d6;border-top:0;border-radius:0 0 10px 10px;text-align:center"><a href="${h(dashboardUrl)}/system" style="display:inline-block;background:#D9070B;color:#ffffff;text-decoration:none;font-weight:700;padding:10px 22px;border-radius:8px;font-size:14px">Open the dashboard</a>
<div style="font-size:11px;color:#8a8a8a;margin-top:12px">Sent every 6 hours. If these stop arriving, the scheduler has stopped: check the GitHub Actions "monitor" workflow.</div></td></tr>
</table></td></tr></table></body></html>`;
}

export function formatDigest(snap: SystemSnapshot, activity: DigestActivity, dashboardUrl: string, now = new Date()): { subject: string; lines: string[]; html: string } {
  const down = snap.services.filter((s) => s.state === "down");
  const warn = snap.services.filter((s) => s.state === "warn");
  const passing = snap.services.length - down.length - warn.length;
  const status = down.length > 0 ? "ATTENTION" : warn.length > 0 ? "WARNINGS" : "ALL OK";
  const subject = `[${status}] jqp health: ${passing}/${snap.services.length} checks pass`;

  const dm = snap.dm.last24h;
  const lines: string[] = [
    `jqp status at ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `Overall: ${status}. ${passing} of ${snap.services.length} checks passing.`,
    ...(down.length || warn.length ? ["", "Needs a look:", ...[...down, ...warn].map((s) => `  - ${s.label}: ${s.detail}`)] : []),
    "",
    "Activity",
    `  Direct messages, last 24 hours: ${dm.sent} sent, ${dm.failed} failed, ${dm.skipped} skipped, ${dm.pending} waiting`,
    `  Sent this hour: ${snap.dm.lastHourSent} of ${snap.dm.hourlyLimit} allowed`,
    ...(activity.commentsMatched24h !== null ? [`  Comments that matched a campaign, last 24 hours: ${activity.commentsMatched24h}`] : []),
    `  Live posts: ${activity.postsLive}. Posts waiting to publish: ${activity.postsWaiting}. Campaigns switched on: ${activity.campaignsOn}`,
    `  Failed posts: ${snap.failedPosts}`,
    `  Last webhook from Meta: ${snap.lastWebhookAt ? stamp(snap.lastWebhookAt) : "none recorded"}`,
    `  Queue: ${snap.queue ? `${snap.queue.waiting} waiting, ${snap.queue.active} sending, ${snap.queue.delayed} delayed, ${snap.queue.failed} failed` : "not readable"}`,
    "",
    "All checks"
  ];
  for (const s of snap.services) lines.push(`  ${ICON[s.state]}  ${s.label}: ${s.detail}`);

  if (snap.dm.topFailures.length > 0) {
    lines.push("", "Top DM failure reasons (24h)");
    for (const f of snap.dm.topFailures.slice(0, 5)) lines.push(`  ${f.count} x ${scrubText(f.reason)}`);
  }
  const recent = snap.events.filter((e) => e.level !== "info").slice(0, 6);
  if (recent.length > 0) {
    lines.push("", "Recent problems");
    for (const e of recent) lines.push(`  ${stamp(e.created_at).slice(0, 16).replace("T", " ")} ${e.level} ${e.source}: ${scrubText(e.message)}`);
  }
  if (snap.token.expiring.length > 0) {
    lines.push("", "Tokens needing attention");
    for (const t of snap.token.expiring) lines.push(`  @${t.username}: ${t.daysLeft === null ? "expiry unknown" : t.daysLeft < 0 ? "expired" : `${t.daysLeft} days left`}`);
  }
  lines.push("", `Dashboard: ${dashboardUrl}/system`, "This email is sent every 6 hours. If it stops arriving, the scheduler has stopped; check the GitHub Actions 'monitor' workflow.");
  const level = down.length > 0 ? "down" : warn.length > 0 ? "warn" : "ok";
  const headline = down.length > 0 ? "Needs attention" : warn.length > 0 ? "Healthy, with warnings" : "All healthy";
  return { subject, lines, html: digestHtml(snap, activity, dashboardUrl, now, level, headline) };
}

async function readActivity(): Promise<DigestActivity> {
  const sql = getDb();
  const [posts] = await sql<{ live: number; waiting: number }[]>`
    select count(*) filter (where status::text = 'PUBLISHED')::int as live, count(*) filter (where status::text = 'DISCOVERED')::int as waiting from posts`;
  const [camps] = await sql<{ n: number }[]>`select count(*)::int as n from campaigns where enabled`;
  let matched: number | null = null;
  try {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from "DmLog" where "createdAt" > now() - interval '24 hours'`;
    matched = row?.n ?? null;
  } catch {
    matched = null;
  }
  return { postsLive: posts?.live ?? 0, postsWaiting: posts?.waiting ?? 0, campaignsOn: camps?.n ?? 0, commentsMatched24h: matched };
}

export async function sendHealthDigest(): Promise<{ sent: boolean; reason?: string; subject: string }> {
  const snap = await getSystemSnapshot();
  const activity = await readActivity();
  const { subject, lines, html } = formatDigest(snap, activity, loadEnv().APP_BASE_URL.replace(/\/$/, ""));
  const result = await sendAlertEmail(subject, lines, html);
  return { ...result, subject };
}
