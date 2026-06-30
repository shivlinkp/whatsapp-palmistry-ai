export async function handleFlow({
  message,
  session,
  from,
  detectIntent,
  safeReply,
  extractFacts,
  sendPaymentRequest,
  handRequest,
  humanReply
}) {
  let userMessage = "";

  // 1. Extract message
  if (message.type === "text") {
    userMessage = message.text?.body || "";
  }

  // 2. Update session
  session.replied = false;

  // 3. Intent detection
  const intent = detectIntent(userMessage);

  // 4. GREETING FLOW (clean exit)
  if (intent === "GREETING" && session.history.length === 0) {
    await safeReply(from, session, "Hi ߑ How can I help you today?");
    session.replied = true;
    return;
  }

  // 5. PAYMENT FLOW
  if (session.paymentRequested && !session.paymentConfirmed) {
    await sendPaymentRequest(from, session);
    session.replied = true;
    return;
  }

  // 6. MISSING INFO FLOW
  const missing = sessionMissingInfo(session);
  if (missing) {
    await safeReply(from, session, missing);
    session.replied = true;
    return;
  }

  // 7. NORMAL AI RESPONSE
  const reply = await humanReply(session, userMessage);

  await safeReply(from, session, reply);
  session.replied = true;
}
