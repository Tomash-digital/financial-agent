// npm i express twilio node-cron @anthropic-ai/sdk   (Node 18+)
require("dotenv").config?.();
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const express = require("express"), cron = require("node-cron"), twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const E = process.env;
const tw = twilio(E.TWILIO_SID, E.TWILIO_TOKEN);
const claude = new Anthropic({ apiKey: E.ANTHROPIC_API_KEY });
const TZ = "Asia/Jerusalem";
const FAMILY = (E.FAMILY_NUMBERS || "").split(",").filter(Boolean); // whatsapp:+972...
const STATE_FILE = path.join(__dirname, "state.json");
const state = Object.assign({ pending: [], reminderDue: false, reminderActive: false, transactions: [], previous: {} },
  fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {});
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state));

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

// ---------- sending ----------
async function broadcast({ body, mediaUrl, contentSid }) {
  for (const to of FAMILY)
    await tw.messages.create({ from: E.TWILIO_WA_FROM, to, ...(contentSid ? { contentSid } : { body }), ...(mediaUrl ? { mediaUrl: [mediaUrl] } : {}) });
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
  const r = await claude.messages.create({ model: "claude-sonnet-5-5", max_tokens: 4000, system: SYSTEM_PROMPT,
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
  const auth = "Basic " + Buffer.from(`${E.TWILIO_SID}:${E.TWILIO_TOKEN}`).toString("base64");
  const res = await fetch(url, { headers: { Authorization: auth } });
  const data = await extract(Buffer.from(await res.arrayBuffer()), type);
  if (data.error) return broadcast({ body: "לא הצלחתי לקרוא את המסמך. אפשר לשלוח שוב בצילום ברור יותר?" });
  const prev = {}; state.transactions.forEach(t => { if (t.type !== "income") prev[t.business] = t.amount; });
  state.previous = prev;
  for (const c of data.categories) state.transactions.push({ date: c.date, business: c.business_name, amount: c.amount, category: c.category_name, type: c.type || "expense" });
  save();
  await broadcast({ body: data.whatsapp_text });
  try { await broadcast({ mediaUrl: await tts(data.voice_script) }); } catch (e) { console.error(e); }
}
async function drainQueue() {
  const items = state.pending.splice(0); save();
  for (const it of items) try { await processFile(it); } catch (e) { console.error(e); }
}

// ---------- monthly reminder + nudge ----------
const startReminder = async () => { state.reminderActive = true; state.reminderDue = false; save(); await sendReminder(); };
const sendReminder = () => broadcast({ contentSid: E.REMINDER_CONTENT_SID }); // quick-reply template: body + 2 buttons
cron.schedule("0 0 1 * *", () => { state.reminderDue = true; save(); }, { timezone: TZ });
cron.schedule("0 9 * * 0-4", async () => { // every working morning
  if (state.reminderDue) await startReminder();
  await drainQueue();
}, { timezone: TZ });
cron.schedule("0 12,15,18 * * 0-4", () => { if (state.reminderActive) sendReminder(); }, { timezone: TZ });

// ---------- webhook ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/data", (_, res) => res.json({ transactions: state.transactions, previous: state.previous }));

app.post("/whatsapp", async (req, res) => {
  const valid = twilio.validateRequest(E.TWILIO_TOKEN, req.get("X-Twilio-Signature") || "", `${E.BASE_URL}/whatsapp`, req.body);
  if (!valid) return res.sendStatus(403);
  res.type("text/xml").send("<Response/>"); // ack fast, work async
  try {
    const b = req.body, btn = b.ButtonPayload || b.ButtonText;
    if (btn) {
      if (/sent|שלחתי/.test(btn)) { state.reminderActive = false; save(); return broadcast({ body: "מעולה! תודה רבה." }); }
      return; // "אני על זה": keep nudging every 3h
    }
    const off = offHoursReply();
    if (off) {
      if (+b.NumMedia > 0) { state.pending.push({ url: b.MediaUrl0, type: b.MediaContentType0 }); save(); }
      return broadcast({ body: off });
    }
    if (+b.NumMedia > 0) await processFile({ url: b.MediaUrl0, type: b.MediaContentType0 });
    else await broadcast({ body: "שלחו לי קובץ PDF או תמונה של פירוט האשראי או הבנק ואחזיר סיכום." });
  } catch (e) { console.error(e); }
});

app.listen(E.PORT || 3000, () => console.log("up"));
