import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".jpg";
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing image" });
    }

    const imageBuffer = await fs.promises.readFile(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `אתה קופירייטר מקצועי בכיר עם ניסיון של 15 שנה בשיווק דיגיטלי.

עבוד בשלושה שלבים פנימיים לפני שאתה כותב את הפוסט:

שלב 1 — זיהוי:
- מה המוצר או השירות המרכזי בתמונה?
- איזה סוג עסק זה? (מסעדה, חנות, מוצר, שירות, עסק מקצועי וכו')
- מי קהל היעד הסביר? (משפחות, צעירים, אנשי מקצוע, הורים, ילדים וכו')

שלב 2 — אסטרטגיה:
בחר את גישת המכירה המתאימה ביותר למוצר:
- רגש (מתאים למזון, ילדים, חיות, מתנות)
- איכות ומקצועיות (מתאים לשירותים, מוצרים יוקרתיים)
- חוויה (מתאים למסעדות, אטרקציות, בידור)
- פתרון לבעיה (מתאים לשירותים מקצועיים, מוצרי טיפוח)
- קהילה והשתייכות (מתאים לחנויות מקומיות, עסקים שכונתיים)

שלב 3 — כתיבה:
כתוב פוסט שיווקי בעברית שמותאם לסוג העסק ולגישת המכירה שבחרת.

חוקים לכתיבה:
- פתח במשפט שתופס את העין מיד — שאלה, עובדה מפתיעה, או משפט שמדבר ישירות ללקוח.
- כתוב 2-3 פסקאות שיווקיות שמדברות אל הלקוח ולא על המוצר.
- השתמש בפסיכולוגיית מכירה: FOMO, חיבור רגשי, תחושת ערך.
- כל פוסט חייב להישמע שונה מהפוסט הקודם — אל תשתמש באותה פתיחה.
- כתוב בעברית שנשמעת כאילו בן אדם כתב אותה, לא AI.
- השתמש באימוג'ים בצורה חכמה ומותאמת לסוג העסק.
- סיים בקריאה לפעולה שגורמת לאנשים להגיב, לשלוח הודעה או לבקר.

אסור בהחלט:
- לא להמציא מחיר, מבצע, הנחה, משלוח או אחריות.
- לא לכתוב "בתמונה רואים" או לתאר את התמונה.
- לא להשתמש בקלישאות: "הדור הבא", "הפתרון האולטימטיבי", "אל תחכה יותר", "מהפכה".
- לא לחזור על אותם משפטים גנריים בכל פוסט.

החזר תמיד JSON תקין בלבד:
{ "post": "" }`,
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

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI HTTP ERROR:", err);
      return res.status(500).json({ error: "OpenAI request failed" });
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const text = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");

    if (!text) {
      console.error("Invalid AI response:", data);
      return res.status(500).json({ error: "AI response invalid" });
    }

    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || !parsed.post) {
        parsed = { post: cleaned };
      }
    } catch {
      parsed = { post: cleaned };
    }

    res.json({ post: parsed.post });

    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (err) {
      console.log("File cleanup error:", err);
    }
  } catch (error) {
    console.log("ANALYZE ERROR:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  }
});

app.post("/improve", async (req, res) => {
  try {
    const { post, tone } = req.body;

    if (!post) {
      return res.status(400).json({ error: "Missing post" });
    }

    let tonePrompt = "";
    if (tone === "aggressive") tonePrompt = "שכתב בסגנון מכירתי חזק יותר עם אנרגיה גבוהה ואימוג'ים";
    if (tone === "luxury") tonePrompt = "שכתב בסגנון יוקרתי ומלוטש עם אימוג'ים אלגנטיים";
    if (tone === "casual") tonePrompt = "שכתב בסגנון קליל וזורם עם אימוג'ים כיפיים";

    if (!tonePrompt) {
      return res.status(400).json({ error: "Invalid tone" });
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `${tonePrompt}:

${post}

החזר JSON:
{ "post": "" }`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI HTTP ERROR:", err);
      return res.status(500).json({ error: "OpenAI request failed" });
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const text = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");

    if (!text) {
      console.error("Invalid AI response:", data);
      return res.status(500).json({ error: "AI response invalid" });
    }

    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || !parsed.post) {
        parsed = { post: cleaned };
      }
    } catch {
      parsed = { post: cleaned };
    }

    res.json(parsed);
  } catch (error) {
    console.log("IMPROVE ERROR:", error);
    res.status(500).json({ error: "שגיאה בשיפור" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});