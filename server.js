/**
 * Palmistry WhatsApp Bot - server.js
 *
 * ENV VARS REQUIRED:
 *   VERIFY_TOKEN      - webhook verification token you set in Meta App dashboard
 *   WHATSAPP_TOKEN    - permanent/temporary token for Graph API
 *   PHONE_NUMBER_ID   - WhatsApp Business phone number id
 *   OPENAI_API_KEY    - OpenAI key for extraction + report generation
 *   QR_IMAGE_URL      - publicly reachable URL (Cloudinary) of your payment
 *                       QR image. This is the ONLY source used to send the
 *                       QR image — no local file, no static route.
 *   DATABASE_URL      - Postgres connection string (Railway Postgres plugin)
 *
 * PRODUCTION RELIABILITY: all session state (name, dob, gender, stage,
 * payment, report status/text/due-time) is stored in Postgres via db.js —
 * nothing lives in an in-memory Map anymore. Report delivery is driven by
 * a polling worker (setInterval, every 60s) that looks for sessions whose
 * report_due_at has passed, NOT by setTimeout — so a Railway restart never
 * loses a pending report; the next poll tick picks it up from the DB.
 */

const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const db = require("./db");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

// ---------------------------------------------------------------------------
// In-memory state that's safe to lose on restart (not customer data)
// ---------------------------------------------------------------------------

// Dedup of processed WhatsApp message ids (capped ring buffer). Not
// persisted — worst case after a restart is a very recent duplicate being
// reprocessed once, which is an acceptable tradeoff and wasn't part of the
// data the person asked to persist.
const processedMessageIds = new Set();
const processedMessageOrder = [];
const MAX_PROCESSED_IDS = 2000;

function markProcessed(id) {
  processedMessageIds.add(id);
  processedMessageOrder.push(id);
  if (processedMessageOrder.length > MAX_PROCESSED_IDS) {
    const old = processedMessageOrder.shift();
    processedMessageIds.delete(old);
  }
}

function isDuplicate(id) {
  return processedMessageIds.has(id);
}

// Tracks the wamid of the last QR image sent per phone number, so incoming
// status webhooks (sent/delivered/read/failed) can be correlated back to
// the actual QR send attempt.
const qrMessageIdsByPhone = new Map();

// ---------------------------------------------------------------------------
// WhatsApp send helpers
// ---------------------------------------------------------------------------

// Human-like pacing between outgoing messages: 10-15 seconds. This ONLY
// affects how quickly consecutive WhatsApp messages are sent — it has no
// effect on report/assessment scheduling (report_due_at), which is
// computed separately via real Date math and stays exactly as configured.
function randomSendDelayMs() {
  return 10000 + Math.random() * 5000; // 10-15 seconds
}

async function sendWhatsAppRequest(payload) {
  const delay = randomSendDelayMs();
  log(`Waiting ${(delay / 1000).toFixed(1)}s before sending (human-like pacing)`);
  await new Promise((resolve) => setTimeout(resolve, delay));

  log("Outgoing WhatsApp API payload:", JSON.stringify(payload));

  try {
    const res = await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    log("WhatsApp API HTTP status:", res.status);
    log("WhatsApp API full response:", JSON.stringify(data));

    return { httpStatus: res.status, ok: res.ok, data };
  } catch (err) {
    log("WhatsApp send network error:", err.message);
    return { httpStatus: null, ok: false, data: null, networkError: err.message };
  }
}

