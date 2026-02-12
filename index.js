import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   Upload Config
========================= */

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

/* =========================
   API Key Check
========================= */

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}

/* =========================
   Routes
========================= */

app.get("/", (req, res) => {
  res.send("Postly backend alive ✅");
});

app.post("/analyze", upload.single("image"), async (req, res) => {
  console.log("📥 POST /analyze הגיע");

  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

  try {
    const imageBuffer = fs.readFileSync(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `אתה קופירייטר ומנהל שיווק מקצועי.

המטרה שלך: לכתוב פוסט אחד חזק במיוחד, מוכן לפרסום מיידי במדיה חברתית, בהתאם למוצר או לתוכן שמופיע בתמונה.

הנחיות:
- כתוב כאילו זה הפוסט היחיד שיעלה לעמוד.
- פתיח חזק שתופס תשומת לב מיד.
- שפה טבעית ואנושית.
- לא להשתמש בביטויים גנריים כמו "הכירו את", "המוצר המושלם".
- התאמת טון לסוג התוכן (אוכל חושני, נדל״ן יוקרתי, מוצר פרקטי וכו').
- פסקאות קצרות וברורות.
- 4–8 אימוג'ים רלוונטיים בלבד.
- לא להמציא פרטים שלא נראים בתמונה.
- הפוסט חייב להיות ברמה גבוהה ומוכן לפרסום ללא עריכה.

החזר JSON בלבד בפורמט הבא:

{
  "post": "כאן יהיה הפוסט המלא"
}`,
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

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ OpenAI Error:", data);
      return res.status(500).json({ error: "שגיאה מ-OpenAI" });
    }

    const aiText = data?.choices?.[0]?.message?.content || "{}";

    const cleanText = aiText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleanText);
    } catch (err) {
      console.error("❌ JSON parse error:", cleanText);
      return res.status(500).json({ error: "AI החזיר JSON לא תקין" });
    }

    res.json(parsed);

  } catch (error) {
    console.error("❌ Server Error:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

/* =========================
   Start Server
========================= */

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});