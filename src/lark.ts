// Lark Open Platform client - acts AS THE USER (user_access_token with auto refresh)
import { loadToken, saveToken, UserToken } from "./store.js";

export const DOMAIN = (process.env.LARK_DOMAIN || "https://open.larksuite.com").replace(/\/$/, "");
export const ACCOUNTS_DOMAIN = (
  process.env.LARK_ACCOUNTS_DOMAIN || DOMAIN.replace("://open.", "://accounts.")
).replace(/\/$/, "");
const APP_ID = process.env.LARK_APP_ID || "";
const APP_SECRET = process.env.LARK_APP_SECRET || "";
export const SCOPES =
  process.env.LARK_SCOPES ||
  "offline_access im:chat:readonly im:message im:message:readonly contact:user.base:readonly";

export class LarkError extends Error {}

const NOT_CONNECTED =
  "Lark is not connected yet (or the login expired). Open <PUBLIC_URL>/lark/login/<MCP_SECRET> in a browser, sign in to Lark and click Allow, then retry.";

async function safeFetch(url: string | URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw new LarkError(
      `Could not reach Lark at ${DOMAIN} (${e instanceof Error ? e.message : e}). Check LARK_DOMAIN (Lark International = https://open.larksuite.com) and retry.`
    );
  }
}

// ---------- OAuth ----------

