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
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_second_person BOOLEAN NOT NULL DEFAULT false;`);
  // Blocklist support — a blocked phone is fully ignored by the bot (no
  // replies sent, though inbound messages are still logged for the record).
  // DB-backed rather than a hardcoded list so numbers can be added/removed
  // via the admin endpoints below without a redeploy.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false;`);

  // Permanent conversation log — every inbound and outbound message, so
  // chats can be reviewed regardless of what Meta/WhatsApp allows and
  // regardless of Railway's log retention window.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id           SERIAL PRIMARY KEY,
      phone        TEXT NOT NULL,
      direction    TEXT NOT NULL, -- 'in' or 'out'
      body         TEXT,
      message_type TEXT,          -- 'text' | 'voice' | 'photo' | 'pdf' | 'qr_image' | etc.
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_phone_time
    ON messages (phone, created_at);
  `);

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
    pendingSecondPerson: row.pending_second_person,
    blocked: row.blocked,
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
  pendingSecondPerson: "pending_second_person",
  blocked: "blocked",
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

// Finds every session where payment was received but report generation
// ultimately gave up (report_status='failed', the terminal state set after
// MAX_REPORT_ATTEMPTS). This is the authoritative "paid but not delivered"
// list — safer than scanning chat transcripts by hand, since it's driven
// directly by DB state rather than by what a message preview happens to
// show. Ordered most-recent-first so the newest cases surface first.
async function findFailedPayments() {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE report_status = 'failed'
     ORDER BY updated_at DESC`
  );
  return result.rows.map(rowToSession);
}

// Logs one message (inbound or outbound) to the permanent conversation log.
// Never throws — a logging failure should never break the actual bot flow.
async function logMessage(phone, direction, body, messageType) {
  try {
    await pool.query(
      `INSERT INTO messages (phone, direction, body, message_type) VALUES ($1, $2, $3, $4)`,
      [phone, direction, body || "", messageType || "text"]
    );
  } catch (err) {
    console.error(new Date().toISOString(), "- logMessage failed (caught):", err.message);
  }
}

// Returns full message history for one phone number, oldest first.
async function getMessagesForPhone(phone) {
  const result = await pool.query(
    `SELECT direction, body, message_type, created_at FROM messages WHERE phone = $1 ORDER BY created_at ASC`,
    [phone]
  );
  return result.rows;
}

// Lists phone numbers with any message activity, most recent first, along
// with a short preview and message count — used for the admin chat list.
async function listConversations() {
  const result = await pool.query(`
    SELECT
      m.phone,
      COUNT(*) AS message_count,
      MAX(m.created_at) AS last_activity,
      (SELECT body FROM messages WHERE phone = m.phone ORDER BY created_at DESC LIMIT 1) AS last_message,
      s.name,
      s.stage
    FROM messages m
    LEFT JOIN sessions s ON s.phone = m.phone
    GROUP BY m.phone, s.name, s.stage
    ORDER BY last_activity DESC
  `);
  return result.rows;
}

// Lists all currently blocked phone numbers, most recently updated first —
// used by the admin /admin/blocked endpoint so the block list is visible
// without querying the DB by hand.
async function listBlockedPhones() {
  const result = await pool.query(
    `SELECT phone, name, updated_at FROM sessions WHERE blocked = true ORDER BY updated_at DESC`
  );
  return result.rows;
}

module.exports = {
  pool,
  initDb,
  getOrCreateSession,
  updateSession,
  findDueReports,
  findFailedPayments,
  logMessage,
  getMessagesForPhone,
  listConversations,
  listBlockedPhones,
};
