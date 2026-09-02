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

if (!OPENAI_API_KEY) {
  console.error("❌ חסר OPENAI_API_KEY");
  process.exit(1);
}

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
// REMOVE.BG
// ============================================================

async function removeBackground(
  imageBuffer,
  { maxRetries = 3, retryDelayMs = 1000 } = {}
) {
  if (!REMOVE_BG_API_KEY) {
    throw new Error("חסר REMOVE_BG_API_KEY");
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();

      form.append("image_file", imageBuffer, {
        filename: "image.jpg",
        contentType: "image/jpeg",
      });

      form.append("size", "auto");

      const response = await fetch(
        "https://api.remove.bg/v1.0/removebg",
        {
          method: "POST",

          headers: {
            "X-Api-Key": REMOVE_BG_API_KEY,
            ...form.getHeaders(),
          },

          body: form,
        }
      );

      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();

        return Buffer.from(arrayBuffer);
      }

      const isRetryableStatus =
        response.status === 429 || response.status >= 500;

      if (
        isRetryableStatus &&
        attempt < maxRetries
      ) {
        console.log(
          `remove.bg failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`
        );

        await new Promise((resolve) =>
          setTimeout(resolve, retryDelayMs * attempt)
        );

        continue;
      }

      const errorText = await response.text();

      throw new Error(
        `remove.bg error (status ${response.status}): ${errorText}`
      );
    } catch (err) {
      lastError = err;

      console.log(
        `remove.bg call threw error, attempt ${attempt}/${maxRetries}:`,
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

  throw lastError || new Error("remove.bg failed after retries");
}

// ============================================================
// PRODUCT STAGING V2.1
// OPENAI BACKGROUND GENERATION + LOCAL IMAGE EDIT
// ============================================================

async function generateProductBackgroundWithRetry(
  prompt,
  { maxRetries = 3, retryDelayMs = 1500 } = {}
) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },

          body: JSON.stringify({
            model: "gpt-image-1",
            prompt,
            size: "1024x1024",
            quality: "high",
            output_format: "png",
          }),
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
          `Product background generation failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`
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
        `Product background generation threw error, attempt ${attempt}/${maxRetries}:`,
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

  throw lastError ||
    new Error("Product background generation failed after retries");
}

// ============================================================
// PRODUCT STAGING V2
// OPENAI IMAGE EDIT
// ============================================================

