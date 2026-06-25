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
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      }
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
      }
    }
  );
}

function isGreeting(text) {
  const t = text.toLowerCase().trim();
  return ["hi", "hai", "hello", "hey", "test", "anyone", "ഹായ്"].some((x) =>
    t.includes(x)
  );
}

async function downloadWhatsAppMedia(mediaId, extension = "ogg") {
  const meta = await axios.get(
    `https://graph.facebook.com/v20.0/${mediaId}`,
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    }
  );

  const mediaUrl = meta.data.url;

  const media = await axios.get(mediaUrl, {
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

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1"
    });

    fs.unlinkSync(filePath);
    return transcription.text || "";
  } catch (error) {
    console.error("Audio transcription error:", error.message);
    return "";
  }
}

async function extractFacts(session, userMessage) {
  const prompt = `
Extract customer information from this WhatsApp message.

Existing information:
Name: ${session.name}
Date of birth: ${session.dob}
Gender: ${session.gender}
Main question: ${session.mainQuestion}

New message:
${userMessage}

Return only JSON:
{
  "name": "",
  "dob": "",
  "gender": "",
  "mainQuestion": ""
}

Rules:
- Use existing information if still valid.
- Gender must be "male", "female", or "".
- Understand Malayalam, English, and Manglish.
- Female words: female, f, girl, woman, സ്ത്രീ, പെൺ, പെണ്ണ്.
- Male words: male, m, boy, man, പുരുഷൻ, ആൺ.
- mainQuestion can be marriage, job, money, love, abroad, children, family, business, or whatever they ask.
`;

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [{ role: "user", content: prompt }]
    });

    const raw = res.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    const data = JSON.parse(cleaned);

    if (data.name) session.name = data.name;
    if (data.dob) session.dob = data.dob;
    if (data.gender) session.gender = data.gender;
    if (data.mainQuestion) session.mainQuestion = data.mainQuestion;
  } catch (error) {
    console.error("Extract facts error:", error.message);
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
    return `ഇനി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.`;
  }

  return `ഇനി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.`;
}

async function humanReply(session, userMessage) {
  const system = `
You are replying on WhatsApp for a ₹99 Malayalam palmistry assessment service.

Behave like a calm human staff member.
Never say you are AI, chatbot, automation, assistant, OpenAI, model, or system.
Never introduce yourself.
Always answer the customer's question first.
Then gently continue the palmistry assessment process.
Use natural Malayalam and simple Manglish.
Keep normal replies short.
No emojis except welcome message and final assessment.
Never sound robotic.
Never ask again for information already collected.

Business flow:
Required before payment:
- Name
- Date of Birth
- Gender
- One clear palm photo only

Male: ask for right hand photo.
Female: ask for left hand photo.

After one palm photo is received, send QR and payment instruction.
Do not ask for the other hand.
`;

  const state = `
Current customer state:
Name: ${session.name || "missing"}
DOB: ${session.dob || "missing"}
Gender: ${session.gender || "missing"}
Main question: ${session.mainQuestion || "not specified"}
Palm photo received: ${session.palmPhotoReceived}
Payment screenshot received: ${session.paymentScreenshotReceived}
Payment confirmed: ${session.paymentConfirmed}
Report sent: ${session.reportSent}
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages: [
      { role: "system", content: system },
      { role: "user", content: state },
      ...session.history.slice(-10),
      { role: "user", content: userMessage }
    ]
  });

  return res.choices[0].message.content.trim();
}

async function generateAssessment(session) {
  const prompt = `
Write a detailed Malayalam palmistry assessment.

Customer:
Name: ${session.name}
DOB: ${session.dob}
Gender: ${session.gender}
Main question: ${session.mainQuestion || "general life reading"}

Rules:
- Malayalam only.
- Premium, detailed, satisfying style.
- Do not mention AI.
- Do not add disclaimers.
- Use emojis naturally in the assessment.
- Include personality, love, marriage, family, career, job/business, money, opportunities, challenges, future indications, and special palm signs.
- If the customer asked a specific question, give that section extra focus.
- Make it one-click-copy friendly as one continuous report.
`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.85,
    messages: [{ role: "user", content: prompt }]
  });

  return res.choices[0].message.content.trim();
}

async function scheduleAssessment(phone, session) {
  setTimeout(async () => {
    try {
      if (session.reportSent) return;
      const report = await generateAssessment(session);
      await sendText(phone, report);
      session.reportSent = true;
    } catch (error) {
      console.error("Final report error:", error.message);
    }
  }, 30 * 60 * 1000);
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const session = getSession(from);

    let userMessage = "";

    if (message.type === "text") {
      userMessage = message.text.body || "";
    }

    if (message.type === "audio") {
      const audioId = message.audio?.id;
      const transcript = audioId ? await transcribeAudio(audioId) : "";
      userMessage = transcript || "Customer sent a voice note, but it was not clear.";
    }

    if (message.type === "image") {
      userMessage = "Customer sent an image.";
    }

    if (!userMessage) {
      userMessage = `Customer sent ${message.type}.`;
    }

    if (message.type === "text") {
      await extractFacts(session, userMessage);
    }

    if (message.type === "audio" && userMessage) {
      await extractFacts(session, userMessage);
    }

    if (message.type === "text" && isGreeting(userMessage) && session.history.length === 0) {
      await sleep(randomDelay(1, 2));
      await sendText(from, WELCOME);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "assistant", content: WELCOME });
      return;
    }

    if (message.type === "image") {
      if (!session.name || !session.dob || !session.gender) {
        session.palmPhotoReceived = true;
        await sleep(randomDelay(12, 18));
        await sendText(
          from,
          `കൈയുടെ ഫോട്ടോ ലഭിച്ചു.

വിശകലനം ആരംഭിക്കാൻ Name, Date of Birth, Gender കൂടി അയച്ചുതരാമോ?`
        );
        return;
      }

      if (!session.palmPhotoReceived) {
        session.palmPhotoReceived = true;
        await sleep(randomDelay(12, 18));

        if (QR_IMAGE_URL) {
          await sendImage(from, QR_IMAGE_URL);
          await sleep(2000);
        }

        await sendText(
          from,
          `ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.`
        );
        return;
      }

      if (!session.paymentConfirmed) {
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

        await scheduleAssessment(from, session);
        return;
      }
    }

    const missing = missingInfo(session);

    if (missing) {
      await sleep(randomDelay(12, 18));
      await sendText(from, missing);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "assistant", content: missing });
      return;
    }

    if (!session.palmPhotoReceived) {
      await sleep(randomDelay(12, 18));
      const reply = handRequest(session);
      await sendText(from, reply);
      session.history.push({ role: "user", content: userMessage });
      session.history.push({ role: "assistant", content: reply });
      return;
    }

    if (session.palmPhotoReceived && !session.paymentConfirmed) {
      await sleep(randomDelay(12, 18));
      const reply =
        "Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.";
      await sendText(from, reply);
      return;
    }

    await sleep(randomDelay(12, 18));
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
