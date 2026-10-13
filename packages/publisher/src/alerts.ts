import nodemailer from "nodemailer";
import { getDb, loadEnv, rootLogger } from "@jqp/core";
import { recordEvent, scrubText } from "./events.js";
import { getSystemSnapshot, type ServiceStatus, type SystemSnapshot } from "./system.js";

/**
 * Turns the health snapshot into notifications.
 *
 * State machine per check (table alert_state):
 *   ok      -> failing : record an error event and email once
 *   failing -> failing : stay quiet, but remind every REMIND_AFTER_HOURS
 *   failing -> ok      : record an info event and email "recovered"
 *
 * The point is to be told when something breaks, not to be emailed every time
 * the monitor looks. At 500-1000 DMs a day a noisy alert is ignored within a week.
 */

const REMIND_AFTER_HOURS = 6;

interface AlertRow {
  key: string;
  status: "ok" | "failing";
  since: string;
  last_notified_at: string | null;
  detail: string;
}

export interface MonitorResult {
  /** False when alert state could not be read, so transition alerts were skipped. */
  stateAvailable: boolean;
  checked: number;
  failing: string[];
  newlyFailing: string[];
  recovered: string[];
  emailed: boolean;
  emailSkippedReason?: string;
}

/**
 * Sends one alert email. Uses SMTP when ALERT_SMTP_HOST is set (Brevo and similar),
 * otherwise Resend's HTTP API. Never throws: a failed email must not break the monitor.
 */
