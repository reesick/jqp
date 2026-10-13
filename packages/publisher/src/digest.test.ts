import { describe, expect, it } from "vitest";
import { formatDigest } from "./digest.js";
import type { SystemSnapshot } from "./system.js";

function snap(over: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    generatedAt: "2026-10-14T00:00:00.000Z",
    services: [
      { key: "database", label: "Database", state: "ok", detail: "Responding in 4ms" },
      { key: "dm-worker", label: "DM worker", state: "ok", detail: "Heartbeat 3s ago" }
    ],
    dm: { last24h: { sent: 4, failed: 0, skipped: 1, pending: 0 }, lastHourSent: 2, hourlyLimit: 750, failureRate24h: null, byDay: [], topFailures: [] },
    queue: { waiting: 0, active: 0, delayed: 0, failed: 0 },
    failedPosts: 0,
    lastWebhookAt: "2026-10-14T00:00:00.000Z",
    token: { expiring: [], lastRefreshError: null },
    events: [],
    openReplyErrors: [],
    ...over
  };
}

const activity = { postsLive: 1, postsWaiting: 2, campaignsOn: 1, commentsMatched24h: 4 };

describe("formatDigest", () => {
  it("says ALL OK and includes the activity numbers when every check passes", () => {
    const { subject, lines } = formatDigest(snap(), activity, "https://example.com", new Date("2026-10-14T00:00:00Z"));
    expect(subject).toBe("[ALL OK] jqp health: 2/2 checks pass");
    const text = lines.join("\n");
    expect(text).toContain("4 sent, 0 failed, 1 skipped");
    expect(text).toContain("Live posts: 1. Posts waiting to publish: 2. Campaigns switched on: 1");
    expect(text).toContain("https://example.com/system");
  });

  it("leads with ATTENTION and lists what is down", () => {
    const s = snap({ services: [{ key: "dm-worker", label: "DM worker", state: "down", detail: "No recent heartbeat" }] });
    const { subject, lines } = formatDigest(s, activity, "https://example.com");
    expect(subject).toBe("[ATTENTION] jqp health: 0/1 checks pass");
    expect(lines.join("\n")).toContain("Needs a look:");
    expect(lines.join("\n")).toContain("- DM worker: No recent heartbeat");
  });

  it("reports warnings separately from outages", () => {
    const s = snap({ services: [{ key: "q", label: "DM queue", state: "warn", detail: "250 jobs waiting" }] });
    expect(formatDigest(s, activity, "https://example.com").subject).toBe("[WARNINGS] jqp health: 0/1 checks pass");
  });

  it("never prints raw event meta, only the scrubbed message", () => {
    const s = snap({ events: [{ id: 1, created_at: "2026-10-14T00:00:00Z", level: "error", source: "pipeline", code: "x", message: "Publish failed", correlation_id: null, meta: { token: "SECRET" } }] });
    const text = formatDigest(s, activity, "https://example.com").lines.join("\n");
    expect(text).toContain("Publish failed");
    expect(text).not.toContain("SECRET");
  });
});

describe("digest html", () => {
  it("is a full html page with the status headline and escaped text", () => {
    const s = snap({ services: [{ key: "x", label: "A <b>check</b>", state: "down", detail: "bad & broken" }] });
    const { html } = formatDigest(s, activity, "https://example.com");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Needs attention");
    expect(html).toContain("A &lt;b&gt;check&lt;/b&gt;");
    expect(html).toContain("bad &amp; broken");
    expect(html).not.toContain("<b>check</b>");
  });
  it("shows All healthy when every check passes", () => {
    expect(formatDigest(snap(), activity, "https://example.com").html).toContain("All healthy");
  });
});

describe("digest with database date objects", () => {
  it("accepts Date values for timestamps (the database returns Date, not text)", () => {
    const s = snap({
      lastWebhookAt: new Date("2026-10-14T00:10:00Z") as unknown as string,
      events: [{ id: 2, created_at: new Date("2026-10-14T00:05:00Z") as unknown as string, level: "warn", source: "x", code: "c", message: "Heads up", correlation_id: null, meta: {} }]
    });
    const out = formatDigest(s, activity, "https://example.com");
    expect(out.html).toContain("2026-10-14T00:10:00.000Z");
    expect(out.lines.join("\n")).toContain("2026-10-14 00:05 warn x: Heads up");
  });
});