async function sendText(to, body) {
  log("Sending text to", to, "->", body.slice(0, 60).replace(/\n/g, " "));
  const result = await sendWhatsAppRequest({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
  return result?.ok === true;
}

// Sends an image by link, following Meta's documented schema exactly:
// https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages#image-messages
// Returns true ONLY if Meta's response confirms acceptance (HTTP 2xx + a
// real message id in response.messages[0].id). This is the ONLY QR-sending
// method in the app — no local file, no media upload, no fallback. It only
// ever uses process.env.QR_IMAGE_URL.
async function sendImageByUrl(to, link, caption) {
  if (!link || !/^https?:\/\//i.test(link)) {
    log(`QR image NOT sent — QR_IMAGE_URL is missing or invalid. Current value: "${link}"`);
    return false;
  }

  console.log("Using QR URL:", QR_IMAGE_URL);

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: caption ? { link, caption } : { link },
  };

  console.log("IMAGE PAYLOAD =", JSON.stringify(payload, null, 2));

  log("Sending QR image (by link) to", to, "-> link:", link);

  const result = await sendWhatsAppRequest(payload);
  const data = result?.data;

  console.log("IMAGE META RESPONSE =", JSON.stringify(data, null, 2));
  console.log("QR MESSAGE ID =", data?.messages?.[0]?.id);

  if (!result || result.networkError) {
    log("QR image send FAILED — network error:", result?.networkError || "unknown");
    return false;
  }

  if (!result.ok) {
    log("QR image REJECTED by Meta. HTTP status:", result.httpStatus, "Full response:", JSON.stringify(result.data));
    return false;
  }

  const wamid = result.data?.messages?.[0]?.id;
  if (!wamid) {
    log(
      "QR image response was HTTP",
      result.httpStatus,
      "but contained no message id — treating as failure. Full response:",
      JSON.stringify(result.data)
    );
    return false;
  }

  log("QR image (by link) ACCEPTED by Meta. HTTP status:", result.httpStatus, "wamid:", wamid);
  qrMessageIdsByPhone.set(to, wamid);
  log("Tracked QR message id for", to, "->", wamid);
  return true;
}

// Splits long text into WhatsApp-safe chunks (~3500 char limit), breaking on
// paragraph/sentence boundaries where possible.
function splitIntoChunks(text, maxLen = 3500) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(". ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

async function sendLongText(to, text) {
  const chunks = splitIntoChunks(text);
  for (const chunk of chunks) {
    await sendText(to, chunk);
  }
}

// ---------------------------------------------------------------------------
// Message content constants (Malayalam)
// ---------------------------------------------------------------------------

const WELCOME_MESSAGE = `Hi

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

- നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും
- സ്നേഹവും ബന്ധങ്ങളും
- വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും
- ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ
- സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും
- ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും
- നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

ദയവായി താഴെ പറയുന്ന വിവരങ്ങൾ ഒരുമിച്ച് അയച്ചുതരാമോ?

• പേര്
• ജനനത്തീയതി
• Gender (ലിംഗം)

ഫീസ്: ₹99 മാത്രം.`;

const ASK_ALL_DETAILS_MESSAGE = `ദയവായി താഴെ പറയുന്ന വിവരങ്ങൾ ഒരുമിച്ച് അയച്ചുതരാമോ?

• പേര്
• ജനനത്തീയതി
• Gender (ലിംഗം)`;

const ASK_SECOND_PERSON_DETAILS_MESSAGE = `തീർച്ചയായും, ഇതേ ചാറ്റിൽ തന്നെ അടുത്ത വ്യക്തിയുടെ കൈരേഖാ വിശകലനം ആരംഭിക്കാം.

ദയവായി ആ വ്യക്തിയുടെ താഴെ പറയുന്ന വിവരങ്ങൾ ഒരുമിച്ച് അയച്ചുതരാമോ?

• പേര്
• ജനനത്തീയതി
• Gender (ലിംഗം)

(ഇഷ്ടമെങ്കിൽ, ഈ വ്യക്തി നിങ്ങളുമായി എങ്ങനെ ബന്ധപ്പെട്ടിരിക്കുന്നു എന്നും പറയാം — നിർബന്ധമില്ല.)

ഫീസ്: ₹99 മാത്രം.`;

function handRequestMessage(name, gender) {
  const hand = gender === "female" ? "ഇടത്" : "വലത്";
  return `നന്ദി ${name}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ ${hand} കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ:
- കൈ മുഴുവനും വ്യക്തമായി കാണണം
- നല്ല വെളിച്ചത്തിൽ എടുക്കണം
- കൈരേഖകൾ blur ആകരുത്`;
}

const PHOTO_RECEIVED_PAYMENT_MESSAGE = `ഫോട്ടോ ലഭിച്ചു. നന്ദി.

താഴെ നൽകിയിരിക്കുന്ന QR Code ഉപയോഗിച്ച് ₹99 payment ചെയ്യുക.

Payment ചെയ്തതിന് ശേഷം payment screenshot ഇവിടെ അയച്ചാൽ മതി.`;

const SUPPORT_EMAIL = "contact@boldwordsmedia.com";
const SUPPORT_EMAIL_INQUIRY_THRESHOLD = 3; // offer support email after this many messages while awaiting_report

const QR_FAILURE_MESSAGE =
  `QR code അയക്കുന്നതിൽ ചെറിയ പ്രശ്നം ഉണ്ടായി. ദയവായി കുറച്ച് സമയം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കൂ. തുടർച്ചയായി പ്രശ്നം ഉണ്ടെങ്കിൽ ${SUPPORT_EMAIL} എന്ന ഇമെയിലിൽ ഞങ്ങളെ ബന്ധപ്പെടാം.`;

function paymentReceivedMessage(name, isRepeatOrder) {
  const timingLine = isRepeatOrder
    ? "Report ഏകദേശം 30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും."
    : "Report ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും.";
  return `Payment screenshot ലഭിച്ചു. നന്ദി ${name}.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

${timingLine}`;
}

const REPORT_PREPARING_MESSAGE =
  "നിങ്ങളുടെ റിപ്പോർട്ട് തയ്യാറാക്കുന്നതിൽ അല്പം സമയമെടുക്കുന്നു. ദയവായി അല്പസമയം കൂടി കാത്തിരിക്കൂ, ഞങ്ങൾ ഉടൻ അയയ്ക്കും.";

const REPORT_EXHAUSTED_MESSAGE =
  `ക്ഷമിക്കണം, റിപ്പോർട്ട് തയ്യാറാക്കുന്നതിൽ കൂടുതൽ സമയമെടുക്കുന്നു. ഞങ്ങൾ ഉടൻ തന്നെ നേരിട്ട് നിങ്ങളെ ബന്ധപ്പെടും. ആവശ്യമെങ്കിൽ ${SUPPORT_EMAIL} എന്ന ഇമെയിലിലും ഞങ്ങളെ ബന്ധപ്പെടാം.`;

const REPORT_STILL_PENDING_MESSAGE =
  "നിങ്ങളുടെ റിപ്പോർട്ട് ഇപ്പോഴും തയ്യാറാക്കുകയാണ്. കുറച്ച് സമയത്തിനുള്ളിൽ ഇവിടെ ലഭിക്കും.";

const REPORT_RETRYING_MESSAGE = "ഒരു നിമിഷം, റിപ്പോർട്ട് വീണ്ടും തയ്യാറാക്കാൻ ശ്രമിക്കുന്നു...";

// ---------------------------------------------------------------------------
// FAQ handling (keyword based, no GPT call — keeps pre-payment flow cheap/fast)
// ---------------------------------------------------------------------------

// Detects "I can't send a screenshot" style messages (English/Manglish) so
// we can offer the transaction-ID fallback instead. Kept as simple regex
// (like matchFaq) since this is usually a fairly literal statement, not
// ambiguous the way some other intents are.
function cannotSendScreenshotIntent(text) {
  const mentionsScreenshot = /screenshot|\bss\b/i.test(text);
  const inability = /\b(illa|pattilla|pattunnilla|cannot|can'?t|not able|mudiyilla|unable|issue|problem)\b/i.test(text);
  return mentionsScreenshot && inability;
}

function matchFaq(text) {
  const t = text.toLowerCase();

  const whatGet = /(what.*get|enthanu kittu|entha kittunnath|what do i|what will i)/i;
  const howMuch = /(how much|price|cost|fee|rate|entha vila|entra vila|₹)/i;
  const howLong = /(how long|when.*report|time.*report|eppo kittum|how many min)/i;
  const asksForNumber = /(phone number|mobile number|upi number|payment number|account number|your number|number tharo|number parayo|number koodukumo|number tharuo)/i;

  if (asksForNumber.test(t))
    return "ഇത് ഒരു കമ്പനി അക്കൗണ്ട് ആണ്; വ്യക്തിഗത payment നമ്പർ ഇല്ല. മുകളിൽ നൽകിയിരിക്കുന്ന QR Code സ്കാൻ ചെയ്ത്, ഏത് UPI ആപ്പ് ഉപയോഗിച്ചും (Google Pay, PhonePe, Paytm etc.) ₹99 payment ചെയ്യാം. Payment കഴിഞ്ഞാൽ screenshot ഇവിടെ അയച്ചാൽ മതി.";
  if (howMuch.test(t)) return "ഫീസ് ₹99 മാത്രം.";
  if (howLong.test(t)) return "Payment screenshot അയച്ചതിന് ശേഷം ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ report ലഭിക്കും.";
  if (whatGet.test(t)) return "നിങ്ങളുടെ സ്വഭാവം, ബന്ധങ്ങൾ, വിവാഹം, കരിയർ, സാമ്പത്തികം, ഭാവി എന്നിവയെക്കുറിച്ചുള്ള വിശദമായ കൈരേഖാ വിശകലനം ലഭിക്കും.";
  return null;
}

// Matches messages asking for report status while awaiting_report, e.g.
// "report", "assessment", "എപ്പോൾ കിട്ടും", "ready ayo", "status".
function isReportStatusQuery(text) {
  return /report|assessment|reading|എപ്പോൾ|kittum|kitum|ready|status|vannu|vanno/i.test(text);
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

async function openaiChat(messages, opts = {}) {
  if (!OPENAI_API_KEY) {
    log("OPENAI_API_KEY missing, skipping OpenAI call");
    return null;
  }
  const requestedModel = opts.model || "gpt-4o-mini";
  log("openaiChat: requesting model:", requestedModel);

  async function attempt(includeTemperature) {
    const body = {
      model: requestedModel,
      messages,
      // max_tokens is rejected outright by newer models (e.g. gpt-5.5) with
      // a 400 error — max_completion_tokens is the current parameter name
      // and works correctly across all models including older ones.
      max_completion_tokens: opts.max_tokens || 800,
    };
    if (includeTemperature) {
      body.temperature = opts.temperature ?? 0.7;
    }
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return { res, data };
  }

  try {
    let { res, data } = await attempt(true);
    log("openaiChat: HTTP status:", res.status, "-> actual model used (response.model):", data.model);

    // Some newer models (e.g. gpt-5.5) reject any non-default temperature
    // value outright rather than accepting/ignoring it. If that's the exact
    // error, retry once without sending temperature at all, instead of
    // giving up and silently falling back to a weaker model.
    if (!res.ok && data?.error?.param === "temperature") {
      log("openaiChat: model rejected custom temperature — retrying once without it.");
      ({ res, data } = await attempt(false));
      log("openaiChat (retry): HTTP status:", res.status, "-> actual model used (response.model):", data.model);
    }

    if (!res.ok) {
      log("OpenAI error:", JSON.stringify(data));
      return null;
    }

    const content = data.choices?.[0]?.message?.content || "";
    const finishReason = data.choices?.[0]?.finish_reason;
    const usage = data.usage;
    log(
      "openaiChat: success — content length:",
      content.length,
      "finish_reason:",
      finishReason,
      "usage:",
      JSON.stringify(usage)
    );
    if (!content) {
      log(
        "openaiChat: WARNING — HTTP 200 but content is EMPTY. This can happen when a reasoning model spends its entire max_completion_tokens budget on internal reasoning tokens, leaving nothing for visible output. Full response:",
        JSON.stringify(data)
      );
    }
    return content || null;
  } catch (err) {
    log("OpenAI call failed:", err.message);
    return null;
  }
}

// Extracts {name, dob, gender} from free text (English/Malayalam/Manglish).
// Returns only the fields it is confident about; never overwrites what we
// don't find. Falls back to simple regex if OpenAI is unavailable/fails.
async function extractFields(text, known) {
  const result = { name: null, dob: null, gender: null, relation: null };

  const dobMatch = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (dobMatch) {
    let [, d, m, y] = dobMatch;
    if (y.length === 2) y = (parseInt(y, 10) > 30 ? "19" : "20") + y;
    result.dob = `${d.padStart(2, "0")}-${m.padStart(2, "0")}-${y}`;
  }

  if (/\bmale\b|ആൺ|പുരുഷൻ/i.test(text) && !/\bfemale\b/i.test(text)) {
    result.gender = "male";
  } else if (/\bfemale\b|പെൺ|സ്ത്രീ/i.test(text)) {
    result.gender = "female";
  }

  const prompt = `Extract name, date of birth, gender, and (if mentioned) how this person relates to the customer, from the customer's WhatsApp message below.
The customer may send the details in ANY order, on separate lines, comma-separated, or in Malayalam/Manglish. Examples of valid inputs:
"Shivlin, 07-11-1992, Male"
"Shivlin\\n07-11-1992\\nMale"
"Male\\n07-11-1992\\nShivlin"
"പേര് Shivlin ജനനത്തീയതി 07-11-1992 ലിംഗം Male"
"This is for my brother, Shivlin, 07-11-1992, Male"

If gender is not explicitly stated as a word (male/female/ആൺ/പെൺ etc.), but the given name is a common Indian name with a clear, widely-recognized conventional gender in Indian naming convention (e.g. Satheesh, Ramesh, Suresh, Anil, Vijay, Rahul, Shivlin → male; Priya, Anitha, Divya, Lakshmi, Meera, Nidhiya → female), infer that gender confidently instead of leaving it null — do not force the customer to state the obvious. Only do this when you are genuinely confident the name is unambiguous; if the name could plausibly be used for either gender, or is unfamiliar to you, leave gender null so it gets asked explicitly instead of guessed.

Already known (do not change unless the new message clearly overrides it): ${JSON.stringify(known)}
Customer message: """${text}"""

Reply with ONLY a raw JSON object, no markdown, no explanation, in this exact shape:
{"name": string or null, "dob": "DD-MM-YYYY" or null, "gender": "male" or "female" or null, "relation": string or null}
"relation" should only be set if the customer explicitly describes how this person relates to them (e.g. "brother", "friend", "wife") — otherwise null. If a field is not present in the message, set it to null.`;

  const raw = await openaiChat([{ role: "user", content: prompt }], {
    model: "gpt-4o-mini",
    temperature: 0,
    max_tokens: 150,
  });

  if (raw) {
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.name) result.name = parsed.name;
      if (parsed.dob) result.dob = parsed.dob;
      if (parsed.gender === "male" || parsed.gender === "female") result.gender = parsed.gender;
      if (parsed.relation) result.relation = parsed.relation;
    } catch (err) {
      log("Extraction JSON parse failed, using regex-only result");
    }
  }

  // Safe regex fallback for name — only when a dob or gender was also found
  // in the same message, to avoid misreading a stray question as a name.
  if (!result.name && (result.dob || result.gender)) {
    let residual = text
      .replace(dobMatch ? dobMatch[0] : "", "")
      .replace(/\b(male|female)\b/gi, "")
      .replace(/ആൺ|പുരുഷൻ|പെൺ|സ്ത്രീ/g, "")
      .replace(/[,\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const words = residual.split(" ").filter(Boolean);
    if (words.length > 0 && words.length <= 4) {
      result.name = words.join(" ");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Media helpers (fetch WhatsApp image as base64 for vision-capable report gen)
// ---------------------------------------------------------------------------

async function getMediaBase64(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const meta = await metaRes.json();
    log("Media metadata lookup for", mediaId, "-> HTTP", metaRes.status, "response:", JSON.stringify(meta));

    if (!meta.url) {
      log("Media download ABORTED — no url in metadata response for mediaId:", mediaId);
      return null;
    }

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    if (!fileRes.ok) {
      log("Media file download FAILED — HTTP", fileRes.status, "for mediaId:", mediaId);
      return null;
    }

    const buffer = await fileRes.buffer();
    const mimeType = meta.mime_type || "image/jpeg";
    const dataUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;

    log("Palm image downloaded successfully. Size in bytes:", buffer.length, "mime_type:", mimeType);
    log("Data URL first 100 chars:", dataUrl.slice(0, 100));

    if (buffer.length === 0) {
      log("Media download WARNING — downloaded buffer is 0 bytes, treating as failure.");
      return null;
    }

    return dataUrl;
  } catch (err) {
    log("Failed to fetch media (caught):", err.message);
    return null;
  }
}

// Quick, cheap vision check: is this actually a photo of a human palm/hand?
// Run BEFORE sending the QR/payment ask, so a wrong photo (a wall, tiles,
// a face, etc.) gets caught immediately instead of only being discovered
// during report generation — after the customer has already paid ₹99.
// Fails OPEN (treats as valid) on any error, so an infrastructure hiccup
// on our end never blocks a genuine customer from proceeding.
const PALM_VALIDATION_MODEL_PRIMARY = "gpt-5.5";
const PALM_VALIDATION_MODEL_FALLBACK = "gpt-4o";

async function callPalmValidation(imageDataUrl, model) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Look at this image. Is it a clear photo of a human hand showing the palm (suitable for a palm reading)? Reply with ONLY one word: YES or NO.",
            },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      // Was 10 — too tight a budget risked truncating the answer mid-word
      // (e.g. cutting off before the model could correct/clarify itself),
      // which could leave a stray "NO" fragment as the entire response.
      // 30 gives enough room for a short sentence to complete normally.
      max_completion_tokens: 30,
    }),
  });
  const data = await res.json();
  return { res, data };
}

