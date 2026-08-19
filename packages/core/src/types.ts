/**
 * Row types mirroring supabase/migrations/0001_init.sql exactly. If
 * you change a column there, change it here in the same commit — this
 * file is the only source of type safety between the app and the
 * database schema (no ORM/codegen in V1).
 */

export type PostStatus =
  | "DISCOVERED"
  | "VALIDATING"
  | "VALIDATION_FAILED"
  | "UPLOADING"
  | "CREATING_CHILDREN"
  | "WAITING_FOR_CHILDREN"
  | "CREATING_CAROUSEL"
  | "WAITING_FOR_CAROUSEL"
  | "PUBLISHING"
  | "PUBLISHED"
  | "FAILED";

export type ContainerStatus = "PENDING" | "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export type CampaignSyncStatus = "DM_SYNC_PENDING" | "DM_SYNCING" | "DM_SYNCED" | "DM_SYNC_FAILED";

export type DmStatus = "PENDING" | "QUEUED" | "SENT" | "FAILED";

export type MatchMode = "WHOLE_WORD" | "PARTIAL" | "EXACT";

export type CommentEventStatus =
  | "PENDING"
  | "MATCHED"
  | "NO_MATCH"
  | "CAMPAIGN_DISABLED"
  | "CAMPAIGN_MISSING"
  | "SELF_COMMENT"
  | "ALREADY_PROCESSED"
  | "QUEUED"
  | "DM_SENT"
  | "DM_FAILED";

export type WebhookEventStatus = "RECEIVED" | "VALIDATED" | "ENQUEUED" | "PROCESSED" | "ERROR" | "INVALID_SIGNATURE";

export interface IgAccountRow {
  id: string;
  ig_user_id: string;
  username: string | null;
  page_id: string | null;
  access_token_encrypted: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  token_expires_at: string | null;
  connected_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface PostRow {
  id: string;
  campaign_id: string;
  folder_name: string;
  folder_path: string;
  ig_account_id: string | null;
  caption: string;
  media_type: "IMAGE" | "CAROUSEL";
  status: PostStatus;
  instagram_media_id: string | null;
  carousel_container_id: string | null;
  published_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface PostMediaRow {
  id: string;
  post_id: string;
  sequence: number;
  original_filename: string;
  storage_path: string;
  public_url: string | null;
  media_type: string;
  child_container_id: string | null;
  container_status: ContainerStatus;
  created_at: string;
}

export interface CampaignRow {
  id: string;
  post_id: string;
  instagram_media_id: string | null;
  trigger_keywords: string[];
  match_mode: MatchMode;
  dm_message: string;
  destination_url: string | null;
  public_reply_enabled: boolean;
  public_reply_message: string | null;
  enabled: boolean;
  sync_status: CampaignSyncStatus;
  sync_error: string | null;
  openreply_automation_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_type: string | null;
  external_event_id: string | null;
  payload: unknown;
  status: WebhookEventStatus;
  error_message: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface CommentEventRow {
  id: string;
  webhook_event_id: string | null;
  comment_id: string;
  media_id: string;
  commenter_ig_id: string | null;
  commenter_username: string | null;
  comment_text: string | null;
  campaign_id: string | null;
  matched: boolean;
  match_keyword: string | null;
  status: CommentEventStatus;
  created_at: string;
  processed_at: string | null;
}

export interface DmLogRow {
  id: string;
  comment_event_id: string | null;
  campaign_id: string | null;
  recipient_ig_id: string | null;
  message_sent: string | null;
  status: DmStatus;
  meta_message_id: string | null;
  error_message: string | null;
  attempt_count: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}
