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

const WELCOME = `Hi 👋

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

🔮 നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും

❤️ സ്നേഹവും ബന്ധങ്ങളും

💍 വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും

💼 ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ

💰 സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും

🌟 ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും

📌 നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

✍🏻 Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      mainQuestion: "",
      palmPhotoReceived: false,
      paymentRequested: false,
      paymentScreenshotReceived: false,
      paymentConfirmed: false,
      reportSent: false,
      history: []
    });
  }
  return sessions.get(phone);
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

function isGreeting(text) {
  const t = text.toLowerCase().trim();
  return ["hi", "hai", "hello", "hey", "test", "anyone", "ഹായ്"].some(x => t.includes(x));
}

function detectGender(text) {
  const t = text.toLowerCase();

  if (t.includes("female") || t.includes("girl") || t.includes("woman") || t.includes("സ്ത്രീ") || t.includes("പെൺ") || t.includes("പെണ്ണ്")) {
    return "female";
  }

  if (t.includes("male") || t.includes("boy") || t.includes("man") || t.includes("പുരുഷൻ") || t.includes("ആൺ")) {
    return "male";
  }

  return "";
}

function detectDob(text) {
  const match = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4})\b/);
  return match ? match[1] : "";
}

function detectName(text) {
  let cleaned = text
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

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words.slice(0, 3).join(" ");
}

async function extractFacts(session, text) {
  const localGender = detectGender(text);
  const localDob = detectDob(text);
  const localName = detectName(text);

  if (localGender && !session.gender) session.gender = localGender;
  if (localDob && !session.dob) session.dob = localDob;
  if (localName && !session.name && !isGreeting(localName)) session.name = localName;

  try {
    const prompt = `Extract customer details from this message.

Existing:
Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
Question: ${session.mainQuestion}

Message:
${text}

Return only JSON:
{"name":"","dob":"","gender":"","mainQuestion":""}

Gender must be male, female, or empty. Understand Malayalam, English, Manglish.`;

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
  if (!session.name) return "Name കൂടി പറയാമോ?";
  if (!session.dob) return "Date of Birth കൂടി പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return "";
}

function handRequest(session) {
  if (session.gender === "male") {
    return `നന്ദി ${session.name || ""}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

📸 ഫോട്ടോ എടുക്കുമ്പോൾ ശ്രദ്ധിക്കേണ്ടത്:
• കൈ മുഴുവനും വ്യക്തമായി കാണണം.
• നല്ല വെളിച്ചത്തിൽ ഫോട്ടോ എടുക്കുക.
• ക്യാമറ കൈയുടെ നേരെ പിടിക്കുക.
• കൈയിൽ നിഴൽ വീഴാതിരിക്കാൻ ശ്രദ്ധിക്കുക.`;
  }

  return `നന്ദി ${session.name || ""}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

📸 ഫോട്ടോ എടുക്കുമ്പോൾ ശ്രദ്ധിക്കേണ്ടത്:
• കൈ മുഴുവനും വ്യക്തമായി കാണണം.
• നല്ല വെളിച്ചത്തിൽ ഫോട്ടോ എടുക്കുക.
• ക്യാമറ കൈയുടെ നേരെ പിടിക്കുക.
• കൈയിൽ നിഴൽ വീഴാതിരിക്കാൻ ശ്രദ്ധിക്കുക.`;
}

async function sendPaymentRequest(to, session) {
  if (session.paymentRequested) {
    return;
  }

  session.paymentRequested = true;

 try {
  if (QR_IMAGE_URL) {
    console.log("Sending QR:", QR_IMAGE_URL);
    await sendImage(to, QR_IMAGE_URL);
    console.log("QR sent successfully");
    await sleep(2000);
  } else {
    console.log("QR_IMAGE_URL is empty");
  }
} catch (err) {
  console.error("QR Error:", err.response?.data || err.message);
}

  await sendText(
    to,
    `ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.`
  );
}

async function downloadWhatsAppMedia(mediaId, extension = "ogg") {
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });

  const media = await axios.get(meta.data.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });

  const filePath = path.join(os.tmpdir(), `${mediaId}.${extension}`);
  fs.writeFileSync(filePath, media.data);
  return filePath;
}

async function transcribeAudio(mediaId) {
  try {
    const filePath = await downloadWhatsAppMedia(mediaId, "ogg");
    const result = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1"
    });
    fs.unlinkSync(filePath);
    return result.text || "";
  } catch (e) {
    console.error("Audio error:", e.message);
    return "";
  }
}

async function humanReply(session, text) {
  const system = `You reply on WhatsApp for a ₹99 Malayalam palmistry service.
