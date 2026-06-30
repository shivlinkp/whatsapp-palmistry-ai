import { isValidMessage } from "../utils/inputGuard.js";

export async function handleFlow({
  message,
  session,
  from,
  detectIntent,
  safeReply,
  extractFacts,
  sendPaymentRequest,
  handRequest,
  humanReply,
  sessionMissingInfo
}) {

  let userMessage = "";

  // Extract text
  if (message.type === "text") {
    userMessage = message.text?.body?.trim() || "";
  }

  // Reset reply flag for this message
  session.replied = false;

  // Ignore invalid messages
  if (!isValidMessage(userMessage)) {
    await safeReply(
      from,
      session,
      "ക്ഷമിക്കണം, സന്ദേശം മനസ്സിലായില്ല. ദയവായി വ്യക്തമായി എഴുതൂ."
    );
    return;
  }

  // Learn facts from user message
  await extractFacts(session, userMessage);

  // Detect intent
  const intent = detectIntent(userMessage);

  // Greeting
  if (intent === "GREETING" && session.history.length === 0) {
    await safeReply(
      from,
      session,
      "നമസ്കാരം ߘ ഞാൻ നിങ്ങളുടെ കൈരേഖാ വിശകലനത്തിനായി സഹായിക്കാം."
    );
    return;
  }

  // Waiting for payment
  if (session.paymentRequested && !session.paymentConfirmed) {
    await sendPaymentRequest(from, session);
    return;
  }

  // Missing information
  const missing = sessionMissingInfo(session);

  if (missing) {
    await safeReply(from, session, missing);
    return;
  }

  // Ask for palm photo
  if (!session.palmPhotoReceived) {
    await safeReply(
      from,
      session,
      handRequest(session)
    );
    return;
  }

  // AI reply
  const reply = await humanReply(session, userMessage);

  await safeReply(from, session, reply);

  // Save history
  session.history.push({
    role: "user",
    content: userMessage
  });

  session.history.push({
    role: "assistant",
    content: reply
  });

}
