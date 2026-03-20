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

PORTFOLIO LINK: https://onehorizonproductions.com

CONVERSATION FLOW:
1. Greet them warmly and personally using their first name. Share the portfolio link. Ask if they have had a chance to explore our work.
2. Once they respond, ask for their wedding date.
3. Ask for their venue name and city.
4. The events question will be handled with a tap-to-select list — acknowledge their selection naturally and move on.
5. The budget question will be handled with tap-to-select buttons — acknowledge their selection naturally and move on.
6. Once all four details are collected, close warmly — let them know our team will put together a personalised package and be in touch within a few hours.

TONE AND STYLE:
- Speak the way a trusted, well-mannered professional would — warm but never overfamiliar, elegant but never stiff.
- Never use casual slang, abbreviations, or overly informal language (no "Hey!", "Cool!", "Awesome!", "np", "tbh" etc.).
- Keep every message to 1 to 2 sentences maximum. Be crisp. Say exactly what needs to be said and nothing more.
- Never over-explain or add filler phrases before getting to the point.
- Ask ONE question at a time. Never combine multiple questions in one message.
- Do not repeat information already shared earlier in the conversation.

PRICING:
- If asked about pricing before details are collected, let them know packages are tailored to each couple's requirements and you would love to understand their vision first.
- If they ask for a starting point, share that coverage for a single event starts from Rs. 80,000, and the final package depends on their specific needs.
- Never quote a specific final price.

CURRENT DATE CONTEXT:
The current year is 2026. If a client gives a date without a year, you may ask which year — but only offer 2026 or 2027 as options. Never suggest, accept, or repeat back any year in the past.

STRICT RULES — NEVER VIOLATE:
- Never confirm whether a date is available. Say "Let me have our team check availability for that date."
- Never accept or suggest a wedding year that has already passed.
- Never mention any competitor studio by name.
- Never use casual slang or informal language.
- Never make promises about deliverables, timelines, or inclusions.
- If asked something outside your knowledge: "Let me have someone from our team get back to you on that shortly."
- Once all 4 details are collected, add "%%QUOTE_READY%%" at the very end of your message.

