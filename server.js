/**
 * Palmistry WhatsApp Bot - single file server.js
 *
 * ENV VARS REQUIRED:
 *   VERIFY_TOKEN      - webhook verification token you set in Meta App dashboard
 *   WHATSAPP_TOKEN    - permanent/temporary token for Graph API
 *   PHONE_NUMBER_ID   - WhatsApp Business phone number id
 *   OPENAI_API_KEY    - OpenAI key for extraction + report generation
 *   QR_IMAGE_URL      - fallback: publicly reachable URL of your payment QR
 *                       image, only used if no local qr.png file is found
 *                       (see QR_LOCAL_PATH below)
 *
 * QR IMAGE: preferred approach is bundling a qr.png file directly in the repo
 * (same folder as server.js). At startup/send-time we read it straight off
 * disk and upload the bytes to Meta directly — no external URL, no Express
 * static route, no network fetch required at all. QR_IMAGE_URL is only a
 * fallback used if no local qr.png is found in the deployment.
 *
 * NOTE: Sessions are stored in-memory (Map). They reset on every Railway
 * restart/deploy. For production durability, add Postgres (see bottom notes).
 */

const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 8080;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";
const QR_LOCAL_PATH = path.join(__dirname, "qr.png");

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;


// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

// sessions: phone -> { stage, name, dob, gender, palmMediaId, reportChunksSent, createdAt, updatedAt }
const sessions = new Map();

// Tracks the wamid of the last QR image sent per phone number, so incoming
// status webhooks (sent/delivered/read/failed) can be correlated back to
// the actual QR send attempt.
const qrMessageIdsByPhone = new Map();

// Dedup of processed WhatsApp message ids (capped ring buffer)
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

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      stage: "new", // new -> collecting -> awaiting_photo -> awaiting_payment -> awaiting_report -> report_sent
      name: null,
      dob: null,
      gender: null,
      palmMediaId: null,
      reportText: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return sessions.get(phone);
}

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

// ---------------------------------------------------------------------------
// WhatsApp send helpers
// ---------------------------------------------------------------------------

// Human-like delay: every outgoing message waits 8-12s before sending.
// Centralized here so no call site needs to remember to add it.
function randomHumanDelayMs() {
  return 8000 + Math.random() * 4000; // 8-12 seconds
}

