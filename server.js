// Green API version. npm i express node-cron @anthropic-ai/sdk dotenv   (Node 18+)
try { require("dotenv").config(); } catch (e) {}
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const express = require("express"), cron = require("node-cron");
const Anthropic = require("@anthropic-ai/sdk");

const E = process.env;
const claude = new Anthropic({ apiKey: E.ANTHROPIC_API_KEY });
const TZ = "Asia/Jerusalem";
const API = `${E.GREEN_API_URL || "https://api.green-api.com"}/waInstance${E.GREEN_ID}`;
const CHAT_ID = E.GROUP_CHAT_ID; // e.g. 120363012345678901@g.us (works with real WhatsApp groups)
const STATE_FILE = path.join(__dirname, "state.json");
const state = Object.assign({ pending: [], reminderDue: false, reminderActive: false, transactions: [], previous: {} },
  fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {});
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

// ---------- Green API helpers ----------
async function gapi(method, body) {
  const r = await fetch(`${API}/${method}/${E.GREEN_TOKEN}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) console.error("GreenAPI", method, r.status, await r.text());
  return r;
}
const sendText = message => gapi("sendMessage", { chatId: CHAT_ID, message });
const sendAudio = urlFile => gapi("sendFileByUrl", { chatId: CHAT_ID, urlFile, fileName: "summary.mp3" });

// ---------- working hours ----------
function nowIL() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", hourCycle: "h23" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { day: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday), hour: +p.hour };
}
function offHoursReply() {
  const { day, hour } = nowIL();
  if (day === 5 || day === 6 || (day === 4 && hour >= 18))
    return "שבת שלום! אני לא עובד בסוף השבוע (שישי-שבת). אשמח לעזור ביום ראשון החל מהשעה 09:00.";
  if (hour < 9 || hour >= 18)
    return "ערב טוב! סיימתי את שעות הפעילות להיום. קיבלתי את פנייתך ואשמח לעזור מחר בבוקר החל מהשעה 09:00.";
  return null;
}

// ---------- Claude extraction ----------
const SYSTEM_PROMPT = `אתה עוזר פיננסי משפחתי מומחה. תפקידך לקבל מסמך פירוט הוראות קבע/חיובים (PDF או תמונה), לחלץ את כל הנתונים ולהחזיר אך ורק אובייקט JSON תקני (ללא טקסט נוסף לפני או אחרי, וללא גדרות קוד).
מבנה:
{"summary_data":{"total_expenses":number,"total_income":number,"top_category":"string"},
"categories":[{"business_name":"string","amount":number,"category_name":"מזון/חשבונות/תקשורת/פנאי/ביטוח/אחר","date":"YYYY-MM-DD","type":"expense|income"}],
"whatsapp_text":"הודעה קצרה, מעוצבת וברורה בעברית לקבוצת וואטסאפ משפחתית: סך הוצאות, חריגות בולטות, פירוט לפי קטגוריות עיקריות, עם אימוג'ים.",
"voice_script":"תסריט קולח בעברית להודעה קולית של עד 60 שניות. ללא סימנים מיוחדים (*, #, טבלאות). מספרים במילים מלאות, למשל: ארבע מאות וחמישים שקלים."}
אם אינך בטוח בערך, אל תמציא: השמט את הפריט. אם אין מסמך קריא, החזר {"error":"unreadable"}.`;

async function extract(buf, mime) {
  const block = mime === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type: mime, data: buf.toString("base64") } }
    : { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } };
  const r = await claude.messages.create({ model: "claude-3-5-sonnet-20241022", max_tokens: 4000, system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [block, { type: "text", text: "חלץ את הנתונים מהמסמך." }] }] });
  const txt = r.content.map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(txt);
}

// ---------- ElevenLabs ----------
async function tts(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${E.ELEVEN_VOICE_ID}`, {
    method: "POST", headers: { "xi-api-key": E.ELEVEN_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }) });
  if (!r.ok) throw new Error("ElevenLabs " + r.status);
  const name = crypto.randomUUID() + ".mp3";
  fs.mkdirSync(path.join(__dirname, "public/audio"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "public/audio", name), Buffer.from(await r.arrayBuffer()));
  return `${E.BASE_URL}/audio/${name}`;
}

