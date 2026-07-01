import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "25mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sessions = new Map();

const WELCOME = `Hi

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

- നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും
- സ്നേഹവും ബന്ധങ്ങളും
- വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും
- ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ
- സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും
- ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും
- നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

Name, Date of Birth, Gender പറയാമോ?

ഫീസ്: ₹99 മാത്രം.`;

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      welcomed: false,
      name: "",
      dob: "",
      gender: "",
      palmPhotoReceived: false,
      palmPhotoMediaId: "",
      paymentRequested: false,
      paymentConfirmed: false,
      assessmentScheduled: false,
      reportSent: false,
      report: "",
      lastMessageId: "",
      history: []
    });
  }

  return sessions.get(phone);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomMinutes(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 60 * 1000;
}

function splitMessage(text, maxLength = 3500) {
  const parts = [];
  let remaining = text || "";

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < 1000) cut = maxLength;

    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

async function sendText(to, body) {
  if (!body) return;

  const chunks = splitMessage(body);

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: chunk }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        },
        timeout: 20000
      }
    );

    await sleep(700);
  }
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

function normalize(text = "") {
  return text.toLowerCase().trim();
}

function detectDob(text = "") {
  const match = text.match(/\b\d{1,2}[\/\-.,]\d{1,2}[\/\-.,]\d{2,4}\b/);
  return match ? match[0].replace(/,/g, "-") : "";
}

function detectGender(text = "") {
  const t = normalize(text);

  if (
    /\bfemale\b/.test(t) ||
    /\bgirl\b/.test(t) ||
    /\bwoman\b/.test(t) ||
    t.includes("സ്ത്രീ") ||
    t.includes("പെൺ")
  ) {
    return "female";
  }

  if (
    /\bmale\b/.test(t) ||
    /\bboy\b/.test(t) ||
    /\bman\b/.test(t) ||
    t.includes("പുരുഷൻ") ||
    t.includes("ആൺ")
  ) {
    return "male";
  }

  return "";
}

function isGreeting(text = "") {
  const t = normalize(text);
  return ["hi", "hello", "hai", "hey", "ഹായ്"].some(x => t === x || t.includes(x));
}

function detectName(text = "") {
  let cleaned = text
    .replace(/\bfemale\b/gi, "")
    .replace(/\bmale\b/gi, "")
    .replace(/\bgirl\b/gi, "")
    .replace(/\bboy\b/gi, "")
    .replace(/\bwoman\b/gi, "")
    .replace(/\bman\b/gi, "")
    .replace(/\d{1,2}[\/\-.,]\d{1,2}[\/\-.,]\d{2,4}/g, "")
    .replace(/name[:\-]/gi, "")
    .replace(/dob[:\-]/gi, "")
    .replace(/date of birth[:\-]/gi, "")
    .replace(/gender[:\-]/gi, "")
    .replace(/[,\|]/g, " ")
    .trim();

  if (!cleaned) return "";
  if (isGreeting(cleaned)) return "";

  const lower = normalize(cleaned);
  if (lower.includes("payment") || lower.includes("price") || lower.includes("fee")) return "";

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3) return words.join(" ");

  return "";
}

async function extractFacts(session, text = "") {
  const dob = detectDob(text);
  const gender = detectGender(text);
  const name = detectName(text);

  if (dob && !session.dob) session.dob = dob;
  if (gender && !session.gender) session.gender = gender;
  if (name && !session.name) session.name = name;

  if (session.name && session.dob && session.gender) return;

  try {
    const prompt = `Extract customer details from this WhatsApp message.

Message:
${text}

Return only JSON:
{"name":"","dob":"","gender":""}

Rules:
- gender must be male, female, or empty.
- Understand Malayalam, English and Manglish.
- Do not guess.
- DOB examples: 07-11-1992, 07/11/1992, 07,11,1992.`;

    const result = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });

    const raw = result.choices[0].message.content
      .trim()
      .replace(/```json/g, "")
      .replace(/```/g, "");

    const data = JSON.parse(raw);

    if (data.name && !session.name) session.name = data.name;
    if (data.dob && !session.dob) session.dob = data.dob;
    if (data.gender && !session.gender) session.gender = data.gender.toLowerCase();
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
  if (session.gender === "male") {
    return `നന്ദി ${session.name}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ:
- കൈ മുഴുവനും വ്യക്തമായി കാണണം
- നല്ല വെളിച്ചത്തിൽ എടുക്കണം
- കൈരേഖകൾ blur ആകരുത്`;
  }

  return `നന്ദി ${session.name}.

ഇപ്പോൾ ദയവായി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ:
- കൈ മുഴുവനും വ്യക്തമായി കാണണം
- നല്ല വെളിച്ചത്തിൽ എടുക്കണം
- കൈരേഖകൾ blur ആകരുത്`;
}

