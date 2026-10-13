import { describe, expect, it } from "vitest";
import { publishingChecks, type PublishingFacts } from "./publishing-checks.js";

const NOW = Date.UTC(2026, 9, 13);
const inDays = (n: number) => new Date(NOW + n * 24 * 3600_000).toISOString();
const facts = (over: Partial<PublishingFacts> = {}): PublishingFacts => ({ stuckPosts: 0, syncFailed: 0, syncStuck: 0, tokens: [{ username: "a", expiresAt: inDays(50) }], ...over });
const find = (rows: ReturnType<typeof publishingChecks>, key: string) => rows.find((r) => r.key === key)!;

describe("publishing token check", () => {
  it("is fine with a month or more left", () => {
    expect(find(publishingChecks(facts(), NOW), "publish-token").state).toBe("ok");
  });
  it("warns at 14 days and goes critical at 3", () => {
    expect(find(publishingChecks(facts({ tokens: [{ username: "a", expiresAt: inDays(10) }] }), NOW), "publish-token").state).toBe("warn");
    expect(find(publishingChecks(facts({ tokens: [{ username: "a", expiresAt: inDays(2) }] }), NOW), "publish-token").state).toBe("down");
  });
  it("says so when the token has already expired", () => {
    const row = find(publishingChecks(facts({ tokens: [{ username: "a", expiresAt: inDays(-1) }] }), NOW), "publish-token");
    expect(row.state).toBe("down");
    expect(row.detail).toContain("expired");
  });
  it("warns, with the fix, when no account is stored or the expiry is unknown", () => {
    const none = find(publishingChecks(facts({ tokens: [] }), NOW), "publish-token");
    expect(none.state).toBe("warn");
    expect(none.detail).toContain("npm run connect-account");
    expect(find(publishingChecks(facts({ tokens: [{ username: "a", expiresAt: null }] }), NOW), "publish-token").state).toBe("warn");
  });
  it("judges by the soonest expiry when several accounts are stored", () => {
    const rows = publishingChecks(facts({ tokens: [{ username: "a", expiresAt: inDays(60) }, { username: "b", expiresAt: inDays(2) }] }), NOW);
    expect(find(rows, "publish-token").state).toBe("down");
  });
});

describe("stuck posts and campaign sync", () => {
  it("is quiet when nothing is wrong", () => {
    const rows = publishingChecks(facts(), NOW);
    expect(find(rows, "stuck-posts").state).toBe("ok");
    expect(find(rows, "campaign-sync").state).toBe("ok");
  });
  it("warns about posts stuck mid-publish", () => {
    expect(find(publishingChecks(facts({ stuckPosts: 2 }), NOW), "stuck-posts").state).toBe("warn");
  });
  it("treats a failed sync as down and a slow one as a warning", () => {
    expect(find(publishingChecks(facts({ syncFailed: 1 }), NOW), "campaign-sync").state).toBe("down");
    const slow = find(publishingChecks(facts({ syncStuck: 1 }), NOW), "campaign-sync");
    expect(slow.state).toBe("warn");
    expect(slow.detail).toContain("publish worker");
  });
});
