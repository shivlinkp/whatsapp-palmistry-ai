import express from "express";
import axios from "axios";
import OpenAI from "openai";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
app.use(express.json({ limit: "25mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sessions = new Map();

const WELCOME = `Hi ߑ

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

ߔ നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും

❤️ സ്നേഹവും ബന്ധങ്ങളും

ߒ വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും

ߒ ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ

ߒ സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും

ߌ ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും

ߓ നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

✍ߏ Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.`;

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      mainQuestion: "",
      palmPhotoReceived: false,
      paymentRequested: false,
      paymentConfirmed: false,
      assessmentScheduled: false,
      reportSent: false,
      replied: false,
      history: [],
      lastMessageId: ""
    });
  }
  return sessions.get(phone);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

async function sendText(to, body) {
  if (!body) return;

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );
}

async function sendImage(to, imageUrl) {
  if (!imageUrl) return;

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 20000
    }
  );
}

async function safeReply(to, session, text) {
  if (session.replied) return;
  session.replied = true;
  await sendText(to, text);
  session.history.push({ role: "assistant", content: text });
}

function isGreeting(text = "") {
  const t = text.toLowerCase().trim();
  return ["hi", "hai", "hello", "hey", "ഹായ്"].some(x => t === x || t.includes(x));
}

function isQuestion(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("?") ||
    t.includes("what") ||
    t.includes("how") ||
    t.includes("price") ||
    t.includes("cost") ||
    t.includes("ithenth") ||
    t.includes("entha") ||
    t.includes("എന്ത") ||
    t.includes("എങ്ങനെ") ||
    t.includes("ഫീസ്") ||
    t.includes("payment")
  );
}

function detectDob(text = "") {
  const match = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/);
  return match ? match[1] : "";
}

function detectGender(text = "") {
  const t = text.toLowerCase();

  if (
    t.includes("female") ||
    t.includes("girl") ||
    t.includes("woman") ||
    t.includes("സ്ത്രീ") ||
    t.includes("പെൺ")
  ) {
    return "female";
  }

  if (
    t.includes("male") ||
    t.includes("boy") ||
    t.includes("man") ||
    t.includes("പുരുഷൻ") ||
    t.includes("ആൺ")
  ) {
    return "male";
  }

  return "";
}

function cleanNameCandidate(text = "") {
  return text
    .replace(/\bmale\b/gi, "")
    .replace(/\bfemale\b/gi, "")
    .replace(/\bboy\b/gi, "")
    .replace(/\bgirl\b/gi, "")
    .replace(/\bman\b/gi, "")
    .replace(/\bwoman\b/gi, "")
    .replace(/\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/g, "")
    .replace(/name[:\-]/gi, "")
    .replace(/dob[:\-]/gi, "")
    .replace(/gender[:\-]/gi, "")
    .trim();
}

async function extractFacts(session, text = "") {
  const dob = detectDob(text);
  const gender = detectGender(text);

  if (dob && !session.dob) session.dob = dob;
  if (gender && !session.gender) session.gender = gender;

  const cleaned = cleanNameCandidate(text);
  const words = cleaned.split(/\s+/).filter(Boolean);

  if (
    !session.name &&
    cleaned &&
    words.length <= 3 &&
    !isGreeting(cleaned) &&
    !isQuestion(cleaned) &&
    !dob &&
    !gender
  ) {
    session.name = cleaned;
  }

  try {
    const prompt = `Extract customer details from this WhatsApp message.

Existing:
Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
Main question: ${session.mainQuestion}

Message:
${text}

Return only JSON:
{"name":"","dob":"","gender":"","mainQuestion":""}

Rules:
- Gender must be male, female, or empty.
- Understand Malayalam, English and Manglish.
- Do not guess name from questions like "ithenthanu".
- If the user asks a life/career/marriage/money question, put it in mainQuestion.`;

    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });

    const raw = res.choices[0].message.content.trim().replace(/```json/g, "").replace(/```/g, "");
    const data = JSON.parse(raw);

    if (data.name && !session.name) session.name = data.name;
    if (data.dob && !session.dob) session.dob = data.dob;
    if (data.gender && !session.gender) session.gender = data.gender;
    if (data.mainQuestion) session.mainQuestion = data.mainQuestion;
  } catch (e) {
    console.error("Fact extraction skipped:", e.message);
  }
}

function missingInfo(session) {
  if (!session.name) return "Name പറയാമോ?";
  if (!session.dob) return "Date of Birth പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return "";
}

function handRequest(session) {
  const hand = session.gender === "male" ? "വലത് കൈയുടെ" : "ഇടത് കൈയുടെ";

  return `നന്ദി ${session.name || ""}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ ${hand} വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ:
• കൈ മുഴുവനും വ്യക്തമായി കാണണം
• നല്ല വെളിച്ചത്തിൽ എടുക്കണം
• കൈരേഖകൾ blur ആകരുത്`;
}

