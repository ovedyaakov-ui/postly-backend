// ============================================================
// BACKGROUND SUGGESTIONS
// ============================================================
//
// The "הצעות לרקע" button. gpt-4o looks at the photo and returns 4 short
// Hebrew scene suggestions that fit the product. The user taps one and the
// app sends it to /change-background as userPrompt (the existing
// "custom description" path) - /change-background itself is unchanged.
//
// Kept in its own file so it can be tested directly with
// test-suggestions.js, without starting the server or signing in.
// ============================================================

import fetch from "node-fetch";
import sharp from "sharp";

const SUGGESTIONS_COUNT = 4;
const MAX_SUGGESTION_LENGTH = 120;

function buildSuggestionsPrompt(description, category) {
  return `You are the art director of a premium product photography studio.
Look at this photo${description ? ` (the item: ${description})` : ""}${
    category ? ` (category: ${category})` : ""
  }.

Suggest exactly ${SUGGESTIONS_COUNT} different backgrounds for a professional PRODUCT photograph of the item itself.

Rules:
- The ITEM is the hero. Ignore any person in the photo; build the scene for the item.
- First understand what the item is, what it is used for and who buys it.
- Each suggestion is a different world (for example: a lifestyle setting where the customer uses it, a premium brand display, an outdoor or seasonal setting, a warm home setting) - not 4 variations of the same place.
- Match the style and price level of the item (luxury item = upscale setting, casual item = casual setting).
- Place it on a surface it can physically rest on in real life.
- Never suggest supermarket shelves, price tags, store signs, brand names, or plain gray/white studio backdrops.
- Do not mention the item itself.
- Write each suggestion in natural, simple Hebrew, 4 to 10 words, describing the surface, place and light. Example style: "על שולחן עץ במרפסת מול הים, אור שקיעה".

Return JSON only: { "suggestions": ["...", "...", "...", "..."] }`;
}

// A suggestion must be written in Hebrew: at least 70% of its letters are
// Hebrew letters. A few Latin letters are allowed (e.g. "LED").
export function isHebrewSuggestion(text) {
  const hebrew = (text.match(/[\u05D0-\u05EA]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return hebrew >= 3 && hebrew / (hebrew + latin) >= 0.7;
}

export function cleanSuggestions(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const result = [];

  for (const item of raw) {
    if (typeof item !== "string") continue;

    const text = item.replace(/\s+/g, " ").trim().slice(0, MAX_SUGGESTION_LENGTH);
    if (text.length < 4 || seen.has(text)) continue;
    if (!isHebrewSuggestion(text)) continue;

    seen.add(text);
    result.push(text);

    if (result.length === SUGGESTIONS_COUNT) break;
  }

  return result;
}

/**
 * Returns an array of up to 4 Hebrew background suggestions.
 * Throws if OpenAI fails or returns fewer than 2 usable suggestions,
 * so the caller can show an error instead of an empty list.
 */
export async function generateBackgroundSuggestions(
  imageBuffer,
  { description = "", category = "", apiKey = process.env.OPENAI_API_KEY, maxRetries = 3 } = {}
) {
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const smallBuffer = await sharp(imageBuffer)
    .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const body = {
    model: "gpt-4o",
    max_tokens: 400,
    temperature: 0.9,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: buildSuggestionsPrompt(description, category) },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${smallBuffer.toString("base64")}` },
          },
        ],
      },
    ],
  };

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        lastError = new Error(`OpenAI ${response.status}: ${text.slice(0, 200)}`);

        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable) break;
      } else {
        const data = await response.json();
        const parsed = JSON.parse(data?.choices?.[0]?.message?.content || "{}");
        const suggestions = cleanSuggestions(parsed.suggestions);

        if (suggestions.length >= 2) {
          return suggestions;
        }

        lastError = new Error(`only ${suggestions.length} usable suggestions returned`);
      }
    } catch (err) {
      lastError = err;
    }

    console.log(`Background suggestions attempt ${attempt}/${maxRetries} failed:`, lastError.message);

    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw lastError || new Error("background suggestions failed");
}