async function sendPaymentRequest(to, session) {
  if (session.paymentRequested) return;

  session.paymentRequested = true;

  if (QR_IMAGE_URL) {
    await sendImage(to, QR_IMAGE_URL);
    await sleep(1500);
  }

  await sendText(
    to,
    `ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം screenshot ഇവിടെ അയച്ചാൽ മതി.`
  );
}

async function getWhatsAppMediaBase64(mediaId) {
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });

  const media = await axios.get(meta.data.url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });

  const contentType = media.headers["content-type"] || "image/jpeg";
  const base64 = Buffer.from(media.data).toString("base64");

  return `data:${contentType};base64,${base64}`;
}

async function generateAssessment(session) {
  let imageContent = [];

  try {
    if (session.palmPhotoMediaId) {
      const imageDataUrl = await getWhatsAppMediaBase64(session.palmPhotoMediaId);
      imageContent.push({
        type: "image_url",
        image_url: { url: imageDataUrl }
      });
    }
  } catch (e) {
    console.error("Palm image fetch skipped:", e.message);
  }

  const prompt = `Write a detailed Malayalam palmistry assessment of not less than 2000 words.

Customer details:
Name: ${session.name}
Date of Birth: ${session.dob}
Gender: ${session.gender}

Important rules:
- Malayalam only.
- Minimum 2000 words.
- Premium, detailed, satisfying style.
- Do not mention AI, OpenAI, chatbot, automation, model, or system.
- Do not add disclaimers.
- Do not say fun or entertainment.
- Include personality, love, relationships, marriage, family life, job, career, business, money, future opportunities, challenges, and special palm signs.
- Make it feel personal and valuable.
- Write as a continuous customer-ready report.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.85,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: prompt }, ...imageContent]
      }
    ]
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
      session.report = report;
      session.reportSent = true;

      await sendText(to, report);
    } catch (e) {
      console.error("Assessment error:", e.response?.data || e.message);
      await sendText(to, "Report തയ്യാറാക്കുമ്പോൾ ചെറിയ technical issue വന്നു. കുറച്ച് സമയം കൂടി തരാമോ?");
    }
  }, randomMinutes(25, 30));
}

async function followUpReply(session, text) {
  const prompt = `You are replying to a customer after their Malayalam palmistry report.

Customer:
Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}

Previous report:
${session.report || "Report not available yet."}

Customer follow-up question:
${text}

Reply in Malayalam.
Be natural, clear, helpful, and personal.
Do not mention AI, chatbot, automation, model, system, or OpenAI.
Do not add disclaimers.
Keep answer focused on the customer's question.`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

app.get("/", (req, res) => {
  res.status(200).send("Palmistry WhatsApp bot is running");
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

    if (message.type === "text") {
      const text = message.text?.body?.trim() || "";
      if (!text) return;

      session.history.push({ role: "user", content: text });

      if (!session.welcomed) {
        session.welcomed = true;
        await sendText(from, WELCOME);
        return;
      }

      await extractFacts(session, text);

      const missing = missingInfo(session);
      if (missing) {
        await sendText(from, missing);
        return;
      }

      if (!session.palmPhotoReceived) {
        await sendText(from, handRequest(session));
        return;
      }

      if (session.paymentRequested && !session.paymentConfirmed) {
        await sendText(from, "Payment ചെയ്ത ശേഷം screenshot ഇവിടെ അയച്ചാൽ മതി.");
        return;
      }

      if (session.paymentConfirmed && !session.reportSent) {
        await sendText(from, "Report തയ്യാറാക്കിക്കൊണ്ടിരിക്കുകയാണ്. ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ ലഭിക്കും.");
        return;
      }

      if (session.reportSent) {
        const reply = await followUpReply(session, text);
        await sendText(from, reply);
        return;
      }

      await sendText(from, "ശരി. തുടരാൻ നിങ്ങളുടെ കൈയുടെ ഫോട്ടോ അയക്കൂ.");
      return;
    }

    if (message.type === "image") {
      const imageId = message.image?.id || "";

      if (!session.palmPhotoReceived) {
        session.palmPhotoReceived = true;
        session.palmPhotoMediaId = imageId;

        await sendText(from, "ഫോട്ടോ ലഭിച്ചു. നന്ദി.");
        await sleep(1500);
        await sendPaymentRequest(from, session);
        return;
      }

      if (session.paymentRequested && !session.paymentConfirmed) {
        session.paymentConfirmed = true;

        await sendText(
          from,
          `Payment screenshot ലഭിച്ചു. നന്ദി ${session.name || ""}.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

Report ഏകദേശം 25-30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കും.`
        );

        scheduleAssessment(from, session);
        return;
      }

      await sendText(from, "Image ലഭിച്ചു.");
      return;
    }

    await sendText(from, "Text അല്ലെങ്കിൽ image ആയി അയക്കാമോ?");
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
