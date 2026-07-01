import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* ---------------- ENV ---------------- */

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sessions = new Map();

/* ---------------- SESSION ---------------- */

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      palmPhotoReceived: false,
      paymentRequested: false,
      paymentConfirmed: false,
      reportSent: false,
      history: [],
      replied: false
    });
  }
  return sessions.get(phone);
}

/* ---------------- UTIL ---------------- */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* ---------------- SEND ---------------- */

async function sendText(to, text) {
  if (!text) return;

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

async function sendImage(to, url) {
  if (!url) return;

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: url }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

/* ---------------- SAFE REPLY ---------------- */

async function safeReply(from, session, text) {
  if (session.replied) return;
  session.replied = true;
  await sendText(from, text);
}

/* ---------------- INTENT ---------------- */

function isGreeting(text) {
  const t = text.toLowerCase();
  return ["hi", "hello", "hai", "hey"].some(x => t.includes(x));
}

/* ---------------- USER DATA PARSER (IMPORTANT FIX) ---------------- */

function extractUserData(text, session) {
  if (!text) return;

  // NAME
  if (!session.name && /^[a-zA-Z ]{2,}$/.test(text)) {
    session.name = text.trim();
    return;
  }

  // DOB (very simple detection)
  if (!session.dob && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text)) {
    session.dob = text.trim();
    return;
  }

  // GENDER
  const t = text.toLowerCase();
  if (!session.gender) {
    if (t.includes("male") || t.includes("female") || t.includes("m") || t.includes("f")) {
      session.gender = text.trim();
      return;
    }
  }
}

/* ---------------- MISSING INFO ---------------- */

function missingInfo(session) {
  if (!session.name) return "Name പറയാമോ?";
  if (!session.dob) return "Date of Birth പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return "";
}

/* ---------------- PAYMENT ---------------- */

async function sendPaymentRequest(to, session) {
  if (session.paymentRequested) return;

  session.paymentRequested = true;

  if (QR_IMAGE_URL) {
    await sendImage(to, QR_IMAGE_URL);
  }

  await sendText(
    to,
    `₹99 payment ചെയ്യുക.

Screenshot അയച്ചാൽ analysis start ചെയ്യും.`
  );
}

/* ---------------- REPORT ---------------- */

async function generateReport(session) {
  const prompt = `
Write a detailed Malayalam palm reading.

Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8
  });

  return res.choices[0].message.content;
}

async function scheduleReport(to, session) {
  setTimeout(async () => {
    try {
      if (session.reportSent) return;

      const report = await generateReport(session);
      await sendText(to, report);

      session.reportSent = true;
    } catch (e) {
      console.error("Report error:", e.message);
    }
  }, 30 * 60 * 1000);
}

/* ---------------- WEBHOOK ---------------- */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return;

    const from = message.from;
    const session = getSession(from);
    session.replied = false;

    let userMessage = "";

    /* ---------------- MESSAGE TYPE ---------------- */

    if (message.type === "text") {
      userMessage = message.text?.body || "";
    } else if (message.type === "image") {
      userMessage = "image";
      session.palmPhotoReceived = true;
    } else {
      userMessage = message.type;
    }

    session.history.push(userMessage);

    /* ---------------- GREETING ---------------- */

    if (isGreeting(userMessage) && session.history.length === 1) {
      await safeReply(
        from,
        session,
        `Hi ߑ

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

ߔ നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും
❤️ സ്നേഹവും ബന്ധങ്ങളും
ߒ വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും
ߒ ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ
ߒ സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും
ߌ ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും
ߓ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

✍ߏ Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.`
      );
      return;
    }

    /* ---------------- EXTRACT INFO ---------------- */

    extractUserData(userMessage, session);

    /* ---------------- MISSING INFO CHECK ---------------- */

    const missing = missingInfo(session);
    if (missing) {
      await safeReply(from, session, missing);
      return;
    }

    /* ---------------- PALM PHOTO ---------------- */

    if (!session.palmPhotoReceived) {
      await safeReply(from, session, "ദയവായി നിങ്ങളുടെ കൈയുടെ ഫോട്ടോ അയയ്ക്കൂ ߓ");
      return;
    }

    /* ---------------- PAYMENT FLOW ---------------- */

    if (!session.paymentRequested) {
      await sendPaymentRequest(from, session);
      await scheduleReport(from, session);
      return;
    }

    /* ---------------- DEFAULT ---------------- */

    await safeReply(from, session, "Received. Processing your report...");

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
