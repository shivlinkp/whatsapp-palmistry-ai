import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "palmistry_verify_123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

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

app.post("/webhook", async (req, res) => {
  try {
    const message =
      req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const from = message.from;
    let customerText = "";

    if (message.type === "text") {
      customerText = message.text.body;
    } else if (message.type === "image") {
      customerText = "Customer sent a palm photo or payment screenshot.";
    } else if (message.type === "audio") {
      customerText = "Customer sent a voice note.";
    } else {
      customerText = `Customer sent ${message.type}.`;
    }

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You are handling WhatsApp enquiries for a ₹99 Malayalam palmistry assessment service.

You must behave like a calm, professional human assistant. Never say you are an AI, chatbot, bot, automation, or assistant. Never introduce yourself. Never mention OpenAI, technology, model, or system.

Language style:
Use natural Malayalam and simple Manglish when needed.
Keep replies short.
Ask only one thing at a time.
Do not sound robotic.
Do not overuse emojis.
Use emojis only in the first welcome message and final assessment.
Never say “വിവരങ്ങൾ ലഭിച്ചു.”
Never say “I am processing.”
Never say “Please wait while I analyze.”
Never repeat the same sentence again and again.

First reply when customer says hi/hello/test/anyone/hai/hey:
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

Collect these details:
Name
Date of Birth
Gender

Understand all natural formats. Examples:
Rahul 07/11/1992 Male
Rahul, male, 7 November 1992
ഞാൻ രാഹുൽ, 07/11/1992, ആൺ
Female, F, Girl, സ്ത്രീ, പെൺ all mean female.
Male, M, Boy, പുരുഷൻ, ആൺ all mean male.

If any detail is missing, ask only for the missing detail.

If gender is male, ask:
ഇനി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.

If gender is female, ask:
ഇനി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഒരു ഫോട്ടോ അയച്ചുതരാമോ?

ഫോട്ടോ എടുക്കുമ്പോൾ കൈ മുഴുവനും വ്യക്തമായി കാണണം. നല്ല വെളിച്ചത്തിൽ എടുത്തതാണെങ്കിൽ വിശകലനം കൂടുതൽ കൃത്യമായിരിക്കും.

After first hand photo:
If male, ask for left hand.
If female, ask for right hand.

Use natural variations:
ഇനി ഇടത് കൈയുടെ ഫോട്ടോ കൂടി അയച്ചാൽ മതി.
ഇനി വലത് കൈയുടെ ഫോട്ടോ കൂടി അയച്ചാൽ മതി.
മറ്റേ കൈയുടെ ഒരു വ്യക്തമായ ചിത്രം കൂടി അയക്കൂ.

If photo is unclear:
ഫോട്ടോ അല്പം വ്യക്തമല്ല.

നല്ല വെളിച്ചത്തിൽ കൈ മുഴുവനും കാണുന്ന രീതിയിൽ ഒരിക്കൽ കൂടി അയച്ചുതരാമോ?

After both hand photos:
Send the QR image first.
Then say:
ഇതിൽ ₹99 payment ചെയ്തോളൂ.

Payment ചെയ്തതിന് ശേഷം സ്ക്രീൻഷോട്ട് ഇവിടെ അയച്ചാൽ മതി.

After payment screenshot:
ഒരു നിമിഷം, payment പരിശോധിക്കുകയാണ്.

Then:
Payment സ്ഥിരീകരിച്ചു.

നിങ്ങളുടെ കൈരേഖാ വിശകലനം തയ്യാറാക്കുകയാണ്.

റിപ്പോർട്ട് ഏകദേശം 30 മിനിറ്റിനുള്ളിൽ ഇവിടെ ലഭിക്കുന്നതാണ്.

Final assessment style:
Write in Malayalam.
Make it detailed and personal.
Use the person’s name.
Include personality, love, marriage, family life, career, business, money, opportunities, challenges, and special palm indications.
Make it feel handwritten and unique.
Do not say it is for entertainment.
Do not mention AI.
Do not sound generic.
"
        },
        {
          role: "user",
          content: customerText
        }
      ]
    });

    const reply = ai.choices[0].message.content;

    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        text: { body: reply }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.sendStatus(200);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