DETAILS TO COLLECT:
1. Wedding date
2. Venue name + city
3. Events (client replies with numbers from a numbered menu — their selection will be provided to you)
4. Budget range (handled via interactive buttons — will be provided as the client's selection)`;

// ─── SESSION MANAGEMENT ───────────────────────────────────────────────────────
function getSession(phone) {
  if (!conversations[phone]) {
    conversations[phone] = {
      messages: [],
      stage: "greeting",
      details: { date: null, venue: null, events: null, budget: null },
    };
  }
  return conversations[phone];
}

function saveMessage(phone, role, content) {
  const session = getSession(phone);
  session.messages.push({ role, content });
  if (session.messages.length > 40) {
    session.messages = session.messages.slice(-40);
  }
}

// ─── WHATSAPP SENDERS ─────────────────────────────────────────────────────────
const WA_URL = () =>
  `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const WA_HEADERS = () => ({
  Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
  "Content-Type": "application/json",
});

async function sendText(to, body) {
  const clean = body.replace("%%QUOTE_READY%%", "").trim();
  await axios.post(
    WA_URL(),
    { messaging_product: "whatsapp", to, type: "text", text: { body: clean } },
    { headers: WA_HEADERS() }
  );
}

async function sendButtons(to, bodyText, buttons) {
  await axios.post(
    WA_URL(),
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b, i) => ({
            type: "reply",
            reply: { id: `btn_${i}`, title: b },
          })),
        },
      },
    },
    { headers: WA_HEADERS() }
  );
}

async function sendList(to, bodyText, buttonLabel, items) {
  await axios.post(
    WA_URL(),
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonLabel,
          sections: [
            {
              title: "Events",
              rows: items.map((item, i) => ({ id: `evt_${i}`, title: item })),
            },
          ],
        },
      },
    },
    { headers: WA_HEADERS() }
  );
}

const EVENTS_MENU = [
  "Engagement shoot",
  "Mehendi",
  "Haldi",
  "Wedding ceremony",
  "Reception",
  "Pre-wedding shoot",
  "Post-wedding shoot",
  "Other",
];

async function sendEventsNumberedMenu(to) {
  const menu = EVENTS_MENU.map((e, i) => (i + 1) + '. ' + e).join('\n');
  const body =
    'Which events would you like us to cover?\n\n' +
    menu +
    '\n\n👉 *Reply with the numbers of the events you want* — for example, type *2, 4, 5* to select Mehendi, Wedding ceremony and Reception.\n\nYou can select as many as you like.';
  await sendText(to, body);
}

function parseEventSelection(text) {
  const nums = text.match(/\d+/g);
  if (!nums) return null;
  const selected = nums
    .map(n => EVENTS_MENU[parseInt(n) - 1])
    .filter(Boolean);
  return selected.length > 0 ? selected.join(", ") : null;
}

function hasOtherSelected(text) {
  const nums = text.match(/\d+/g);
  if (!nums) return false;
  return nums.some(n => parseInt(n) === EVENTS_MENU.length); // last item is Other
}

async function sendBudgetButtons(to) {
  await sendButtons(
    to,
    "What is your approximate budget for photography and videography?",
    ["Rs. 2L - 4L", "Rs. 4L - 6L", "Above Rs. 6L"]
  );
}

// ─── NOTIFY SALES TEAM ────────────────────────────────────────────────────────
async function notifySalesTeam(phone, session) {
  const { details } = session;
  const brief =
    `*New Quote Request — One Horizon Productions*\n\n` +
    `*Client:* ${phone}\n` +
    `*Wedding date:* ${details.date || "Not provided"}\n` +
    `*Venue & city:* ${details.venue || "Not provided"}\n` +
    `*Events:* ${details.events || "Not provided"}\n` +
    `*Budget:* ${details.budget || "Not provided"}\n\n` +
    `Please prepare a personalised package for this client.`;

  if (process.env.SALES_TEAM_NUMBER) {
    await sendText(process.env.SALES_TEAM_NUMBER, brief);
  }
  console.log(`Quote brief sent to sales team for ${phone}`);
}

// ─── CLAUDE REPLY ─────────────────────────────────────────────────────────────
async function getChatReply(phone, userMessage, clientName = "") {
  saveMessage(phone, "user", userMessage);
  const session = getSession(phone);

  const system = clientName
    ? `${SYSTEM_PROMPT}\n\nThe client's name is ${clientName}.`
    : SYSTEM_PROMPT;

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system,
    messages: session.messages,
  });

  const reply = response.content[0].text;
  saveMessage(phone, "assistant", reply);

  if (reply.includes("%%QUOTE_READY%%")) {
    await notifySalesTeam(phone, session);
  }

  return reply;
}