async function sendWhatsAppRequest(payload) {
  const delay = randomHumanDelayMs();
  log(`Waiting ${(delay / 1000).toFixed(1)}s before sending (human-like delay)`);
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
// real message id in response.messages[0].id). Returns false otherwise —
// callers must NOT proceed to the next step in the flow if this is false.
async function sendImageByUrl(to, link, caption) {
  if (!link || !/^https?:\/\//i.test(link)) {
    log(
      `QR image NOT sent — QR_IMAGE_URL is missing or invalid. Current value: "${link}"`
    );
    return false;
  }

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
    log(
      "QR image REJECTED by Meta. HTTP status:",
      result.httpStatus,
      "Full response:",
      JSON.stringify(result.data)
    );
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

  log(
    "QR image (by link) ACCEPTED by Meta. HTTP status:",
    result.httpStatus,
    "wamid:",
    wamid
  );
  qrMessageIdsByPhone.set(to, wamid);
  log("Tracked QR message id for", to, "->", wamid);
  return true;
}

// Uploads the QR image bytes directly to Meta's /media endpoint, returning
// a media_id. Prefers a local qr.png file bundled in the deployed repo
// (no network fetch needed at all); falls back to downloading from
// QR_IMAGE_URL only if no local file is found. Either way, this removes
// Meta's dependency on fetching the image itself at send-time — the
// root-cause fix for "accepted (200 + wamid) but never delivered" sends.
async function uploadMediaToMeta() {
  let buffer;
  let contentType = "image/png";

  if (fs.existsSync(QR_LOCAL_PATH)) {
    try {
      buffer = fs.readFileSync(QR_LOCAL_PATH);
      log(
        "Using local qr.png bundled in deployment:",
        QR_LOCAL_PATH,
        "-",
        buffer.length,
        "bytes"
      );
    } catch (err) {
      log("Failed to read local qr.png:", err.message);
      buffer = null;
    }
  } else {
    log("No local qr.png found at", QR_LOCAL_PATH, "— falling back to QR_IMAGE_URL");
  }

  if (!buffer) {
    if (!QR_IMAGE_URL || !/^https?:\/\//i.test(QR_IMAGE_URL)) {
      log(
        `Media upload skipped — no local qr.png AND QR_IMAGE_URL is missing/invalid: "${QR_IMAGE_URL}"`
      );
      return null;
    }
    try {
      const imgRes = await fetch(QR_IMAGE_URL);
      if (!imgRes.ok) {
        log(
          "Media upload: failed to download QR image from",
          QR_IMAGE_URL,
          "-> HTTP",
          imgRes.status
        );
        return null;
      }
      buffer = await imgRes.buffer();
      contentType = imgRes.headers.get("content-type") || "image/png";
      log(
        "Downloaded QR image from QR_IMAGE_URL for upload:",
        buffer.length,
        "bytes, content-type:",
        contentType
      );
    } catch (err) {
      log("Media upload: download from QR_IMAGE_URL crashed (caught):", err.message);
      return null;
    }
  }

  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([buffer], { type: contentType }), "qr.png");

    const uploadRes = await globalThis.fetch(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
        body: form,
      }
    );
    const uploadText = await uploadRes.text();
    let uploadData;
    try {
      uploadData = JSON.parse(uploadText);
    } catch {
      uploadData = { rawText: uploadText };
    }

    log("Media upload HTTP status:", uploadRes.status);
    log("Media upload full response:", JSON.stringify(uploadData));

    if (!uploadRes.ok || !uploadData.id) {
      log("Media upload FAILED — no media id returned.");
      return null;
    }

    log("Media upload SUCCEEDED — media_id:", uploadData.id);
    return uploadData.id;
  } catch (err) {
    log("Media upload crashed (caught):", err.message);
    return null;
  }
}

async function sendImageByMediaId(to, mediaId, caption) {
  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "image",
    image: caption ? { id: mediaId, caption } : { id: mediaId },
  };

  log("Sending QR image (by media_id) to", to, "-> media_id:", mediaId);

  const result = await sendWhatsAppRequest(payload);

  if (!result || result.networkError) {
    log(
      "QR image (by media_id) send FAILED — network error:",
      result?.networkError || "unknown"
    );
    return false;
  }

  if (!result.ok) {
    log(
      "QR image (by media_id) REJECTED by Meta. HTTP status:",
      result.httpStatus,
      "Full response:",
      JSON.stringify(result.data)
    );
    return false;
  }

  const wamid = result.data?.messages?.[0]?.id;
  if (!wamid) {
    log(
      "QR image (by media_id) response was HTTP",
      result.httpStatus,
      "but contained no message id — treating as failure. Full response:",
      JSON.stringify(result.data)
    );
    return false;
  }

  log(
    "QR image (by media_id) ACCEPTED by Meta. HTTP status:",
    result.httpStatus,
    "wamid:",
    wamid
  );
  qrMessageIdsByPhone.set(to, wamid);
  log("Tracked QR message id for", to, "->", wamid);
  return true;
}

// Primary QR-sending path: upload the image to Meta directly, then send by
// media_id. Falls back to the old link-based method only if the upload
// itself fails (e.g. Cloudinary temporarily unreachable) — link-based
// sending is what we've confirmed gets accepted-but-not-delivered, so it's
// a last resort, not the default anymore.
async function sendQrImage(to) {
  const mediaId = await uploadMediaToMeta();
  if (mediaId) {
    const sent = await sendImageByMediaId(to, mediaId, "");
    if (sent) return true;
    log("Send-by-media_id failed after successful upload — falling back to link method.");
  } else {
    log("Media upload failed — falling back to link method.");
  }
  console.log("ABOUT TO SEND QR_IMAGE_URL =", QR_IMAGE_URL);
  return sendImageByUrl(to, QR_IMAGE_URL, "");
}