export function authorizeUrl(redirectUri: string, state: string): string {
  const u = new URL(`${ACCOUNTS_DOMAIN}/open-apis/authen/v1/authorize`);
  u.searchParams.set("client_id", APP_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", SCOPES);
  u.searchParams.set("state", state);
  return u.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const res = await safeFetch(`${DOMAIN}/open-apis/authen/v2/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ client_id: APP_ID, client_secret: APP_SECRET, ...body }),
  });
  const data: any = await res.json().catch(() => ({}));
  const d = data.access_token ? data : data.data || {};
  if (!d.access_token) {
    throw new LarkError(
      `Lark token request failed (code ${data.code ?? res.status}: ${data.error_description || data.msg || data.error || "unknown"}).`
    );
  }
  return d;
}

function toStored(d: any, prev?: UserToken): UserToken {
  const now = Date.now();
  return {
    access_token: d.access_token,
    access_expires_at: now + (Number(d.expires_in) || 7200) * 1000,
    refresh_token: d.refresh_token || prev?.refresh_token || "",
    refresh_expires_at: d.refresh_token
      ? now + (Number(d.refresh_token_expires_in) || 7 * 86400) * 1000
      : prev?.refresh_expires_at || 0,
    open_id: prev?.open_id || "",
    name: prev?.name || "",
    scope: d.scope || prev?.scope || "",
  };
}

export async function completeLogin(code: string, redirectUri: string): Promise<UserToken> {
  const d = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  const t = toStored(d);
  if (!t.refresh_token) {
    throw new LarkError("Lark did not return a refresh token. Add the offline_access permission to the app, publish a new version, and log in again.");
  }
  // who am I
  const res = await safeFetch(`${DOMAIN}/open-apis/authen/v1/user_info`, {
    method: "GET",
    headers: { Authorization: `Bearer ${t.access_token}` },
  });
  const info: any = await res.json().catch(() => ({}));
  t.open_id = info?.data?.open_id || "";
  t.name = info?.data?.name || info?.data?.en_name || "";
  await saveToken(t);
  cached = t;
  return t;
}

// ---------- token management ----------

let cached: UserToken | null = null;
let refreshing: Promise<UserToken> | null = null;

async function refresh(t: UserToken): Promise<UserToken> {
  if (!refreshing) {
    refreshing = (async () => {
      try {
        if (!t.refresh_token || Date.now() > t.refresh_expires_at) throw new LarkError(NOT_CONNECTED);
        const d = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token });
        const nt = toStored(d, t);
        await saveToken(nt); // refresh tokens are single-use: save the new one immediately
        cached = nt;
        return nt;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export async function getUserToken(): Promise<UserToken> {
  if (!cached) cached = await loadToken();
  if (!cached) throw new LarkError(NOT_CONNECTED);
  if (Date.now() > cached.access_expires_at - 5 * 60 * 1000) {
    try {
      return await refresh(cached);
    } catch (e) {
      // another instance may have refreshed already: reload once
      const fresh = await loadToken();
      if (fresh && fresh.access_expires_at > Date.now() + 60 * 1000) {
        cached = fresh;
        return fresh;
      }
      throw e;
    }
  }
  return cached;
}

// Keep the login alive: refresh well before the refresh token expires.
export function startKeepAlive() {
  setInterval(async () => {
    try {
      const t = cached || (await loadToken());
      if (!t) return;
      cached = t;
      const soon = Date.now() + 24 * 3600 * 1000;
      if (t.access_expires_at < Date.now() + 10 * 60 * 1000 || t.refresh_expires_at < soon) {
        await refresh(t);
        console.error("Lark token refreshed");
      }
    } catch (e) {
      console.error("Lark keep-alive refresh failed:", e instanceof Error ? e.message : e);
    }
  }, 30 * 60 * 1000);
}

export async function connectionStatus() {
  const t = cached || (await loadToken());
  if (!t) return { connected: false };
  return {
    connected: Date.now() < t.refresh_expires_at,
    user: t.name,
    login_valid_until: new Date(t.refresh_expires_at).toISOString(),
    scopes: t.scope,
  };
}

export async function myOpenId(): Promise<string> {
  return (await getUserToken()).open_id;
}

// ---------- API ----------

export async function larkApi(
  method: "GET" | "POST",
  path: string,
  query: Record<string, string | number | undefined> = {},
  body?: unknown
): Promise<any> {
  const token = (await getUserToken()).access_token;
  const url = new URL(`${DOMAIN}/open-apis${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await safeFetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => null);
  if (!data) throw new LarkError(`Lark returned HTTP ${res.status} with no JSON body.`);
  if (data.code !== 0) {
    let hint = "Check that the app has this permission enabled for USER identity, publish a new app version, then log in again via /lark/login.";
    if (res.status === 429 || data.code === 99991400) hint = "Rate limited - wait a minute and retry.";
    if (data.code === 99991677 || data.code === 99991668) hint = NOT_CONNECTED;
    throw new LarkError(`Lark API error (code ${data.code}: ${data.msg}). ${hint}`);
  }
  return data.data;
}

// ---------- helpers ----------

const nameCache = new Map<string, string>();

export async function getUserName(openId: string): Promise<string> {
  if (!openId) return "";
  if (nameCache.has(openId)) return nameCache.get(openId)!;
  try {
    const d = await larkApi("GET", `/contact/v3/users/${openId}`, { user_id_type: "open_id" });
    const name = d?.user?.name || d?.user?.en_name || "";
    nameCache.set(openId, name);
    return name;
  } catch {
    nameCache.set(openId, ""); // external user or no contact permission
    return "";
  }
}

function flattenPost(obj: any): string {
  let post = obj;
  if (!Array.isArray(post?.content)) {
    const first = Object.values(obj || {})[0] as any; // locale-wrapped
    if (first && Array.isArray(first.content)) post = first;
  }
  const lines: string[] = [];
  if (post?.title) lines.push(post.title);
  for (const para of post?.content || []) {
    lines.push(
      (para || [])
        .map((el: any) => {
          if (el.tag === "text") return el.text || "";
          if (el.tag === "a") return `${el.text || ""} (${el.href || ""})`;
          if (el.tag === "at") return `@${el.user_name || el.user_id || ""}`;
          if (el.tag === "img") return "[image]";
          if (el.tag === "media") return "[video]";
          return el.text || "";
        })
        .join("")
    );
  }
  return lines.join("\n").trim();
}

export function messageToText(msg: any): string {
  if (msg.deleted) return "[deleted message]";
  let obj: any = {};
  try {
    obj = JSON.parse(msg.body?.content || "{}");
  } catch {
    return msg.body?.content || "";
  }
  let text: string;
  switch (msg.msg_type) {
    case "text": text = obj.text || ""; break;
    case "post": text = flattenPost(obj); break;
    case "image": text = "[image]"; break;
    case "file": text = `[file: ${obj.file_name || "attachment"}]`; break;
    case "audio": text = "[voice message]"; break;
    case "media": text = `[video: ${obj.file_name || ""}]`; break;
    case "interactive": text = "[card message]"; break;
    default: text = `[${msg.msg_type}]`;
  }
  for (const m of msg.mentions || []) {
    if (m.key) text = text.split(m.key).join(`@${m.name || ""}`);
  }
  return text;
}
