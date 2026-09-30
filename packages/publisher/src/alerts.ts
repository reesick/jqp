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
  checked: number;
  failing: string[];
  newlyFailing: string[];
  recovered: string[];
  emailed: boolean;
  emailSkippedReason?: string;
}

async function sendEmail(subject: string, lines: string[]): Promise<{ sent: boolean; reason?: string }> {
  const env = loadEnv();
  const to = env.ALERT_EMAIL_TO.trim();
  const apiKey = (env.ALERT_RESEND_API_KEY || process.env.OPENREPLY_RESEND_API_KEY || "").trim();
  const from = (env.ALERT_EMAIL_FROM || process.env.OPENREPLY_EMAIL_FROM || "").trim();
  if (!to) return { sent: false, reason: "ALERT_EMAIL_TO not set" };
  if (!apiKey || !from) return { sent: false, reason: "Resend API key or from-address not set" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from,
        to: to.split(",").map((s) => s.trim()).filter(Boolean),
        subject,
        text: lines.join("\n")
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return { sent: false, reason: `Resend returned HTTP ${res.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: scrubText(err instanceof Error ? err.message : String(err)) };
  }
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
    if (/alert_state/.test(String(err)) && /does not exist/.test(String(err))) {
      rootLogger.warn("alert_state_table_missing", { hint: "apply supabase/migrations/0008_system_events.sql" });
    } else {
      throw err;
    }
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
    const result = await sendEmail(subject, lines);
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
    checked: snapshot.services.length,
    failing: snapshot.services.filter((s) => s.state !== "ok").map((s) => s.key),
    newlyFailing: newlyFailing.map((s) => s.key),
    recovered: recovered.map((s) => s.key),
    emailed,
    emailSkippedReason
  };
}
