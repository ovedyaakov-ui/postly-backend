import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

app.get("/", (req, res) => {
  res.send("Postly backend alive ✅");
});

app.get("/analyze", (req, res) => {
  res.json({ text: "📸 Postly בדיקה – השרת מחזיר פוסט כמו שצריך ✅" });
});

app.post("/analyze", upload.single("image"), async (req, res) => {
  console.log("📥 POST /analyze הגיע");
  console.log("📄 FILE:", req.file);

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
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `אתה כותב פוסטים מקצועי לרשתות חברתיות בעברית.

תאר בקצרה מה מופיע בתמונה, ואז צור 3 גרסאות פוסט שונות:

1. **רגשי** - פוסט חם ומרגש שמתחבר לרגשות
2. **מכירתי** - פוסט עם קריאה לפעולה ושכנוע
3. **מצחיק** - פוסט קליל ומשעשע

כל פוסט צריך להיות:
- 4-6 שורות
- עם אימוג'ים מתאימים
- עם 3-5 האשטאגים רלוונטיים

החזר את התשובה בפורמט JSON בדיוק כך:
{
  "description": "תיאור קצר של התמונה",
  "posts": [
    {
      "type": "רגשי",
      "text": "הפוסט הרגשי כאן..."
    },
    {
      "type": "מכירתי", 
      "text": "הפוסט המכירתי כאן..."
    },
    {
      "type": "מצחיק",
      "text": "הפוסט המצחיק כאן..."
    }
  ]
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
        max_tokens: 1000,
      }),
    });

    const data = await response.json();
    const aiText = data?.choices?.[0]?.message?.content || "{}";

    fs.unlinkSync(req.file.path);

    const cleanText = aiText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleanText);

    res.json(parsed);
  } catch (error) {
    console.error("❌ OpenAI Error:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});