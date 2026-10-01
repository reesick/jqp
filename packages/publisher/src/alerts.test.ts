import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// runMonitor reads alert_state through getDb(); these tests replace it so we can
// simulate the two situations the review flagged: the table not existing yet
// (migration 0008 unapplied) and the database being unreachable.
let dbError: Error | null = null;
const sendMail = vi.fn(async () => ({}));
let smtpHost = "";

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

vi.mock("@jqp/core", () => {
  const sql = Object.assign(
    async () => {
      if (dbError) throw dbError;
      return [];
    },
    { json: (v: unknown) => v }
  );
  return {
    getDb: () => sql,
    loadEnv: () => ({
      APP_BASE_URL: "https://example.test",
      ALERT_EMAIL_TO: "owner@example.test",
      ALERT_RESEND_API_KEY: "test-key",
      ALERT_EMAIL_FROM: "alerts@example.test",
      get ALERT_SMTP_HOST() {
        return smtpHost;
      },
      ALERT_SMTP_PORT: 587,
      ALERT_SMTP_USER: "user",
      ALERT_SMTP_PASS: "pass",
      SYSTEM_EVENT_RETENTION_DAYS: 90
    }),
    rootLogger: { warn: () => undefined, error: () => undefined, info: () => undefined }
  };
});

import { __resetAlertThrottleForTests, runMonitor } from "./alerts.js";
import type { SystemSnapshot } from "./system.js";

function snapshot(state: "ok" | "down"): SystemSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    services: [{ key: "redis", label: "Message queue (Redis)", state, detail: state === "ok" ? "Connected" : "Not connected" }],
    dm: { last24h: { sent: 0, failed: 0, skipped: 0, pending: 0 }, lastHourSent: 0, hourlyLimit: 750, failureRate24h: null, byDay: [], topFailures: [] },
    queue: null,
    failedPosts: 0,
    lastWebhookAt: null,
    token: { expiring: [], lastRefreshError: null },
    events: [],
    openReplyErrors: []
  };
}

describe("runMonitor", () => {
  const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

  beforeEach(() => {
    dbError = null;
    smtpHost = "";
    __resetAlertThrottleForTests();
    sendMail.mockClear();
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not email when the alert_state table does not exist yet", async () => {
    dbError = new Error('relation "alert_state" does not exist');
    const result = await runMonitor(snapshot("down"));
    expect(result.emailed).toBe(false);
    expect(result.stateAvailable).toBe(false);
    expect(result.emailSkippedReason).toMatch(/0008/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("emails about an unreachable database, and only once within the hour", async () => {
    dbError = new Error("connect ECONNREFUSED");
    const first = await runMonitor(snapshot("ok"));
    expect(first.emailed).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await runMonitor(snapshot("ok"));
    expect(second.emailed).toBe(false);
    expect(second.emailSkippedReason).toMatch(/within the last hour/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sends through SMTP, not Resend, when ALERT_SMTP_HOST is set", async () => {
    smtpHost = "smtp-relay.example.test";
    dbError = new Error("connect ECONNREFUSED");
    const result = await runMonitor(snapshot("ok"));
    expect(result.emailed).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const sent = sendMail.mock.calls[0]?.[0] as unknown as { to: string[]; subject: string };
    expect(sent.to).toEqual(["owner@example.test"]);
    expect(sent.subject).toMatch(/database unreachable/);
  });
});