export async function sendAlertEmail(subject: string, lines: string[], html?: string): Promise<{ sent: boolean; reason?: string }> {
  const env = loadEnv();
  const to = env.ALERT_EMAIL_TO.trim();
  const from = (env.ALERT_EMAIL_FROM || process.env.OPENREPLY_EMAIL_FROM || "").trim();
  if (!to) return { sent: false, reason: "ALERT_EMAIL_TO not set" };

  const smtpHost = env.ALERT_SMTP_HOST.trim();
  if (smtpHost) {
    if (!from || !env.ALERT_SMTP_USER || !env.ALERT_SMTP_PASS) return { sent: false, reason: "SMTP user, password or from-address not set" };
    try {
      const transport = nodemailer.createTransport({
        host: smtpHost,
        port: env.ALERT_SMTP_PORT,
        secure: env.ALERT_SMTP_PORT === 465,
        // Refuse to send credentials unless the connection is upgraded to TLS (STARTTLS is otherwise strippable).
        requireTLS: env.ALERT_SMTP_PORT !== 465,
        auth: { user: env.ALERT_SMTP_USER, pass: env.ALERT_SMTP_PASS },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 12000
      });
      await transport.sendMail({ from, to: to.split(",").map((s) => s.trim()).filter(Boolean), subject, text: lines.join("\n"), ...(html ? { html } : {}) });
      return { sent: true };
    } catch (err) {
      return { sent: false, reason: scrubText(err instanceof Error ? err.message : String(err)) };
    }
  }

  const apiKey = (env.ALERT_RESEND_API_KEY || process.env.OPENREPLY_RESEND_API_KEY || "").trim();
  if (!apiKey || !from) return { sent: false, reason: "No email provider configured (set ALERT_SMTP_* or a Resend key) or from-address missing" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        text: lines.join("\n"),
        ...(html ? { html } : {})
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { sent: false, reason: `Resend returned HTTP ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: scrubText(err instanceof Error ? err.message : String(err)) };
  }
}

// In-memory throttle for the "database unreachable" email. Alert state lives in
// the database, so when the database is the thing that is down there is nowhere
// durable to remember that we already told you. Per-instance and best effort:
// worst case is one email per hour per warm instance, never one every 10 minutes.
let lastDbDownEmailAt = 0;
const DB_DOWN_EMAIL_INTERVAL_MS = 60 * 60 * 1000;

/** Test hook: forget that a database-down email was recently sent. */
export function __resetAlertThrottleForTests(): void {
  lastDbDownEmailAt = 0;
}

function describe(checks: ServiceStatus[]): string[] {
  return checks.map((c) => `- ${c.label}: ${c.detail}`);
}

export async function runMonitor(existing?: SystemSnapshot): Promise<MonitorResult> {
  const sql = getDb();
  const env = loadEnv();
  const snapshot = existing ?? (await getSystemSnapshot());
  const dashboard = env.APP_BASE_URL.replace(/\/$/, "");

  let rows: AlertRow[] = [];
  try {
    rows = await sql<AlertRow[]>`select key, status, since, last_notified_at, detail from alert_state`;
  } catch (err) {
    const failing = snapshot.services.filter((s) => s.state !== "ok").map((s) => s.key);
    const base = { stateAvailable: false, checked: snapshot.services.length, failing, newlyFailing: [] as string[], recovered: [] as string[], emailed: false };

    if (/alert_state/.test(String(err)) && /does not exist/.test(String(err))) {
      // Without the state table every failing check would look new on every run and
      // email every 10 minutes. Stay quiet until the migration is applied.
      rootLogger.warn("alert_state_table_missing", { hint: "apply supabase/migrations/0008_system_events.sql" });
      return { ...base, emailSkippedReason: "migration 0008 not applied: alerts are disabled until it is" };
    }

    // The database itself is unreachable. Say so, at most once an hour.
    rootLogger.error("monitor_state_unreadable", { error: scrubText(err instanceof Error ? err.message : String(err)) });
    if (Date.now() - lastDbDownEmailAt > DB_DOWN_EMAIL_INTERVAL_MS) {
      const result = await sendAlertEmail("[DOWN] jqp: database unreachable", [
        "The monitor could not read from the database, so the system cannot be fully checked.",
        "",
        ...describe(snapshot.services.filter((s) => s.state !== "ok")),
        "",
        `Dashboard: ${dashboard}/system`,
        `Checked at ${snapshot.generatedAt}`
      ]);
      if (result.sent) lastDbDownEmailAt = Date.now();
      return { ...base, emailed: result.sent, emailSkippedReason: result.reason };
    }
    return { ...base, emailSkippedReason: "database unreachable; already emailed within the last hour" };
  }
  const previous = new Map(rows.map((r) => [r.key, r]));

  const newlyFailing: ServiceStatus[] = [];
  const reminders: ServiceStatus[] = [];
  const recovered: ServiceStatus[] = [];
  const now = Date.now();

  for (const service of snapshot.services) {
    const prior = previous.get(service.key);
    const failing = service.state !== "ok";

    if (failing && (!prior || prior.status === "ok")) {
      newlyFailing.push(service);
    } else if (failing && prior) {
      const last = prior.last_notified_at ? new Date(prior.last_notified_at).getTime() : 0;
      if (now - last > REMIND_AFTER_HOURS * 3_600_000) reminders.push(service);
    } else if (!failing && prior?.status === "failing") {
      recovered.push(service);
    }
  }

  for (const s of newlyFailing) {
    await recordEvent({ level: s.state === "down" ? "error" : "warn", source: "monitor", code: `check_failing_${s.key}`, message: `${s.label}: ${s.detail}` });
  }
  for (const s of recovered) {
    await recordEvent({ level: "info", source: "monitor", code: `check_recovered_${s.key}`, message: `${s.label} recovered` });
  }

  let emailed = false;
  let emailSkippedReason: string | undefined;
  const toSend = [...newlyFailing, ...reminders];
  if (toSend.length > 0 || recovered.length > 0) {
    const worst = toSend.some((s) => s.state === "down");
    const subject =
      toSend.length > 0
        ? `${worst ? "[DOWN]" : "[WARNING]"} jqp: ${toSend.map((s) => s.label).join(", ")}`
        : `[RECOVERED] jqp: ${recovered.map((s) => s.label).join(", ")}`;
    const lines = [
      ...(toSend.length > 0 ? ["Needs attention:", ...describe(toSend), ""] : []),
      ...(recovered.length > 0 ? ["Recovered:", ...describe(recovered), ""] : []),
      `Details: ${dashboard}/system`,
      `Checked at ${snapshot.generatedAt}`
    ];
    const result = await sendAlertEmail(subject, lines);
    emailed = result.sent;
    emailSkippedReason = result.reason;
  }

  // Persist the new state. last_notified_at moves only when we actually emailed,
  // so a missing email configuration keeps retrying until one is set up.
  try {
    for (const s of snapshot.services) {
      const failing = s.state !== "ok";
      const prior = previous.get(s.key);
      const notifyNow = emailed && (newlyFailing.includes(s) || reminders.includes(s) || recovered.includes(s));
      const becameFailing = failing && (!prior || prior.status === "ok");
      const since = becameFailing || (!failing && prior?.status === "failing") ? new Date() : prior ? new Date(prior.since) : new Date();
      await sql`
        insert into alert_state (key, status, since, last_notified_at, detail)
        values (${s.key}, ${failing ? "failing" : "ok"}, ${since}, ${notifyNow ? new Date() : (prior?.last_notified_at ? new Date(prior.last_notified_at) : null)}, ${scrubText(s.detail)})
        on conflict (key) do update set
          status = excluded.status,
          since = excluded.since,
          last_notified_at = excluded.last_notified_at,
          detail = excluded.detail
      `;
    }
  } catch (err) {
    if (!(/alert_state/.test(String(err)) && /does not exist/.test(String(err)))) throw err;
  }

  return {
    stateAvailable: true,
    checked: snapshot.services.length,
    failing: snapshot.services.filter((s) => s.state !== "ok").map((s) => s.key),
    newlyFailing: newlyFailing.map((s) => s.key),
    recovered: recovered.map((s) => s.key),
    emailed,
    emailSkippedReason
  };
}
