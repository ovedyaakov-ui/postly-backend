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
                text: "תאר בצורה קצרה וברורה מה מופיע בתמונה, ואז צור פוסט קצר ומושך לפייסבוק או אינסטגרם בעברית.",
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
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    const aiText = data?.choices?.[0]?.message?.content || "לא התקבלה תוצאה מה-AI.";

    fs.unlinkSync(req.file.path);

    res.json({ text: aiText });
  } catch (error) {
    console.error("❌ OpenAI Error:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});