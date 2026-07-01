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

/* ---------------- SESSION ---------------- */

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, {
      name: "",
      dob: "",
      gender: "",
      mainQuestion: "",
      palmPhotoReceived: false,
      paymentRequested: false,
      paymentScreenshotReceived: false,
      paymentConfirmed: false,
      reportSent: false,
      history: [],
      replied: false,
      lastIntent: ""
    });
  }
  return sessions.get(phone);
}

/* ---------------- UTIL ---------------- */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(min, max) {
  return (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
}

/* ---------------- WHATSAPP SEND ---------------- */

async function sendText(to, text) {
  if (!text) return;

  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
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

/* ---------------- SAFE REPLY (FIXED) ---------------- */

async function safeReply(from, session, text) {
  if (session.replied) return;

  session.replied = true;
  await sendText(from, text);
}

/* ---------------- INTENT ---------------- */

function isGreeting(text) {
  const t = text.toLowerCase();
  return ["hi", "hello", "hai", "hey"].some(x => t.includes(x));
}

/* ---------------- BASIC FLOW HELPERS ---------------- */

function missingInfo(session) {
  if (!session.name) return "Name കൂടി പറയാമോ?";
  if (!session.dob) return "Date of Birth കൂടി പറയാമോ?";
  if (!session.gender) return "Gender പറയാമോ?";
  return "";
}

function handRequest(session) {
  return `Please send your palm photo clearly.`;
}

/* ---------------- PAYMENT ---------------- */

async function sendPaymentRequest(to, session) {
  if (session.paymentRequested) return;

  session.paymentRequested = true;

  if (QR_IMAGE_URL) {
    await sendImage(to, QR_IMAGE_URL);
  }

  await sendText(
    to,
    `₹99 payment ചെയ്യുക. Screenshot അയച്ചാൽ report process ചെയ്യും.`
  );
}

/* ---------------- REPORT ---------------- */

async function generateAssessment(session) {
  const prompt = `Write Malayalam palm reading for:
Name:${session.name}
DOB:${session.dob}
Gender:${session.gender}`;

  const res = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.8
  });

  return res.choices[0].message.content;
}

function scheduleAssessment(to, session) {
  setTimeout(async () => {
    try {
      if (session.reportSent) return;

      const report = await generateAssessment(session);
      await sendText(to, report);

      session.reportSent = true;
    } catch (e) {
      console.error("Report error:", e.message);
    }
  }, 30 * 60 * 1000);
}

/* ---------------- WEBHOOK ---------------- */

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
  res.sendStatus(200);

  try {
    const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const session = getSession(from);
    session.replied = false;

    let userMessage = "";

    if (message.type === "text") {
      userMessage = message.text?.body || "";
    } else if (message.type === "image") {
      userMessage = "Customer sent image";
      session.palmPhotoReceived = true;
    } else {
      userMessage = `Customer sent ${message.type}`;
    }

    /* GREETING */
    if (isGreeting(userMessage) && session.history.length === 0) {
      await safeReply(from, session, "Hi ߑ Welcome!");
      session.history.push(userMessage);
      return;
    }

    /* MISSING INFO */
    const missing = missingInfo(session);
    if (missing) {
      await safeReply(from, session, missing);
      return;
    }

    /* PAYMENT FLOW */
    if (session.palmPhotoReceived && !session.paymentRequested) {
      await sendPaymentRequest(from, session);
      scheduleAssessment(from, session);
      return;
    }

    /* DEFAULT */
    await safeReply(from, session, "OK received. Working on it...");

  } catch (err) {
    console.error("Webhook error:", err.message);
  }
});

/* ---------------- START ---------------- */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
});
