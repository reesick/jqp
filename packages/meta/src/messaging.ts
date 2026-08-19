import { graphRequest } from "./client.js";

export interface SendPrivateReplyParams {
  igUserId: string;
  commentId: string;
  message: string;
  accessToken: string;
}

export interface SendPrivateReplyResult {
  recipient_id?: string;
  message_id?: string;
}

/**
 * Sends a private reply to the commenter, triggered by their comment
 * (the official "private replies to comments" capability — not a
 * cold DM). recipient/message are complex objects; Graph API accepts
 * them as JSON-stringified single param values on a form/query POST,
 * which is what graphRequest sends them as here.
 *
 * Verify the current endpoint shape against Meta's docs before
 * production — private reply eligibility windows and exact payload
 * fields have changed across API versions (plan section 91).
 */
export async function sendPrivateReply(params: SendPrivateReplyParams): Promise<SendPrivateReplyResult> {
  const { igUserId, commentId, message, accessToken } = params;
  return graphRequest(`/${igUserId}/messages`, {
    method: "POST",
    accessToken,
    params: {
      recipient: JSON.stringify({ comment_id: commentId }),
      message: JSON.stringify({ text: message })
    }
  });
}

export interface ReplyToCommentParams {
  commentId: string;
  message: string;
  accessToken: string;
}

/** Optional public reply left on the comment itself (plan section 30's "optional public reply"). */
export async function replyToComment(params: ReplyToCommentParams): Promise<{ id: string }> {
  const { commentId, message, accessToken } = params;
  return graphRequest(`/${commentId}/replies`, {
    method: "POST",
    accessToken,
    params: { message }
  });
}
