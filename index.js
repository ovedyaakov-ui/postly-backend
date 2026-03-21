import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import admin from "firebase-admin";

/* 🔥 קריאה מ-Render Secret Files */
const serviceAccount = JSON.parse(
  fs.readFileSync("/etc/secrets/serviceAccountKey.json", "utf8")
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + ".jpg"),
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

function getDeviceId(req) {
  return req.body?.deviceId || req.headers["x-device-id"] || null;
}

/* =========================
   ANALYZE
========================= */

app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    const deviceId = getDeviceId(req);

    if (!deviceId) return res.status(400).json({ error: "Missing device ID" });
    if (!req.file) return res.status(400).json({ error: "Missing image" });

    const userRef = db.collection("users").doc(deviceId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      await userRef.set({ imagesUsed: 0, isAdmin: false });
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
    });

    const data = await response.json();

    const raw = data?.choices?.[0]?.message?.content;
    const text =
      typeof raw === "string" ? raw : JSON.stringify(raw ?? "");

    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
      if (!parsed.post) parsed = { post: cleaned };
    } catch {
      parsed = { post: cleaned };
    }

    const imageRef = userRef.collection("images").doc();

    await imageRef.set({
      upgradesUsed: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      imageId: imageRef.id,
      post: parsed.post,
    });

  } catch (error) {
    console.log("ANALYZE ERROR:", error);
    res.status(500).json({ error: "שגיאה בעיבוד התמונה" });
  }
});

/* =========================
   IMPROVE
========================= */

app.post("/improve", async (req, res) => {
  try {
    const { post, tone, imageId } = req.body;
    const deviceId = getDeviceId(req);

    if (!deviceId || !imageId)
      return res.status(400).json({ error: "Missing data" });

    const toneMap = {
      aggressive: "שכתב בסגנון מכירתי חזק יותר",
      luxury: "שכתב בסגנון יוקרתי ומלוטש",
      casual: "שכתב בסגנון קליל וזורם",
    };

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
            content: `${toneMap[tone] || ""}:

${post}

החזר JSON:
{ "post": "" }`,
          },
        ],
      }),
    });

    const data = await response.json();

    const raw = data?.choices?.[0]?.message?.content;
    const text =
      typeof raw === "string" ? raw : JSON.stringify(raw ?? "");

    const cleaned = text
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let parsed;

    try {
      parsed = JSON.parse(cleaned);
      if (!parsed.post) parsed = { post: cleaned };
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