# Lark MCP Server (Shakti connector) - acts as YOU

Shakti reads your Lark groups and replies under your name. No bot needs to be added to groups.
No password is stored: you log in once via Lark's official "Allow" page; the login renews itself automatically.

## Tools
- lark_connection_status: is Lark connected, as whom, valid until when
- lark_list_chats: groups you are in
- lark_get_new_messages: new messages from ALL your groups in last N minutes (your own messages excluded by default)
- lark_get_messages: history of one group
- lark_send_message: post in a group (as you)
- lark_reply_message: reply to a specific message (as you)

## Environment variables
LARK_APP_ID, LARK_APP_SECRET, LARK_DOMAIN, MCP_SECRET, DATABASE_URL (Supabase/Postgres - stores the login token)

## Render
Build: npm install && npm run build
Start: npm start

## URLs (replace <SECRET> with MCP_SECRET)
- One-time login:   https://<app>.onrender.com/lark/login/<SECRET>
- Status:           https://<app>.onrender.com/lark/status/<SECRET>
- Lark redirect URL (add in Lark app Security Settings): https://<app>.onrender.com/lark/callback
- Claude connector: https://<app>.onrender.com/mcp/<SECRET>

Keep <SECRET> private: anyone with these URLs can read/send Lark messages as you.