Behave like a calm human staff member.
Never say AI, chatbot, automation, assistant, OpenAI, model, or system.
Always answer the customer's question first, then gently continue the assessment flow.
Use natural Malayalam and simple Manglish.
Keep replies short.
No emojis except welcome and final report.
Never ask again for info already collected.
Required before payment: name, dob, gender, one palm photo.
After one palm photo, payment is required. Do not ask for other hand.`;

  const state = `State:
Name: ${session.name || "missing"}
DOB: ${session.dob || "missing"}
Gender: ${session.gender || "missing"}
Question: ${session.mainQuestion || "not specified"}
Palm photo received: ${session.palmPhotoReceived}
Payment requested: ${session.paymentRequested}
Payment confirmed: ${session.paymentConfirmed}`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: state },
        ...session.history.slice(-8),
        { role: "user", content: text }
      ]
    });

    return res.choices[0].message.content.trim();
  } catch (e) {
    console.error("Human reply error:", e.message);
    return "ശരി. വിശകലനം തുടരാൻ ആവശ്യമായ വിവരങ്ങൾ അയച്ചാൽ മതി.";
  }
}

async function generateAssessment(session) {
  const prompt = `Write a detailed Malayalam palmistry assessment.

Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
Main question: ${session.mainQuestion || "general life reading"}

Rules:
Malayalam only.
Premium, detailed, satisfying style.
Do not mention AI.
Do not add disclaimers.
One-click-copy friendly continuous report.
Include personality, love, marriage, family, career, business, money, opportunities, challenges, future indications, and special palm signs.
If main question exists, give extra focus to it.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.85,
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

function scheduleAssessment(to, session) {
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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    console.log("Webhook received");

    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const session = getSession(from);

    let userMessage = "";

    if (message.type === "text") {
      userMessage = message.text?.body || "";
      await extractFacts(session, userMessage);
    } else if (message.type === "audio") {
      const audioId = message.audio?.id;
      userMessage = audioId ? await transcribeAudio(audioId) : "";
      if (!userMessage) userMessage = "Voice note വ്യക്തമായി കിട്ടിയില്ല.";
      await extractFacts(session, userMessage);
    } else if (message.type === "image") {
  if (session.paymentRequested) {
    session.paymentScreenshotReceived = true;

    await sleep(randomDelay(8, 12));
    await sendText(from, "ഒരു നിമിഷം.");

    await sleep(5000);
    session.paymentConfirmed = true;

    await sendText(
      from,
      `Payment സ്ഥിരീകരിച്ചു.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

റിപ്പോർട്ട് ഏകദേശം 30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കുന്നതാണ്.`
    );

    scheduleAssessment(from, session);
    return;
  }

  if (!session.palmPhotoReceived) {
    session.palmPhotoReceived = true;
  }

  userMessage = "Customer sent an image.";
} else {
      userMessage = `Customer sent ${message.type}.`;
    }

    if (message.type === "text" && isGreeting(userMessage) && session.history.length === 0) {
      await sleep(randomDelay(1, 2));
      await sendText(from, WELCOME);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "assistant", content: WELCOME });
      return;
    }

if (session.palmPhotoReceived && !session.paymentRequested) {
    const missing = missingInfo(session);

    if (missing) {
        await sleep(randomDelay(12, 18));
        await sendText(from, missing);
        session.history.push({ role: "user", content: userMessage });
        session.history.push({ role: "assistant", content: missing });
        return;
    }

    await sleep(randomDelay(12, 18));
    await sendPaymentRequest(from, session);
    return;
}

      const reply = await humanReply(session, userMessage);
    await sendText(from, reply);

    session.history.push({ role: "user", content: userMessage });
    session.history.push({ role: "assistant", content: reply });
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
