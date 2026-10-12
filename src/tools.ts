import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { larkApi, getUserName, messageToText, myOpenId, connectionStatus } from "./lark.js";

const CHAR_LIMIT = 40000;

function ok(data: unknown) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > CHAR_LIMIT) {
    text = text.slice(0, CHAR_LIMIT) + "\n...[truncated - use a smaller time window or page_token]";
  }
  return { content: [{ type: "text" as const, text }] };
}

function fail(e: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
  };
}

async function listAllChats(): Promise<{ chat_id: string; name: string; description: string }[]> {
  const chats: { chat_id: string; name: string; description: string }[] = [];
  let pageToken: string | undefined;
  do {
    const d = await larkApi("GET", "/im/v1/chats", { page_size: 100, page_token: pageToken });
    for (const c of d.items || []) {
      chats.push({ chat_id: c.chat_id, name: c.name || "", description: c.description || "" });
    }
    pageToken = d.has_more ? d.page_token : undefined;
  } while (pageToken);
  return chats;
}

async function formatMessages(items: any[]) {
  const me = await myOpenId();
  const out = [];
  for (const m of items) {
    const senderId = m.sender?.id || "";
    const isBot = m.sender?.sender_type === "app";
    out.push({
      message_id: m.message_id,
      time: new Date(Number(m.create_time)).toISOString(),
      sender_name: isBot ? "(bot)" : senderId === me ? "(me)" : await getUserName(senderId),
      sender_id: senderId,
      sender_type: m.sender?.sender_type,
      reply_to_message_id: m.parent_id || null,
      thread_root_id: m.root_id || null,
      type: m.msg_type,
      text: messageToText(m),
    });
  }
  return out;
}

async function fetchMessages(chatId: string, startSec: number, limit: number, pageToken?: string) {
  const d = await larkApi("GET", "/im/v1/messages", {
    container_id_type: "chat",
    container_id: chatId,
    start_time: startSec,
    sort_type: "ByCreateTimeAsc",
    page_size: Math.min(limit, 50),
    page_token: pageToken,
  });
  return { items: d.items || [], has_more: !!d.has_more, page_token: d.page_token || null };
}

export function registerTools(server: McpServer) {
  server.registerTool(
    "lark_connection_status",
    {
      title: "Lark connection status",
      description: "Check whether Lark is connected, which user it acts as, and until when the login stays valid. Call this first if other Lark tools return a 'not connected' error.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        return ok(await connectionStatus());
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "lark_list_chats",
    {
      title: "List Lark groups",
      description:
        "List all Lark group chats the logged-in user is a member of. Returns chat_id, name and description for each group. Use the chat_id with lark_get_messages or lark_send_message.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const chats = await listAllChats();
        return ok({ count: chats.length, chats });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "lark_get_new_messages",
    {
      title: "Get new messages from all Lark groups",
      description: `Check ALL groups the logged-in user is in and return messages posted in the last N minutes, grouped by group. Best tool for a scheduled check ("any new updates on Lark?").

Args:
  - since_minutes (number): look-back window, default 60, max 10080 (7 days)
  - include_bot_messages (boolean): include messages sent by bots, default false
  - include_my_messages (boolean): include messages sent by the logged-in user (incl. replies Shakti sent as the user), default false

Each message has message_id (use with lark_reply_message), time (UTC ISO), sender_name, text, and reply_to_message_id if it is a reply.`,
      inputSchema: {
        since_minutes: z.number().int().min(1).max(10080).default(60).describe("Look-back window in minutes"),
        include_bot_messages: z.boolean().default(false).describe("Include bot messages"),
        include_my_messages: z.boolean().default(false).describe("Include the logged-in user's own messages"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ since_minutes, include_bot_messages, include_my_messages }) => {
      try {
        const me = await myOpenId();
        const startSec = Math.floor(Date.now() / 1000) - since_minutes * 60;
        const chats = await listAllChats();
        const groups = [];
        const errors = [];
        for (const chat of chats) {
          try {
            const all: any[] = [];
            let token: string | undefined;
            do {
              const r = await fetchMessages(chat.chat_id, startSec, 50, token);
              all.push(...r.items);
              token = r.has_more && all.length < 200 ? r.page_token || undefined : undefined;
            } while (token);
            const filtered = all.filter(
              (m) =>
                (include_bot_messages || m.sender?.sender_type !== "app") &&
                (include_my_messages || m.sender?.id !== me)
            );
            if (filtered.length) {
              groups.push({ chat_id: chat.chat_id, group_name: chat.name, messages: await formatMessages(filtered) });
            }
          } catch (e) {
            errors.push({ group_name: chat.name, error: e instanceof Error ? e.message : String(e) });
          }
        }
        return ok({
          window: `last ${since_minutes} minutes`,
          groups_checked: chats.length,
          groups_with_new_messages: groups.length,
          groups,
          ...(errors.length ? { errors } : {}),
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "lark_get_messages",
    {
      title: "Get messages from one Lark group",
      description: `Read messages from one group (oldest first) to see full context of a conversation.

Args:
  - chat_id (string): from lark_list_chats, e.g. "oc_a0553eda9014c201e6969b478895c230"
  - since_minutes (number): look-back window, default 1440 (24 h), max 43200 (30 days)
  - limit (number): 1-50 per page, default 50
  - page_token (string): from a previous call's next_page_token to get more`,
      inputSchema: {
        chat_id: z.string().min(3).describe("Group chat_id (starts with oc_)"),
        since_minutes: z.number().int().min(1).max(43200).default(1440),
        limit: z.number().int().min(1).max(50).default(50),
        page_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat_id, since_minutes, limit, page_token }) => {
      try {
        const startSec = Math.floor(Date.now() / 1000) - since_minutes * 60;
        const r = await fetchMessages(chat_id, startSec, limit, page_token);
        return ok({
          count: r.items.length,
          messages: await formatMessages(r.items),
          has_more: r.has_more,
          next_page_token: r.has_more ? r.page_token : null,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "lark_send_message",
    {
      title: "Send message to a Lark group",
      description:
        "Post a new plain-text message in a Lark group AS THE LOGGED-IN USER (appears under their name). Use lark_reply_message instead when answering a specific message.",
      inputSchema: {
        chat_id: z.string().min(3).describe("Group chat_id (starts with oc_)"),
        text: z.string().min(1).max(20000).describe("Message text"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ chat_id, text }) => {
      try {
        const d = await larkApi("POST", "/im/v1/messages", { receive_id_type: "chat_id" }, {
          receive_id: chat_id,
          msg_type: "text",
          content: JSON.stringify({ text }),
        });
        return ok({ sent: true, message_id: d.message_id });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "lark_reply_message",
    {
      title: "Reply to a Lark message",
      description: "Reply (quoted) to a specific message in a Lark group AS THE LOGGED-IN USER. message_id comes from lark_get_new_messages or lark_get_messages.",
      inputSchema: {
        message_id: z.string().min(3).describe("Message ID to reply to (starts with om_)"),
        text: z.string().min(1).max(20000).describe("Reply text"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ message_id, text }) => {
      try {
        const d = await larkApi("POST", `/im/v1/messages/${message_id}/reply`, {}, {
          msg_type: "text",
          content: JSON.stringify({ text }),
        });
        return ok({ sent: true, message_id: d.message_id });
      } catch (e) {
        return fail(e);
      }
    }
  );
}
