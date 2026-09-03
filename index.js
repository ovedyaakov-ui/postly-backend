import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import fetch from "node-fetch";
import sharp from "sharp";
import FormData from "form-data";
import strategies from "./strategies.js";
import { GoogleGenAI } from "@google/genai";
 
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
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
});
 
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REMOVE_BG_API_KEY = process.env.REMOVE_BG_API_KEY;
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
 
if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}
 
if (!GEMINI_API_KEY) {
  console.error("❌ חסר GEMINI_API_KEY");
  process.exit(1);
}
 
const gemini = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
 
// ============================================================
// OPENAI TEXT RETRY
// ============================================================
 
async function callOpenAIWithRetry(
  body,
  { maxRetries = 3, retryDelayMs = 1000 } = {}
) {
  let lastError = null;
 
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
 
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
 
          body: JSON.stringify(body),
        }
      );
 
      const isRetryableStatus =
        response.status === 429 || response.status >= 500;
 
      if (
        !response.ok &&
        isRetryableStatus &&
        attempt < maxRetries
      ) {
        console.log(
          `OpenAI call failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`
        );
 
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * attempt)
        );
 
        continue;
      }
 
      return response;
    } catch (err) {
      lastError = err;
 
      console.log(
        `OpenAI call threw error, attempt ${attempt}/${maxRetries}:`,
        err.message
      );
 
      if (attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * attempt)
        );
 
        continue;
      }
    }
  }
 
  throw lastError || new Error("OpenAI call failed after retries");
}
 
// ============================================================
// PRODUCT STAGING V3
// GEMINI 3.1 FLASH IMAGE
// ============================================================
//
// V2 (retired): remove.bg cutout -> anchor canvas -> mask -> OpenAI Image Edit
// V3 (current): original photo -> Gemini 3.1 Flash Image
//
// Gemini receives the full original photo directly and is instructed
// to preserve the exact subject while building a wide, fully new
// environment around it - no cutout, no mask needed.
//
// ============================================================
 
// Maps the category already detected by /analyze to a realistic, generic
// (unbranded) environment suitable for that kind of subject. Used only when
// the user did not type a custom scene description (the "automatic" path).
const CATEGORY_SCENE_DEFAULTS = {
  restaurant:
    "an elegant restaurant table setting, either a cozy warm-lit indoor dining space or an outdoor terrace with a scenic view, appetizing fine-dining presentation",
  food_product:
    "a bright modern grocery store shelf environment, softly blurred neighboring generic products, clean natural white lighting, wide aisle view",
  pet:
    "a cozy home living room with soft natural window light, or alternatively a green outdoor park setting",
  gaming:
    "a modern gaming setup with ambient RGB lighting, a clean desk environment",
  cosmetics:
    "an elegant makeup vanity table, or alternatively a luxurious bedroom setting with a stylish decorative mirror, soft flattering natural light, clean minimal styling",
  professional_service:
    "a clean modern professional office or workspace environment",
  vehicle:
    "an open road or stylish urban street setting, natural daylight",
  judaica:
    "an elegant home setting appropriate for a festive or traditional occasion, warm natural light",
  sports:
    "an outdoor urban street, park, or sports field setting, natural daylight, active energetic feel",
  children:
    "a bright, cheerful home playroom or nursery setting, soft natural light",
  fashion:
    "a clean low display pedestal or podium in a modern sport/urban studio setting (not placed directly on an empty floor), professional product photography composition, natural or soft studio light",
  jewelry_accessories:
    "displayed on a small elegant velvet cushion or resting inside an open luxury jewelry/watch presentation box, soft dramatic lighting, premium boutique setting",
  toys_games:
    "a bright cheerful home playroom setting, natural light",
  baby_products:
    "a soft, warm, cozy nursery setting, gentle natural light",
  garden_plants:
    "an outdoor garden or bright sunlit balcony setting",
  tools_hardware:
    "a clean workshop or garage setting, practical natural lighting",
  art_handmade:
    "a bright minimal home or studio interior, natural light, tasteful styling",
  books_media:
    "a cozy home reading nook or minimal bright shelf setting, warm natural light",
  events_party:
    "a festive, tastefully decorated indoor event setting, warm ambient lighting",
  smoking_accessories:
    "a minimal moody indoor setting with soft ambient lighting",
  alcohol_beverage:
    "an elegant bar counter or restaurant table setting, warm ambient lighting",
  home_services:
    "a clean modern home interior setting, natural daylight",
  health_wellness:
    "a calm, clean, bright wellness or spa-like setting, soft natural light",
  music_instruments:
    "a warm cozy studio or living room setting, natural light",
  electronics:
    "a clean modern minimal desk or home setting, soft natural light",
  home_goods:
    "a stylish modern home or office interior room appropriate for the item, with a window showing a pleasant outdoor view in the background to convey a sense of freedom, comfort and calm, natural daylight",
  everyday_items:
    "a clean modern minimal home setting, natural daylight",
  beauty_service:
    "an elegant clean salon or vanity setting, soft flattering light",
  real_estate:
    "a bright, tastefully furnished modern interior setting, natural daylight",
  education:
    "a bright clean modern learning or study setting, natural daylight",
  general:
    "a clean professional environment naturally suitable for the subject, with a wide visible background",
};
 
