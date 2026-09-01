import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import sharp from "sharp";
import FormData from "form-data";
import strategies from "./strategies.js";
 
const app = express();
app.use(cors());
app.use(express.json());
 
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + "-" + Math.round(Math.random() * 1e9) + ".jpg";
    cb(null, uniqueName);
  },
});
 
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});
 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PHOTOROOM_API_KEY = process.env.PHOTOROOM_API_KEY;
 
if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}
 
// עוטף קריאה ל-OpenAI (טקסט/JSON) בניסיונות חוזרים (retry) במקרה של כשל זמני
async function callOpenAIWithRetry(body, { maxRetries = 3, retryDelayMs = 1000 } = {}) {
  let lastError = null;
 
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body),
      });
 
      const isRetryableStatus = response.status === 429 || response.status >= 500;
 
      if (!response.ok && isRetryableStatus && attempt < maxRetries) {
        console.log(`OpenAI call failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
 
      return response;
    } catch (err) {
      lastError = err;
      console.log(`OpenAI call threw error, attempt ${attempt}/${maxRetries}:`, err.message);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
    }
  }
 
  throw lastError || new Error("OpenAI call failed after retries");
}
 
// עוטף קריאה ל-Photoroom (הסרת רקע + רקע AI + צללים, הכל בקריאה אחת) בניסיונות חוזרים
async function callPhotoroomWithRetry(form, { maxRetries = 3, retryDelayMs = 1000 } = {}) {
  if (!PHOTOROOM_API_KEY) {
    throw new Error("חסר PHOTOROOM_API_KEY");
  }
 
  let lastError = null;
 
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("https://image-api.photoroom.com/v2/edit", {
        method: "POST",
        headers: {
          "x-api-key": PHOTOROOM_API_KEY,
          Accept: "image/png, application/json",
          ...form.getHeaders(),
        },
        body: form.getBuffer(),
      });
 
      const isRetryableStatus = response.status === 429 || response.status >= 500;
 
      if (!response.ok && isRetryableStatus && attempt < maxRetries) {
        console.log(`Photoroom call failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
 
      return response;
    } catch (err) {
      lastError = err;
      console.log(`Photoroom call threw error, attempt ${attempt}/${maxRetries}:`, err.message);
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        continue;
      }
    }
  }
 
  throw lastError || new Error("Photoroom call failed after retries");
}
 
