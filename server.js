import express from "express";

const app = express();
app.use(express.json());

const sessions = new Map();

/* -------------------- SESSION -------------------- */
function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      step: "WELCOME",
      name: "",
      dob: "",
      gender: "",
      palmPhoto: false,
      payment: false,
      history: []
    });
  }
  return sessions.get(phone);
}

/* -------------------- WELCOME MESSAGE -------------------- */
const WELCOME = `Hi ߑ

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

• സ്വഭാവവും വ്യക്തിത്വവും  
• സ്നേഹവും ബന്ധങ്ങളും  
• വിവാഹവും കുടുംബജീവിതവും  
• ജോലി, കരിയർ, ബിസിനസ്  
• സാമ്പത്തിക അവസ്ഥ  
• ഭാവി സാധ്യതകൾ  

ߓ Name, Date of Birth, Gender പറയാമോ?

ߒ ഫീസ്: ₹99 മാത്രം.`;

/* -------------------- SIMPLE INTENT CHECK -------------------- */
function isQuestion(text) {
  const t = text.toLowerCase();
  return (
    t.includes("?") ||
    t.includes("what") ||
    t.includes("how") ||
    t.includes("why") ||
    t.includes("price") ||
    t.includes("details")
  );
}

/* -------------------- MAIN REPLY ENGINE -------------------- */
function generateReply(session, message) {
  const text = message.toLowerCase();

  // FAQ / doubts → human-like reply
  if (isQuestion(message)) {
    if (text.includes("price") || text.includes("99")) {
      return "₹99 മാത്രമാണ് ߘ full palm reading report നിങ്ങൾക്ക് ലഭിക്കും.";
    }

    if (text.includes("what") || text.includes("details")) {
      return "നിങ്ങളുടെ കൈരേഖ പരിശോധിച്ച് personality, love, career, finance എല്ലാം വിശദമായി നൽകും.";
    }

    return "നിങ്ങൾക്ക് സംശയം പറയാം ߘ ഞാൻ വിശദമായി explain ചെയ്യും.";
  }

  // FLOW CONTROL
  if (!session.name) {
    session.step = "NAME";
    return "നിങ്ങളുടെ Name പറയാമോ?";
  }

  if (!session.dob) {
    session.step = "DOB";
    return "Date of Birth പറയാമോ?";
  }

  if (!session.gender) {
    session.step = "GENDER";
    return "Gender (Male / Female) പറയാമോ?";
  }

  if (!session.palmPhoto) {
    session.step = "PHOTO";
    return "Right hand (male) / Left hand (female) photo അയക്കാമോ?";
  }

  if (!session.payment) {
    session.step = "PAYMENT";
    return "₹99 payment confirm ചെയ്താൽ analysis start ചെയ്യും ߘ";
  }

  return "നന്ദി ߘ നിങ്ങളുടെ analysis തയ്യാറാക്കുന്നു.";
}

/* -------------------- WEBHOOK -------------------- */
app.post("/webhook", async (req, res) => {
  const msg = req.body;
  const phone = msg.from;
  const text = msg.text || "";

  const session = getSession(phone);

  // save history
  session.history.push(text);

  // FIRST MESSAGE
  if (!session.name && session.step === "WELCOME") {
    session.step = "NAME";
    return res.json({ reply: WELCOME });
  }

  // STORE DATA
  if (session.step === "NAME" && session.name === "") {
    session.name = text;
  } else if (session.step === "DOB" && session.dob === "") {
    session.dob = text;
  } else if (session.step === "GENDER" && session.gender === "") {
    session.gender = text;
  } else if (session.step === "PHOTO") {
    session.palmPhoto = true;
  } else if (session.step === "PAYMENT") {
    if (text.includes("paid") || text.includes("screenshot")) {
      session.payment = true;
    }
  }

  // GENERATE RESPONSE
  const reply = generateReply(session, text);

  return res.json({ reply });
});

/* -------------------- START SERVER -------------------- */
app.listen(8080, () => {
  console.log("Bot running on port 8080");
});
