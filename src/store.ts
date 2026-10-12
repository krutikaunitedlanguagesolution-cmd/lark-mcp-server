// Persistent token storage in Postgres (Supabase). Render's disk is wiped on every deploy/restart.
import pg from "pg";

export interface UserToken {
  access_token: string;
  access_expires_at: number; // ms epoch
  refresh_token: string;
  refresh_expires_at: number; // ms epoch
  open_id: string;
  name: string;
  scope: string;
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ready) {
    ready = pool
      .query(
        `CREATE TABLE IF NOT EXISTS lark_mcp_tokens (
           id TEXT PRIMARY KEY,
           data JSONB NOT NULL,
           updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`
      )
      .then(() => undefined);
  }
  return ready;
}

export async function loadToken(): Promise<UserToken | null> {
  await init();
  const r = await pool.query("SELECT data FROM lark_mcp_tokens WHERE id = 'user'");
  return r.rows[0]?.data ?? null;
}

export async function saveToken(t: UserToken): Promise<void> {
  await init();
  await pool.query(
    `INSERT INTO lark_mcp_tokens (id, data, updated_at) VALUES ('user', $1, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [t]
  );
}