async function humanReply(session, userMessage) {
  const system = `You are the official WhatsApp assistant for Boldwords Media Solutions palmistry service.

Personality:
- Reply like a calm human assistant.
- Natural Malayalam with simple English if needed.
- Do not sound like a bot.
- Do not say AI, chatbot, automation, system, model, or OpenAI.
- Reply short, useful, and warm.
- Answer the customer's question first.
- Then gently continue the flow.
- Ask only one thing at a time.
- Never ask again for already collected details.

Business rules:
- Service fee is ₹99.
- Required before payment: Name, Date of Birth, Gender, one clear palm photo.
- For male ask right hand. For female ask left hand.
- After palm photo, send QR/payment request.
- After payment screenshot, confirm and say report will be prepared.
- Do not mention entertainment/fun/disclaimer.`;

  const state = `Current customer state:
Name: ${session.name || "missing"}
DOB: ${session.dob || "missing"}
Gender: ${session.gender || "missing"}
Main question: ${session.mainQuestion || "not specified"}
Palm photo received: ${session.palmPhotoReceived}
Payment requested: ${session.paymentRequested}
Payment confirmed: ${session.paymentConfirmed}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.65,
      messages: [
        { role: "system", content: system },
        { role: "user", content: state },
        ...session.history.slice(-8),
        { role: "user", content: userMessage }
      ]
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("Human reply error:", e.message);
    return "ശരി. വിശകലനം തുടങ്ങാൻ വേണ്ട വിവരങ്ങൾ അയച്ചാൽ ഞാൻ തുടർന്നുപറയാം.";
  }
}

async function sendPaymentRequest(to, session) {
  if (session.paymentRequested) return;

  session.paymentRequested = true;

  try {
    if (QR_IMAGE_URL) {
      await sendImage(to, QR_IMAGE_URL);
      await sleep(1500);
    }
  } catch (err) {
    console.error("QR send error:", err.response?.data || err.message);
  }

  await sendText(
    to,
    `ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം screenshot ഇവിടെ അയച്ചാൽ മതി.`
  );
}

async function generateAssessment(session) {
  const prompt = `Write a detailed Malayalam palmistry assessment.

Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
Main question: ${session.mainQuestion || "general life reading"}

Rules:
- Malayalam only.
- Premium and satisfying style.
- Do not mention AI.
- Do not add disclaimers.
- Do not say fun/entertainment.
- One-click-copy friendly continuous report.
- Around 1800 to 2200 words.
- Include personality, love, marriage, family, career, business, money, opportunities, challenges, future indications, and special palm signs.
- If main question exists, give extra focus to it.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.85,
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

function scheduleAssessment(to, session) {
  if (session.assessmentScheduled) return;

  session.assessmentScheduled = true;

  setTimeout(async () => {
    try {
      if (session.reportSent) return;

      const report = await generateAssessment(session);
      await sendText(to, report);

      session.reportSent = true;
    } catch (e) {
      console.error("Report error:", e.message);
    }
  }, 30 * 60 * 1000);
}

app.get("/", (req, res) => {
  res.status(200).send("Palmistry WhatsApp bot is running ✅");
});

app.get("/qr.png", (req, res) => {
  res.sendFile(path.resolve("qr.png"));
});

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
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const session = getSession(from);

    if (message.id && session.lastMessageId === message.id) return;
    session.lastMessageId = message.id;
    session.replied = false;

    let userMessage = "";

    if (message.type === "text") {
      userMessage = message.text?.body?.trim() || "";
    } else if (message.type === "image") {
      if (session.paymentRequested && !session.paymentConfirmed) {
        session.paymentConfirmed = true;

        await safeReply(
          from,
          session,
          `Payment screenshot കിട്ടി. നന്ദി ${session.name || ""}.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

റിപ്പോർട്ട് ഏകദേശം 30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും.`
        );

        scheduleAssessment(from, session);
        return;
      }

      session.palmPhotoReceived = true;

      await safeReply(
        from,
        session,
        `ഫോട്ടോ ലഭിച്ചു. നന്ദി ${session.name || ""}.

ഇപ്പോൾ payment details അയക്കാം.`
      );

      await sleep(1500);
      await sendPaymentRequest(from, session);
      return;
    } else {
      userMessage = `Customer sent ${message.type}`;
    }

    if (!userMessage) return;

    session.history.push({ role: "user", content: userMessage });

    if (isGreeting(userMessage) && session.history.length <= 1) {
      await sleep(randomDelay(1, 2));
      await safeReply(from, session, WELCOME);
      return;
    }

    await extractFacts(session, userMessage);

    const missing = missingInfo(session);

    if (missing) {
      if (isQuestion(userMessage)) {
        const reply = await humanReply(session, userMessage);
        await safeReply(from, session, `${reply}\n\n${missing}`);
        return;
      }

      await safeReply(from, session, missing);
      return;
    }

    if (!session.palmPhotoReceived) {
      await sleep(randomDelay(1, 2));
      await safeReply(from, session, handRequest(session));
      return;
    }

    if (session.palmPhotoReceived && !session.paymentRequested) {
      await sleep(randomDelay(1, 2));
      await sendPaymentRequest(from, session);
      return;
    }

    if (session.paymentRequested && !session.paymentConfirmed) {
      const reply = await humanReply(session, userMessage);
      await safeReply(
        from,
        session,
        `${reply}\n\nPayment ചെയ്ത ശേഷം screenshot ഇവിടെ അയച്ചാൽ report തയ്യാറാക്കാം.`
      );
      return;
    }

    if (session.paymentConfirmed && !session.reportSent) {
      await safeReply(
        from,
        session,
        `Report തയ്യാറാക്കിക്കൊണ്ടിരിക്കുകയാണ്. കുറച്ച് സമയം കൂടി കാത്തിരിക്കൂ.`
      );
      return;
    }

    const reply = await humanReply(session, userMessage);
    await safeReply(from, session, reply);

  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
