import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 5 * 1024 * 1024 },
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.send("Postly backend alive ✅");
});

app.post("/analyze", upload.single("image"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image uploaded" });
  }

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

שלב 1 (פנימי בלבד, אל תציג):
רשום לעצמך תיאור יבש של:
- סוג המוצר
- צבעים בולטים
- אלמנטים עיצוביים

שלב 2:
כתוב פוסט מכירתי חד וברור.

חוקים:
- לציין במפורש את סוג המוצר
- לציין לפחות 2 פרטים ויזואליים מדויקים
- פתיח חזק
- עד 5 אימוג'ים
- בלי קלישאות
- שפה ישירה וברורה
- סיום בקריאה לפעולה ברורה

החזר JSON בלבד:
{
  "post": ""
}`
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
      console.error("❌ OpenAI Draft Error:", draftData);
      return res.status(500).json({ error: "שגיאה מ-OpenAI (Draft)" });
    }

    const draftText = draftData?.choices?.[0]?.message?.content || "{}";

    const cleanDraft = draftText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleanDraft);
    } catch (err) {
      console.error("❌ JSON parse error:", cleanDraft);
      return res.status(500).json({ error: "AI החזיר JSON לא תקין" });
    }

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

בצע:
- חיזוק פתיח
- חידוד מכירתי
- הסרת ניסוחים כלליים
- קיצור משפטים חלשים
- חיזוק הקריאה לפעולה

אל תכתוב מחדש לגמרי.
רק שפר.

החזר JSON בלבד:
{
  "post": ""
}

פוסט:
${parsed.post}`
          },
        ],
      }),
    });

    const refineData = await refineResponse.json();

    if (!refineResponse.ok) {
      console.error("❌ OpenAI Refine Error:", refineData);
      return res.status(500).json({ error: "שגיאה בשיפור הפוסט" });
    }

    const refineText = refineData?.choices?.[0]?.message?.content || "{}";

    const cleanRefine = refineText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();

    let finalParsed;
    try {
      finalParsed = JSON.parse(cleanRefine);
    } catch (err) {
      console.error("❌ Refinement JSON parse error:", cleanRefine);
      return res.status(500).json({ error: "AI החזיר JSON שיפור לא תקין" });
    }

    res.json(finalParsed);

  } catch (error) {
    console.error("❌ Server Error:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  } finally {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

app.post("/improve", async (req, res) => {
  const { post, tone } = req.body;

  if (!post) {
    return res.status(400).json({ error: "No post provided" });
  }

  try {
    let tonePrompt = "";
    
    if (tone === "aggressive") {
      tonePrompt = "שכתב את הפוסט בסגנון מכירתי וחזק יותר";
    } else if (tone === "luxury") {
      tonePrompt = "שכתב את הפוסט בסגנון יוקרתי ומלוטש";
    } else if (tone === "casual") {
      tonePrompt = "שכתב את הפוסט בסגנון קליל ומשעשע";
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
        messages: [
          {
            role: "user",
            content: `${tonePrompt}:

${post}

החזר JSON:
{
  "post": ""
}`
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

    let parsed;
    try {
      parsed = JSON.parse(cleanText);
    } catch (err) {
      return res.status(500).json({ error: "AI החזיר JSON לא תקין" });
    }

    res.json(parsed);
  } catch (error) {
    res.status(500).json({ error: "שגיאה בשיפור" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});