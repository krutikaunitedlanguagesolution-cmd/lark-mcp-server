import express from "express";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.js";
import { authorizeUrl, completeLogin, connectionStatus, startKeepAlive } from "./lark.js";

for (const v of ["LARK_APP_ID", "LARK_APP_SECRET", "MCP_SECRET", "DATABASE_URL"]) {
  if (!process.env[v]) {
    console.error(`ERROR: environment variable ${v} is missing`);
    process.exit(1);
  }
}
const SECRET = process.env.MCP_SECRET!;
if (SECRET.length < 24) {
  console.error("ERROR: MCP_SECRET must be at least 24 characters");
  process.exit(1);
}
// Render sets RENDER_EXTERNAL_URL automatically
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3000").replace(/\/$/, "");
const REDIRECT_URI = `${PUBLIC_URL}/lark/callback`;

function secretOk(given: string): boolean {
  const a = Buffer.from(given || "");
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:60px auto;padding:0 20px;line-height:1.6}
.ok{color:#0a7d32}.err{color:#b42318}code{background:#f2f2f2;padding:2px 6px;border-radius:4px}</style></head>
<body><h2>${title}</h2>${body}</body></html>`;
}

const pendingStates = new Map<string, number>(); // state -> expiry

function createServer() {
  const server = new McpServer({ name: "lark-mcp-server", version: "2.0.0" });
  registerTools(server);
  return server;
}

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.send("Lark MCP server is running");
});

// ---- One-time Lark login (acts as you afterwards) ----
app.get("/lark/login/:secret", (req, res) => {
  if (!secretOk(req.params.secret)) return void res.status(404).send("Not found");
  const state = randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now() + 10 * 60 * 1000);
  res.redirect(authorizeUrl(REDIRECT_URI, state));
});

app.get("/lark/callback", async (req, res) => {
  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const exp = pendingStates.get(state);
  pendingStates.delete(state);
  if (!code || !exp || Date.now() > exp) {
    return void res
      .status(400)
      .send(page("Login failed", `<p class="err">The login link expired or was cancelled. Open the login link again.</p>`));
  }
  try {
    const t = await completeLogin(code, REDIRECT_URI);
    res.send(
      page(
        "Lark connected",
        `<p class="ok">Connected as <b>${t.name || "your Lark account"}</b>.</p>
         <p>Shakti can now read your Lark groups and reply under your name. You can close this page.</p>`
      )
    );
  } catch (e) {
    res
      .status(500)
      .send(page("Login failed", `<p class="err">${e instanceof Error ? e.message : String(e)}</p>`));
  }
});

app.get("/lark/status/:secret", async (req, res) => {
  if (!secretOk(req.params.secret)) return void res.status(404).send("Not found");
  try {
    res.json(await connectionStatus());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- MCP endpoint ----
app.post("/mcp/:secret", async (req, res) => {
  if (!secretOk(req.params.secret)) return void res.status(404).send("Not found");
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP request error:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.all("/mcp/:secret", (_req, res) => {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

startKeepAlive();
const port = parseInt(process.env.PORT || "3000", 10);
app.listen(port, () => console.error(`Lark MCP server listening on port ${port} (redirect URI: ${REDIRECT_URI})`));