// ---------- file pipeline ----------
async function processFile({ url, type }) {
  const res = await fetch(url); // Green API download links are public
  const data = await extract(Buffer.from(await res.arrayBuffer()), type);
  if (data.error) return sendText("לא הצלחתי לקרוא את המסמך. אפשר לשלוח שוב בצילום ברור יותר?");
  const prev = {}; state.transactions.forEach(t => { if (t.type !== "income") prev[t.business] = t.amount; });
  state.previous = prev;
  for (const c of data.categories) state.transactions.push({ date: c.date, business: c.business_name, amount: c.amount, category: c.category_name, type: c.type || "expense" });
  save();
  await sendText(data.whatsapp_text);
  try { await sendAudio(await tts(data.voice_script)); } catch (e) { console.error(e); }
}
async function drainQueue() {
  const items = state.pending.splice(0); save();
  for (const it of items) try { await processFile(it); } catch (e) { console.error(e); }
}

// ---------- monthly reminder + nudge ----------
// Interactive buttons are unreliable on WhatsApp groups, so replies are plain text.
const REMINDER = "תומש, בוקר טוב. נא לא לשכוח לשלוח פירוט שעות ללקוחות.\nהשיבו:\n1 - שלחתי\n2 - אני על זה";
const sendReminder = () => sendText(REMINDER);
const startReminder = async () => { state.reminderActive = true; state.reminderDue = false; save(); await sendReminder(); };
cron.schedule("0 0 1 * *", () => { state.reminderDue = true; save(); }, { timezone: TZ });
cron.schedule("0 9 * * 0-4", async () => { if (state.reminderDue) await startReminder(); await drainQueue(); }, { timezone: TZ });
cron.schedule("0 12,15,18 * * 0-4", () => { if (state.reminderActive) sendReminder(); }, { timezone: TZ });

// ---------- webhook ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/data", (_, res) => res.json({ transactions: state.transactions, previous: state.previous }));

const seen = new Set();
app.post("/greenapi", (req, res) => {
  if (req.get("Authorization") !== `Bearer ${E.WEBHOOK_TOKEN}`) return res.sendStatus(403);
  res.sendStatus(200); // ack fast, work async
  handle(req.body).catch(console.error);
});

async function handle(w) {
  if (w.typeWebhook !== "incomingMessageReceived") return;
  if (w.senderData?.chatId !== CHAT_ID) return; // only our group
  if (seen.has(w.idMessage)) return; seen.add(w.idMessage); if (seen.size > 500) seen.clear();
  const m = w.messageData || {};
  const text = (m.textMessageData?.textMessage || m.extendedTextMessageData?.text || "").trim();

  if (state.reminderActive && /^(1|שלחתי)$/.test(text)) { state.reminderActive = false; save(); return sendText("מעולה! תודה רבה."); }
  if (state.reminderActive && /^(2|אני על זה)$/.test(text)) return; // keep nudging every 3h

  if (m.typeMessage === "imageMessage" || m.typeMessage === "documentMessage") {
    const f = m.fileMessageData || {};
    const file = { url: f.downloadUrl, type: f.mimeType };
    const off = offHoursReply();
    if (off) { state.pending.push(file); save(); return sendText(off); }
    return processFile(file);
  }
  // Ordinary group chatter is ignored, so the bot does not reply to every message.
}

app.listen(E.PORT || 3000, async () => {
  console.log("up");
  if (E.SET_WEBHOOK === "1") // one-time: point Green API at this server
    await gapi("setSettings", { webhookUrl: `${E.BASE_URL}/greenapi`, webhookUrlToken: `Bearer ${E.WEBHOOK_TOKEN}`, incomingWebhook: "yes", outgoingWebhook: "no", outgoingMessageWebhook: "no" });
});
app.get("/get-id", async (req, res) => {
  try {
    const id = process.env.GREEN_ID;
    const token = process.env.GREEN_TOKEN;
    const response = await fetch(`https://api.green-api.com/waInstance${id}/getChats/${token}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).send(err.message);
  }
});
