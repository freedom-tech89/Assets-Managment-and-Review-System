// Database access. Uses PostgreSQL when DATABASE_URL (or POSTGRES_URL) is set, e.g. Neon on
// Vercel. Without one, it falls back to an embedded PostgreSQL (PGlite) stored in ./data, so the
// app runs locally with no setup.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
  id             SERIAL PRIMARY KEY,
  upload_type    TEXT NOT NULL,              -- 'individual' or 'platform'
  client_name    TEXT NOT NULL DEFAULT '',   -- individual uploads only
  client_key     TEXT NOT NULL DEFAULT '',
  platform       TEXT NOT NULL,
  platform_key   TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  file_format    TEXT NOT NULL,
  file_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT,
  status         TEXT NOT NULL,
  notes          TEXT NOT NULL DEFAULT '',
  holdings_count INTEGER NOT NULL DEFAULT 0,
  clients_count  INTEGER NOT NULL DEFAULT 0,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  file_data      BYTEA
);
CREATE INDEX IF NOT EXISTS uploads_client_idx ON uploads (upload_type, client_key);
CREATE INDEX IF NOT EXISTS uploads_platform_idx ON uploads (upload_type, platform_key);

CREATE TABLE IF NOT EXISTS holdings (
  id             SERIAL PRIMARY KEY,
  upload_id      INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  client_name    TEXT NOT NULL,
  client_key     TEXT NOT NULL,
  client_id      TEXT,
  platform       TEXT NOT NULL,
  platform_key   TEXT NOT NULL,
  asset_class    TEXT,
  category       TEXT,
  security_name  TEXT,
  isin           TEXT,
  identifier     TEXT,
  quantity       DOUBLE PRECISION,
  avg_cost       DOUBLE PRECISION,
  invested       DOUBLE PRECISION,
  current_price  DOUBLE PRECISION,
  current_value  DOUBLE PRECISION,
  gain_loss      DOUBLE PRECISION,
  return_pct     DOUBLE PRECISION,
  xirr           DOUBLE PRECISION,
  as_of          TEXT
);
CREATE INDEX IF NOT EXISTS holdings_platform_idx ON holdings (platform_key);
CREATE INDEX IF NOT EXISTS holdings_client_idx ON holdings (client_key);
CREATE INDEX IF NOT EXISTS holdings_upload_idx ON holdings (upload_id);

-- Multi-asset additions: every upload is an AUM or SIP file for one platform + category, kept
-- as a dated version (nothing is overwritten). Dashboards read the latest version.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'aum';          -- 'aum' or 'sip'
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'Other';     -- MF, Stocks, PMS, ...
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS batch_id TEXT;                             -- one "Upload All"
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS snapshot_date TEXT;                        -- date the data is as of
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
UPDATE uploads SET upload_type = 'client' WHERE upload_type = 'individual';
-- holdings.category is the category as written in the file; product is the matrix row (MF, Stocks, ...).
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS product TEXT NOT NULL DEFAULT 'Other';
CREATE INDEX IF NOT EXISTS holdings_scope_idx ON holdings (client_key, platform_key, product, upload_id);
-- When the money went in and when the holding ends (maturity, redemption), where the file says.
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS start_date TEXT;
ALTER TABLE holdings ADD COLUMN IF NOT EXISTS end_date TEXT;

CREATE TABLE IF NOT EXISTS sips (
  id             SERIAL PRIMARY KEY,
  upload_id      INTEGER NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  client_name    TEXT NOT NULL,
  client_key     TEXT NOT NULL,
  client_id      TEXT,
  platform       TEXT NOT NULL,
  platform_key   TEXT NOT NULL,
  product        TEXT NOT NULL DEFAULT 'Other',
  asset_class    TEXT,
  security_name  TEXT,
  isin           TEXT,
  identifier     TEXT,
  sip_amount     DOUBLE PRECISION,
  monthly_amount DOUBLE PRECISION,
  frequency      TEXT,
  sip_day        INTEGER,
  start_date     TEXT,
  end_date       TEXT,
  status         TEXT,
  live           BOOLEAN NOT NULL DEFAULT TRUE,
  as_of          TEXT
);
CREATE INDEX IF NOT EXISTS sips_upload_idx ON sips (upload_id);
CREATE INDEX IF NOT EXISTS sips_client_idx ON sips (client_key);
CREATE INDEX IF NOT EXISTS sips_platform_idx ON sips (platform_key);
CREATE INDEX IF NOT EXISTS sips_scope_idx ON sips (client_key, platform_key, product, upload_id);

CREATE TABLE IF NOT EXISTS platforms (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  product     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 1000,
  UNIQUE (name_key, product)
);