// Splits long text into WhatsApp-safe chunks (~4000 char limit), breaking on
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
    // sendText -> sendWhatsAppRequest already applies an 8-12s human-like
    // delay before each send, so chunks naturally arrive spaced out in order.
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
• ലിംഗം

ഫീസ്: ₹99 മാത്രം.`;

const ASK_ALL_DETAILS_MESSAGE = `ദയവായി താഴെ പറയുന്ന വിവരങ്ങൾ ഒരുമിച്ച് അയച്ചുതരാമോ?

• പേര്
• ജനനത്തീയതി
• ലിംഗം`;

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

const QR_FAILURE_MESSAGE =
  "QR code അയക്കുന്നതിൽ ചെറിയ പ്രശ്നം ഉണ്ടായി. ദയവായി കുറച്ച് സമയം കഴിഞ്ഞ് വീണ്ടും ശ്രമിക്കൂ.";

function paymentReceivedMessage(name) {
  return `Payment screenshot ലഭിച്ചു. നന്ദി ${name}.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

Report ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും.`;
}

// ---------------------------------------------------------------------------
// FAQ handling (keyword based, no GPT call — keeps pre-payment flow cheap/fast)
// ---------------------------------------------------------------------------

function matchFaq(text) {
  const t = text.toLowerCase();

  const whatGet = /(what.*get|enthanu kittu|entha kittunnath|what do i|what will i)/i;
  const howMuch = /(how much|price|cost|fee|rate|entha vila|entra vila|₹)/i;
  const howLong = /(how long|when.*report|time.*report|eppo kittum|how many min)/i;

  if (howMuch.test(t)) {
    return "ഫീസ് ₹99 മാത്രം.";
  }
  if (howLong.test(t)) {
    return "Payment screenshot അയച്ചതിന് ശേഷം ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ report ലഭിക്കും.";
  }
  if (whatGet.test(t)) {
    return "നിങ്ങളുടെ സ്വഭാവം, ബന്ധങ്ങൾ, വിവാഹം, കരിയർ, സാമ്പത്തികം, ഭാവി എന്നിവയെക്കുറിച്ചുള്ള വിശദമായ കൈരേഖാ വിശകലനം ലഭിക്കും.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

async function openaiChat(messages, opts = {}) {
  if (!OPENAI_API_KEY) {
    log("OPENAI_API_KEY missing, skipping OpenAI call");
    return null;
  }
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts.model || "gpt-4o-mini",
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.max_tokens || 800,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      log("OpenAI error:", JSON.stringify(data));
      return null;
    }
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    log("OpenAI call failed:", err.message);
    return null;
  }
}

// Extracts {name, dob, gender} from free text (English/Malayalam/Manglish).
// Returns only the fields it is confident about; never overwrites what we
// don't find. Falls back to simple regex if OpenAI is unavailable/fails.
async function extractFields(text, known) {
  const result = { name: null, dob: null, gender: null };

  // --- Fast regex pass (cheap, works for the common "Name, gender, dob" style) ---
  const dobMatch = text.match(
    /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/
  );
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

  // --- OpenAI pass to catch names / messier formats / Malayalam script ---
  const prompt = `Extract name, date of birth, and gender from the customer's WhatsApp message below.
The customer may send the details in ANY order, on separate lines, comma-separated, or in Malayalam/Manglish. Examples of valid inputs:
"Shivlin, 07-11-1992, Male"
"Shivlin\\n07-11-1992\\nMale"
"Male\\n07-11-1992\\nShivlin"
"പേര് Shivlin ജനനത്തീയതി 07-11-1992 ലിംഗം Male"

Already known (do not change unless the new message clearly overrides it): ${JSON.stringify(
    known
  )}
Customer message: """${text}"""

