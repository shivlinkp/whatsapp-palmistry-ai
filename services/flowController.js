import { extractFacts } from "../utils/extractFacts.js";
import { isValidMessage } from "../utils/inputGuard.js";

/* ---------------- SESSION MISSING INFO ---------------- */

function sessionMissingInfo(session) {
  if (!session.name) return "Name പറയാമോ?";
  if (!session.dob) return "Date of Birth പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return "";
}

/* ---------------- HAND REQUEST ---------------- */

function getHandRequest(session) {
  if (session.gender === "male") {
    return "ദയവായി നിങ്ങളുടെ വലത് കൈയുടെ വ്യക്തമായ ഫോട്ടോ അയക്കൂ ߓ";
  }
  return "ദയവായി നിങ്ങളുടെ ഇടത് കൈയുടെ വ്യക്തമായ ഫോട്ടോ അയക്കൂ ߓ";
}

/* ---------------- MAIN FLOW ---------------- */

export async function handleFlow({
  message,
  session,
  from,
  detectIntent,
  safeReply,
  sendPaymentRequest,
  humanReply
}) {
  let userMessage = "";

  /* Extract text */
  if (message.type === "text") {
    userMessage = message.text?.body?.trim() || "";
  }

  if (!session.history) session.history = [];

  session.replied = false;

  /* Validate message */
  if (!isValidMessage(userMessage)) {
    await safeReply(
      from,
      session,
      "ക്ഷമിക്കണം ߙ ദയവായി വ്യക്തമായി എഴുതൂ."
    );
    return;
  }

  /* Extract facts (IMPORTANT FIX) */
  extractFacts(session, userMessage);

  /* Detect intent */
  const intent = detectIntent(userMessage);

  /* ---------------- GREETING ---------------- */
  if (intent === "GREETING" && session.history.length === 0) {
    await safeReply(
      from,
      session,
`Hi ߑ

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

ߔ നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും

❤️ സ്നേഹവും ബന്ധങ്ങളും

ߒ വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും

ߒ ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ

ߒ സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും

ߌ ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും

ߓ നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ

✍ߏ Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.`
    );

    session.history.push({ role: "assistant", content: "welcome" });
    return;
  }

  /* ---------------- MISSING INFO ---------------- */
  const missing = sessionMissingInfo(session);
  if (missing) {
    await safeReply(from, session, missing);
    return;
  }

  /* ---------------- PALM PHOTO ---------------- */
  if (!session.palmPhotoReceived) {
    session.palmPhotoReceived = true;

    await safeReply(from, session, getHandRequest(session));
    return;
  }

  /* ---------------- PAYMENT FLOW ---------------- */
  if (!session.paymentRequested) {
    session.paymentRequested = true;

    await sendPaymentRequest(from, session);

    await safeReply(
      from,
      session,
      "Payment ചെയ്ത ശേഷം screenshot ഇവിടെ അയക്കൂ ߙ"
    );

    return;
  }

  /* ---------------- PAYMENT WAIT ---------------- */
  if (!session.paymentConfirmed) {
    await safeReply(
      from,
      session,
      "Payment screenshot ലഭിച്ചു. പരിശോധിക്കുന്നു... ⏳"
    );
    return;
  }

  /* ---------------- AI RESPONSE ---------------- */
  const reply = await humanReply(session, userMessage);

  await safeReply(from, session, reply);

  session.history.push({ role: "user", content: userMessage });
  session.history.push({ role: "assistant", content: reply });
}