async function isPalmPhoto(imageDataUrl) {
  if (!imageDataUrl) {
    return { valid: true, reason: "no image data to check — defaulting to accept" };
  }
  if (!OPENAI_API_KEY) {
    return { valid: true, reason: "OPENAI_API_KEY missing — defaulting to accept" };
  }
  try {
    // Use the account's flagship model for the best vision judgment —
    // real customer logs showed clear, valid palm photos being wrongly
    // rejected on gpt-4o-mini. Only fall back to gpt-4o if gpt-5.5 itself
    // is unavailable on this account (not for a genuine YES/NO answer,
    // which should be trusted either way).
    let { res, data } = await callPalmValidation(imageDataUrl, PALM_VALIDATION_MODEL_PRIMARY);
    log(
      `Palm photo validation (model "${PALM_VALIDATION_MODEL_PRIMARY}") -> HTTP status:`,
      res.status,
      "response:",
      JSON.stringify(data)
    );

    const modelUnavailable =
      !res.ok &&
      data?.error &&
      /model/i.test(data.error.code || "") &&
      /not found|does not exist|invalid|unknown/i.test(data.error.message || data.error.code || "");

    if (modelUnavailable) {
      log(
        `Palm photo validation: model "${PALM_VALIDATION_MODEL_PRIMARY}" appears unavailable on this account — falling back to "${PALM_VALIDATION_MODEL_FALLBACK}"`
      );
      ({ res, data } = await callPalmValidation(imageDataUrl, PALM_VALIDATION_MODEL_FALLBACK));
      log(
        `Palm photo validation (model "${PALM_VALIDATION_MODEL_FALLBACK}") -> HTTP status:`,
        res.status,
        "response:",
        JSON.stringify(data)
      );
    }

    if (!res.ok) {
      return { valid: true, reason: "validation call failed (HTTP " + res.status + ") — defaulting to accept" };
    }

    const rawAnswer = (data.choices?.[0]?.message?.content || "").trim();
    const upper = rawAnswer.toUpperCase();
    if (!upper) {
      return { valid: true, reason: "empty validation response — defaulting to accept" };
    }

    // Smaller vision models don't always follow strict "reply with ONLY
    // one word" instructions — e.g. "Yes, this looks like a palm" or "The
    // image shows a hand, so yes" are both genuine affirmative answers that
    // don't literally START with "YES". Checking for YES/NO anywhere (as a
    // whole word) is far more robust than requiring an exact prefix match,
    // which was silently rejecting real palm photos whenever the model
    // phrased its answer even slightly differently than instructed.
    const saysYes = /\bYES\b/.test(upper);
    const saysNo = /\bNO\b/.test(upper);

    let valid;
    if (saysYes && !saysNo) {
      valid = true;
    } else if (saysNo && !saysYes) {
      valid = false;
    } else {
      // Both, neither, or genuinely unclear — fail open. Blocking a real
      // customer over an ambiguous validation answer is a worse outcome
      // than occasionally letting a borderline photo through.
      valid = true;
    }

    return { valid, reason: rawAnswer };
  } catch (err) {
    log("Palm photo validation crashed (caught):", err.message);
    return { valid: true, reason: "exception — defaulting to accept" };
  }
}

// After a customer already has their own report, do they want to start a
// NEW reading for a DIFFERENT person, in this SAME chat? Deliberately
// conservative: any ambiguity, error, or non-YES answer defaults to false,
// so a misclassification never accidentally resets someone's own session.
async function wantsAnotherPersonReading(text) {
  if (!OPENAI_API_KEY) return false;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: `The customer already received their own palm reading in this WhatsApp chat (and possibly a reading for one other person too, in the same chat). Does this NEW message clearly indicate they now want to START a NEW palm reading for a DIFFERENT person? Reply YES only if they are clearly asking to begin/order a new reading for someone else.

Reply NO if the message is instead:
- A question ABOUT an existing reading or reply (even if it mentions another person by name/relation) — e.g. "Ente karyamano wifeinte karyamano" ("is this about me or my wife?") is asking to CLARIFY which existing reading a reply refers to — that is NO, not a new-reading request.
- A general question, thanks, or comment.
- Ambiguous in any way.

Reply with ONLY one word: YES or NO.

Message: """${text}"""`,
          },
        ],
        max_completion_tokens: 5,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      log("wantsAnotherPersonReading check FAILED:", JSON.stringify(data));
      return false;
    }
    const answer = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    log("wantsAnotherPersonReading classification ->", answer);
    return answer.startsWith("YES");
  } catch (err) {
    log("wantsAnotherPersonReading crashed (caught):", err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Voice message support (transcription) — feeds into the SAME text pipeline
// as typed messages. Does not touch report generation in any way.
// ---------------------------------------------------------------------------

// Downloads a WhatsApp audio/voice message and returns the raw bytes +
// mime type (not a data URL — OpenAI's transcription endpoint needs a real
// file upload, not base64).
async function getAudioBuffer(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const meta = await metaRes.json();
    log("Voice media metadata lookup for", mediaId, "-> HTTP", metaRes.status, "response:", JSON.stringify(meta));

    if (!meta.url) {
      log("Voice media download ABORTED — no url in metadata response for mediaId:", mediaId);
      return null;
    }

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });

    if (!fileRes.ok) {
      log("Voice media file download FAILED — HTTP", fileRes.status, "for mediaId:", mediaId);
      return null;
    }

    const buffer = await fileRes.buffer();
    const mimeType = meta.mime_type || "audio/ogg";
    log("Voice message downloaded successfully. Size in bytes:", buffer.length, "mime_type:", mimeType);

    if (buffer.length === 0) {
      log("Voice media download WARNING — downloaded buffer is 0 bytes, treating as failure.");
      return null;
    }

    return { buffer, mimeType };
  } catch (err) {
    log("Failed to fetch voice media (caught):", err.message);
    return null;
  }
}

