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
  res.json({ text: "Postly backend עובד 🎉" });
});

app.listen(3001, () => {
  console.log("🔥 Backend עובד על פורט 3001");
});