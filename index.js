import express from "express";
import multer from "multer";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

/**
 * ✅ בדיקת חיים – רק לבדיקה בדפדפן
 * לא קשור לאפליקציה
 */
app.get("/", (req, res) => {
  res.send("Postly backend alive ✅");
});

/**
 * POST /analyze
 * האפליקציה שולחת תמונה → השרת מחזיר פוסט דמה
 */
app.post("/analyze", upload.single("image"), (req, res) => {
  console.log("📥 REQUEST הגיע לשרת");
  console.log("📄 FILE:", req.file);

  res.json({
    text: "📸 רגעים קטנים עושים יום גדול ✨\nמתחיל את היום עם אנרגיה טובה ☕️🔥"
  });
});

/**
 * GET /analyze
 * בדיקה ידנית (לא חובה לאפליקציה)
 */
app.get("/analyze", (req, res) => {
  res.json({
    text: "📸 Postly בדיקה – השרת מחזיר פוסט כמו שצריך ✅"
  });
});

/**
 * חובה ל-Render
 */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});
