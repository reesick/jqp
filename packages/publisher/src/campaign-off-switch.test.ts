import { beforeEach, describe, expect, it, vi } from "vitest";

// upsertCampaign is the one place every caller (dashboard, REST API, Claude Code tools) changes
// `enabled`. These tests pin the rule: turning a campaign OFF switches the OpenReply automation
// off first, and if that fails nothing else changes.

interface SqlCall {
  text: string;
  values: unknown[];
}
const calls: SqlCall[] = [];
let existingAutomationId: string | null = null;
let failAutomationUpdate = false;

function mockSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join("?");
  calls.push({ text, values });
  if (text.includes('update "Automation"')) {
    return failAutomationUpdate ? Promise.reject(new Error("db blip")) : Promise.resolve([]);
  }
  if (text.includes("select * from campaigns where post_id")) {
    return Promise.resolve(existingAutomationId ? [{ id: "c1", post_id: "p1", openreply_automation_id: existingAutomationId }] : []);
  }
  if (text.includes("insert into campaigns")) {
    return Promise.resolve([{ id: "c1", post_id: "p1", enabled: values[values.length - 1] }]);
  }
  return Promise.resolve([]);
}

vi.mock("@jqp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jqp/core")>();
  return { ...actual, getDb: () => mockSql };
});

const { upsertCampaign } = await import("./repository.js");

const base = {
  postId: "p1",
  triggerKeywords: ["PROMPT"],
  matchMode: "WHOLE_WORD" as const,
  dmMessage: "hello",
  publicReplyEnabled: false
};

const indexOf = (needle: string) => calls.findIndex((c) => c.text.includes(needle));

beforeEach(() => {
  calls.length = 0;
  existingAutomationId = null;
  failAutomationUpdate = false;
});

describe("campaign off switch", () => {
  it("switches the OpenReply automation off BEFORE saving the campaign as disabled", async () => {
    existingAutomationId = "auto_1";
    await upsertCampaign({ ...base, enabled: false });

    const off = indexOf('update "Automation"');
    const save = indexOf("insert into campaigns");
    expect(off).toBeGreaterThanOrEqual(0);
    expect(save).toBeGreaterThan(off);
    const offCall = calls[off]!;
    expect(offCall.text).toContain('"isActive" = false');
    expect(offCall.values).toContain("auto_1");
  });

  it("changes nothing and reports the error if OpenReply could not be switched off", async () => {
    existingAutomationId = "auto_1";
    failAutomationUpdate = true;

    await expect(upsertCampaign({ ...base, enabled: false })).rejects.toThrow("db blip");
    expect(indexOf("insert into campaigns")).toBe(-1);
  });

  it("does not touch OpenReply when the campaign was never synced", async () => {
    existingAutomationId = null;
    await upsertCampaign({ ...base, enabled: false });

    expect(indexOf('update "Automation"')).toBe(-1);
    expect(indexOf("insert into campaigns")).toBeGreaterThanOrEqual(0);
  });

  it("does not switch anything off when the campaign stays enabled", async () => {
    existingAutomationId = "auto_1";
    await upsertCampaign({ ...base, enabled: true });

    expect(indexOf('update "Automation"')).toBe(-1);
    expect(indexOf("select * from campaigns where post_id")).toBe(-1);
  });
});