async function editProductSceneWithRetry(
  imageBuffer,
  maskBuffer,
  prompt,
  { maxRetries = 3, retryDelayMs = 1500 } = {}
) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const form = new FormData();

      form.append("model", "gpt-image-1");

      form.append("image", imageBuffer, {
        filename: "product-anchor.png",
        contentType: "image/png",
      });

      form.append("mask", maskBuffer, {
        filename: "product-mask.png",
        contentType: "image/png",
      });

      form.append("prompt", prompt);

      form.append("size", "1024x1024");

      form.append("quality", "high");

      form.append("input_fidelity", "high");

      const response = await fetch(
        "https://api.openai.com/v1/images/edits",
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            ...form.getHeaders(),
          },

          body: form,
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
          `Product Staging V2 failed (status ${response.status}), attempt ${attempt}/${maxRetries}. Retrying...`
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
        `Product Staging V2 threw error, attempt ${attempt}/${maxRetries}:`,
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

  throw lastError ||
    new Error("Product Staging V2 failed after retries");
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
// PRODUCT STAGING V2.1
// ============================================================
//
// V1.1:
// background generation -> manual product composite
//
// V2:
// product anchor -> OpenAI builds the whole environment
//
// V2.1:
// sharp background generation -> real product composite
// -> local OpenAI edit ONLY at the product/support contact area
//
// המטרה: לשמור את הרקע חד, לשמור את המוצר האמיתי,
// ולתת ל-AI ליצור רק את החיבור הפיזי באזור המגע.
//
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
      } = req.body;

      const hasUserPrompt =
        userPrompt &&
        userPrompt.trim().length > 0;

      const rawBuffer =
        await fs.promises.readFile(
          req.file.path
        );

      // ======================================================
      // STEP 1
      // Normalize source image
      // ======================================================

      const originalBuffer =
        await sharp(rawBuffer)
          .resize(1600, 1600, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 95,
          })
          .toBuffer();

      // ======================================================
      // STEP 2
      // Extract the REAL product
      // ======================================================

      const cutoutBuffer =
        await removeBackground(
          originalBuffer
        );

      // הסרת שטח שקוף מיותר מסביב למוצר.
      const trimmedCutout =
        await sharp(cutoutBuffer)
          .trim({
            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          })
          .png()
          .toBuffer();

      // ======================================================
      // STEP 3
      // Size and position the real product
      // ======================================================

      const canvasSize = 1024;

      const maxProductWidth =
        Math.round(
          canvasSize * 0.46
        );

      const maxProductHeight =
        Math.round(
          canvasSize * 0.54
        );

      const resizedProduct =
        await sharp(trimmedCutout)
          .resize({
            width:
              maxProductWidth,

            height:
              maxProductHeight,

            fit: "inside",

            withoutEnlargement:
              true,
          })
          .png()
          .toBuffer();

      const productMeta =
        await sharp(
          resizedProduct
        ).metadata();

      const productWidth =
        productMeta.width ||
        maxProductWidth;

      const productHeight =
        productMeta.height ||
        maxProductHeight;

      const productLeft =
        Math.round(
          (canvasSize -
            productWidth) /
            2
        );

      const contactY =
        Math.round(
          canvasSize * 0.79
        );

      const productTop =
        Math.max(
          0,
          contactY -
            productHeight
        );

      // ======================================================
      // STEP 4
      // Generate a SHARP background without the product
      // ======================================================

      const requestedScene =
        hasUserPrompt
          ? userPrompt.trim()
          : `a clean professional commercial advertising environment naturally suitable for ${
              description ||
              "this product"
            }`;

      const backgroundPrompt = `
Create a highly realistic professional commercial product photography BACKGROUND ONLY.

SCENE REQUEST:
${requestedScene}

IMPORTANT COMPOSITION:

- Do NOT generate the advertised product.
- Do NOT generate packaging, boxes or another competing hero product.
- Leave a clean empty hero area in the lower center of the image for a real product that will be added later.
- The product will stand on a physical support surface with its bottom at approximately 79% of the image height.
- Build the table, counter, pedestal, floor or other suitable support so that this lower-center contact position makes physical sense.
- Keep the support surface clearly visible under the future product position.

FOCUS AND IMAGE QUALITY:

- Photorealistic commercial photography.
- Premium advertising quality.
- DEEP FOCUS PHOTOGRAPHY.
- Keep foreground, support surface, props and background detailed and recognizable.
- Preserve visible texture, edges and material detail throughout the scene.
- Use a small-aperture deep-focus look similar to f/11.
- NO HEAVY BLUR.
- NO STRONG BOKEH.
- NO EXTREME SHALLOW DEPTH OF FIELD.
- NO SOFT OR SMEARED BACKGROUND.
- Do not use background blur as the main visual effect.
- Natural believable materials.
- Realistic perspective and scale.
- No advertising text.
- No fake logos.
- No watermark.
- Avoid artificial CGI appearance.
- Avoid obvious AI artifacts.

Square 1:1 composition.
`;

      const backgroundResponse =
        await generateProductBackgroundWithRetry(
          backgroundPrompt
        );

      const backgroundRawText =
        await backgroundResponse.text();

      let backgroundData;

      try {
        backgroundData =
          JSON.parse(
            backgroundRawText
          );
      } catch {
        console.log(
          "PRODUCT STAGING V2.1 - invalid background response:",
          backgroundRawText
        );

        return res
          .status(500)
          .json({
            error:
              "OpenAI החזיר תשובה לא תקינה ביצירת הרקע",
          });
      }

      if (!backgroundResponse.ok) {
        console.log(
          "PRODUCT STAGING V2.1 BACKGROUND ERROR:",
          JSON.stringify(
            backgroundData
          )
        );

        return res
          .status(
            backgroundResponse.status
          )
          .json({
            error:
              backgroundData?.error
                ?.message ||
              "שגיאה ביצירת הרקע",
          });
      }

      const backgroundB64 =
        backgroundData?.data?.[0]
          ?.b64_json;

      if (!backgroundB64) {
        console.log(
          "PRODUCT STAGING V2.1 - no background image returned:",
          JSON.stringify(
            backgroundData
          )
        );

        return res
          .status(500)
          .json({
            error:
              "לא התקבלה תמונת רקע מ-OpenAI",
          });
      }

      const backgroundBuffer =
        await sharp(
          Buffer.from(
            backgroundB64,
            "base64"
          )
        )
          .resize(
            canvasSize,
            canvasSize,
            {
              fit: "cover",
            }
          )
          .png()
          .toBuffer();

      // ======================================================
      // STEP 5
      // Composite the REAL product over the sharp background
      // ======================================================

      const productComposite =
        await sharp(backgroundBuffer)
          .composite([
            {
              input:
                resizedProduct,

              left:
                productLeft,

              top:
                productTop,
            },
          ])
          .png()
          .toBuffer();

      // ======================================================
      // STEP 6
      // Build a LOCAL edit mask only under the product
      // ======================================================
      //
      // Opaque mask = protected area.
      // Transparent mask = area OpenAI may edit.
      //
      // רוב הרקע והמוצר מוגנים.
      // רק פס קטן מתחת למוצר פתוח לעריכת צל ומגע.
      //
      // ======================================================

      const editPaddingX = 70;
      const editBandHeight = 58;

      const editLeft =
        Math.max(
          0,
          productLeft -
            editPaddingX
        );

      const editWidth =
        Math.min(
          canvasSize -
            editLeft,
          productWidth +
            editPaddingX * 2
        );

      const editTop =
        Math.max(
          0,
          contactY
        );

      const editHeight =
        Math.min(
          editBandHeight,
          canvasSize - editTop
        );

      const opaqueMaskPiece = async (width, height) =>
        sharp({
          create: {
            width,
            height,
            channels: 4,
            background: {
              r: 255,
              g: 255,
              b: 255,
              alpha: 1,
            },
          },
        })
          .png()
          .toBuffer();

      const maskParts = [];

      if (editTop > 0) {
        maskParts.push({
          input:
            await opaqueMaskPiece(
              canvasSize,
              editTop
            ),
          left: 0,
          top: 0,
        });
      }

      if (editTop + editHeight < canvasSize) {
        maskParts.push({
          input:
            await opaqueMaskPiece(
              canvasSize,
              canvasSize -
                (editTop + editHeight)
            ),
          left: 0,
          top:
            editTop + editHeight,
        });
      }

      if (editLeft > 0) {
        maskParts.push({
          input:
            await opaqueMaskPiece(
              editLeft,
              editHeight
            ),
          left: 0,
          top: editTop,
        });
      }

      if (editLeft + editWidth < canvasSize) {
        maskParts.push({
          input:
            await opaqueMaskPiece(
              canvasSize -
                (editLeft + editWidth),
              editHeight
            ),
          left:
            editLeft + editWidth,
          top: editTop,
        });
      }

      const localEditMask =
        await sharp({
          create: {
            width: canvasSize,
            height: canvasSize,
            channels: 4,

            background: {
              r: 0,
              g: 0,
              b: 0,
              alpha: 0,
            },
          },
        })
          .composite(maskParts)
          .png()
          .toBuffer();

      // ======================================================
      // STEP 7
      // Local Image Edit: contact shadow only
      // ======================================================

      const integrationPrompt = `
This image already contains the REAL advertised product placed on a finished sharp commercial background.

EDIT ONLY THE SMALL TRANSPARENT MASKED AREA DIRECTLY UNDER THE PRODUCT.

GOAL:
Create the physical contact between the existing real product and the existing support surface.

RULES:

- Do not redesign or replace the product.
- Do not change the product packaging, logo, label, colors, shape or proportions.
- Do not alter the background outside the editable masked area.
- Do not blur the background.
- Do not add bokeh.
- Do not create new props or products.
- Preserve the existing perspective and surface texture.
- Create a realistic tight contact shadow beginning exactly at the product base.
- Add subtle ambient occlusion at the product/support contact edge.
- Match the existing light direction, intensity and color temperature.
- Keep the shadow physically plausible and subtle, not a floating drop shadow.
- The result must make the product look physically grounded on the existing surface.
`;

      const editResponse =
        await editProductSceneWithRetry(
          productComposite,
          localEditMask,
          integrationPrompt
        );

      const rawResponseText =
        await editResponse.text();

      let editData;

      try {
        editData =
          JSON.parse(
            rawResponseText
          );
      } catch {
        console.log(
          "PRODUCT STAGING V2.1 - invalid local edit response:",
          rawResponseText
        );

        return res
          .status(500)
          .json({
            error:
              "OpenAI החזיר תשובה לא תקינה בחיבור המוצר",
          });
      }

      if (!editResponse.ok) {
        console.log(
          "PRODUCT STAGING V2.1 LOCAL EDIT ERROR:",
          JSON.stringify(
            editData
          )
        );

        return res
          .status(
            editResponse.status
          )
          .json({
            error:
              editData?.error
                ?.message ||
              "שגיאה בחיבור המוצר לרקע",
          });
      }

      const editedB64 =
        editData?.data?.[0]
          ?.b64_json;

      if (!editedB64) {
        console.log(
          "PRODUCT STAGING V2.1 - no local edit image returned:",
          JSON.stringify(
            editData
          )
        );

        return res
          .status(500)
          .json({
            error:
              "לא התקבלה תמונה מ-OpenAI בחיבור המוצר",
          });
      }

      const finalBuffer =
        await sharp(
          Buffer.from(
            editedB64,
            "base64"
          )
        )
          .resize(
            canvasSize,
            canvasSize,
            {
              fit: "cover",
            }
          )
          .png()
          .toBuffer();

      res.json({
        image:
          `data:image/png;base64,${finalBuffer.toString(
            "base64"
          )}`,

        stagingVersion:
          "v2.1-sharp-background-local-contact-edit",
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
        "PRODUCT STAGING V2.1 ERROR:",
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
      "🖼️ Product Staging V2.1: Sharp Background + Local Contact Edit"
    );
  }
);