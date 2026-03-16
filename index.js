const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation store (keyed by phone number)
const conversations = {};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Priya, a warm and friendly client relations executive at One Horizon Productions — a premium wedding photography studio based in Bangalore. You speak in a natural, conversational tone — like a real person, not a bot. Never say you are an AI or a bot.

Your job is to warmly welcome new leads, share our portfolio, and collect the details our team needs to prepare a personalised quote.

PORTFOLIO LINK: https://onehorizonproductions.com (replace with real link)

CONVERSATION FLOW:
1. Greet them warmly using their first name. Congratulate them on their upcoming wedding. Share the portfolio link and ask if they've had a chance to look at our work.
2. Once they respond, ask for their wedding date.
3. Ask for their venue name and city.
4. Ask how many events they'd like covered (e.g. engagement shoot, mehendi, haldi, wedding, reception).
5. Ask for a rough budget range they have in mind for photography and videography.
6. Once you have all four details, warmly wrap up — tell them our team will prepare a personalised package and get back to them within a few hours. Thank them genuinely.

RULES:
- Ask ONE question at a time. Never list multiple questions together.
- Keep messages short — 2-4 sentences max. People are on WhatsApp, not reading an email.
- Be warm, human, and celebratory. This is one of the biggest days of their life.
- If they ask about pricing before you've collected details, say pricing depends on their specific requirements and you'd love to understand their vision first.
- If they ask something you can't answer (specific packages, availability), say "Let me have our team check that for you and get back to you shortly!"
- Never make up prices or availability.
- Once all 4 details are collected, add the text "%%QUOTE_READY%%" at the very end of your final message (hidden from client — this is a system signal).

DETAILS TO COLLECT:
1. Wedding date
2. Venue name + city  
3. Number and type of events
4. Budget range`;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function getHistory(phone) {
  if (!conversations[phone]) conversations[phone] = [];
  return conversations[phone];
}

function saveMessage(phone, role, content) {
  if (!conversations[phone]) conversations[phone] = [];
  conversations[phone].push({ role, content });
  // Keep last 40 messages to stay within token limits
  if (conversations[phone].length > 40) {
    conversations[phone] = conversations[phone].slice(-40);
  }
}

async function sendWhatsApp(to, message) {
  const cleanMessage = message.replace("%%QUOTE_READY%%", "").trim();
  await axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: cleanMessage },
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

async function notifySalesTeam(phone, history) {
  // Build a clean quote brief from conversation history
  const transcript = history
    .map((m) => `${m.role === "user" ? "Client" : "Priya"}: ${m.content}`)
    .join("\n");

  const brief = `🎉 *New Quote Request — One Horizon Productions*\n\n*Client number:* ${phone}\n\n*Conversation summary:*\n${transcript}\n\n_Please prepare a personalised package for this client._`;

  // Send to your sales team WhatsApp number
  if (process.env.SALES_TEAM_NUMBER) {
    await sendWhatsApp(process.env.SALES_TEAM_NUMBER, brief);
  }

  console.log(`Quote brief sent to sales team for ${phone}`);
}

async function getChatReply(phone, userMessage, clientName = "") {
  saveMessage(phone, "user", userMessage);
  const history = getHistory(phone);

  const systemWithName = clientName
    ? `${SYSTEM_PROMPT}\n\nThe client's name is ${clientName}.`
    : SYSTEM_PROMPT;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    system: systemWithName,
    messages: history,
  });

  const reply = response.content[0].text;
  saveMessage(phone, "assistant", reply);

  // Check if all quote details have been collected
  if (reply.includes("%%QUOTE_READY%%")) {
    await notifySalesTeam(phone, history);
  }

  return reply;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Meta webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    const contact = change?.value?.contacts?.[0];

    if (!message || message.type !== "text") return res.sendStatus(200);

    const phone = message.from;
    const userText = message.text.body;
    const clientName = contact?.profile?.name || "";

    console.log(`Message from ${phone} (${clientName}): ${userText}`);

    const reply = await getChatReply(phone, userText, clientName);
    await sendWhatsApp(phone, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error("Error handling message:", err?.response?.data || err.message);
    res.sendStatus(200); // Always return 200 to Meta
  }
});

// New lead trigger from Zapier — fires the first message
app.post("/new-lead", async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });

    // Format phone: remove spaces, ensure country code
    const cleanPhone = phone.replace(/\D/g, "");

    console.log(`New lead: ${name} (${cleanPhone})`);

    const firstMessage = await getChatReply(
      cleanPhone,
      `Hi, I'm interested in wedding photography. My name is ${name || "there"}.`,
      name || ""
    );

    await sendWhatsApp(cleanPhone, firstMessage);
    res.json({ success: true, phone: cleanPhone });
  } catch (err) {
    console.error("Error sending first message:", err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "One Horizon Bot is running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