// ─── STAGE HANDLER ────────────────────────────────────────────────────────────
async function handleIncoming(phone, userText, clientName, interactiveReply) {
  const session = getSession(phone);

  // Client typed event numbers (e.g. "1, 3, 5")
  if (session.stage === "events" && userText) {
    const selected = parseEventSelection(userText);
    if (selected) {
      // If they included Other, ask them to describe it
      if (hasOtherSelected(userText)) {
        session.details.events = selected;
        session.stage = "events_other";
        saveMessage(phone, "user", `Events selected: ${selected}`);
        await sendText(phone, "Please briefly describe the other event(s) you have in mind.");
        return;
      }
      session.details.events = selected;
      session.stage = "budget";
      saveMessage(phone, "user", `Events selected: ${selected}`);
      await sendText(phone, `Lovely — ${selected}. One last question:`);
      await sendBudgetButtons(phone);
      return;
    }
    // Could not parse — prompt again
    await sendText(phone, "Please reply with the numbers of the events you'd like — e.g. *2, 4, 5*");
    await sendEventsNumberedMenu(phone);
    return;
  }

  // Client described their Other event
  if (session.stage === "events_other" && userText) {
    session.details.events = session.details.events.replace("Other", userText);
    session.stage = "budget";
    saveMessage(phone, "user", `Other event described: ${userText}`);
    await sendText(phone, "Noted — we will keep that in mind. One last question:");
    await sendBudgetButtons(phone);
    return;
  }

  // Client tapped a button (budget)
  if (interactiveReply?.type === "button_reply") {
    const selected = interactiveReply.button_reply.title;
    session.details.budget = selected;
    session.stage = "done";

    const closingPrompt =
      `The client has selected a budget of ${selected}. ` +
      `You now have all four details — date: ${session.details.date}, ` +
      `venue: ${session.details.venue}, events: ${session.details.events}, ` +
      `budget: ${selected}. Close the conversation warmly. Tell them the team ` +
      `will prepare a personalised package and be in touch within a few hours. ` +
      `End your message with %%QUOTE_READY%%.`;

    const reply = await getChatReply(phone, closingPrompt, clientName);
    await sendText(phone, reply);
    return;
  }

  // Regular text messages
  switch (session.stage) {
    case "greeting": {
      // Client has replied to the opening template — Priya acknowledges and asks for date
      const name = clientName || session.clientName || "";
      const prompt = name
        ? `The client ${name} has just replied to our opening message saying: "${userText}". Acknowledge warmly using their name and ask for their wedding date.`
        : `The client has just replied to our opening message saying: "${userText}". Acknowledge warmly and ask for their wedding date.`;
      const reply = await getChatReply(phone, prompt, name);
      await sendText(phone, reply);
      session.stage = "date";
      break;
    }

    case "date": {
      session.details.date = userText;
      const reply = await getChatReply(phone, userText, clientName);
      await sendText(phone, reply);
      session.stage = "venue";
      break;
    }

    case "venue": {
      session.details.venue = userText;
      session.stage = "events";
      // Acknowledge venue with a fixed line — no Claude call to avoid duplicate event lists
      await sendText(phone, `Perfect — ${userText} is a lovely choice.`);
      await sendEventsNumberedMenu(phone);
      break;
    }

    default: {
      // Client typed instead of tapping during events/budget stage
      const reply = await getChatReply(phone, userText, clientName);
      await sendText(phone, reply);
      break;
    }
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const contact = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0];

    if (!message) return res.sendStatus(200);

    const phone = message.from;
    const clientName = contact?.profile?.name || "";

    if (message.type === "interactive") {
      console.log(`Interactive from ${phone}:`, message.interactive?.type);
      await handleIncoming(phone, null, clientName, message.interactive);
    } else if (message.type === "text") {
      const userText = message.text.body;
      console.log(`Text from ${phone} (${clientName}): ${userText}`);

      // Reset command — clears conversation for this number only
      if (userText.trim().toLowerCase() === 'reset') {
        delete conversations[phone];
        await sendText(phone, 'Conversation reset. Send any message to start again.');
        console.log(`Conversation reset for ${phone}`);
        return res.sendStatus(200);
      }

      await handleIncoming(phone, userText, clientName, null);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err?.response?.data || err.message);
    res.sendStatus(200);
  }
});

app.post("/new-lead", async (req, res) => {
  try {
    const { phone, name } = req.body;
    if (!phone) return res.status(400).json({ error: "phone required" });

    const cleanPhone = phone.replace(/\D/g, "");
    console.log(`New lead: ${name} (${cleanPhone})`);

    // Initialise session — stage is 'greeting' until client replies
    const session = getSession(cleanPhone);
    session.stage = "greeting";
    session.clientName = name || "";

    // Send approved Meta template as the opening message
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: cleanPhone,
        type: "template",
        template: {
          name: "one_horizon_opening",
          language: { code: "en" },
        },
      },
      { headers: WA_HEADERS() }
    );

    console.log(`Template sent to ${cleanPhone}`);
    res.json({ success: true, phone: cleanPhone });
  } catch (err) {
    console.error("Error:", err?.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "One Horizon Bot is running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
