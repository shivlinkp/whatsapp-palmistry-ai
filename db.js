/**
 * db.js — PostgreSQL layer for the palmistry bot.
 *
 * Uses the "pg" package with CommonJS require(). Expects DATABASE_URL to be
 * set (Railway provides this automatically when you add a Postgres service
 * and reference it, e.g. DATABASE_URL=${{ Postgres.DATABASE_URL }}).
 *
 * All session state (name, dob, gender, stage, payment, report status/text,
 * report due time) lives here instead of in-memory, so nothing is lost on
 * a Railway restart/redeploy.
 */

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Add a Postgres service in Railway and link it.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway's internal Postgres typically doesn't require SSL, but Railway's
  // public/proxy connection strings sometimes do. This works for both.
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
  // "pg" has NO default connection timeout — without this, a bad/unreachable
  // DATABASE_URL causes the app to hang forever with zero output instead of
  // erroring out. This makes failures fast and visible in the logs.
  connectionTimeoutMillis: 10000,
  query_timeout: 15000,
});

pool.on("error", (err) => {
  console.error(new Date().toISOString(), "- Unexpected PG pool error (caught):", err.message);
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      phone             TEXT PRIMARY KEY,
      name              TEXT,
      dob               TEXT,
      gender            TEXT,
      stage             TEXT NOT NULL DEFAULT 'new',
      palm_media_id     TEXT,
      payment_received  BOOLEAN NOT NULL DEFAULT false,
      report_text       TEXT,
      report_status     TEXT NOT NULL DEFAULT 'none',
      report_due_at     TIMESTAMPTZ,
      report_error      TEXT,
      report_attempts   INTEGER NOT NULL DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Safe migration for tables created before "order for someone else"
  // support was added — ADD COLUMN IF NOT EXISTS is a no-op on tables that
  // already have these columns, so this is safe to run on every boot.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS relation TEXT;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS order_count INTEGER NOT NULL DEFAULT 1;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS awaiting_transaction_id BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS awaiting_report_inquiry_count INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sessions_report_due
    ON sessions (report_status, report_due_at);
  `);
  console.log(new Date().toISOString(), "- DB: sessions table ready");
}

// Converts a DB row (snake_case) into the camelCase session object shape
// used throughout server.js.
function rowToSession(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    name: row.name,
    dob: row.dob,
    gender: row.gender,
    stage: row.stage,
    palmMediaId: row.palm_media_id,
    paymentReceived: row.payment_received,
    reportText: row.report_text,
    reportStatus: row.report_status,
    reportDueAt: row.report_due_at,
    reportError: row.report_error,
    reportAttempts: row.report_attempts,
    relation: row.relation,
    orderCount: row.order_count,
    awaitingTransactionId: row.awaiting_transaction_id,
    awaitingReportInquiryCount: row.awaiting_report_inquiry_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// Fetches the session for a phone number, creating a fresh default row if
// none exists yet. Always returns a session object (never null).
async function getOrCreateSession(phone) {
  const existing = await pool.query("SELECT * FROM sessions WHERE phone = $1", [phone]);
  if (existing.rows.length) {
    return rowToSession(existing.rows[0]);
  }
  const inserted = await pool.query(
    `INSERT INTO sessions (phone) VALUES ($1)
     ON CONFLICT (phone) DO UPDATE SET updated_at = sessions.updated_at
     RETURNING *`,
    [phone]
  );
  return rowToSession(inserted.rows[0]);
}

// Maps camelCase patch keys to their DB column names. Only keys present
// here are ever written — this is intentional, to keep the mapping between
// server.js session fields and DB columns explicit and safe.
const FIELD_MAP = {
  name: "name",
  dob: "dob",
  gender: "gender",
  stage: "stage",
  palmMediaId: "palm_media_id",
  paymentReceived: "payment_received",
  reportText: "report_text",
  reportStatus: "report_status",
  reportDueAt: "report_due_at",
  reportError: "report_error",
  reportAttempts: "report_attempts",
  relation: "relation",
  orderCount: "order_count",
  awaitingTransactionId: "awaiting_transaction_id",
  awaitingReportInquiryCount: "awaiting_report_inquiry_count",
};

// Updates only the given fields for a phone number's session, bumps
// updated_at automatically, and returns the full updated session object.
async function updateSession(phone, patch) {
  const keys = Object.keys(patch).filter((k) => Object.prototype.hasOwnProperty.call(FIELD_MAP, k));
  if (keys.length === 0) {
    return getOrCreateSession(phone);
  }

  const setClauses = keys.map((k, i) => `${FIELD_MAP[k]} = $${i + 2}`);
  const values = keys.map((k) => patch[k]);

  const sql = `UPDATE sessions SET ${setClauses.join(", ")}, updated_at = now() WHERE phone = $1 RETURNING *`;
  const result = await pool.query(sql, [phone, ...values]);

  if (result.rows.length === 0) {
    // Row didn't exist yet (shouldn't normally happen since webhook always
    // calls getOrCreateSession first) — create it, then apply the patch.
    await getOrCreateSession(phone);
    return updateSession(phone, patch);
  }

  return rowToSession(result.rows[0]);
}

// Finds all sessions whose report is pending and due (report_due_at has
// passed). Used by the polling worker — this is what makes report delivery
// survive a Railway restart, since it's driven entirely by DB state rather
// than an in-memory setTimeout.
async function findDueReports() {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE report_status = 'pending'
       AND report_due_at IS NOT NULL
       AND report_due_at <= now()`
  );
  return result.rows.map(rowToSession);
}

module.exports = {
  pool,
  initDb,
  getOrCreateSession,
  updateSession,
  findDueReports,
};
