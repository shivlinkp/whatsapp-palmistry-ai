import { extractFacts } from "../utils/extractFacts.js";
import { isValidMessage } from "../utils/inputGuard.js";

export async function handleFlow({
  message,
  session,
  from,
  safeReply,
  sendPaymentRequest,
  handRequest,
  humanReply
}) {

  let text = "";

  if (message.type === "text") {
    text = message.text?.body?.trim() || "";
  }

  session.replied = false;

  if (!isValidMessage(text)) {
    await safeReply(from, session, "ദയവായി ശരിയായ message അയക്കൂ ߙ");
    return;
  }

  // Save facts
  extractFacts(session, text);

  const isFirstMessage = session.step === undefined;

  // STEP SYSTEM (IMPORTANT FIX)
  if (!session.step) session.step = "WELCOME";

  /* ---------------- WELCOME ---------------- */
  if (session.step === "WELCOME") {

    session.step = "GET_NAME";

    await safeReply(from, session, `Hi ߑ

₹99 കൈരേഖാ വിശകലനത്തിൽ നിങ്ങൾക്ക് ലഭിക്കുന്നത്:

ߔ നിങ്ങളുടെ സ്വഭാവവും വ്യക്തിത്വവും  
❤️ സ്നേഹവും ബന്ധങ്ങളും  
ߒ വിവാഹ സാധ്യതകളും കുടുംബജീവിതവും  
ߒ ജോലി, കരിയർ, ബിസിനസ് സാധ്യതകൾ  
ߒ സാമ്പത്തിക വളർച്ചയും ധനകാര്യ സൂചനകളും  
ߌ ഭാവിയിലെ പ്രധാന അവസരങ്ങളും വെല്ലുവിളികളും  
ߓ നിങ്ങളുടെ കൈരേഖയിലെ പ്രത്യേക സൂചനകൾ  

✍ߏ Name, Date of Birth, Gender പറയാമോ?

✨ ഫീസ്: ₹99 മാത്രം.`);

    return;
  }

  /* ---------------- NAME STEP ---------------- */
  if (session.step === "GET_NAME") {

    if (!session.name) {
      session.name = text;
      await safeReply(from, session, "Date of Birth പറയാമോ? (DD/MM/YYYY)");
      session.step = "GET_DOB";
      return;
    }
  }

  /* ---------------- DOB STEP ---------------- */
  if (session.step === "GET_DOB") {

    if (!session.dob) {
      session.dob = text;
      await safeReply(from, session, "Gender പറയാമോ? (Male / Female)");
      session.step = "GET_GENDER";
      return;
    }
  }

  /* ---------------- GENDER STEP ---------------- */
  if (session.step === "GET_GENDER") {

    if (!session.gender) {
      session.gender = text.toLowerCase();

      await safeReply(
        from,
        session,
        "നന്ദി ߙ\n\nഇപ്പോൾ നിങ്ങളുടെ കൈയുടെ clear photo അയക്കൂ (Right/Left hand)"
      );

      session.step = "WAIT_PHOTO";
      return;
    }
  }

  /* ---------------- WAIT PHOTO ---------------- */
  if (session.step === "WAIT_PHOTO") {

    if (message.type === "image") {

      session.palmPhotoReceived = true;

      await sendPaymentRequest(from, session);

      await safeReply(
        from,
        session,
        "ߓ Payment received ചെയ്ത ശേഷം 25–30 minutes കാത്തിരിക്കൂ. Report തയ്യാറാക്കുന്നു..."
      );

      session.step = "WAIT_PAYMENT";
      return;
    }

    await safeReply(from, session, "ദയവായി hand photo അയക്കൂ ߙ");
    return;
  }

  /* ---------------- PAYMENT STEP ---------------- */
  if (session.step === "WAIT_PAYMENT") {

    await safeReply(from, session, "Payment screenshot കിട്ടിയാൽ report process തുടങ്ങും.");
    return;
  }

  /* ---------------- DEFAULT ---------------- */
  await safeReply(from, session, "OK ߑ");
}
