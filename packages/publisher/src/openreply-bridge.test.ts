import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, PostRow } from "@jqp/core";

interface SqlCall {
  text: string;
  values: unknown[];
}

const sqlCalls: SqlCall[] = [];

// Captures every tagged-template SQL call so we can assert on the exact
// values sent for "Automation" — this is what caught (and now
// locks in the fix for) the empty-keywords/matchAnyWord bug.
function mockSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join("?");
  sqlCalls.push({ text, values });
  if (text.includes('"InstagramAccount"')) {
    return Promise.resolve([{ id: "openreply_account_1", workspaceId: "workspace_1" }]);
  }
  return Promise.resolve([]);
}

vi.mock("@jqp/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@jqp/core")>();
  return { ...actual, getDb: () => mockSql };
});

const repo = {
  getCampaign: vi.fn(),
  getPost: vi.fn(),
  resolveIgUserIdForPost: vi.fn(),
  updateCampaignSync: vi.fn()
};
vi.mock("./repository.js", () => repo);

const { syncCampaignToOpenReply } = await import("./openreply-bridge.js");

function basePost(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "post_1",
    campaign_id: "POST_042",
    folder_name: "POST_042",
    folder_path: "/fake",
    ig_account_id: null,
    caption: "hi",
    media_type: "CAROUSEL",
    status: "PUBLISHED",
    instagram_media_id: "media_123",
    carousel_container_id: "container_1",
    published_at: new Date().toISOString(),
    error_message: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

function baseCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign_1",
    post_id: "post_1",
    instagram_media_id: null,
    trigger_keywords: ["INFO"],
    match_mode: "WHOLE_WORD",
    dm_message: "Here's your link!",
    destination_url: null,
    public_reply_enabled: false,
    public_reply_message: null,
    enabled: true,
    sync_status: "DM_SYNC_PENDING",
    sync_error: null,
    openreply_automation_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides
  };
}

beforeEach(() => {
  sqlCalls.length = 0;
  vi.clearAllMocks();
  repo.resolveIgUserIdForPost.mockResolvedValue("ig_user_1");
});

describe("syncCampaignToOpenReply — matchAnyWord correctness", () => {
  it("sets matchAnyWord:true when keywords are empty (not a dead campaign)", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ trigger_keywords: [] }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    expect(insertCall).toBeDefined();
    // Positional values in the INSERT: id, workspaceId, instagramAccountId, name, postId, keywords, matchAnyWord, ...
    const matchAnyWordValue = insertCall!.values[6];
    expect(matchAnyWordValue).toBe(true);
  });

  it("sets matchAnyWord:false when keywords are present", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ trigger_keywords: ["INFO", "LINK"] }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    const matchAnyWordValue = insertCall!.values[6];
    expect(matchAnyWordValue).toBe(false);
  });

  it("uses the human-readable campaign_id (folder name) as the Automation name, not the internal post UUID", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign());
    repo.getPost.mockResolvedValue(basePost({ campaign_id: "POST_042" }));

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    const nameValue = insertCall!.values[3] as string;
    expect(nameValue).toContain("POST_042");
    expect(nameValue).not.toContain("post_1"); // the internal FK uuid must not leak into the display name
  });

  it("also fixes matchAnyWord on the UPDATE path (re-sync of an existing automation)", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ trigger_keywords: [], openreply_automation_id: "existing_automation_1" }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const updateCall = sqlCalls.find((c) => c.text.includes("update"));
    expect(updateCall).toBeDefined();
    // update "Automation" set "postId" = ?, "keywords" = ?, "matchAnyWord" = ?, ...
    const matchAnyWordValue = updateCall!.values[2];
    expect(matchAnyWordValue).toBe(true);
  });
});

describe("syncCampaignToOpenReply — guards", () => {
  it("does nothing when the post isn't PUBLISHED yet", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign());
    repo.getPost.mockResolvedValue(basePost({ status: "PUBLISHING", instagram_media_id: null }));

    await syncCampaignToOpenReply("campaign_1");

    expect(sqlCalls.some((c) => c.text.includes("insert into") || c.text.includes("update"))).toBe(false);
  });

  it("does nothing when the campaign isn't enabled", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ enabled: false }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    expect(sqlCalls.some((c) => c.text.includes("insert into") || c.text.includes("update"))).toBe(false);
  });
});