function buildAutomaticScene(category, description) {
  const sceneBase =
    CATEGORY_SCENE_DEFAULTS[category] ||
    CATEGORY_SCENE_DEFAULTS.general;
 
  return `${sceneBase}${
    description ? `, fitting for: ${description}` : ""
  }`;
}
 
function buildScenePrompt(sceneDescription) {
  return `
Create a photorealistic premium photograph using the exact real subject from the provided image (this may be a product, food, a pet, or any other subject).
 
IMPORTANT SUBJECT PRESERVATION:
- Preserve the exact identity, shape and proportions of the subject in the image.
- If the subject has packaging, logos, brand colors or text, preserve them exactly.
- Do not redesign, replace or invent a different subject.
 
SCENE:
Place the real subject naturally in the following scene: ${sceneDescription}
 
FRAMING (VERY IMPORTANT):
- Reframe the shot as if the camera has been pulled back to a wider angle than the original image.
- The subject should occupy roughly 25-40% of the frame, not fill it.
- Show the entire supporting surface (the full table, plate area, or ground) with clear space around the subject.
- Show a generous, clearly visible background environment behind and around the subject (e.g. a street view, a sea view, a room, as described in the scene) - the background must be a real recognizable part of the image, not blurred out or cropped away.
- Do not simply repaint the area immediately touching the subject - construct a full wide environmental photograph.
 
PHYSICAL INTEGRATION:
- Match the subject's lighting to the new scene's lighting.
- Match color temperature and exposure.
- Add realistic reflected environmental light onto the subject.
- Add realistic contact shadow and soft cast shadow beneath the subject.
- Make the subject physically grounded in the scene (standing, sitting or resting naturally, as appropriate).
- Match perspective, scale and camera angle naturally.
- The subject must look photographed inside the scene, not pasted onto it.
- The support surface itself (table, shelf, floor, counter, etc.) must be rendered as a fully integrated part of the environment - not as a separate inserted platform floating in front of the background.
- The support surface must match the material, color, perspective and lighting of the surrounding environment (other shelves, walls, floor, furniture already in the scene).
- There must be no visible seam, edge, or discontinuity between the support surface and the rest of the environment - it should look like a single continuous photograph, not a collage of separate elements.
 
CONTENT RESTRICTIONS (STRICT):
- Do NOT generate any real-world brand names, store names, chain names, or logos anywhere in the background (e.g. no supermarket chain signage, no store banners with real brand names).
- Do NOT generate any price tags, price labels, discount stickers, or any readable pricing text anywhere in the image.
- Do NOT generate any readable text, signage, or labels in the background other than what already exists on the preserved subject itself.
- Keep the environment generic and unbranded - a realistic but fictional/generic setting only.
 
ENVIRONMENT RICHNESS (IMPORTANT):
- The background environment must be visually rich and specific to the product's category and commercial mood - not sparse, empty, or generically bright.
- Add appropriate atmospheric elements: materials, textures, subtle props, and depth that reinforce the intended premium/commercial feel of this type of product.
- For premium or luxury subjects, use richer materials (e.g. textured walls, wood, stone, fabric, ambient depth) and more deliberate, moody lighting rather than flat bright lighting.
- The environment should tell a visual story appropriate to the product - it should not feel like a blank showroom unless that is specifically what was requested.
- These added elements must stay in the background/periphery and must not compete with or visually overpower the subject.
 
HERO PRODUCT DOMINANCE (CRITICAL BALANCE):
- Despite the environment richness above, the subject must remain the unmistakable hero of the image at first glance - context yes, distraction no.
- The subject should occupy roughly 35-45% of the frame - large enough to dominate visually, not lost in a busy scene.
- Create strong visual separation between the subject and the background: if the subject is dark-colored, the area immediately behind and around it should be relatively lighter (and vice versa) so it doesn't blend into the background.
- Add a subtle rim light or edge light around the subject's silhouette to help it stand out crisply from the background.
- Keep the immediate area directly behind the subject visually calmer/simpler than the rest of the scene - richness and detail should be more present at the edges and periphery of the frame, not directly behind the subject where it would compete with it.
- The background is a supporting environment, not the main subject of the photograph.
 
IMAGE QUALITY:
- Sharp detailed photography.
- Deep focus.
- Clear, detailed background matching the requested scene.
- No heavy blur.
- No strong bokeh.
- No artificial CGI appearance.
- No watermark.
 
Square 1:1 composition.
`.trim();
}
 
