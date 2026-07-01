import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

/* ---------------- ENV ---------------- */

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ---------------- MEMORY ---------------- */

const sessions = new Map();

/* ---------------- SESSION ---------------- */

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      palmPhoto: false,
      paymentRequested: false,
      paymentDone: false,
      step: "START",
      replied: false,
      history: []
    });
  }
  return sessions.get(phone);
}

/* ---------------- SEND MESSAGE ---------------- */

async function sendMessage(to, text) {
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

/* ---------------- SAFE REPLY ---------------- */

async function safeReply(from, session, text) {
  if (session.replied) return;
  session.replied = true;

  await sendMessage(from, text);
}

/* ---------------- HELPERS ---------------- */

function isGreeting(text = "") {
  return /hi|hello|hai|hey/i.test(text);
}

function extractInfo(session, text = "") {
  if (!session.name && /^[a-zA-Z ]{2,}$/.test(text)) {
    session.name = text.trim();
  }

  if (!session.dob && /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/.test(text)) {
    session.dob = text.trim();
  }

  if (!session.gender) {
    if (/male|female|boy|girl/i.test(text)) {
      session.gender = text;
    }
  }
}

function missingInfo(session) {
  if (!session.name) return "ߘ നിങ്ങളുടെ പേര് പറയാമോ?";
  if (!session.dob) return "ߓ Date of Birth പറഞ്ഞുതരാമോ?";
  if (!session.gender) return "ߑ Male / Female എന്ന് പറയാമോ?";
  return null;
}

/* ---------------- AI RESPONSE ---------------- */

async function aiReply(session, message) {
  const prompt = `
You are a friendly WhatsApp assistant for ₹99 palm reading service.

Be natural like a human chatting.

User message: ${message}

User data:
Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}

Reply in simple Malayalam + light English.
Keep it short and friendly.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7
  });

  return res.choices[0].message.content;
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const from = msg.from;
    const session = getSession(from);

    session.replied = false;

    let text = "";

    if (msg.type === "text") {
      text = msg.text.body;
    }

    session.history.push(text);

    /* ---------------- GREETING ---------------- */

    if (isGreeting(text) && session.step === "START") {
      session.step = "COLLECT";
      await safeReply(
        from,
        session,
        `ߑ ഹായ്!

₹99 മാത്രം ഉള്ള Palm Reading Service ആണ്.

ഞാൻ നിങ്ങളുടെ:
• Personality
• Love
• Career
• Finance
• Future predictions

എല്ലാം analyze ചെയ്യും.

ആദ്യം Name പറയാമോ?`
      );
      return;
    }

    /* ---------------- STORE INFO ---------------- */

    extractInfo(session, text);

    /* ---------------- MISSING INFO ---------------- */

    const missing = missingInfo(session);
    if (missing) {
      await safeReply(from, session, missing);
      return;
    }

    /* ---------------- PALM PHOTO STEP ---------------- */

    if (!session.palmPhoto) {
      session.palmPhoto = true;

      await safeReply(
        from,
        session,
        `ߑ നല്ലത് ${session.name}

ഇപ്പോൾ നിങ്ങളുടെ കൈയുടെ clear photo അയയ്ക്കൂ ߓ`
      );
      return;
    }

    /* ---------------- PAYMENT STEP ---------------- */

    if (!session.paymentRequested) {
      session.paymentRequested = true;

      await safeReply(
        from,
        session,
        `ߒ ₹99 payment required.

Payment complete ചെയ്ത ശേഷം screenshot അയക്കൂ.

(Analysis immediately start ചെയ്യും)`
      );
      return;
    }

    /* ---------------- FINAL AI RESPONSE ---------------- */

    const reply = await aiReply(session, text);

    await safeReply(from, session, reply);

    session.history.push(reply);

  } catch (err) {
    console.error("ERROR:", err.message);
  }
});

/* ---------------- VERIFY ---------------- */

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
