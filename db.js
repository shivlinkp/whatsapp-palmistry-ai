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
  // Same pattern as awaiting_report_inquiry_count, but for the payment
  // verification stage — previously that stage never offered support
  // contact no matter how many times or how confusedly a customer asked.
  // Real incident: Sreeja pv, 918606427024, 13/8 — sent 4 messages
  // (including confused voice notes) stuck verifying payment, never once
  // pointed to a human.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS awaiting_payment_inquiry_count INTEGER NOT NULL DEFAULT 0;`);
  // Counts failed attempts to match a language choice in the
  // awaiting_language picker. Without a fallback, a customer who never
  // sends an exact "1"/"2"/"English"/"Malayalam"-style reply gets the
  // identical picker message re-sent forever, with zero acknowledgment,
  // no matter how many times or how differently they try — losing the
  // sale before they've even seen pricing. Real incident: 918637429436 —
  // tried 5 separate times across 8 days (general questions, "Tamil", a
  // voice message), got the exact same picker every time, never got
  // through. After a couple of failed attempts we now default to
  // Malayalam (this bot's customers are overwhelmingly Malayalam
  // speakers, same reasoning used elsewhere in this codebase) and let
  // them proceed rather than trap them indefinitely.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS language_attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pending_second_person BOOLEAN NOT NULL DEFAULT false;`);
  // Customer's current reply language, detected per-message (see
  // detectLanguage() in server.js) and updated adaptively — whatever
  // language their most recent message was in is what they get replied to
  // in next, including for the eventual report generation itself. Defaults
  // to 'ml' so every existing session (and any session where detection is
  // ever skipped/fails) keeps today's Malayalam-only behavior unchanged.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'ml';`);
  // Stable "payment confirmed" timestamp — unlike report_due_at (which gets
  // pushed forward by REPORT_RETRY_INTERVAL_MS on every failed attempt),
  // this never changes once set, so it's what we use to measure genuine
  // elapsed wait time for the 30-minute force-retry safety net.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;`);
  // Tracks the moment the last actual generation attempt STARTED (poller's
  // normal due-processing, poller's overdue sweep, or a manually forced
  // retry from a customer message) — separate from updated_at, which gets
  // bumped by unrelated writes like awaiting_report_inquiry_count. Used to
  // throttle forced retries so a burst of customer messages ("ߑ", "Hlo",
  // "??") can't each trigger their own full (costly) regeneration attempt
  // seconds apart. Real incident: Shameena, 919946345651, 26/7 — over a
  // dozen forced retries fired within an hour, several just 5 seconds
  // apart, from consecutive short messages while she was frustrated and
  // waiting.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;`);
  // Throttles the "we'll contact you directly" message once a session is
  // past REPORT_FORCE_RETRY_HARD_CAP_MS — without this, that exact message
  // got repeated verbatim to every single thing the customer sent, for
  // hours, because nobody ever actually followed up. Real incident:
  // Sangeetha, 919778743899, 29/7 — same message repeated ~10 times over
  // 18+ hours, including to two explicit refund requests.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS hard_cap_notified_at TIMESTAMPTZ;`);
  // Flags sessions where the customer explicitly asked for a refund, so
  // they're visible on their own admin list instead of only being noticed
  // by chance while reviewing an unrelated chat.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ;`);

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
    awaitingPaymentInquiryCount: row.awaiting_payment_inquiry_count,
    languageAttempts: row.language_attempts,
    pendingSecondPerson: row.pending_second_person,
    paymentConfirmedAt: row.payment_confirmed_at,
    lastAttemptAt: row.last_attempt_at,
    hardCapNotifiedAt: row.hard_cap_notified_at,
    refundRequestedAt: row.refund_requested_at,
    language: row.language,
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
  awaitingPaymentInquiryCount: "awaiting_payment_inquiry_count",
  languageAttempts: "language_attempts",
  pendingSecondPerson: "pending_second_person",
  paymentConfirmedAt: "payment_confirmed_at",
  lastAttemptAt: "last_attempt_at",
  hardCapNotifiedAt: "hard_cap_notified_at",
  refundRequestedAt: "refund_requested_at",
  language: "language",
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
// Fetches every session marked report_status='sent' along with its report
// text. Used by the one-off /admin/scan-stuck-reports endpoint to find
// sessions where a refusal or degenerate-output slipped past isLikelyRefusal
// / isLikelyDegenerateRepetition and got sent to the customer (and marked
// 'sent' in the DB) as if it were their real report — these sessions never
// show up in findFailedPayments() because their status isn't 'failed'.
async function findSentReports() {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE report_status = 'sent'
       AND report_text IS NOT NULL
     ORDER BY updated_at DESC`
  );
  return result.rows.map(rowToSession);
}

// Finds sessions stuck in awaiting_report where genuine wall-clock time
// since payment (payment_confirmed_at) exceeds thresholdMs, regardless of
// what report_status/report_attempts/report_due_at currently say. This is
// a deliberate belt-and-suspenders check independent of the normal
// attempt-counter bookkeeping — it exists specifically to catch the case
// where that bookkeeping itself is broken (e.g. an attempt silently fails
// to persist its incremented count and the session retries "attempt 1"
// forever without ever reaching report_status='failed'). Real incident
// this defends against: Aswathy, 918921390826, 24-25/7 — stuck over an
// hour past payment with no exhausted message ever sent, because attempts
// never appeared to progress past the first one.
//
// hardCapMs is a SEPARATE, MUCH LARGER upper bound: sessions older than
// this are EXCLUDED from the sweep entirely, even though they're still
// "overdue" by the normal threshold. Without this, a customer who
// abandons the chat after one failed cycle gets swept and retried FOREVER.
//
// pacingMs is a CRITICAL third gate, added after discovering a severe bug:
// the poller runs every 60 SECONDS, but this query previously had no idea
// when a session was last actually attempted — only how old the payment
// was. That meant once a session crossed the overdue threshold, it got
// swept and fully re-attempted on EVERY 60-second poll tick, not once
// per REPORT_FORCE_RETRY_AFTER_MS (30 min) as intended — up to ~150+
// redundant full generation attempts over a 3-hour window for a single
// abandoned session. pacingMs (using last_attempt_at, set at the start of
// every real generation attempt) enforces genuine spacing between
// sweep-triggered attempts. This — not just the missing hard cap — is
// almost certainly the dominant cause behind gpt-4.1 request volume
// growing from ~200/day to 7,333/day over 25-27/7.
async function findOverdueAwaitingReports(thresholdMs, hardCapMs, pacingMs) {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE stage = 'awaiting_report'
       AND report_status != 'sent'
       AND payment_confirmed_at IS NOT NULL
       AND payment_confirmed_at <= now() - ($1 || ' milliseconds')::interval
       AND ($2::bigint IS NULL OR payment_confirmed_at > now() - ($2 || ' milliseconds')::interval)
       AND ($3::bigint IS NULL OR last_attempt_at IS NULL OR last_attempt_at <= now() - ($3 || ' milliseconds')::interval)`,
    [thresholdMs, hardCapMs || null, pacingMs || null]
  );
  return result.rows.map(rowToSession);
}

// Finds every session where the customer explicitly asked for a refund at
// some point (refund_requested_at set), most-recent-first. Real incident
// this fixes: Sangeetha, 919778743899, 29/7 — asked for a refund twice,
// got a canned "we'll contact you" reply both times, and nobody noticed
// for hours because there was no way to see refund requests separately
// from ordinary "where's my report" inquiries.
async function findRefundRequests() {
  const result = await pool.query(
    `SELECT * FROM sessions
     WHERE refund_requested_at IS NOT NULL
     ORDER BY refund_requested_at DESC`
  );
  return result.rows.map(rowToSession);
}

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

module.exports = {
  pool,
  initDb,
  getOrCreateSession,
  updateSession,
  findDueReports,
  findOverdueAwaitingReports,
  findFailedPayments,
  findRefundRequests,
  findSentReports,
  logMessage,
  getMessagesForPhone,
  listConversations,
};