// Transcribes voice message bytes via OpenAI's Whisper endpoint. No
// "language" parameter is passed — Whisper auto-detects, so both Malayalam
// and English voice messages work without special-casing either.
async function transcribeVoiceMessage(buffer, mimeType) {
  if (!OPENAI_API_KEY) {
    log("OPENAI_API_KEY missing, cannot transcribe voice message");
    return null;
  }

  try {
    const extension = mimeType.includes("mp4")
      ? "mp4"
      : mimeType.includes("mpeg")
      ? "mp3"
      : mimeType.includes("wav")
      ? "wav"
      : "ogg"; // WhatsApp voice notes are typically audio/ogg (opus codec)

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), `voice.${extension}`);
    form.append("model", "whisper-1");

    log("Sending voice message to OpenAI for transcription (whisper-1). Size:", buffer.length, "bytes, mime:", mimeType);

    const res = await globalThis.fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { rawText };
    }

    log("OpenAI transcription HTTP status:", res.status);
    log("OpenAI transcription full response:", JSON.stringify(data));

    if (!res.ok || !data.text) {
      log("Voice transcription FAILED:", JSON.stringify(data));
      return null;
    }

    const transcript = data.text.trim();
    log("Voice transcription SUCCEEDED. Transcript:", transcript);
    return transcript || null;
  } catch (err) {
    log("Voice transcription call crashed (caught):", err.message);
    return null;
  }
}

const VOICE_TRANSCRIPTION_FAILED_MESSAGE =
  "ക്ഷമിക്കണം, നിങ്ങളുടെ ശബ്ദ സന്ദേശം മനസ്സിലാക്കാൻ കഴിഞ്ഞില്ല. ദയവായി വീണ്ടും ശബ്ദ സന്ദേശം അയക്കാമോ?";

// Handles an incoming voice message end-to-end: download -> transcribe ->
// hand off to the EXACT SAME handleTextMessage() used for typed text, so
// every downstream stage (detail collection, FAQs, follow-up Q&A, etc.)
// behaves identically regardless of whether the customer typed or spoke.
async function handleVoiceMessage(phone, mediaId, session) {
  log("Voice message received from", phone, "-> mediaId:", mediaId);

  const audio = await getAudioBuffer(mediaId);
  if (!audio) {
    await sendText(phone, VOICE_TRANSCRIPTION_FAILED_MESSAGE);
    return;
  }

  const transcript = await transcribeVoiceMessage(audio.buffer, audio.mimeType);
  if (!transcript) {
    await sendText(phone, VOICE_TRANSCRIPTION_FAILED_MESSAGE);
    return;
  }

  log("Voice message transcribed for", phone, "-> treating as text:", transcript);
  await handleTextMessage(phone, transcript, session);
}

// Detects short English-language decline/apology text, which is what the
// model outputs on the rare occasions it refuses instead of writing the
// Malayalam reading. A real report is 2000+ words of Malayalam script, so
// any short response matching these patterns is treated as a failure.
function isLikelyRefusal(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 400) return false;
  const refusalPatterns = /i'?m sorry|i can'?t assist|i cannot assist|i'?m unable to|as an ai|i can'?t help with that/i;
  if (refusalPatterns.test(trimmed)) return true;

  // A real report is 2000+ words of flowing Malayalam narrative. A short
  // Malayalam response commenting on the IMAGE itself — e.g. saying it
  // can't see a palm, or that what was sent looks like a payment
  // screenshot rather than a hand photo — is the model declining to write
  // a reading, not a reading. This was previously slipping through
  // uncaught (the English-only regex above missed it entirely) and being
  // sent to the customer as if it were their paid report.
  const malayalamRefusalPatterns =
    /കൈരേഖ.{0,20}(കാണാൻ കഴിയു|വ്യക്തമല്ല|ഇല്ല)|സ്ക്രീൻഷോട്ട്|കൈപ്പത്തി.{0,20}(കാണാൻ കഴിയു|അല്ല)|ചിത്രം.{0,20}(അല്ല|വ്യക്തമല്ല)|വീണ്ടും അയച്ചുതരാമോ|അപ്ലോഡ് ചെയ്യുക/;
  if (malayalamRefusalPatterns.test(trimmed)) return true;

  return false;
}

// Dedicated OpenAI call for report generation, logging the full request
// payload (image truncated) and full raw response.
async function callOpenAIForReport(messages, maxTokens, model) {
  if (!OPENAI_API_KEY) {
    log("OPENAI_API_KEY missing, cannot generate report");
    return { ok: false, status: null, data: null, content: null };
  }

  const requestBody = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: maxTokens,
  };

  const loggableMessages = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === "image_url"
          ? { type: "image_url", image_url: { url: (part.image_url?.url || "").slice(0, 100) + "...[truncated]" } }
          : part
      ),
    };
  });
  log(`OpenAI report request payload for model "${model}" (image truncated):`, JSON.stringify({ ...requestBody, messages: loggableMessages }));

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const data = await res.json();

    log(`OpenAI report response HTTP status (model "${model}"):`, res.status);
    log(`OpenAI report full response (model "${model}"):`, JSON.stringify(data));

    if (!res.ok) {
      log(`OpenAI report generation FAILED (model "${model}"):`, JSON.stringify(data));
      return { ok: false, status: res.status, data, content: null };
    }
    return { ok: true, status: res.status, data, content: data.choices?.[0]?.message?.content || null };
  } catch (err) {
    log(`OpenAI report call crashed (caught) (model "${model}"):`, err.message);
    return { ok: false, status: null, data: null, content: null, networkError: err.message };
  }
}

