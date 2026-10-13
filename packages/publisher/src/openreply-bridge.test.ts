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
  deactivateOpenReplyAutomation: vi.fn(),
  getCampaign: vi.fn(),
  getPost: vi.fn(),
  resolveIgUserIdForPost: vi.fn(),
  updateCampaignSync: vi.fn()
};
vi.mock("./repository.js", async () => {
  // The id helper is pure; use the real one so the bridge and the tests agree on the derived ids.
  const actual = await vi.importActual<typeof import("./repository.js")>("./repository.js");
  return { ...repo, automationIdForCampaign: actual.automationIdForCampaign };
});

const { syncCampaignToOpenReply, automationIdForCampaign } = await import("./openreply-bridge.js");

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
    opening_dm_enabled: false,
    opening_dm_message: null,
    opening_dm_button_label: null,
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

describe("syncCampaignToOpenReply — opening DM (two-step button reveal)", () => {
  const openingDm = {
    opening_dm_enabled: true,
    opening_dm_message: "Tap below for the link",
    opening_dm_button_label: "Send the link"
  };

  it("pushes all three opening-DM columns when fully configured", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign(openingDm));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    expect(insertCall!.text).toContain("openingDmEnabled");
    expect(insertCall!.values).toContain(true);
    expect(insertCall!.values).toContain("Tap below for the link");
    expect(insertCall!.values).toContain("Send the link");
  });

  it("falls back to the single-DM flow when enabled but the button label is missing", async () => {
    // OpenReply's dm-worker gates on all three being truthy, so a half-configured
    // campaign must write enabled:false rather than half-engage the button flow.
    repo.getCampaign.mockResolvedValue(baseCampaign({ ...openingDm, opening_dm_button_label: null }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    expect(insertCall!.values).not.toContain("Tap below for the link");
  });

  it("truncates to Meta's button-template caps rather than letting the API silently cut them", async () => {
    repo.getCampaign.mockResolvedValue(
      baseCampaign({
        opening_dm_enabled: true,
        opening_dm_message: "x".repeat(700),
        opening_dm_button_label: "y".repeat(40)
      })
    );
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    expect(insertCall!.values).toContain("x".repeat(640));
    expect(insertCall!.values).toContain("y".repeat(20));
  });

  it("also writes the opening-DM columns on the UPDATE path (re-sync)", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ ...openingDm, openreply_automation_id: "existing_automation_1" }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const updateCall = sqlCalls.find((c) => c.text.includes("update"));
    expect(updateCall!.text).toContain("openingDmButtonLabel");
    expect(updateCall!.values).toContain("Send the link");
  });

  it("clears the opening-DM columns when the toggle is turned back off", async () => {
    repo.getCampaign.mockResolvedValue(
      baseCampaign({ opening_dm_enabled: false, opening_dm_message: "stale", opening_dm_button_label: "stale" })
    );
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insertCall = sqlCalls.find((c) => c.text.includes("insert into"));
    expect(insertCall!.values).not.toContain("stale");
  });
});

describe("syncCampaignToOpenReply — creating an automation is safe to repeat", () => {
  it("derives the same automation id for the same campaign every time, and a different one per campaign", () => {
    expect(automationIdForCampaign("campaign_1")).toBe(automationIdForCampaign("campaign_1"));
    expect(automationIdForCampaign("campaign_1")).not.toBe(automationIdForCampaign("campaign_2"));
    expect(automationIdForCampaign("campaign_1")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("inserts with the derived id and an on-conflict update, so a repeat cannot create a second row", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign());
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    const insert = sqlCalls.find((c) => c.text.includes("insert into"))!;
    expect(insert.values).toContain(automationIdForCampaign("campaign_1"));
    expect(insert.text).toContain('on conflict ("id") do update');
    expect(repo.updateCampaignSync).toHaveBeenCalledWith("campaign_1", expect.objectContaining({ openreplyAutomationId: automationIdForCampaign("campaign_1") }));
  });
});

describe("syncCampaignToOpenReply — off switch", () => {
  it("switches an existing automation off when the campaign is disabled", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ enabled: false, openreply_automation_id: "auto_9" }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    expect(repo.deactivateOpenReplyAutomation).toHaveBeenCalledWith("auto_9");
    expect(repo.updateCampaignSync).toHaveBeenCalledWith("campaign_1", { syncStatus: "DM_SYNCED", syncError: null });
    // and never re-activates it or rewrites its copy
    expect(sqlCalls.some((c) => c.text.includes("insert into") || c.text.includes("update"))).toBe(false);
  });

  it("switches it off even if the post lookup would not have allowed a sync", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ enabled: false, openreply_automation_id: "auto_9" }));
    repo.getPost.mockResolvedValue(basePost({ status: "FAILED", instagram_media_id: null }));

    await syncCampaignToOpenReply("campaign_1");

    expect(repo.deactivateOpenReplyAutomation).toHaveBeenCalledWith("auto_9");
  });

  it("leaves OpenReply alone when a disabled campaign never had an automation", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ enabled: false, openreply_automation_id: null }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    expect(repo.deactivateOpenReplyAutomation).not.toHaveBeenCalled();
  });

  it("keeps an enabled campaign's automation active", async () => {
    repo.getCampaign.mockResolvedValue(baseCampaign({ enabled: true, openreply_automation_id: "auto_9" }));
    repo.getPost.mockResolvedValue(basePost());

    await syncCampaignToOpenReply("campaign_1");

    expect(repo.deactivateOpenReplyAutomation).not.toHaveBeenCalled();
    const update = sqlCalls.find((c) => c.text.includes('"isActive"'));
    expect(update!.values).toContain(true);
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