-- Changes a reviewer made on the Review Report page, one JSON document per client. Uploaded
-- holdings and SIPs are never changed; the report applies these on top of them.
CREATE TABLE IF NOT EXISTS review_edits (
  client_key  TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest version for each client + platform + product.
CREATE OR REPLACE VIEW current_holdings AS
  SELECT h.* FROM holdings h JOIN (
    SELECT DISTINCT ON (client_key, platform_key, product) client_key, platform_key, product, upload_id
    FROM holdings ORDER BY client_key, platform_key, product, upload_id DESC
  ) l ON l.client_key = h.client_key AND l.platform_key = h.platform_key AND l.product = h.product AND l.upload_id = h.upload_id;

CREATE OR REPLACE VIEW current_sips AS
  SELECT s.* FROM sips s JOIN (
    SELECT DISTINCT ON (client_key, platform_key, product) client_key, platform_key, product, upload_id
    FROM sips ORDER BY client_key, platform_key, product, upload_id DESC
  ) l ON l.client_key = s.client_key AND l.platform_key = s.platform_key AND l.product = s.product AND l.upload_id = s.upload_id;
`;

// Platforms and products (categories) from the Multi Asset System Workflow sheet.
export const PRODUCTS = ["MF", "Stocks", "PMS", "AIF", "Bonds", "LAS", "Other"];
const DEFAULT_PLATFORMS = [
  ["MF", ["Finowise", "Freedomlifex", "NJ", "Anand Rathi"]],
  ["Stocks", ["Motilal Oswal", "Omni Science", "Piper Serica", "Philip Capital"]],
  ["PMS", ["NJ", "Omni Science", "AMETRA"]],
  ["AIF", ["Piper Serica"]],
  ["Bonds", ["Philip Capital"]],
  ["LAS", ["Volt Money"]],
  ["Other", ["GIFT CITY"]],
];

async function seedPlatforms(client) {
  const { rows } = await client.query("SELECT COUNT(*)::int AS n FROM platforms");
  if (rows[0].n) return;
  let order = 0;
  for (const [product, names] of DEFAULT_PLATFORMS) {
    for (const name of names) {
      await client.query(
        "INSERT INTO platforms (name, name_key, product, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [name, name.toLowerCase(), product, order++]);
    }
  }
}

// Bump when SCHEMA changes so every deployment re-runs it once.
const SCHEMA_VERSION = 4;
const MIGRATION_LOCK = 724113;

// The pool gets its SSL settings below; an sslmode in the URL only makes pg print a warning.
function withoutSslMode(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    return url;
  }
}

let ready;

async function connect() {
  let client;
  if (DATABASE_URL) {
    const { default: pg } = await import("pg");
    const local = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
    const pool = new pg.Pool({
      connectionString: withoutSslMode(DATABASE_URL),
      ssl: local || /sslmode=disable/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
      max: 3,
    });
    client = {
      query: (text, params) => pool.query(text, params),
      exec: (text) => pool.query(text),
      async migrate(fn) {
        // One instance at a time: concurrent cold starts running ALTER TABLE / CREATE VIEW at once
        // can deadlock each other and in-flight dashboard queries.
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await c.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
          await fn({ query: (t, p) => c.query(t, p) });
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          c.release();
        }
      },
      async transaction(fn) {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          const result = await fn({ query: (t, p) => c.query(t, p) });
          await c.query("COMMIT");
          return result;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    if (process.env.VERCEL) throw new Error("DATABASE_URL is not set. Add a Postgres database to this Vercel project.");
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = process.env.UPLOAD_DETAILS_DATA || path.join(ROOT, "data", "pgdata");
    const db = new PGlite(dir);
    client = {
      query: (text, params) => db.query(text, params),
      exec: (text) => db.exec(text),
      migrate: (fn) => fn({ query: (t, p) => db.query(t, p) }),
      transaction: (fn) => db.transaction((tx) => fn({ query: (t, p) => tx.query(t, p) })),
    };
  }
  await client.migrate(async (tx) => {
    await tx.query("CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)");
    const { rows } = await tx.query("SELECT version FROM schema_meta WHERE id = 1");
    if (rows[0]?.version === SCHEMA_VERSION) return;
    // pg runs a parameterless multi-statement query as one simple query; PGlite needs exec().
    await (DATABASE_URL ? tx.query(SCHEMA) : client.exec(SCHEMA));
    await seedPlatforms(tx);
    await tx.query(
      "INSERT INTO schema_meta (id, version) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET version = $1",
      [SCHEMA_VERSION]);
  });
  return client;
}

export function db() {
  ready = ready || connect().catch((e) => { ready = null; throw e; });
  return ready;
}

export async function query(text, params = []) {
  return (await db()).query(text, params);
}
