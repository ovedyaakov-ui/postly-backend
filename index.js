import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());
app.set("trust proxy", 1);

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}

/* =========================
   DAILY LIMIT SYSTEM
========================= */

const DAILY_LIMIT_ANALYZE = 3;
const DAILY_LIMIT_IMPROVE = 10;

const usageMap = new Map();

function getDateKey() {
  return new Date().toDateString();
}

function getClientIp(req) {
  return (req.ip || "").replace("::ffff:", "") || "unknown";
}

function ensureUsage(ip) {
  const today = getDateKey();
  const current = usageMap.get(ip);

  if (!current || current.dateKey !== today) {
    const fresh = { dateKey: today, analyzeCount: 0, improveCount: 0 };
    usageMap.set(ip, fresh);
    return fresh;
  }

  return current;
}

app.get("/", (req, res) => {
  res.send("Postly backend alive ✅");
});

/* =========================
   ANALYZE
========================= */

app.post("/analyze", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

  const ip = getClientIp(req);
  const usage = ensureUsage(ip);

  if (usage.analyzeCount >= DAILY_LIMIT_ANALYZE) {
    return res.status(403).json({
      error: "Free limit reached",
      message: `הגעת למכסה היומית (${DAILY_LIMIT_ANALYZE}). נסה שוב מחר.`,
    });
  }

  usage.analyzeCount += 1;

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const draftResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 700,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `אתה קופירייטר מכירתי מדויק.

שלב 1 (פנימי בלבד):
נתח סוג מוצר ופרטים ויזואליים.

שלב 2:
כתוב פוסט חד וברור.
- פתיח חזק
- עד 5 אימוג'ים
- בלי קלישאות
- קריאה לפעולה ברורה

החזר JSON:
{ "post": "" }`
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
                },
              },
            ],
          },
        ],
      }),
    });

    const draftData = await draftResponse.json();
    if (!draftResponse.ok) {
      return res.status(500).json({ error: "שגיאה מ-OpenAI (Draft)" });
    }

    const draftText = draftData?.choices?.[0]?.message?.content || "{}";
    const cleanDraft = draftText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleanDraft);

    const refineResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `שפר את הפוסט הבא לרמה גבוהה יותר.
חזק פתיח, קצר משפטים, חדד מכירה.

החזר JSON:
{ "post": "" }

פוסט:
${parsed.post}`
          },
        ],
      }),
    });

    const refineData = await refineResponse.json();
    if (!refineResponse.ok) {
      return res.status(500).json({ error: "שגיאה בשיפור הפוסט" });
    }

    const refineText = refineData?.choices?.[0]?.message?.content || "{}";
    const cleanRefine = refineText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const finalParsed = JSON.parse(cleanRefine);

    res.json(finalParsed);

  } catch (error) {
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

/* =========================
   IMPROVE
========================= */

app.post("/improve", async (req, res) => {
  const { post, tone } = req.body;

  if (!post) {
    return res.status(400).json({ error: "No post provided" });
  }

  const ip = getClientIp(req);
  const usage = ensureUsage(ip);

  if (usage.improveCount >= DAILY_LIMIT_IMPROVE) {
    return res.status(403).json({
      error: "Free limit reached",
      message: `הגעת למכסה היומית לשיפורים (${DAILY_LIMIT_IMPROVE}).`,
    });
  }

  usage.improveCount += 1;

  try {
    let tonePrompt = "";

    if (tone === "aggressive") tonePrompt = "שכתב בסגנון מכירתי וחזק יותר";
    if (tone === "luxury") tonePrompt = "שכתב בסגנון יוקרתי ומלוטש";
    if (tone === "casual") tonePrompt = "שכתב בסגנון קליל וזורם";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `${tonePrompt}:

${post}

החזר JSON:
{ "post": "" }`
          },
        ],
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: "שגיאה מ-OpenAI" });
    }

    const aiText = data?.choices?.[0]?.message?.content || "{}";
    const cleanText = aiText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleanText);

    res.json(parsed);

  } catch (error) {
    res.status(500).json({ error: "שגיאה בשיפור" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});