async function generateReport(session) {
  const { name, dob, gender, palmMediaId, relation } = session;

  let imageDataUrl = null;
  if (palmMediaId) {
    imageDataUrl = await getMediaBase64(palmMediaId);
  } else {
    log("generateReport: session has no palmMediaId at all — no photo was ever stored.");
  }

  const imageAvailable = Boolean(imageDataUrl);
  log("generateReport: imageAvailable =", imageAvailable);

  const relationLine = relation
    ? `\n\n(Context for you only, not to be stated as a fact in the reading: the customer described this person as their ${relation}. You may let this inform tone/warmth naturally if relevant, but do not fabricate anything about the relationship that wasn't stated.)`
    : "";

  const systemPrompt = `You are an experienced traditional Malayalam palmist (കൈരേഖാ വിശാരദൻ) with many years of practice, writing a formal, authoritative personal palm reading entirely in Malayalam script, minimum 2000 words.

ADDRESSING THE CUSTOMER:
- Never use casual/familiar terms like ചേട്ടാ, ചേച്ചി, മോനെ, മോളെ, or similar.
- You may address the customer by name once, near the beginning (e.g. "ശിവ്ലിൻ,\n\nനിങ്ങളുടെ കൈയിലെ പ്രധാന രേഖകൾ സൂക്ഷ്മമായി പരിശോധിക്കുമ്പോൾ...") — after that, avoid repeatedly addressing them directly. Write as a respected, experienced traditional palmist speaking with quiet authority, not as a casual younger conversational voice.

TONE AND CONFIDENCE:
- Avoid hedging phrases: എനിക്ക് തോന്നുന്നു, ഒരുപക്ഷേ, ആയിരിക്കാം, ചിലപ്പോൾ.
- Prefer grounded, authoritative interpretive phrases such as: "ഈ രേഖകൾ സൂചിപ്പിക്കുന്നത്...", "വ്യക്തമായി കാണപ്പെടുന്നത്...", "രേഖകളുടെ ഘടന വ്യക്തമാക്കുന്നത്...", "ഈ കൈരേഖയിൽ നിന്ന് മനസ്സിലാകുന്നത്...", "വിലയിരുത്തുമ്പോൾ കാണുന്നത്...".
- The confidence should come from the interpretation of the palm itself — describe tendencies and possibilities (സാധ്യതകൾ) firmly, without making absolute guarantees about specific outcomes.

VARIETY AND DIRECTNESS:
- Do not repeatedly start sentences with നിങ്ങളുടെ ജീവിതത്തിൽ..., നിങ്ങളുടെ കൈയിൽ..., or നിങ്ങളുടെ രേഖകൾ.... Vary sentence openings and structure naturally throughout.
- Do not explain what a palm line means in general (no palmistry-theory or textbook-style explanations). Go straight to interpreting THIS customer's palm. For example, instead of "ഹൃദയരേഖ സ്നേഹത്തെയും വികാരങ്ങളെയും സൂചിപ്പിക്കുന്നു," write something like "ഹൃദയരേഖയുടെ വ്യക്തതയും ആഴവും നോക്കുമ്പോൾ ബന്ധങ്ങളിൽ ആത്മാർത്ഥതയും സ്ഥിരതയും ആഗ്രഹിക്കുന്ന വ്യക്തിത്വമാണ് കാണുന്നത്." Customers are paying for interpretation, not a palmistry lesson.

GROUNDING IN THE ACTUAL PALM:
- Where a palm image is available, naturally weave in specific visible observations — only ones actually visible in the image — such as ജീവരേഖയുടെ ആഴം, ശിരോരേഖയുടെ ദിശ, ഹൃദയരേഖയുടെ ഘടന, ഭാഗ്യരേഖയുടെ വ്യക്തത, ശുക്രപർവതം, ഗുരുപർവതം, സൂര്യപർവതം, അംഗുഷ്ഠത്തിന്റെ ഘടന, വിരലുകളുടെ അനുപാതം. Do not invent features that are not visible.

LANGUAGE:
- Write consistently in Malayalam. Avoid unnecessary English terms like Heart Line, Head Line, Life Line, Marriage Line, Fate Line, flexibility, adaptability, decision-making — use ഹൃദയരേഖ, ശിരോരേഖ, ജീവരേഖ, വിവാഹരേഖ, ഭാഗ്യരേഖ, തീരുമാനശേഷി, സാഹചര്യങ്ങളോട് പൊരുത്തപ്പെടുന്ന സ്വഭാവം instead. English may appear in brackets only if truly necessary for clarity.

CONTENT (weave naturally into a flowing narrative, never as labeled headings or a checklist):
സ്വഭാവവും വ്യക്തിത്വവും, സ്നേഹവും ബന്ധങ്ങളും, വിവാഹവും കുടുംബജീവിതവും, ജോലി/കരിയർ/ബിസിനസ്, സാമ്പത്തിക കാര്യങ്ങൾ, ആരോഗ്യം, വിദേശ അവസരങ്ങൾ, വീട്/സ്വത്ത്, ആത്മീയ വളർച്ച, അടുത്ത 2-5 വർഷത്തെ ഭാവി സാധ്യതകളും വെല്ലുവിളികളും, കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ. Expand meaningfully on future possibilities across these areas rather than listing them briefly.

CONCLUSION:
End with a strong, premium, confident, and inspiring closing passage that ties together the overall reading and future outlook — not a generic sign-off.

Do not include any disclaimers. Do not say you are unable to see or analyze an image. Never use the words: fun, entertainment, AI, OpenAI, bot, automation, model, system (in English or Malayalam equivalents). Minimum 2000 words.`;

  const instructionText = imageAvailable
    ? `Customer details:\nപേര്: ${name}\nജനനത്തീയതി: ${dob}\nലിംഗം: ${
        gender === "female" ? "സ്ത്രീ" : "പുരുഷൻ"
      }\n\nThe customer's palm image is attached. Use it together with the details above to write the full reading, referencing specific palm lines and signs naturally.${relationLine}`
    : `Customer details:\nപേര്: ${name}\nജനനത്തീയതി: ${dob}\nലിംഗം: ${
        gender === "female" ? "സ്ത്രീ" : "പുരുഷൻ"
      }\n\nWrite the full palmistry reading based on these details. Describe palm lines and signs naturally as part of the reading, without mentioning that no image was provided.${relationLine}`;

  const userContent = [{ type: "text", text: instructionText }];
  if (imageAvailable) {
    userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const REPORT_MODEL_PRIMARY = "gpt-4.1";
  const REPORT_MODEL_FALLBACK = "gpt-4o";

  let result = await callOpenAIForReport(messages, 7000, REPORT_MODEL_PRIMARY);

  // Only fall back if the PRIMARY model itself is unavailable on this
  // account (invalid/unknown model error) — not for refusals or other
  // content-based failures, which should surface normally either way.
  const modelUnavailable =
    !result.ok &&
    result.data?.error &&
    /model/i.test(result.data.error.code || "") &&
    /not found|does not exist|invalid|unknown/i.test(result.data.error.message || result.data.error.code || "");

  if (modelUnavailable) {
    log(
      `Model "${REPORT_MODEL_PRIMARY}" appears unavailable on this account (error: ${JSON.stringify(
        result.data.error
      )}) — falling back to "${REPORT_MODEL_FALLBACK}"`
    );
    result = await callOpenAIForReport(messages, 7000, REPORT_MODEL_FALLBACK);
  }

  let report = result.content;

  if (report && isLikelyRefusal(report)) {
    log("generateReport: model output looks like a refusal, not a report. Treating as failure. Content was:", report);
    report = null;
  }

  if (report) {
    // response.model reflects the exact model OpenAI actually used (may be
    // a specific dated snapshot, e.g. "gpt-4.1-2025-04-14") — this is more
    // reliable than the model string we requested, and also tells us
    // definitively whether the primary or fallback model produced this
    // particular report.
    console.log("REPORT GENERATED USING:", result.data?.model);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Report delivery — generation + DB bookkeeping, shared by the poller and
// by manual "check status" retries. No setTimeout anywhere in this flow.
// ---------------------------------------------------------------------------

const MAX_REPORT_ATTEMPTS = 5;
const REPORT_RETRY_INTERVAL_MS = 3 * 60 * 1000; // how far to push report_due_at forward on failure

async function generateAndDeliverReport(session) {
  const phone = session.phone;
  const attemptNumber = (session.reportAttempts || 0) + 1;
  log(`generateAndDeliverReport: attempt ${attemptNumber}/${MAX_REPORT_ATTEMPTS} for`, phone);

  let report = null;
  try {
    report = await generateReport(session);
  } catch (err) {
    log("generateAndDeliverReport crashed (caught):", err.message);
  }

  if (report) {
    await db.updateSession(phone, {
      reportText: report,
      reportStatus: "sent",
      stage: "report_sent",
      reportError: null,
      reportAttempts: attemptNumber,
    });
    await sendLongText(phone, report);
    log(`Report sent to ${phone} on attempt ${attemptNumber}`);
    return { success: true, attemptNumber };
  }

  const exhausted = attemptNumber >= MAX_REPORT_ATTEMPTS;
  await db.updateSession(phone, {
    reportStatus: exhausted ? "failed" : "pending",
    reportAttempts: attemptNumber,
    reportDueAt: exhausted ? null : new Date(Date.now() + REPORT_RETRY_INTERVAL_MS),
    reportError: `Attempt ${attemptNumber} failed to produce a valid report`,
  });
  log(
    `Report generation FAILED for ${phone} on attempt ${attemptNumber}` +
      (exhausted ? " — max attempts exhausted, marked failed." : " — will retry via poller.")
  );
  return { success: false, attemptNumber, exhausted };
}

// ---------------------------------------------------------------------------
// Core message handling
// ---------------------------------------------------------------------------

function applyExtractedPatch(session, extracted) {
  const patch = {};
  if (extracted.name && !session.name) patch.name = extracted.name;
  if (extracted.dob && !session.dob) patch.dob = extracted.dob;
  if (extracted.gender && !session.gender) patch.gender = extracted.gender;
  if (extracted.relation && !session.relation) patch.relation = extracted.relation;
  return patch;
}

async function progressCollectingStage(phone, session) {
  const missingFields = [];
  if (!session.name) missingFields.push("പേര്");
  if (!session.dob) missingFields.push("ജനനത്തീയതി");
  if (!session.gender) missingFields.push("Gender (ലിംഗം)");

  if (missingFields.length > 0) {
    // Only ask for what's actually still missing — previously this always
    // sent the full "please send name/DOB/gender" message even when some
    // fields (e.g. name and gender) had already been provided.
    const message =
      missingFields.length === 3
        ? ASK_ALL_DETAILS_MESSAGE
        : `നന്ദി! ദയവായി ${missingFields.join(", ")} കൂടി അയച്ചുതരാമോ?`;
    await sendText(phone, message);
    return session;
  }

  if (session.palmMediaId) {
    // A photo was already sent earlier (before all details were known) and
    // stashed — don't ask for it again, just process it now.
    log("progressCollectingStage: details complete AND a photo was already stashed for", phone, "— processing it now instead of re-asking.");
    const updated = await db.updateSession(phone, { stage: "awaiting_photo" });
    await sendText(phone, `നന്ദി ${updated.name}.`);
    await processReceivedPalmPhoto(phone, session.palmMediaId, updated);
    return updated;
  }

  const updated = await db.updateSession(phone, { stage: "awaiting_photo" });
  await sendText(phone, handRequestMessage(updated.name, updated.gender));
  return updated;
}

// Shared by all three ways a customer can confirm payment: screenshot image,
// PDF receipt, or (if they can't send either) typing a transaction ID.
// Real scheduling stays 10-15 min regardless of source — unaffected by the
// per-message send delay, which is a separate concern.
async function confirmPaymentAndScheduleReport(phone, session, sourceLabel) {
  const dueAt = new Date(Date.now() + (10 + Math.random() * 5) * 60 * 1000);
  await db.updateSession(phone, {
    paymentReceived: true,
    stage: "awaiting_report",
    reportStatus: "pending",
    reportDueAt: dueAt,
    reportAttempts: 0,
    reportError: null,
    awaitingTransactionId: false,
  });
  log(`Payment confirmed via ${sourceLabel} for`, phone, "— report scheduled (via DB, no setTimeout), due at", dueAt.toISOString());
  await sendText(phone, paymentReceivedMessage(session.name || "", (session.orderCount || 1) > 1));
}

// Hidden testing command — wipes a phone number's session back to a fresh
// state so the same test number(s) can be reused indefinitely instead of
// needing a new number for every test run. Not documented to customers;
// deliberately an uncommon phrase so it's never triggered by accident.
const RESET_COMMAND = "resetmybot123";

async function handleTextMessage(phone, text, session) {
  if (text.trim().toLowerCase() === RESET_COMMAND) {
    await db.updateSession(phone, {
      stage: "new",
      name: null,
      dob: null,
      gender: null,
      palmMediaId: null,
      paymentReceived: false,
      reportText: null,
      reportStatus: "none",
      reportDueAt: null,
      reportAttempts: 0,
      reportError: null,
    });
    log("Session RESET for", phone, "via hidden test command");
    await sendText(phone, "സെഷൻ റീസെറ്റ് ചെയ്തു. വീണ്ടും തുടങ്ങാൻ 'Hi' എന്ന് അയക്കൂ.");
    return;
  }

  log(
    "Current session state for",
    phone,
    "->",
    JSON.stringify({ stage: session.stage, name: session.name, dob: session.dob, gender: session.gender })
  );

  if (session.stage === "new") {
    session = await db.updateSession(phone, { stage: "collecting" });
    await sendText(phone, WELCOME_MESSAGE);

    const extracted = await extractFields(text, session);
    const patch = applyExtractedPatch(session, extracted);
    if (Object.keys(patch).length) session = await db.updateSession(phone, patch);
    await progressCollectingStage(phone, session);
    return;
  }

  if (session.stage === "collecting") {
    const faqAnswer = matchFaq(text);
    if (faqAnswer) await sendText(phone, faqAnswer);

    const extracted = await extractFields(text, session);
    const patch = applyExtractedPatch(session, extracted);
    if (Object.keys(patch).length) session = await db.updateSession(phone, patch);

    // If nothing new was extracted and no fixed FAQ matched, this is likely
    // a genuine question or hesitation (trust concerns, "will this work",
    // etc.) — repeating the exact same "please send your details" prompt
    // ignores what they actually asked. Give a real, brief, reassuring
    // reply instead, then still end with the details request.
    if (!faqAnswer && Object.keys(patch).length === 0) {
      const preReply = await openaiChat(
        [
          {
            role: "system",
            content: `You are the same experienced traditional Malayalam palmist. The customer has not yet given their name, date of birth, and gender to start their ₹99 palm reading, and just sent a message that isn't providing those details — it may be a trust concern ("is this genuine", "will it actually work"), a question, or hesitation. Answer briefly in Malayalam (2-3 sentences). Never use casual/familiar address terms like ചേട്ടാ, ചേച്ചി, മോനെ, മോളെ.
If it's a trust concern specifically, be concrete and honest, not vague: say directly that the reading is done from their own actual palm photo (not a generic template answer), and that the ₹99 fee makes it low-risk to simply try. Do NOT just describe what palmistry generally covers (personality, career, family, etc.) as if that were an answer to a trust question — that doesn't actually address "is this real/legit" and reads as empty filler before the payment ask.
End by asking them to share their പേര് (name), ജനനത്തീയതി (date of birth), and ലിംഗം (gender) together to continue.`,
          },
          { role: "user", content: text },
        ],
        { model: "gpt-5.5", temperature: 0.7, max_tokens: 800 }
      );

      if (preReply) {
        await sendText(phone, preReply);
        return;
      }
      // If the GPT call itself failed, fall through to the normal prompt below.
    }

    await progressCollectingStage(phone, session);
    return;
  }

  if (session.stage === "awaiting_photo") {
    const faqAnswer = matchFaq(text);
    if (faqAnswer) await sendText(phone, faqAnswer);

    if (session.palmMediaId) {
      // Photo was already received but QR sending failed earlier — retry now.
      const qrSent = await sendImageByUrl(phone, QR_IMAGE_URL, "");
      if (qrSent) {
        await db.updateSession(phone, { stage: "awaiting_payment" });
        await sendText(phone, PHOTO_RECEIVED_PAYMENT_MESSAGE);
      } else {
        await sendText(phone, QR_FAILURE_MESSAGE);
      }
      return;
    }

    await sendText(
      phone,
      `ദയവായി നിങ്ങളുടെ ${session.gender === "female" ? "ഇടത്" : "വലത്"} കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?`
    );
    return;
  }

  if (session.stage === "awaiting_payment") {
    if (session.awaitingTransactionId) {
      // We already asked for a transaction ID after they said they couldn't
      // send a screenshot — accept whatever they send now, unverified, and
      // proceed exactly as if a payment screenshot had arrived.
      log("Transaction ID received (unverified) for", phone, "-> treating as payment confirmation. Text was:", text);
      await confirmPaymentAndScheduleReport(phone, session, "transaction ID text");
      return;
    }

    if (cannotSendScreenshotIntent(text)) {
      await db.updateSession(phone, { awaitingTransactionId: true });
      await sendText(
        phone,
        "സ്ക്രീൻഷോട്ട് അയക്കാൻ കഴിയുന്നില്ലെങ്കിൽ കുഴപ്പമില്ല. Payment ചെയ്ത transaction ID ഇവിടെ ടൈപ്പ് ചെയ്ത് അയച്ചാൽ മതി."
      );
      return;
    }

    const faqAnswer = matchFaq(text);
    if (faqAnswer) {
      await sendText(phone, faqAnswer);
      return;
    }

    // Previously: any message that didn't match the small fixed FAQ list
    // (price/duration/what-you-get) got the exact same generic reminder,
    // even for genuinely different questions (trust concerns, "explain
    // first", etc.) — repetitive and unhelpful right before asking someone
    // to pay. Now: give a real, brief, reassuring answer, still ending
    // with the payment reminder.
    const preReply = await openaiChat(
      [
        {
          role: "system",
          content: `You are the same experienced traditional Malayalam palmist, speaking with a customer who is about to pay ₹99 for their palm reading but has a question or hesitation before paying. Answer briefly in Malayalam (2-4 sentences) — this could be a trust concern ("how do I know this is legit"), a request to explain the process again, or anything else. Never use casual/familiar address terms like ചേട്ടാ, ചേച്ചി, മോനെ, മോളെ.
If it's a trust concern specifically, be concrete and honest, not vague: say directly that the reading is done from their own actual palm photo they already sent (not a generic template answer), and that the ₹99 fee makes it low-risk to simply try. Do NOT just describe what palmistry generally covers (personality, career, family, etc.) as if that were an answer to a trust question — that doesn't actually address "is this real/legit" and reads as empty filler before the payment ask.
After your answer, end with a gentle reminder that once they complete the ₹99 payment using the QR code above, they should send the payment screenshot here to receive their reading.`,
        },
        { role: "user", content: text },
      ],
      { model: "gpt-5.5", temperature: 0.7, max_tokens: 800 }
    );

    if (preReply) {
      await sendText(phone, preReply);
    } else {
      await sendText(phone, "Payment ചെയ്തതിന് ശേഷം screenshot ഇവിടെ അയച്ചാൽ മതി.");
    }
    return;
  }

  if (session.stage === "awaiting_report") {
    // Track how many times this customer has messaged while still waiting.
    // After several inquiries with no report yet, proactively offer the
    // support email rather than waiting for them to ask for it.
    const inquiryCount = (session.awaitingReportInquiryCount || 0) + 1;
    await db.updateSession(phone, { awaitingReportInquiryCount: inquiryCount });
    const offerSupport = inquiryCount >= SUPPORT_EMAIL_INQUIRY_THRESHOLD;
    const withSupport = (msg) =>
      offerSupport ? `${msg}\n\nകൂടുതൽ സഹായത്തിന് ${SUPPORT_EMAIL} എന്ന ഇമെയിലിൽ ഞങ്ങളെ ബന്ധപ്പെടാം.` : msg;

    if (!isReportStatusQuery(text)) {
      await sendText(phone, withSupport(REPORT_STILL_PENDING_MESSAGE));
      return;
    }

    // Re-fetch fresh from DB — the poller may have updated this in the background.
    const fresh = await db.getOrCreateSession(phone);

    if (fresh.reportStatus === "sent" && fresh.reportText) {
      // Self-heal an edge case where stage didn't get updated in sync.
      await db.updateSession(phone, { stage: "report_sent", awaitingReportInquiryCount: 0 });
      await sendLongText(phone, fresh.reportText);
      return;
    }

    if (fresh.reportStatus === "failed") {
      await sendText(phone, REPORT_RETRYING_MESSAGE);
      const resetSession = await db.updateSession(phone, { reportAttempts: 0, reportStatus: "pending" });
      const result = await generateAndDeliverReport(resetSession);
      if (!result.success) {
        await sendText(phone, withSupport(result.exhausted ? REPORT_EXHAUSTED_MESSAGE : REPORT_STILL_PENDING_MESSAGE));
      } else {
        await db.updateSession(phone, { awaitingReportInquiryCount: 0 });
      }
      return;
    }

    // status === 'pending'
    await sendText(phone, withSupport(REPORT_STILL_PENDING_MESSAGE));
    return;
  }

  if (session.stage === "report_sent") {
    const wantsAnother = await wantsAnotherPersonReading(text);
    if (wantsAnother) {
      log(
        "Customer at",
        phone,
        "wants a reading for another person — restarting collection flow in the same chat (order #",
        (session.orderCount || 1) + 1,
        ")"
      );
      await db.updateSession(phone, {
        stage: "collecting",
        name: null,
        dob: null,
        gender: null,
        relation: null,
        palmMediaId: null,
        paymentReceived: false,
        reportText: null,
        reportStatus: "none",
        reportDueAt: null,
        reportAttempts: 0,
        reportError: null,
        orderCount: (session.orderCount || 1) + 1,
      });
      await sendText(phone, ASK_SECOND_PERSON_DETAILS_MESSAGE);
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10); // e.g. "2026-07-03"
    const currentYear = new Date().getFullYear();

    const followUpMessages = [
      {
        role: "system",
        content: `You are the same experienced traditional Malayalam palmist continuing a conversation with a customer, after having given them a palm reading earlier. Respond naturally and briefly in Malayalam.
Never use casual/familiar address terms like ചേട്ടാ, ചേച്ചി, മോനെ, മോളെ, or similar — do not address the customer directly by any such term. Speak with the same quiet, authoritative confidence as the original reading (avoid hedging words like എനിക്ക് തോന്നുന്നു, ഒരുപക്ഷേ, ആയിരിക്കാം, ചിലപ്പോൾ). Use correct, natural Malayalam word choices throughout.

Today's actual date is ${todayStr} (year ${currentYear}). If the customer asks about future timing (which year, when, how soon, etc.), any year or timeframe you mention MUST be ${currentYear} or later — never state a year that has already passed as if it were a future prediction. If asked generally "when," prefer a relative timeframe (അടുത്ത കുറച്ച് മാസങ്ങൾ, അടുത്ത വർഷം, അടുത്ത 1-2 വർഷത്തിനുള്ളിൽ) over naming a specific year unless you are confident it is genuinely in the future.

Customers write casually and in Manglish (Malayalam typed in English letters). Read past literal wording to their actual intent before answering:
- If they're asking a question about THEIR OWN earlier reading, answer using the reading context below.
- If they're asking about price for an additional or repeat reading, the fee is ₹99 per person, same as before.
- If it's a greeting, thanks, or general conversation unrelated to the reading, respond warmly and briefly in the same authoritative but personal voice, without forcing it back to palm topics.
${
  (session.orderCount || 1) > 1
    ? `\nIMPORTANT: this customer has ordered more than one reading in this chat (this is order #${
        session.orderCount
      }, most recently for ${
        session.name || "the person below"
      }). The reading below belongs to that most recent order specifically. If the customer's message is at all ambiguous about WHICH person's reading you're discussing (e.g. "is this about me or about my wife?"), explicitly clarify by naming whose reading this is before answering — do not answer generically as if there's only one reading in this chat.`
    : ""
}

Earlier reading:\n${session.reportText || ""}`,
      },
      { role: "user", content: text },
    ];

    // gpt-4o-mini was producing instruction slips (still using banned
    // address terms) and outright wrong word choices in this specific
    // conversational path. gpt-5.5 is the current available flagship;
    // falls back to gpt-4o-mini only if gpt-5.5 is inaccessible on this
    // account for any reason. Main report generation (gpt-4.1/gpt-4o) is
    // untouched by this change.
    let followUp = await openaiChat(followUpMessages, {
      model: "gpt-5.5",
      temperature: 0.7,
      max_tokens: 800,
    });

    if (!followUp) {
      log("Follow-up Q&A: gpt-5.5 call failed or returned nothing — falling back to gpt-4o-mini.");
      followUp = await openaiChat(followUpMessages, {
        model: "gpt-4o-mini",
        temperature: 0.7,
        max_tokens: 500,
      });
    }

    if (followUp) {
      await sendText(phone, followUp);
    } else {
      await sendText(phone, "ക്ഷമിക്കണം, ഒരു നിമിഷം ശ്രമിക്കാമോ? ചെറിയൊരു തടസ്സം ഉണ്ടായി.");
    }
    return;
  }
}

const NOT_A_PALM_MESSAGE_TEMPLATE = (gender) =>
  `ക്ഷമിക്കണം, അയച്ച ഫോട്ടോയിൽ കൈരേഖ വ്യക്തമായി കാണാൻ കഴിയുന്നില്ല. ദയവായി നിങ്ങളുടെ ${
    gender === "female" ? "ഇടത്" : "വലത്"
  } കൈയുടെ താളത്തിൽ നിന്ന്, നല്ല വെളിച്ചത്തിൽ എടുത്ത വ്യക്തമായ ഒരു ഫോട്ടോ വീണ്ടും അയച്ചുതരാമോ?`;

const PHOTO_REPLACED_MESSAGE =
  "പുതിയ ഫോട്ടോ ലഭിച്ചു, നന്ദി. ഇത് ഉപയോഗിച്ച് നിങ്ങളുടെ കൈരേഖാ വിശകലനം വീണ്ടും തയ്യാറാക്കുന്നു. കുറച്ച് സമയത്തിനുള്ളിൽ ഇവിടെ ലഭിക്കും.";

// Validates a palm photo and either sends the QR (moving to
// awaiting_payment) or asks for a proper resend (staying in awaiting_photo).
// Shared between the normal awaiting_photo flow and the case where a photo
// arrives BEFORE name/DOB/gender are known (see handleImageMessage and
// progressCollectingStage) — previously that second case silently
// discarded the photo entirely.
async function processReceivedPalmPhoto(phone, mediaId, session) {
  const imageDataUrl = await getMediaBase64(mediaId);
  const validation = await isPalmPhoto(imageDataUrl);
  log("Palm photo validation result for", phone, "->", JSON.stringify(validation));

  if (!validation.valid) {
    await db.updateSession(phone, { stage: "awaiting_photo", palmMediaId: null });
    await sendText(phone, NOT_A_PALM_MESSAGE_TEMPLATE(session.gender));
    return;
  }

  await db.updateSession(phone, { palmMediaId: mediaId, stage: "awaiting_photo" });

  const qrSent = await sendImageByUrl(phone, QR_IMAGE_URL, "");
  if (!qrSent) {
    log("QR image failed to send to", phone, "— NOT sending payment message. Staying in awaiting_photo for retry.");
    await sendText(phone, QR_FAILURE_MESSAGE);
    return;
  }

  await db.updateSession(phone, { stage: "awaiting_payment" });
  await sendText(phone, PHOTO_RECEIVED_PAYMENT_MESSAGE);
}

async function handleImageMessage(phone, mediaId, session) {
  log("Current session state for", phone, "->", JSON.stringify({ stage: session.stage }));

  if (session.stage === "awaiting_photo") {
    await processReceivedPalmPhoto(phone, mediaId, session);
    return;
  }

  if (session.stage === "awaiting_payment") {
    log("Payment screenshot received from", phone);
    await confirmPaymentAndScheduleReport(phone, session, "screenshot image");
    return;
  }

  if (session.stage === "awaiting_report") {
    // Previously: any photo sent here fell through to a generic "photo
    // received, thanks" with NO session update at all — so if the report
    // failed because the original photo wasn't a valid palm, a corrected
    // photo sent afterward was silently ignored forever, and every retry
    // kept re-using the original bad photo. Now: treat this as a genuine
    // replacement and actually reschedule using the new photo.
    log("New photo received while awaiting_report for", phone, "— treating as a corrected palm photo submission.");
    const retryDueAt = new Date(Date.now() + 2 * 60 * 1000);
    await db.updateSession(phone, {
      palmMediaId: mediaId,
      reportStatus: "pending",
      reportAttempts: 0,
      reportDueAt: retryDueAt,
      reportError: null,
    });
    await sendText(phone, PHOTO_REPLACED_MESSAGE);
    return;
  }

  if (session.stage === "report_sent") {
    // Previously: any photo sent here fell through to the generic
    // catch-all ("photo received, thanks") with no session change at all —
    // the photo was never stored or used anywhere. Any follow-up text
    // about it (e.g. "this is someone else's hand, take a look") then hit
    // the post-report Q&A model, which only has the ORIGINAL report text
    // to work from and no access to the new image — so it could only
    // produce generic filler asking the customer to "send a clear photo,"
    // on repeat, even though a clear photo had already been sent (often
    // more than once). A customer sending a new hand photo after already
    // receiving their own reading is, in practice, reliably a request to
    // start a reading for a DIFFERENT person — so treat it as exactly
    // that: start the second-person flow immediately and stash the photo,
    // the same way an early photo is stashed during collecting/new.
    log(
      "Photo received while in report_sent for",
      phone,
      "— treating as a request for a new reading for a different person (order #",
      (session.orderCount || 1) + 1,
      ") and stashing the photo instead of discarding it."
    );
    await db.updateSession(phone, {
      stage: "collecting",
      name: null,
      dob: null,
      gender: null,
      relation: null,
      palmMediaId: mediaId,
      paymentReceived: false,
      reportText: null,
      reportStatus: "none",
      reportDueAt: null,
      reportAttempts: 0,
      reportError: null,
      orderCount: (session.orderCount || 1) + 1,
    });
    await sendText(
      phone,
      "ഫോട്ടോ ലഭിച്ചു, നന്ദി! അത് സൂക്ഷിച്ചു വച്ചിട്ടുണ്ട്.\n\n" + ASK_SECOND_PERSON_DETAILS_MESSAGE
    );
    return;
  }

  if (session.stage === "new" || session.stage === "collecting") {
    // Previously: a photo sent before name/DOB/gender were known was
    // completely discarded — not saved anywhere — and the customer would
    // later be asked for "a photo" again during awaiting_photo as if it
    // had never been sent. Now: stash it, and acknowledge that it's saved.
    log("Photo received early (stage", session.stage, ") for", phone, "— stashing mediaId for later, not discarding.");

    if (session.stage === "new") {
      // This is genuinely the customer's first-ever contact — send the
      // "Hi" welcome/service intro FIRST, before anything else, exactly
      // as if their first message had been text instead of a photo.
      await sendText(phone, WELCOME_MESSAGE);
      await db.updateSession(phone, { stage: "collecting" });
    }

    await db.updateSession(phone, { palmMediaId: mediaId });
    await sendText(
      phone,
      "ഫോട്ടോ ലഭിച്ചു, നന്ദി! അത് സൂക്ഷിച്ചു വച്ചിട്ടുണ്ട്.\n\n" + ASK_ALL_DETAILS_MESSAGE
    );
    return;
  }

  await sendText(phone, "ഫോട്ടോ ലഭിച്ചു, നന്ദി.");
}


// ---------------------------------------------------------------------------
// Polling worker — replaces setTimeout for report delivery. Runs every 60s,
// finds sessions whose report is due, generates + sends. Survives restarts
// because it's driven entirely by DB state (report_status + report_due_at).
// ---------------------------------------------------------------------------

let pollInProgress = false;

async function pollDueReports() {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const dueSessions = await db.findDueReports();
    if (dueSessions.length) {
      log(`Poller: found ${dueSessions.length} due report(s)`);
    }
    for (const session of dueSessions) {
      const result = await generateAndDeliverReport(session);
      if (!result.success) {
        if (result.attemptNumber === 1) {
          await sendText(session.phone, REPORT_PREPARING_MESSAGE);
        }
        if (result.exhausted) {
          await sendText(session.phone, REPORT_EXHAUSTED_MESSAGE);
        }
      }
    }
  } catch (err) {
    log("Poller crashed (caught):", err.message);
  } finally {
    pollInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Webhook routes
// ---------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).send("Palmistry WhatsApp bot is running");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Admin/testing endpoint — resets a phone number's session by visiting a
// URL, no need to send a WhatsApp message from that number. Protected by
// the same secret as the hidden in-chat reset command (see RESET_COMMAND).
// Usage: GET /admin/reset-session?phone=917736236010&key=resetmybot123
app.get("/admin/reset-session", async (req, res) => {
  const { phone, key } = req.query;

  if (key !== RESET_COMMAND) {
    return res.status(403).send("Forbidden — missing or wrong key.");
  }
  if (!phone) {
    return res.status(400).send('Missing ?phone= (e.g. ?phone=917736236010&key=...)');
  }

  try {
    await db.updateSession(phone, {
      stage: "new",
      name: null,
      dob: null,
      gender: null,
      palmMediaId: null,
      paymentReceived: false,
      reportText: null,
      reportStatus: "none",
      reportDueAt: null,
      reportAttempts: 0,
      reportError: null,
    });
    log("Session RESET for", phone, "via admin HTTP endpoint");
    res.status(200).send(`Session reset for ${phone}. Send "Hi" from that number on WhatsApp to start fresh.`);
  } catch (err) {
    log("Admin reset failed (caught):", err.message);
    res.status(500).send("Reset failed: " + err.message);
  }
});

app.post("/webhook", (req, res) => {
  res.sendStatus(200); // Ack immediately so Meta doesn't retry/timeout

  processWebhookBody(req.body).catch((err) => log("Webhook handler crashed (caught):", err.message));
});

async function processWebhookBody(body) {
  log("Webhook received");
  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  const statuses = value?.statuses;
  if (statuses?.length) {
    console.log("STATUS WEBHOOK:", JSON.stringify(statuses, null, 2));
    for (const status of statuses) {
      log("Status update -> id:", status.id);
      log("Status update -> status:", status.status);
      log("Status update -> timestamp:", status.timestamp);
      log("Status update -> recipient_id:", status.recipient_id);
      log("Status update -> full payload:", JSON.stringify(status));

      if (status.status === "failed") {
        log("Status update -> FAILURE ERROR DETAILS:", JSON.stringify(status.errors));
      }

      const trackedQrId = qrMessageIdsByPhone.get(status.recipient_id);
      if (trackedQrId && trackedQrId === status.id) {
        log("*** This status update matches the tracked QR image message id for", status.recipient_id, "-> status:", status.status);
      }
    }
    return;
  }

  const message = value?.messages?.[0];
  if (!message) return;

  if (isDuplicate(message.id)) {
    log("Duplicate message ignored:", message.id);
    return;
  }
  markProcessed(message.id);

  const phone = message.from;
  const session = await db.getOrCreateSession(phone);

  log("Message type:", message.type, "from", phone);

  if (message.type === "text") {
    const text = message.text?.body || "";
    await handleTextMessage(phone, text, session);
  } else if (message.type === "audio") {
    // Voice messages/voice notes — transcribed and then handled exactly
    // like a normal text message (see handleVoiceMessage above).
    const mediaId = message.audio?.id;
    await handleVoiceMessage(phone, mediaId, session);
  } else if (
    message.type === "image" ||
    (message.type === "document" && message.document?.mime_type?.startsWith("image/"))
  ) {
    // WhatsApp sometimes sends HD-quality photos as a document instead of
    // a standard image message — treat both the same way.
    const mediaId = message.image?.id || message.document?.id;
    log("Photo received as", message.type, "-> mediaId:", mediaId);
    await handleImageMessage(phone, mediaId, session);
  } else if (
    message.type === "document" &&
    message.document?.mime_type === "application/pdf" &&
    session.stage === "awaiting_payment"
  ) {
    // Payment receipt sent as a PDF (some UPI apps/banks do this instead of
    // a screenshot) — accepted unconditionally, same trust model as the
    // transaction-ID fallback: no parsing/verification, just proceed.
    log("Payment PDF receipt received from", phone, "-> accepting unconditionally, proceeding to report scheduling.");
    await confirmPaymentAndScheduleReport(phone, session, "PDF receipt");
  } else if (message.type === "unsupported") {
    // WhatsApp sends a transient "unsupported" placeholder event a few
    // milliseconds before the real "image"/"document" event for HD media
    // sends (confirmed repeatedly in logs — same phone, same moment,
    // always immediately followed by the real photo event). This is not
    // real customer content, so we log it and say nothing, letting the
    // follow-up event that arrives right after handle the actual photo —
    // replying here just confuses the customer mid-send.
    log("Ignoring transient 'unsupported' placeholder event from", phone, "(real event should follow immediately)");
  } else {
    await sendText(phone, "ദയവായി text ആയോ photo ആയോ അയക്കൂ.");
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  log("Process started. Node version:", process.version);
  log(
    "DATABASE_URL is",
    process.env.DATABASE_URL ? "set (length " + process.env.DATABASE_URL.length + ")" : "MISSING"
  );
  if (process.env.DATABASE_URL) {
    // Log only the shape (scheme + host), never credentials.
    try {
      const u = new URL(process.env.DATABASE_URL);
      log("DATABASE_URL shape -> protocol:", u.protocol, "host:", u.hostname, "port:", u.port || "(default)");
    } catch (e) {
      log("DATABASE_URL could not be parsed as a URL — this itself may be the problem. Error:", e.message);
    }
  }

  log("Connecting to database...");
  try {
    await Promise.race([
      db.initDb(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("DB connection timed out after 15s — check DATABASE_URL / network")), 15000)
      ),
    ]);
    log("Database connected successfully.");
  } catch (err) {
    log("FATAL: could not initialize database:", err.message);
    process.exit(1);
  }

  app.listen(PORT, () => {
    log(`Bot running on port ${PORT}`);
    console.log("STARTUP QR_IMAGE_URL =", process.env.QR_IMAGE_URL);
  });

  setInterval(pollDueReports, 60 * 1000);
  log("Report polling worker started (every 60s)");
  // Run one immediately at boot too, in case reports were already due
  // while the container was restarting.
  pollDueReports();
}

start();
