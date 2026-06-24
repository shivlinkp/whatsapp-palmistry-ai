import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const QR_IMAGE_URL = process.env.QR_IMAGE_URL || "";

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sessions = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min, max) =>
  delay((Math.floor(Math.random() * (max - min + 1)) + min) * 1000);

app.get("/", (req, res) => {
  res.send("Palmistry WhatsApp bot is running ✅");
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

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      stage: "new",
      name: "",
      dob: "",
      gender: "",
      firstHandReceived: false,
      secondHandReceived: false,
      paymentReceived: false,
      history: [],
    });
  }
  return sessions.get(phone);
}

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

async function sendImage(to, imageUrl, caption = "") {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: {
        link: imageUrl,
        caption,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

const welcomeMessage = `Hi 👋

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

function looksLikeGreeting(text) {
  const t = text.toLowerCase().trim();
  return ["hi", "hello", "hey", "hai", "test", "anyone", "halo"].some((x) =>
    t.includes(x)
  );
}

function detectGender(text) {
  const t = text.toLowerCase();

  if (
    t.includes("female") ||
    t.includes("girl") ||
    t.includes("woman") ||
    t.includes("സ്ത്രീ") ||
    t.includes("പെൺ") ||
    t.includes("പെണ്ണ്")
  ) {
    return "female";
  }

  if (
    t.includes("male") ||
    t.includes("boy") ||
    t.includes("man") ||
    t.includes("പുരുഷൻ") ||
    t.includes("ആൺ") ||
    t.includes("ആണ്")
  ) {
    return "male";
  }

  return "";
}

async function extractDetails(session, text) {
  const prompt = `
Extract customer details from this WhatsApp message.

Message:
${text}

Return only valid JSON like this:
{
  "name": "",
  "dob": "",
  "gender": ""
}

Rules:
- gender must be "male", "female", or "".
- Understand Malayalam, English and Manglish.
- If a value is missing, keep it empty.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
  });

  try {
    const json = JSON.parse(response.choices[0].message.content);
    if (json.name && !session.name) session.name = json.name;
    if (json.dob && !session.dob) session.dob = json.dob;
    if (json.gender && !session.gender) session.gender = json.gender;
  } catch {
    const gender = detectGender(text);
    if (gender && !session.gender) session.gender = gender;
  }
}

function missingDetailsReply(session) {
  if (!session.name && !session.dob && !session.gender) {
    return "Name, Date of Birth, Gender പറയാമോ?";
  }

  if (!session.name) return "Name കൂടി പറയാമോ?";
  if (!session.dob) return "Date of Birth കൂടി പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";

  return "";
}

function firstHandMessage(session) {
  if (session.gender === "male") {
    return `ഇനി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.`;
  }

  return `ഇനി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.`;
}

function secondHandMessage(session) {
  if (session.gender === "male") {
    return "ഇനി ഇടത് കൈയുടെ ഫോട്ടോ കൂടി അയച്ചാൽ മതി.";
  }

  return "ഇനി വലത് കൈയുടെ ഫോട്ടോ കൂടി അയച്ചാൽ മതി.";
}

async function generateFinalAssessment(session) {
  const prompt = `
Write a detailed Malayalam palmistry assessment.

Customer details:
Name: ${session.name}
Date of Birth: ${session.dob}
Gender: ${session.gender}

Style:
- Write like an experienced palmistry consultant.
- Make it personal and satisfying.
- Do not mention AI.
- Do not mention entertainment.
- Use emojis only inside the final report where it feels natural.
- Include personality, love, marriage, family life, career, business, money, opportunities, challenges, and special palm indications.
- Make it detailed and premium.
`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8,
  });

  return response.choices[0].message.content.trim();
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const session = getSession(from);

    if (message.type === "text") {
      const text = message.text.body;

      if (session.stage === "new" && looksLikeGreeting(text)) {
        session.stage = "collecting_details";
        await sendText(from, welcomeMessage);
        return;
      }

      await extractDetails(session, text);

      const missing = missingDetailsReply(session);
      await randomDelay(12, 18);

      if (missing) {
        await sendText(from, missing);
        return;
      }

      if (session.stage === "collecting_details" || session.stage === "new") {
        session.stage = "waiting_first_hand";
        await sendText(from, firstHandMessage(session));
        return;
      }

      await sendText(from, "കൈയുടെ വ്യക്തമായ ഫോട്ടോ അയച്ചുതരാമോ?");
      return;
    }

    if (message.type === "image") {
      if (session.stage === "waiting_first_hand") {
        session.firstHandReceived = true;
        session.stage = "waiting_second_hand";

        await randomDelay(15, 20);
        await sendText(from, secondHandMessage(session));
        return;
      }

      if (session.stage === "waiting_second_hand") {
        session.secondHandReceived = true;
        session.stage = "waiting_payment";

        await randomDelay(15, 20);

        if (QR_IMAGE_URL) {
          await sendImage(from, QR_IMAGE_URL);
        }

        await sendText(
          from,
          `ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.`
        );
        return;
      }

      if (session.stage === "waiting_payment") {
        session.paymentReceived = true;
        session.stage = "payment_confirmed";

        await randomDelay(5, 10);
        await sendText(from, "ഒരു നിമിഷം.");

        await randomDelay(5, 8);
        await sendText(
          from,
          `Payment സ്ഥിരീകരിച്ചു.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

റിപ്പോർട്ട് ഏകദേശം 30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കുന്നതാണ്.`
        );

        setTimeout(async () => {
          try {
            const report = await generateFinalAssessment(session);
            await sendText(from, report);
            session.stage = "completed";
          } catch (err) {
            console.error("Final report error:", err.message);
          }
        }, 30 * 60 * 1000);

        return;
      }

      await sendText(from, "Name, Date of Birth, Gender ആദ്യം അയച്ചുതരാമോ?");
      return;
    }

    if (message.type === "audio") {
      await randomDelay(12, 18);
      await sendText(
        from,
        "Voice note കിട്ടി. Name, Date of Birth, Gender text ആയി അയച്ചാൽ മതി."
      );
      return;
    }

    await sendText(from, "Message കിട്ടി. Name, Date of Birth, Gender പറയാമോ?");
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});
