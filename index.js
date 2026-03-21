import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import admin from "firebase-admin";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() + "-" + Math.round(Math.random() * 1e9) + ".jpg";
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

const MAX_IMAGES = 9999;
const MAX_UPGRADES_PER_IMAGE = 9999;

function getDeviceId(req) {
  return req.body?.deviceId || req.headers["x-device-id"] || null;
}

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    const deviceId = getDeviceId(req);

    if (!deviceId) {
      return res.status(400).json({ error: "Missing device ID" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Missing image" });
    }

    const userRef = db.collection("users").doc(deviceId);
    const userDoc = await userRef.get();

    let imagesUsed = 0;
    let isAdmin = false;

    if (!userDoc.exists) {
      await userRef.set({ imagesUsed: 0, isAdmin: false });
    } else {
      const data = userDoc.data();
      imagesUsed = data.imagesUsed || 0;
      isAdmin = data.isAdmin || false;
    }

    if (!isAdmin && imagesUsed >= MAX_IMAGES) {
      return res.status(403).json({
        error: "Free limit reached",
        message: "סיימת את הניסיונות החינמיים.",
      });
    }

    const imageBuffer = await fs.promises.readFile(req.file.path);
    const base64Image = imageBuffer.toString("base64");

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: 'נתח את התמונה וכתוב פוסט מכירתי. החזר JSON: { "post": "" }',
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
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI HTTP ERROR:", err);
      return res.status(500).json({ error: "OpenAI request failed" });
    }

    const data = await response.json();

    const rawContent = data?.choices?.[0]?.message?.content;
    const text =
      typeof rawContent === "string"
        ? rawContent
        : JSON.stringify(rawContent ?? "");

    if (!text) {
      console.error("Invalid AI response:", data);
      return res.status(500).json({ error: "AI response invalid" });
    }

    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);

      if (!parsed || typeof parsed !== "object" || !parsed.post) {
        parsed = { post: cleaned };
      }
    } catch {
      parsed = { post: cleaned };
    }

    const imageRef = userRef.collection("images").doc();

    await imageRef.set({
      upgradesUsed: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    if (!isAdmin) {
      await userRef.update({
        imagesUsed: admin.firestore.FieldValue.increment(1),
      });
    }

    res.json({
      imageId: imageRef.id,
      post: parsed.post,
    });

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
    const { post, tone, imageId } = req.body;
    const deviceId = getDeviceId(req);

    if (!deviceId || !imageId) {
      return res.status(400).json({ error: "Missing data" });
    }

    if (!post) {
      return res.status(400).json({ error: "Missing post" });
    }

    const userRef = db.collection("users").doc(deviceId);
    const imageRef = userRef.collection("images").doc(imageId);

    const imageDoc = await imageRef.get();

    if (!imageDoc.exists) {
      return res.status(404).json({ error: "Image not found" });
    }

    let tonePrompt = "";

    if (tone === "aggressive") tonePrompt = "שכתב בסגנון מכירתי חזק יותר";
    if (tone === "luxury") tonePrompt = "שכתב בסגנון יוקרתי ומלוטש";
    if (tone === "casual") tonePrompt = "שכתב בסגנון קליל וזורם";

    if (!tonePrompt) {
      return res.status(400).json({ error: "Invalid tone" });
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
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
      }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI HTTP ERROR:", err);
      return res.status(500).json({ error: "OpenAI request failed" });
    }

    const data = await response.json();

    const rawContent = data?.choices?.[0]?.message?.content;
    const text =
      typeof rawContent === "string"
        ? rawContent
        : JSON.stringify(rawContent ?? "");

    if (!text) {
      console.error("Invalid AI response:", data);
      return res.status(500).json({ error: "AI response invalid" });
    }

    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);

      if (!parsed || typeof parsed !== "object" || !parsed.post) {
        parsed = { post: cleaned };
      }
    } catch {
      parsed = { post: cleaned };
    }

    await imageRef.update({
      upgradesUsed: admin.firestore.FieldValue.increment(1),
    });

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