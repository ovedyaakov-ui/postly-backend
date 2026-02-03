import express from "express";
import multer from "multer";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

app.post("/analyze", upload.single("image"), (req, res) => {
  console.log("📥 REQUEST הגיע לשרת");
  console.log("📄 FILE:", req.file);

  // פוסט דמה – שלב ביניים
  res.json({
    text: "📸 רגעים קטנים עושים יום גדול ✨\nמתחיל את היום עם אנרגיה טובה ☕️🔥"
  });
});

// ⚠️ תיקון קריטי ל־Render
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("🔥 Backend עובד על פורט", PORT);
});