app.post("/analyze", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing image" });
    }
 
    const rawBuffer = await fs.promises.readFile(req.file.path);
    const imageBuffer = await sharp(rawBuffer).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
    const base64Image = imageBuffer.toString("base64");
 
    const visionResponse = await callOpenAIWithRetry({
      model: "gpt-4o",
      max_tokens: 300,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `נתח את התמונה והחזר JSON בלבד.
 
חשוב: זהה מה המוצר או השירות מיועד לעשות — לא רק מה שרואים פיזית.
לדוגמה: אם רואים בקבוק עם תרסיס, כתוב "חומר לניקוי חלונות" ולא "בקבוק".
אם רואים שפופרת, כתוב "קרם ידיים" ולא "שפופרת".
אם רואים צלחת עם אוכל, כתוב את שם המנה ולא "צלחת".
 
החזר JSON בלבד:
{
  "category": "restaurant|food_product|pet|gaming|cosmetics|professional_service|vehicle|judaica|sports|children|fashion|jewelry_accessories|toys_games|baby_products|garden_plants|tools_hardware|art_handmade|books_media|events_party|smoking_accessories|alcohol_beverage|home_services|health_wellness|music_instruments|electronics|home_goods|everyday_items|beauty_service|real_estate|education|general",
  "description": "מה המוצר או השירות עושה — לא התיאור הפיזי שלו",
  "detectedItems": "רשימה של מוצרים או שירותים שנראים בבירור בתמונה",
  "targetAudience": "קהל היעד",
  "businessName": "שם העסק אם נראה בבירור בתמונה, אחרת null",
  "productName": "שם המוצר אם נראה בבירור בתמונה, אחרת null",
  "brand": "שם המותג אם נראה בבירור בתמונה, אחרת null"
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
    });
 
    const visionData = await visionResponse.json();
    const visionText = visionData?.choices?.[0]?.message?.content;
    let vision;
    try {
      vision = JSON.parse(visionText);
    } catch {
      vision = { category: "general", description: "", detectedItems: "", targetAudience: "כללי", businessName: null, productName: null, brand: null };
    }
 
    const category = vision.category || "general";
    const strategy = strategies[category] || strategies.general;
 
    const hook = strategy.hooks[Math.floor(Math.random() * strategy.hooks.length)];
    const cta = strategy.cta[Math.floor(Math.random() * strategy.cta.length)];
    const emojis = strategy.emoji.join(" ");
 
    let titleHint = "";
    if (vision.businessName) {
      titleHint = `שם העסק: ${vision.businessName} — השתמש בו בכותרת הפוסט.`;
    } else if (vision.productName) {
      titleHint = `שם המוצר: ${vision.productName} — השתמש בו בכותרת הפוסט.`;
    } else if (vision.brand) {
      titleHint = `מותג: ${vision.brand} — אפשר להשתמש בו בכותרת.`;
    } else {
      titleHint = `לא זוהה שם ספציפי — כתוב כותרת לפי סוג המוצר בלבד.`;
    }
 
    const postPrompt = `אתה קופירייטר של עסקים אמיתיים.
 
המטרה שלך היא לכתוב פוסטים שנראים כאילו בעל העסק כתב אותם או כאילו נכתבו על ידי משרד פרסום.
 
מותר להשתמש במשפטים שיווקיים מקובלים.
אל תנסה להיות ספרותי.
אל תנסה להיות פילוסופי.
כתוב פשוט. כתוב טבעי. כתוב משכנע.
 
המוצר: ${vision.description}
פריטים שנראים בבירור בתמונה: ${vision.detectedItems}
קהל יעד: ${vision.targetAudience}
סגנון: ${strategy.tone}
רגשות להדגיש: ${strategy.emotions.join(", ")}
גישה: ${strategy.approach}
אסור לכתוב: ${strategy.forbidden.join(", ")}
אימוג'ים מומלצים: ${emojis}
 
הנחיית כותרת: ${titleHint}
פתיחה מומלצת: ${hook}
קריאה לפעולה: ${cta}
 
כללי עיצוב הפוסט:
- כל כותרת חייבת להתחיל באימוג'י אחד ולהסתיים באימוג'י אחד.
- כל פסקה תתחיל באימוג'י שמתאים לנושא.
- השאר שורה ריקה בין כל פסקה.
- השתמש ב-5 עד 8 אימוג'ים לאורך כל הפוסט.
- אל תשים יותר מ-2 אימוג'ים רצופים.
- הקריאה לפעולה בסוף חייבת להתחיל באימוג'י.
- הפוסט צריך להיות נעים לעין, עם רווחים בין הפסקאות, ולא גוש טקסט אחד.
 
כתוב פוסט שיווקי בעברית:
- התחל עם כותרת חזקה לפי הנחיית הכותרת
- המשך עם 2-3 פסקאות שמדברות אל הלקוח
- כתוב רק על מה שזוהה בתמונה — אל תמציא מוצרים ספציפיים שלא נראים בבירור
- אל תמציא מחיר, מבצע או הנחה
- אל תכתוב "בתמונה רואים"
- סיים עם קריאה לפעולה
 
החזר JSON בלבד: { "post": "" }`;
 
    const writeResponse = await callOpenAIWithRetry({
      model: "gpt-4o",
      max_tokens: 1000,
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: postPrompt }],
    });
 
    const writeData = await writeResponse.json();
    const writeText = writeData?.choices?.[0]?.message?.content;
    let written;
    try {
      written = JSON.parse(writeText);
    } catch {
      written = { post: writeText };
    }
 
    const reviewPrompt = `קרא את הפוסט הבא ודרג אותו:
 
${written.post}
 
החזר JSON בלבד:
{
  "hook": 0-10,
  "naturalness": 0-10,
  "sales": 0-10,
  "overall": 0-10,
  "rewrite": true/false
}
 
rewrite יהיה true רק אם overall נמוך מ-8.`;
 
    const reviewResponse = await callOpenAIWithRetry({
      model: "gpt-4o",
      max_tokens: 200,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: reviewPrompt }],
    });
 
    const reviewData = await reviewResponse.json();
    const reviewText = reviewData?.choices?.[0]?.message?.content;
    let review;
    try {
      review = JSON.parse(reviewText);
    } catch {
      review = { rewrite: false };
    }
 
    let finalPost = written.post;
 
    if (review.rewrite) {
      const rewriteResponse = await callOpenAIWithRetry({
        model: "gpt-4o",
        max_tokens: 1000,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `שפר את הפוסט הבא. גרום לו להיות יותר טבעי, מושך ומכירתי:
 
${written.post}
 
החזר JSON בלבד: { "post": "" }`
          }
        ],
      });
 
      const rewriteData = await rewriteResponse.json();
      const rewriteText = rewriteData?.choices?.[0]?.message?.content;
      try {
        const rewritten = JSON.parse(rewriteText);
        finalPost = rewritten.post || finalPost;
      } catch {}
    }
 
    res.json({
      post: finalPost,
      category,
      businessName: vision.businessName,
      productName: vision.productName,
      brand: vision.brand
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
 
// endpoint: שינוי הרקע של תמונת המוצר, באמצעות Photoroom Image Editing API.
// קריאה אחת עושה הכל: הסרת הרקע המקורי, יצירת רקע חדש שמתאים למוצר (AI Backgrounds),
// והוספת צל טבעי (AI Shadow) - כולל שימור מדויק של המוצר עצמו (כולל פרטים כמו פרצוף).
app.post("/change-background", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Missing image" });
    }
 
    const { userPrompt, description } = req.body;
    const hasUserPrompt = userPrompt && userPrompt.trim().length > 0;
 
    const rawBuffer = await fs.promises.readFile(req.file.path);
    const imageBuffer = await sharp(rawBuffer)
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer();
 
    const backgroundPrompt = hasUserPrompt
      ? userPrompt.trim()
      : `the image displays ${description || "a product"} placed outdoors on vivid green grass, under warm golden-hour sunlight, with a blurred garden in the background full of colorful flowers. Do not use gray, white, or neutral studio colors anywhere in the background.`;
 
    console.log("BACKGROUND PROMPT SENT:", backgroundPrompt);
 
    const form = new FormData();
    form.append("imageFile", imageBuffer, { filename: "image.jpg", contentType: "image/jpeg" });
    form.append("shadow.mode", "ai.soft");
    form.append("background.prompt", backgroundPrompt);
    form.append("padding", "0.1");
 
    const photoroomResponse = await callPhotoroomWithRetry(form);
 
    if (!photoroomResponse.ok) {
      const errorText = await photoroomResponse.text();
      console.log("PHOTOROOM ERROR:", photoroomResponse.status, errorText);
      return res.status(500).json({ error: "לא הצלחנו לשנות את הרקע" });
    }
 
    const resultArrayBuffer = await photoroomResponse.arrayBuffer();
    const resultBuffer = Buffer.from(resultArrayBuffer);
 
    res.json({
      image: `data:image/png;base64,${resultBuffer.toString("base64")}`,
      debugPromptSent: backgroundPrompt,
    });
 
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (err) {
      console.log("File cleanup error:", err);
    }
  } catch (error) {
    console.log("BACKGROUND CHANGE ERROR:", error);
    res.status(500).json({ error: "שגיאה בשינוי הרקע" });
  }
});
 
app.post("/improve", async (req, res) => {
  try {
    const { post, tone, category, productName, brand } = req.body;
 
    if (!post) {
      return res.status(400).json({ error: "Missing post" });
    }
 
    const strategy = strategies[category] || strategies.general;
 
    let tonePrompt = "";
 
    if (tone === "aggressive") tonePrompt = `אתה קופירייטר מכירות מנוסה.
שכתב את הפוסט הבא כך שיגרום לאנשים לרצות לקנות או להתעניין עכשיו.
המוצר שייך לקטגוריה: ${category}
${productName ? `שם המוצר: ${productName}` : ""}
${brand ? `שם המותג: ${brand}` : ""}
פעל לפי הגישה: ${strategy.approach}
רגשות להדגיש: ${strategy.emotions.join(", ")}
הדגש את התועלת הישירה ללקוח — מה הוא מרוויח, מה הוא חוסך, מה הוא מרגיש.
השתמש במשפטים קצרים וחדים שיוצרים תחושת דחיפות טבעית — לא צעקות.
אל תגזים. אל תיצור לחץ מלאכותי.
אל תכתוב: "אל תחכו", "מהרו", "פיצוץ", "מדהים", "מושלם", "חייב".
השתמש ב-5 עד 8 אימוג'ים — כל פסקה מתחילה באימוג'י, הכותרת מתחילה ומסתיימת באימוג'י.
סיים בקריאה לפעולה ספציפית וברורה שמתחילה באימוג'י.`;
 
    if (tone === "luxury") tonePrompt = `אתה קופירייטר של מותגי יוקרה.
שכתב את הפוסט הבא בסגנון אלגנטי, שקט ומלוטש — כמו Apple, Rolex או Louis Vuitton.
המוצר שייך לקטגוריה: ${category}
${productName ? `שם המוצר: ${productName}` : ""}
${brand ? `שם המותג: ${brand}` : ""}
פעל לפי הגישה: ${strategy.approach}
כתוב לפחות 3 פסקאות עם רווחים ביניהם.
השתמש ב-5 עד 7 אימוג'ים אלגנטיים לאורך הפוסט — כל פסקה מתחילה באימוג'י.
אל תצעק. אל תשתמש בסימני קריאה מרובים.
אל תשתמש במשפטים פילוסופיים או ספרותיים מדי.
אל תכתוב: "מדהים", "מושלם", "מהפכה", "הדור הבא", "לא תאמין".
הפוסט צריך לגרום לקורא להרגיש שהמוצר הוא מעל הממוצע — בלי להגיד את זה במפורש.`;
 
    if (tone === "casual") tonePrompt = `אתה בעל עסק שכותב פוסט לחברים שלו ברשת החברתית.
שכתב את הפוסט הבא בסגנון קליל, אישי וחברותי — כאילו בן אדם אמיתי כתב אותו.
המוצר שייך לקטגוריה: ${category}
${productName ? `שם המוצר: ${productName}` : ""}
${brand ? `שם המותג: ${brand}` : ""}
פעל לפי הגישה: ${strategy.approach}
כתוב בשפה יומיומית ופשוטה. אל תנסה להישמע "מקצועי מדי".
השתמש ב-5 עד 8 אימוג'ים בצורה טבעית — כמו שאנשים כותבים בוואטסאפ.
אל תשתמש בסלנג מוגזם או בבדיחות שלא מתאימות לעסק.
הפוסט צריך לגרום לקורא לחייך ולהרגיש שהוא מכיר את הכותב.`;
 
    if (!tonePrompt) {
      return res.status(400).json({ error: "Invalid tone" });
    }
 
    const response = await callOpenAIWithRetry({
      model: "gpt-4o",
      max_tokens: 600,
      temperature: 0.85,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: `${tonePrompt}
 
הפוסט המקורי:
${post}
 
החזר JSON:
{ "post": "" }`,
        },
      ],
    });
 
    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content;
    const text = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");
    const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
 
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
      if (!parsed || typeof parsed !== "object" || !parsed.post) {
        parsed = { post: cleaned };
      }
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