Reply with ONLY a raw JSON object, no markdown, no explanation, in this exact shape:
{"name": string or null, "dob": "DD-MM-YYYY" or null, "gender": "male" or "female" or null}
If a field is not present in the message, set it to null.`;

  const raw = await openaiChat(
    [{ role: "user", content: prompt }],
    { model: "gpt-4o-mini", temperature: 0, max_tokens: 150 }
  );

  if (raw) {
    try {
      const cleaned = raw.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed.name) result.name = parsed.name;
      if (parsed.dob) result.dob = parsed.dob;
      if (parsed.gender === "male" || parsed.gender === "female") {
        result.gender = parsed.gender;
      }
    } catch (err) {
      log("Extraction JSON parse failed, using regex-only result");
    }
  }

  // --- Safe regex fallback for name (only if GPT missed it) ---
  // Only guess a name here when the message also contains a dob or gender
  // match — otherwise a random question ("how much?") could get misread as
  // a name, which we want to avoid.
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
// Media helpers (fetch WhatsApp media as base64 for vision-capable report gen)
// ---------------------------------------------------------------------------

async function getMediaBase64(mediaId) {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const meta = await metaRes.json();
    if (!meta.url) return null;

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    const buffer = await fileRes.buffer();
    const mimeType = meta.mime_type || "image/jpeg";
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (err) {
    log("Failed to fetch media:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

async function generateReport(session) {
  const { name, dob, gender, palmMediaId } = session;

  const systemPrompt = `You are writing a detailed Malayalam palm reading report for a paying customer.
