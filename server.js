import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "20mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sessions = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      history: [],
    });
  }
  return sessions.get(phone);
}

app.get("/", (req, res) => {
  res.send("Palmistry GPT WhatsApp bot is running ✅");
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
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function sendImage(to, imageUrl) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

const systemPrompt = `
You are handling WhatsApp enquiries for a ₹99 Malayalam palmistry assessment service.

You must behave like a calm human staff member.
Never say you are AI, chatbot, automation, OpenAI, model, or system.
Never introduce yourself.
Never say "assistant".
Never sound robotic.
Use emojis only in the first welcome message and final assessment.
Normal replies must be short, natural and human.
Ask only one thing at a time.
Never ask for information already given.
Understand Malayalam, English and Manglish.

Main flow:
1. If customer says hi, hello, hey, hai, test, anyone, or starts a new enquiry, send the welcome message.
2. Collect Name, Date of Birth and Gender.
3. If any detail is missing, ask only for the missing detail.
4. If Gender is Male, ask for right hand photo first.
5. If Gender is Female, ask for left hand photo first.
6. After first hand photo, ask for the other hand.
7. After both hand photos, tell the system to send QR.
8. After QR is sent, ask customer to pay ₹99 and send screenshot.
9. After payment screenshot, say "ഒരു നിമിഷം."
10. Then confirm payment and say report will be sent in about 30 minutes.
11. If final report is needed, write a detailed Malayalam palmistry assessment.

Welcome message must be exactly:

Hi 👋

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

🔮 നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും

❤️ സ്നേഹവും ബന്ധങ്ങളും

💍 വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും

💼 ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ

💰 സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും

🌟 ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും

📌 നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

✍🏻 Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.

Male first hand message:
ഇനി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.

Female first hand message:
ഇനി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.

After QR:
ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.

Final assessment:
Write in Malayalam.
Make it detailed, personal, premium and satisfying.
Include personality, love, marriage, family life, career, business, money, opportunities, challenges and special palm indications.
Never mention AI.
Never add disclaimers.

Return ONLY JSON:
{
  "reply": "message to send to customer",
  "action": "none | send_qr | final_report",
  "delay_seconds": 15
}
`;

async function askGPT(session, userMessage) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...session.history,
    { role: "user", content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    messages,
  });

  const raw = response.choices[0].message.content.trim();

  try {
    const cleaned = raw.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return {
      reply: raw,
      action: "none",
      delay_seconds: 15,
    };
  }
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
      userMessage = message.text.body;
    } else if (message.type === "image") {
      userMessage = "Customer sent an image/photo.";
    } else if (message.type === "audio") {
      userMessage = "Customer sent a voice note.";
    } else {
      userMessage = `Customer sent ${message.type}.`;
    }

    const result = await askGPT(session, userMessage);

    const delaySeconds =
      typeof result.delay_seconds === "number"
        ? result.delay_seconds
        : Math.floor(Math.random() * 7) + 12;

    await sleep(delaySeconds * 1000);

    if (result.action === "send_qr" && QR_IMAGE_URL) {
      await sendImage(from, QR_IMAGE_URL);
      await sleep(2000);
    }

    if (result.reply) {
      await sendText(from, result.reply);
    }

    session.history.push({ role: "user", content: userMessage });
    session.history.push({
      role: "assistant",
      content: result.reply || "",
    });
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
