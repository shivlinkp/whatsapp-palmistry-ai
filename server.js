import express from "express";

const app = express();
app.use(express.json({ limit: "25mb" }));

const sessions = new Map();

/* ---------------- SESSION ---------------- */

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      step: 0,
      palmPhoto: false
    });
  }
  return sessions.get(phone);
}

/* ---------------- WELCOME ---------------- */

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

/* ---------------- PARSER (FIXED CORE) ---------------- */

function parseUserMessage(text, session) {
  const t = text.toLowerCase();

  // NAME
  if (!session.name) {
    const nameMatch = text.match(/name[:\s-]*([a-zA-Z]+)/i);
    if (nameMatch) session.name = nameMatch[1].trim();
  }

  // DOB
  if (!session.dob) {
    const dobMatch = text.match(
      /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/
    );
    if (dobMatch) session.dob = dobMatch[0];
  }

  // GENDER
  if (!session.gender) {
    if (t.includes("male")) session.gender = "male";
    if (t.includes("female")) session.gender = "female";
  }
}

/* ---------------- FLOW ---------------- */

function getNextQuestion(session) {
  if (!session.name) return "Name പറയാമോ?";
  if (!session.dob) return "Date of Birth പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return null;
}

/* ---------------- WEBHOOK ---------------- */

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (!message) return res.sendStatus(200);

    const phone = message.from;
    const text = message.text?.body || "";

    const session = getSession(phone);

    // first time welcome
    if (!session.welcomed) {
      session.welcomed = true;
      return res.json({ reply: WELCOME });
    }

    // parse all info from SAME message
    parseUserMessage(text, session);

    // check missing
    const next = getNextQuestion(session);
    if (next) {
      return res.json({ reply: next });
    }

    // final step
    if (!session.palmPhoto) {
      session.palmPhoto = true;
      return res.json({
        reply:
          "ശരി ߑ\nഇപ്പോൾ നിങ്ങളുടെ കൈരേഖ ഫോട്ടോ അയക്കൂ (right/left hand clear photo)."
      });
    }

    return res.json({
      reply: "ഞാൻ നിങ്ങളുടെ റിപ്പോർട്ട് തയ്യാറാക്കുന്നു..."
    });
  } catch (err) {
    console.log(err);
    res.sendStatus(200);
  }
});

/* ---------------- SERVER ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