async function translateSceneToEnglish(text) {
  if (!text || !text.trim()) {
    return text;
  }
 
  // Quick check - if it's already plain English/Latin text, skip the extra API call.
  const hasNonLatin = /[^\x00-\x7F]/.test(text);
  if (!hasNonLatin) {
    return text;
  }
 
  try {
    const response = await callOpenAIWithRetry({
      model: "gpt-4o",
      max_tokens: 200,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Translate the following product photo scene description into natural, concise English, suitable as an image generation prompt. Return ONLY the translated text, nothing else, no quotes, no explanation.\n\n${text}`,
        },
      ],
    });
 
    const data = await response.json();
    const translated = data?.choices?.[0]?.message?.content?.trim();
 
    return translated || text;
  } catch (err) {
    console.log("Scene translation failed, using original text:", err.message);
    return text;
  }
}
 
async function generateSceneWithGemini(
  imageBuffer,
  sceneDescription,
  { maxRetries = 3, retryDelayMs = 1500 } = {}
) {
  const prompt = buildScenePrompt(sceneDescription);
  const base64Image = imageBuffer.toString("base64");
 
  let lastError = null;
 
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await gemini.models.generateContent({
        model: "gemini-3.1-flash-image",
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64Image,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: "1:1",
            imageSize: "1K",
          },
        },
      });
 
      const parts = response?.candidates?.[0]?.content?.parts || [];
 
      let imageData = null;
      let refusalText = null;
 
      for (const part of parts) {
        if (part.text) {
          refusalText = part.text;
        }
        if (part.inlineData?.data) {
          imageData = part.inlineData.data;
          break;
        }
      }
 
      if (imageData) {
        return { imageData };
      }
 
      // Gemini responded but returned no image (e.g. a refusal message).
      // This is not a retryable network/rate error - fail immediately with the reason.
      return {
        imageData: null,
        refusalText: refusalText || "Gemini לא החזיר תמונה",
      };
    } catch (err) {
      lastError = err;
 
      const isRetryable =
        err?.status === 429 ||
        err?.status >= 500 ||
        /RESOURCE_EXHAUSTED|UNAVAILABLE/i.test(err?.message || "");
 
      console.log(
        `Gemini call threw error, attempt ${attempt}/${maxRetries}:`,
        err.message
      );
 
      if (isRetryable && attempt < maxRetries) {
        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * attempt)
        );
 
        continue;
      }
 
      throw err;
    }
  }
 
  throw lastError || new Error("Gemini call failed after retries");
}
 
// ============================================================
// ANALYZE
// ============================================================
 
app.post(
  "/analyze",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Missing image",
        });
      }
 
      const rawBuffer =
        await fs.promises.readFile(req.file.path);
 
      const imageBuffer = await sharp(rawBuffer)
        .resize(1024, 1024, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: 80,
        })
        .toBuffer();
 
      const base64Image =
        imageBuffer.toString("base64");
 
      const visionResponse =
        await callOpenAIWithRetry({
          model: "gpt-4o",
 
          max_tokens: 300,
 
          temperature: 0.2,
 
          response_format: {
            type: "json_object",
          },
 
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
        });
 
      const visionData =
        await visionResponse.json();
 
      const visionText =
        visionData?.choices?.[0]?.message?.content;
 
      let vision;
 
      try {
        vision = JSON.parse(visionText);
      } catch {
        vision = {
          category: "general",
          description: "",
          detectedItems: "",
          targetAudience: "כללי",
          businessName: null,
          productName: null,
          brand: null,
        };
      }
 
      const category =
        vision.category || "general";
 
      const strategy =
        strategies[category] ||
        strategies.general;
 
      const hook =
        strategy.hooks[
          Math.floor(
            Math.random() *
              strategy.hooks.length
          )
        ];
 
      const cta =
        strategy.cta[
          Math.floor(
            Math.random() *
              strategy.cta.length
          )
        ];
 
      const emojis =
        strategy.emoji.join(" ");
 
      let titleHint = "";
 
      if (vision.businessName) {
        titleHint =
          `שם העסק: ${vision.businessName} — השתמש בו בכותרת הפוסט.`;
      } else if (vision.productName) {
        titleHint =
          `שם המוצר: ${vision.productName} — השתמש בו בכותרת הפוסט.`;
      } else if (vision.brand) {
        titleHint =
          `מותג: ${vision.brand} — אפשר להשתמש בו בכותרת.`;
      } else {
        titleHint =
          "לא זוהה שם ספציפי — כתוב כותרת לפי סוג המוצר בלבד.";
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
 
      const writeResponse =
        await callOpenAIWithRetry({
          model: "gpt-4o",
 
          max_tokens: 1000,
 
          temperature: 0.85,
 
          response_format: {
            type: "json_object",
          },
 
          messages: [
            {
              role: "user",
              content: postPrompt,
            },
          ],
        });
 
      const writeData =
        await writeResponse.json();
 
      const writeText =
        writeData?.choices?.[0]?.message?.content;
 
      let written;
 
      try {
        written =
          JSON.parse(writeText);
      } catch {
        written = {
          post: writeText,
        };
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
 
      const reviewResponse =
        await callOpenAIWithRetry({
          model: "gpt-4o",
 
          max_tokens: 200,
 
          temperature: 0.1,
 
          response_format: {
            type: "json_object",
          },
 
          messages: [
            {
              role: "user",
              content: reviewPrompt,
            },
          ],
        });
 
      const reviewData =
        await reviewResponse.json();
 
      const reviewText =
        reviewData?.choices?.[0]?.message?.content;
 
      let review;
 
      try {
        review =
          JSON.parse(reviewText);
      } catch {
        review = {
          rewrite: false,
        };
      }
 
      let finalPost =
        written.post;
 
      if (review.rewrite) {
        const rewriteResponse =
          await callOpenAIWithRetry({
            model: "gpt-4o",
 
            max_tokens: 1000,
 
            response_format: {
              type: "json_object",
            },
 
            messages: [
              {
                role: "user",
 
                content: `שפר את הפוסט הבא. גרום לו להיות יותר טבעי, מושך ומכירתי:
 
${written.post}
 
החזר JSON בלבד: { "post": "" }`,
              },
            ],
          });
 
        const rewriteData =
          await rewriteResponse.json();
 
        const rewriteText =
          rewriteData?.choices?.[0]?.message?.content;
 
        try {
          const rewritten =
            JSON.parse(rewriteText);
 
          finalPost =
            rewritten.post ||
            finalPost;
        } catch {}
      }
 
      res.json({
        post: finalPost,
        category,
        businessName:
          vision.businessName,
        productName:
          vision.productName,
        brand:
          vision.brand,
      });
 
      try {
        if (
          req.file &&
          fs.existsSync(
            req.file.path
          )
        ) {
          fs.unlinkSync(
            req.file.path
          );
        }
      } catch (err) {
        console.log(
          "File cleanup error:",
          err
        );
      }
    } catch (error) {
      console.log(
        "ANALYZE ERROR:",
        error
      );
 
      res.status(500).json({
        error:
          "שגיאה בעיבוד התמונה",
      });
    }
  }
);
 
// ============================================================
// CHANGE BACKGROUND (V3 - GEMINI)
// ============================================================
 
app.post(
  "/change-background",
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Missing image",
        });
      }
 
      const {
        userPrompt,
        description,
        category,
      } = req.body;
 
      const hasUserPrompt =
        userPrompt &&
        userPrompt.trim().length > 0;
 
      const rawBuffer =
        await fs.promises.readFile(
          req.file.path
        );
 
      // Normalize the source image (size + format) before sending to Gemini.
      const normalizedBuffer =
        await sharp(rawBuffer)
          .resize(1600, 1600, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 95,
          })
          .toBuffer();
 
      const requestedSceneRaw =
        hasUserPrompt
          ? userPrompt.trim()
          : buildAutomaticScene(
              category,
              description
            );
 
      const requestedScene =
        await translateSceneToEnglish(
          requestedSceneRaw
        );
 
      const { imageData, refusalText } =
        await generateSceneWithGemini(
          normalizedBuffer,
          requestedScene
        );
 
      if (!imageData) {
        console.log(
          "PRODUCT STAGING V3 - Gemini did not return an image:",
          refusalText
        );
 
        return res
          .status(422)
          .json({
            error:
              "לא ניתן היה ליצור את הסצנה עבור התמונה הזו",
            details: refusalText,
          });
      }
 
      const editedBuffer =
        Buffer.from(imageData, "base64");
 
      // Final normalization only - no compositing needed with the V3 pipeline.
      const finalBuffer =
        await sharp(editedBuffer)
          .resize(1024, 1024, {
            fit: "cover",
          })
          .png()
          .toBuffer();
 
      res.json({
        image: `data:image/png;base64,${finalBuffer.toString(
          "base64"
        )}`,
 
        stagingVersion:
          "v3-gemini-3.1-flash-image",
      });
 
      try {
        if (
          req.file &&
          fs.existsSync(
            req.file.path
          )
        ) {
          fs.unlinkSync(
            req.file.path
          );
        }
      } catch (err) {
        console.log(
          "File cleanup error:",
          err
        );
      }
    } catch (error) {
      console.log(
        "PRODUCT STAGING V3 ERROR:",
        error
      );
 
      res.status(500).json({
        error:
          "שגיאה בשינוי הרקע",
      });
    }
  }
);
 
// ============================================================
// IMPROVE
// ============================================================
 
app.post(
  "/improve",
  async (req, res) => {
    try {
      const {
        post,
        tone,
        category,
        productName,
        brand,
      } = req.body;
 
      if (!post) {
        return res
          .status(400)
          .json({
            error:
              "Missing post",
          });
      }
 
      const strategy =
        strategies[category] ||
        strategies.general;
 
      let tonePrompt = "";
 
      if (
        tone ===
        "aggressive"
      )
        tonePrompt = `אתה קופירייטר מכירות מנוסה.
 
שכתב את הפוסט הבא כך שיגרום לאנשים לרצות לקנות או להתעניין עכשיו.
 
המוצר שייך לקטגוריה: ${category}
 
${
  productName
    ? `שם המוצר: ${productName}`
    : ""
}
 
${
  brand
    ? `שם המותג: ${brand}`
    : ""
}
 
פעל לפי הגישה: ${strategy.approach}
 
רגשות להדגיש: ${strategy.emotions.join(
          ", "
        )}
 
הדגש את התועלת הישירה ללקוח — מה הוא מרוויח, מה הוא חוסך, מה הוא מרגיש.
 
השתמש במשפטים קצרים וחדים שיוצרים תחושת דחיפות טבעית — לא צעקות.
 
אל תגזים. אל תיצור לחץ מלאכותי.
 
אל תכתוב: "אל תחכו", "מהרו", "פיצוץ", "מדהים", "מושלם", "חייב".
 
השתמש ב-5 עד 8 אימוג'ים — כל פסקה מתחילה באימוג'י, הכותרת מתחילה ומסתיימת באימוג'י.
 
סיים בקריאה לפעולה ספציפית וברורה שמתחילה באימוג'י.`;
 
      if (
        tone ===
        "luxury"
      )
        tonePrompt = `אתה קופירייטר של מותגי יוקרה.
 
שכתב את הפוסט הבא בסגנון אלגנטי, שקט ומלוטש — כמו Apple, Rolex או Louis Vuitton.
 
המוצר שייך לקטגוריה: ${category}
 
${
  productName
    ? `שם המוצר: ${productName}`
    : ""
}
 
${
  brand
    ? `שם המותג: ${brand}`
    : ""
}
 
פעל לפי הגישה: ${strategy.approach}
 
כתוב לפחות 3 פסקאות עם רווחים ביניהם.
 
השתמש ב-5 עד 7 אימוג'ים אלגנטיים לאורך הפוסט — כל פסקה מתחילה באימוג'י.
 
אל תצעק. אל תשתמש בסימני קריאה מרובים.
 
אל תשתמש במשפטים פילוסופיים או ספרותיים מדי.
 
אל תכתוב: "מדהים", "מושלם", "מהפכה", "הדור הבא", "לא תאמין".
 
הפוסט צריך לגרום לקורא להרגיש שהמוצר הוא מעל הממוצע — בלי להגיד את זה במפורש.`;
 
      if (
        tone ===
        "casual"
      )
        tonePrompt = `אתה בעל עסק שכותב פוסט לחברים שלו ברשת החברתית.
 
שכתב את הפוסט הבא בסגנון קליל, אישי וחברותי — כאילו בן אדם אמיתי כתב אותו.
 
המוצר שייך לקטגוריה: ${category}
 
${
  productName
    ? `שם המוצר: ${productName}`
    : ""
}
 
${
  brand
    ? `שם המותג: ${brand}`
    : ""
}
 
פעל לפי הגישה: ${strategy.approach}
 
כתוב בשפה יומיומית ופשוטה. אל תנסה להישמע "מקצועי מדי".
 
השתמש ב-5 עד 8 אימוג'ים בצורה טבעית — כמו שאנשים כותבים בוואטסאפ.
 
אל תשתמש בסלנג מוגזם או בבדיחות שלא מתאימות לעסק.
 
הפוסט צריך לגרום לקורא לחייך ולהרגיש שהוא מכיר את הכותב.`;
 
      if (!tonePrompt) {
        return res
          .status(400)
          .json({
            error:
              "Invalid tone",
          });
      }
 
      const response =
        await callOpenAIWithRetry({
          model: "gpt-4o",
 
          max_tokens: 600,
 
          temperature: 0.85,
 
          response_format: {
            type: "json_object",
          },
 
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
 
      const data =
        await response.json();
 
      const rawContent =
        data?.choices?.[0]
          ?.message?.content;
 
      const text =
        typeof rawContent ===
        "string"
          ? rawContent
          : JSON.stringify(
              rawContent ??
                ""
            );
 
      const cleaned =
        text
          .replace(
            /```json/g,
            ""
          )
          .replace(
            /```/g,
            ""
          )
          .trim();
 
      let parsed;
 
      try {
        parsed =
          JSON.parse(
            cleaned
          );
 
        if (
          !parsed ||
          typeof parsed !==
            "object" ||
          !parsed.post
        ) {
          parsed = {
            post: cleaned,
          };
        }
      } catch {
        parsed = {
          post: cleaned,
        };
      }
 
      res.json(parsed);
    } catch (error) {
      console.log(
        "IMPROVE ERROR:",
        error
      );
 
      res.status(500).json({
        error:
          "שגיאה בשיפור",
      });
    }
  }
);
 
const PORT =
  process.env.PORT ||
  3001;
 
app.listen(
  PORT,
  () => {
    console.log(
      "🔥 Backend עובד על פורט",
      PORT
    );
 
    console.log(
      "🖼️ Product Staging V3: Gemini 3.1 Flash Image"
    );
  }
);