Write naturally and warmly, entirely in Malayalam script, minimum 2000 words.
Cover these sections clearly: സ്വഭാവവും വ്യക്തിത്വവും, സ്നേഹവും ബന്ധങ്ങളും, വിവാഹവും കുടുംബജീവിതവും, ജോലി/കരിയർ/ബിസിനസ്, സാമ്പത്തിക കാര്യങ്ങൾ, ഭാവിയിലെ അവസരങ്ങളും വെല്ലുവിളികളും, കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ.
Do not include any disclaimers. Never use the words: fun, entertainment, AI, OpenAI, bot, automation, model, system (in English or Malayalam equivalents).
Address the customer by name naturally through the report.`;

  const userContent = [
    {
      type: "text",
      text: `Customer details:\nപേര്: ${name}\nജനനത്തീയതി: ${dob}\nലിംഗം: ${
        gender === "female" ? "സ്ത്രീ" : "പുരുഷൻ"
      }\n\nAnalyze the attached palm image if present and write the full report.`,
    },
  ];

  let imageDataUrl = null;
  if (palmMediaId) {
    imageDataUrl = await getMediaBase64(palmMediaId);
    if (imageDataUrl) {
      userContent.push({ type: "image_url", image_url: { url: imageDataUrl } });
    }
  }

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  const report = await openaiChat(messages, {
    model: "gpt-4o-mini",
    temperature: 0.8,
    max_tokens: 4000,
  });

  return report;
}

function scheduleReport(phone) {
  const delayMinutes = 25 + Math.random() * 5; // 25-30 min
  const delayMs = delayMinutes * 60 * 1000;
  log("Scheduling report for", phone, "in", delayMinutes.toFixed(1), "minutes");

  setTimeout(async () => {
    const session = sessions.get(phone);
    if (!session) return;
    try {
      const report = await generateReport(session);
      if (!report) {
        await sendText(
          phone,
          "നിങ്ങളുടെ റിപ്പോർട്ട് തയ്യാറാക്കുന്നതിൽ അല്പം സമയമെടുക്കുന്നു. ദയവായി അല്പസമയം കൂടി കാത്തിരിക്കൂ, ഞങ്ങൾ ഉടൻ അയയ്ക്കും."
        );
        // retry once after 3 minutes
        setTimeout(async () => {
          const s2 = sessions.get(phone);
          if (!s2) return;
          const retryReport = await generateReport(s2);
          if (retryReport) {
            s2.reportText = retryReport;
            s2.stage = "report_sent";
            await sendLongText(phone, retryReport);
            log("Report sent (retry) to", phone);
          }
        }, 3 * 60 * 1000);
        return;
      }
      session.reportText = report;
      session.stage = "report_sent";
      await sendLongText(phone, report);
      log("Report sent to", phone);
    } catch (err) {
      log("Report generation crashed (caught):", err.message);
    }
  }, delayMs);
}

// ---------------------------------------------------------------------------
// Core message handling
// ---------------------------------------------------------------------------

async function handleTextMessage(phone, text, session) {
  log("Current session state for", phone, "->", JSON.stringify({
    stage: session.stage,
    name: session.name,
    dob: session.dob,
    gender: session.gender,
  }));

  if (session.stage === "new") {
    session.stage = "collecting";
    await sendText(phone, WELCOME_MESSAGE);

    // In case the very first message already contains details (rare but possible)
    const extracted = await extractFields(text, session);
    applyExtracted(session, extracted);
    await progressCollectingStage(phone, session);
    return;
  }

  if (session.stage === "collecting") {
    // Answer basic FAQs inline without breaking the flow
    const faqAnswer = matchFaq(text);
    if (faqAnswer) {
      await sendText(phone, faqAnswer);
    }

    const extracted = await extractFields(text, session);
    applyExtracted(session, extracted);
    await progressCollectingStage(phone, session);
    return;
  }

  if (session.stage === "awaiting_photo") {
    const faqAnswer = matchFaq(text);
    if (faqAnswer) {
      await sendText(phone, faqAnswer);
    }

    if (session.palmMediaId) {
      // Photo was already received but QR sending failed earlier — retry now.
      const qrSent = await sendQrImage(phone);
      if (qrSent) {
        session.stage = "awaiting_payment";
        await sendText(phone, PHOTO_RECEIVED_PAYMENT_MESSAGE);
      } else {
        await sendText(phone, QR_FAILURE_MESSAGE);
      }
      return;
    }

    await sendText(
      phone,
      `ദയവായി നിങ്ങളുടെ ${
        session.gender === "female" ? "ഇടത്" : "വലത്"
      } കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?`
    );
    return;
  }

  if (session.stage === "awaiting_payment") {
    const faqAnswer = matchFaq(text);
    if (faqAnswer) {
      await sendText(phone, faqAnswer);
    } else {
      await sendText(
        phone,
        "Payment ചെയ്തതിന് ശേഷം screenshot ഇവിടെ അയച്ചാൽ മതി."
      );
    }
    return;
  }

  if (session.stage === "awaiting_report") {
    await sendText(
      phone,
      "നിങ്ങളുടെ റിപ്പോർട്ട് തയ്യാറാക്കുന്നു. കുറച്ച് സമയത്തിനുള്ളിൽ ലഭിക്കും."
    );
    return;
  }

  if (session.stage === "report_sent") {
    // Free-form follow-up Q&A using report + context — fine to use GPT here.
    const followUp = await openaiChat(
      [
        {
          role: "system",
          content: `You are continuing a conversation with a customer in Malayalam, after having given them a palm reading report earlier. Answer their follow-up question naturally and briefly using the report context below. Never mention AI, bot, automation, model, or system.\n\nEarlier report:\n${session.reportText || ""}`,
        },
        { role: "user", content: text },
      ],
      { model: "gpt-4o-mini", temperature: 0.7, max_tokens: 500 }
    );
    if (followUp) {
      await sendText(phone, followUp);
    } else {
      await sendText(
        phone,
        "ക്ഷമിക്കണം, ഒരു നിമിഷം ശ്രമിക്കാമോ? ചെറിയൊരു തടസ്സം ഉണ്ടായി."
      );
    }
    return;
  }
}

function applyExtracted(session, extracted) {
  if (extracted.name && !session.name) session.name = extracted.name;
  if (extracted.dob && !session.dob) session.dob = extracted.dob;
  if (extracted.gender && !session.gender) session.gender = extracted.gender;
  session.updatedAt = Date.now();
}

async function progressCollectingStage(phone, session) {
  const missing = [];
  if (!session.name) missing.push("name");
  if (!session.dob) missing.push("dob");
  if (!session.gender) missing.push("gender");

  if (missing.length > 0) {
    await sendText(phone, ASK_ALL_DETAILS_MESSAGE);
    return;
  }

  // All fields collected
  session.stage = "awaiting_photo";
  await sendText(phone, handRequestMessage(session.name, session.gender));
}

async function handleImageMessage(phone, mediaId, session) {
  log("Current session state for", phone, "->", JSON.stringify({
    stage: session.stage,
  }));

  if (session.stage === "awaiting_photo") {
    session.palmMediaId = mediaId;

    const qrSent = await sendQrImage(phone);
    if (!qrSent) {
      log(
        "QR image failed to send to",
        phone,
        "— NOT sending payment message. Staying in awaiting_photo for retry."
      );
      await sendText(phone, QR_FAILURE_MESSAGE);
      // Stage stays "awaiting_photo"; palmMediaId is already saved so the
      // next incoming message from this customer retries the QR send
      // instead of asking them to resend the photo.
      return;
    }

    session.stage = "awaiting_payment";
    await sendText(phone, PHOTO_RECEIVED_PAYMENT_MESSAGE);
    return;
  }

  if (session.stage === "awaiting_payment") {
    log("Payment screenshot received from", phone);
    session.stage = "awaiting_report";
    await sendText(phone, paymentReceivedMessage(session.name || ""));
    scheduleReport(phone);
    return;
  }

  // Image sent at an unexpected stage
  if (session.stage === "new" || session.stage === "collecting") {
    await sendText(phone, ASK_ALL_DETAILS_MESSAGE);
    return;
  }

  await sendText(phone, "ഫോട്ടോ ലഭിച്ചു, നന്ദി.");
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

app.post("/webhook", (req, res) => {
  // Ack immediately so Meta doesn't retry/timeout
  res.sendStatus(200);

  try {
    log("Webhook received");
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // WhatsApp sends message status updates (sent/delivered/read/failed)
    // as separate webhook events with no "messages" array — log these in
    // detail so we can see exactly what Meta reports after accepting a send.
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
          log(
            "*** This status update matches the tracked QR image message id for",
            status.recipient_id,
            "-> status:",
            status.status
          );
        }
      }
      return;
    }

    const message = value?.messages?.[0];

    if (!message) {
      // Neither a message nor a status update — nothing to do
      return;
    }

    if (isDuplicate(message.id)) {
      log("Duplicate message ignored:", message.id);
      return;
    }
    markProcessed(message.id);

    const phone = message.from;
    const session = getSession(phone);

    log("Message type:", message.type, "from", phone);

    if (message.type === "text") {
      const text = message.text?.body || "";
      handleTextMessage(phone, text, session).catch((err) =>
        log("handleTextMessage error (caught):", err.message)
      );
    } else if (
      message.type === "image" ||
      (message.type === "document" &&
        message.document?.mime_type?.startsWith("image/"))
    ) {
      // WhatsApp sometimes sends photos sent in "HD" quality as a document
      // (mime_type image/...) instead of a standard image message — treat
      // both the same way so HD palm photos aren't rejected.
      const mediaId = message.image?.id || message.document?.id;
      log("Photo received as", message.type, "-> mediaId:", mediaId);
      handleImageMessage(phone, mediaId, session).catch((err) =>
        log("handleImageMessage error (caught):", err.message)
      );
    } else {
      // Unsupported type (audio, non-image document, location, etc.)
      sendText(
        phone,
        "ദയവായി text ആയോ photo ആയോ അയക്കൂ."
      ).catch((err) => log("send fallback error (caught):", err.message));
    }
  } catch (err) {
    log("Webhook handler crashed (caught):", err.message);
  }
});

app.listen(PORT, () => {
  log(`Bot running on port ${PORT}`);
  console.log("STARTUP QR_IMAGE_URL =", process.env.QR_IMAGE_URL);
  if (fs.existsSync(QR_LOCAL_PATH)) {
    const stats = fs.statSync(QR_LOCAL_PATH);
    log(`QR check: local qr.png FOUND at ${QR_LOCAL_PATH} (${stats.size} bytes) — will be used directly.`);
  } else {
    log(
      `QR check: no local qr.png found at ${QR_LOCAL_PATH}. Will fall back to QR_IMAGE_URL = "${QR_IMAGE_URL}"`
    );
  }
});
