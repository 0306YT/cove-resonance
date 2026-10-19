import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { neteaseAccountProfileSchema } from "./accountTools.js";
import type { NeteaseClient } from "./client.js";
import type { JsonRecord } from "./types.js";

const rawRecordSchema = z.record(z.string(), z.unknown());
const userIdSchema = z.string().trim().regex(/^\d+$/);
const threadIdSchema = z.string().trim().min(1).max(200);
const commentIdSchema = z.string().trim().min(1).max(100);

function readResult(data: JsonRecord) {
  const result = { data };
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

function mutationResult(data: JsonRecord) {
  const result = { ok: true, data };
  return {
    structuredContent: result,
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

export function registerNeteaseSocialTools(server: McpServer, client: NeteaseClient): void {
  server.registerTool(
    "netease_private_inbox",
    {
      title: "NetEase private-message inbox",
      description: "Read Cove's NetEase private-message conversation list. Use this to discover correspondents before opening a conversation.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(30),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ limit, offset }) => readResult(await client.getPrivateInbox(limit, offset)),
  );

  server.registerTool(
    "netease_private_history",
    {
      title: "NetEase private-message history",
      description: "Read private-message history with a specific NetEase user id. Use the returned message times as before for older pages.",
      inputSchema: {
        userId: userIdSchema,
        limit: z.number().int().min(1).max(100).default(30),
        before: z.number().int().min(0).default(0),
      },
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ userId, limit, before }) =>
      readResult(await client.getPrivateHistory(userId, limit, before)),
  );

  server.registerTool(
    "netease_recent_contacts",
    {
      title: "NetEase recent contacts",
      description: "Read Cove's recent NetEase contacts.",
      inputSchema: {},
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => readResult(await client.getRecentContacts()),
  );

  server.registerTool(
    "netease_notification_counts",
    {
      title: "NetEase message and notification counts",
      description: "Read Cove's current NetEase private-message and notification counters.",
      inputSchema: {},
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => readResult(await client.getNotificationCounts()),
  );

  server.registerTool(
    "netease_resolve_users",
    {
      title: "Resolve NetEase nicknames to user ids",
      description: "Resolve one or more exact NetEase nicknames to user ids before messaging, following, or reading dynamics. Do not guess user ids.",
      inputSchema: {
        nicknames: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
      },
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ nicknames }) => readResult(await client.resolveUserIds(nicknames)),
  );

  server.registerTool(
    "netease_send_private_message",
    {
      title: "Send NetEase private message",
      description: "Send an ordinary text private message from Cove's NetEase account to one or more explicit user ids. This is a real user-visible side effect.",
      inputSchema: {
        userIds: z.array(userIdSchema).min(1).max(20),
        text: z.string().trim().min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ userIds, text }) => mutationResult(await client.sendPrivateText(userIds, text)),
  );

  server.registerTool(
    "netease_user_events",
    {
      title: "NetEase user dynamics",
      description: "Read a NetEase user's dynamics/posts. Use Cove's own account id to read Cove's dynamics, or an explicitly resolved user id for another account.",
      inputSchema: {
        userId: userIdSchema,
        limit: z.number().int().min(1).max(100).default(30),
        lasttime: z.number().int().min(-1).default(-1),
      },
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ userId, limit, lasttime }) =>
      readResult(await client.getUserEvents(userId, limit, lasttime)),
  );

  server.registerTool(
    "netease_event_comments",
    {
      title: "NetEase dynamic comments",
      description: "Read comments for a NetEase dynamic using its exact threadId returned by the dynamic APIs.",
      inputSchema: {
        threadId: threadIdSchema,
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        before: z.number().int().min(0).default(0),
      },
      outputSchema: { data: rawRecordSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async ({ threadId, limit, offset, before }) =>
      readResult(await client.getEventComments(threadId, limit, offset, before)),
  );

  server.registerTool(
    "netease_comment_event",
    {
      title: "Comment on NetEase dynamic",
      description: "Post a real public comment on a NetEase dynamic using an exact threadId.",
      inputSchema: {
        threadId: threadIdSchema,
        content: z.string().trim().min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ threadId, content }) =>
      mutationResult(await client.addEventComment(threadId, content)),
  );

  server.registerTool(
    "netease_reply_event_comment",
    {
      title: "Reply to NetEase dynamic comment",
      description: "Reply publicly to a specific comment under a NetEase dynamic.",
      inputSchema: {
        threadId: threadIdSchema,
        commentId: commentIdSchema,
        content: z.string().trim().min(1).max(500),
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ threadId, commentId, content }) =>
      mutationResult(await client.replyEventComment(threadId, commentId, content)),
  );

  server.registerTool(
    "netease_delete_event_comment",
    {
      title: "Delete Cove's NetEase dynamic comment",
      description: "Delete a comment by exact comment id and dynamic threadId. This is destructive and cannot be undone through this tool.",
      inputSchema: {
        threadId: threadIdSchema,
        commentId: commentIdSchema,
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ threadId, commentId }) =>
      mutationResult(await client.deleteEventComment(threadId, commentId)),
  );

  server.registerTool(
    "netease_set_event_like",
    {
      title: "Set NetEase dynamic like state",
      description: "Like or unlike a NetEase dynamic using its exact threadId.",
      inputSchema: {
        threadId: threadIdSchema,
        liked: z.boolean().default(true),
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ threadId, liked }) =>
      mutationResult(await client.setEventLike(threadId, liked)),
  );

  server.registerTool(
    "netease_set_follow_user",
    {
      title: "Set NetEase user follow state",
      description: "Follow or unfollow an explicit NetEase user id from Cove's account. Some accounts may trigger NetEase verification.",
      inputSchema: {
        userId: userIdSchema,
        following: z.boolean().default(true),
      },
      outputSchema: { ok: z.boolean(), data: rawRecordSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async ({ userId, following }) =>
      mutationResult(await client.setFollowUser(userId, following)),
  );

  server.registerTool(
    "netease_update_profile",
    {
      title: "Update Cove's NetEase profile",
      description: "Update Cove's NetEase nickname, signature, gender, birthday, province, or city while preserving omitted values from the current profile. Avatar/skin decoration is not handled by this tool.",
      inputSchema: {
        nickname: z.string().trim().min(1).max(40).optional(),
        signature: z.string().max(300).optional(),
        gender: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
        birthdayMs: z.number().int().min(0).optional(),
        province: z.number().int().min(0).optional(),
        city: z.number().int().min(0).optional(),
      },
      outputSchema: { profile: neteaseAccountProfileSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async (input) => {
      if (
        input.nickname === undefined
        && input.signature === undefined
        && input.gender === undefined
        && input.birthdayMs === undefined
        && input.province === undefined
        && input.city === undefined
      ) {
        throw new Error("At least one profile field is required");
      }
      const profile = await client.updateAccountProfile(input);
      const result = { profile };
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );
}
