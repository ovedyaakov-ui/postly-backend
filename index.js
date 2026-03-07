import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import admin from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

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

/* 🔓 הגדלנו לימיטים כדי שלא יחסמו אותך בזמן פיתוח */
const MAX_IMAGES = 9999;
const MAX_UPGRADES_PER_IMAGE = 9999;

function getDeviceId(req) {
  return req.headers["x-device-id"] || null;
}

/* =========================
   ANALYZE
========================= */

app.post("/analyze", upload.single("image"), async (req, res) => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    return res.status(400).json({ error: "Missing device ID" });
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
      message:
        "סיימת את הניסיונות החינמיים. כדי להמשיך הירשם ועבור לגרסת Pro.",
    });
  }

  const imageBuffer = fs.readFileSync(req.file.path);
  const base64Image = imageBuffer.toString("base64");

  try {
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
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    'נתח את התמונה וכתוב פוסט מכירתי. החזר JSON: { "post": "" }',
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

    const data = await response.json();
    const text = data.choices[0].message.content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(text);

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
  } catch (error) {
    res.status(500).json({ error: "שגיאה ביצירת פוסט" });
  } finally {
    fs.unlinkSync(req.file.path);
  }
});

/* =========================
   IMPROVE
========================= */

app.post("/improve", async (req, res) => {
  const { post, tone, imageId } = req.body;
  const deviceId = getDeviceId(req);

  if (!deviceId || !imageId) {
    return res.status(400).json({ error: "Missing data" });
  }

  const userRef = db.collection("users").doc(deviceId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "User not found" });
  }

  const isAdmin = userDoc.data().isAdmin || false;

  const imageRef = userRef.collection("images").doc(imageId);
  const imageDoc = await imageRef.get();

  if (!imageDoc.exists) {
    return res.status(404).json({ error: "Image not found" });
  }

  const upgradesUsed = imageDoc.data().upgradesUsed || 0;

  if (!isAdmin && upgradesUsed >= MAX_UPGRADES_PER_IMAGE) {
    return res.status(403).json({
      error: "Upgrade limit reached",
      message: "אין יותר שדרוגים לתמונה הזו.",
    });
  }

  try {
    let tonePrompt = "";

    if (tone === "aggressive")
      tonePrompt = "שכתב בסגנון מכירתי וחזק יותר";

    if (tone === "luxury")
      tonePrompt = "שכתב בסגנון יוקרתי ומלוטש";

    if (tone === "casual")
      tonePrompt = "שכתב בסגנון קליל וזורם";

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

    const data = await response.json();
    const text = data.choices[0].message.content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const parsed = JSON.parse(text);

    if (!isAdmin) {
      await imageRef.update({
        upgradesUsed: admin.firestore.FieldValue.increment(1),
      });
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