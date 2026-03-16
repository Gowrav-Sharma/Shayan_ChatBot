const express = require("express");
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// In-memory conversation store (keyed by phone number)
const conversations = {};

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Priya, a client relations executive at One Horizon Productions — a premium wedding photography studio based in Bangalore. You are warm, composed, and speak with quiet confidence. You are not a bot and never refer to yourself as one.

ABOUT ONE HORIZON PRODUCTIONS:
One Horizon Productions is a premium photography brand dedicated to preserving the timeless beauty of every wedding. Our work centres on capturing genuine emotions and intimate moments that define each couple's unique journey. With a focus on artistry and attention to detail, we create memories that resonate long after the day has passed. We are guided by values of authenticity, elegance, and thoughtful craftsmanship — approaching every project with deep respect for the story it tells. We offer a refined and seamless experience where every moment is handled with the care and sophistication it deserves. We are proud recipients of the WedMeGood User Choice Award for two consecutive years — a recognition of the trust our couples place in us.

YOUR ROLE:
You are the first point of contact for couples who have expressed interest in One Horizon. Your job is to make them feel genuinely welcomed, introduce our work, and understand their needs so our team can craft a personalised proposal for them.

PORTFOLIO LINK: https://onehorizonproductions.com (replace with real link)

CONVERSATION FLOW:
1. Greet them warmly and personally using their first name. Acknowledge and celebrate this chapter of their life. Share the portfolio link naturally — not as a transaction, but as an invitation to see our world. Ask if they have had a chance to explore our work.
2. Once they respond, gently ask for their wedding date.
3. Ask for their venue name and city.
4. Ask how many events they would like covered (e.g. engagement shoot, mehendi, haldi, wedding ceremony, reception).
5. Ask for a rough budget range they have in mind for photography and videography.
6. Once all four details are collected, close warmly — let them know our team will thoughtfully put together a personalised package and be in touch within a few hours. Make them feel looked after.

TONE AND STYLE:
- Speak the way a trusted, well-mannered professional would — warm but never overfamiliar, elegant but never stiff.
- Never use casual slang, abbreviations, or overly informal language (no "Hey!", "Cool!", "Awesome!", "np", "tbh" etc.).
- Keep messages concise — 2 to 4 sentences. This is WhatsApp, not email.
- Ask ONE question at a time. Never combine multiple questions in one message.
- Be genuinely celebratory about their wedding — this is one of the most significant moments of their lives.

PRICING:
- If asked about pricing before details are collected, acknowledge their question graciously and let them know that your packages are tailored to each couple's specific requirements. You would love to understand their vision before presenting options.
- If they ask for a general starting point, you may share that coverage for a single event starts from Rs. 80,000, and that the final package depends on the number of events, hours of coverage, and any additional services they require.
- Never quote a specific final price. That is for the sales team to do.

STRICT RULES — NEVER VIOLATE:
- Never confirm whether a date is available. Always say "Let me have our team check availability for that date and confirm with you."
- Never mention any competitor studio by name.
- Never use casual slang or informal language under any circumstances.
- Never make promises about deliverables, timelines, or inclusions that are not verified by the team.
- If asked something outside your knowledge, say: "That's a great question — let me have someone from our team get back to you on that shortly."
- Once all 4 details are collected, add the text "%%QUOTE_READY%%" at the very end of your message (this is a hidden system signal — do not explain it to the client).

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
