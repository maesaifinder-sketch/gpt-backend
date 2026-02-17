/**
 * server.js (ไฟล์เดียวจบ) — Express + Multer + OpenAI
 *
 * ✅ รองรับทั้ง “งาน” และ “ภาพ”
 * - POST /api/generate-gpt-prompt (multipart/form-data)
 *    fields:
 *      - soraPrompt (string) [required]
 *      - img1 (file) [optional]
 *      - img2 (file) [optional]
 *
 * - POST /api/generate-image (multipart/form-data)
 *    fields:
 *      - soraPrompt (string) [required]
 *      - img1 (file) [required]  // ใช้รูปสินค้าอย่างเดียว
 *    ✅ ตั้ง size เป็น 1024x1792 (9:16)
 *    ✅ ส่งกลับ base64: { success:true, mime:"image/png", b64:"..." }
 *
 * - GET /health
 *
 * ----------------------------
 * ติดตั้ง:
 *   npm i express cors multer openai
 *
 * package.json ต้องมี:
 *   "type": "module"
 *   "scripts": { "start": "node server.js" }
 *
 * Render Env Vars:
 *   OPENAI_API_KEY=sk-...
 *   (Render ตั้ง PORT ให้เอง)
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();

/** =========================
 * CORS (ล็อก origin ให้ตรงเว็บคุณ)
 * ========================= */
const ALLOWED_ORIGINS = [
  "https://maesaifinder-sketch.github.io",
  // ถ้ามีโดเมนอื่น เพิ่มได้ เช่น:
  // "http://localhost:5500",
];

app.use(cors({
  origin(origin, cb){
    // allow same-origin / curl / server-to-server
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options("*", cors());

/** =========================
 * Multer (รับไฟล์เป็น memory)
 * ========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB ต่อไฟล์
  },
});

/** =========================
 * OpenAI Client
 * ========================= */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** =========================
 * Utils
 * ========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callOpenAIWithRetry(makeCall, retries = 2){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{
      return await makeCall();
    }catch(err){
      lastErr = err;
      const status = err?.status || err?.response?.status;

      // Retry เฉพาะ 429 แบบสุภาพ
      if(status === 429 && i < retries){
        const wait = 1000 * Math.pow(2, i); // 1s, 2s, 4s...
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function shortFileInfo(f){
  if(!f) return null;
  return {
    fieldname: f.fieldname,
    originalname: f.originalname,
    mimetype: f.mimetype,
    size: f.size
  };
}

function fileToDataUrl(file){
  // ใช้กับ Vision input_image
  const b64 = file.buffer.toString("base64");
  return `data:${file.mimetype};base64,${b64}`;
}

/** =========================
 * Routes
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "prompt-backend", version: "v3-all-in-one" });
});

/**
 * POST /api/generate-gpt-prompt
 * (เมนู “งาน”) แปลง soraPrompt -> Sora video prompt แบบ Scene 1-4
 */
app.post(
  "/api/generate-gpt-prompt",
  upload.fields([
    { name: "img1", maxCount: 1 },
    { name: "img2", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ success: false, error: "Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if (!soraPrompt) {
        return res.status(400).json({ success: false, error: "Missing soraPrompt" });
      }

      const img1 = req.files?.img1?.[0] || null;
      const img2 = req.files?.img2?.[0] || null;

      const imgSummary = {
        img1: shortFileInfo(img1),
        img2: shortFileInfo(img2),
      };

      const system = `
You are an expert prompt engineer for Sora AI (video generation).
Convert the user's request into ONE Sora-ready VIDEO prompt.

Rules:
- Output must be directly usable in Sora
- Use: Scene 1, Scene 2, Scene 3, Scene 4
- Include: aspect ratio, camera, lighting, mood, motion
- Do NOT use OBJECTIVE/INPUTS/CONSTRAINTS/CHECKLIST
- Write in English (best for Sora)
      `.trim();

      const user = `
User request (source prompt):
---
${soraPrompt}
---

Uploaded refs (optional):
- img1: ${img1 ? img1.originalname : "none"}
- img2: ${img2 ? img2.originalname : "none"}

Generate the final Sora-ready video prompt.
      `.trim();

      const response = await callOpenAIWithRetry(() =>
        client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.3,
          max_output_tokens: 1200,
        })
      );

      const promptText = (response.output_text || "").trim();
      if (!promptText) {
        return res.status(502).json({ success: false, error: "Empty response from model" });
      }

      return res.json({
        success: true,
        prompt: promptText,
        meta: { receivedImages: imgSummary }
      });

    } catch (err) {
      console.error("generate-gpt-prompt error:", err);

      const status = err?.status || err?.response?.status || 500;
      let message = err?.message || "Server error";
      if (status === 429) {
        message = "OpenAI rate limit / quota reached (HTTP 429). Please wait or check billing/usage limits.";
      }

      return res.status(status).json({ success: false, error: message });
    }
  }
);

/**
 * POST /api/generate-image
 * (เมนู “ภาพ”) ใช้ img1 (สินค้า) + soraPrompt -> เจนภาพโฆษณา 9:16
 *
 * Response:
 *  { success:true, mime:"image/png", b64:"..." }
 */
app.post(
  "/api/generate-image",
  upload.fields([{ name: "img1", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ success: false, error: "Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if (!soraPrompt) {
        return res.status(400).json({ success: false, error: "Missing soraPrompt" });
      }

      const img1 = req.files?.img1?.[0] || null;
      if (!img1) {
        return res.status(400).json({ success: false, error: "Missing img1 (product reference image)" });
      }

      const imgDataUrl = fileToDataUrl(img1);

      // 1) Vision: สรุปลักษณะสินค้าให้ “คงดีไซน์”
      const visionSystem = `
You are an expert product visual analyst for advertising.
Describe ONLY what you see in the product image so it can be recreated faithfully.

Return a compact bullet list:
- product type
- key shape / silhouette
- main colors
- materials / textures
- patterns / prints (if any)
- important details that must remain consistent

Write in English. No extra commentary.
      `.trim();

      const visionResp = await callOpenAIWithRetry(() =>
        client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role: "system", content: visionSystem },
            {
              role: "user",
              content: [
                { type: "input_text", text: "Analyze the product image for faithful recreation." },
                { type: "input_image", image_url: imgDataUrl }
              ]
            }
          ],
          temperature: 0.2,
          max_output_tokens: 250,
        })
      );

      const productDesc = (visionResp.output_text || "").trim();
      if (!productDesc) {
        return res.status(502).json({ success: false, error: "Vision analysis returned empty" });
      }

      // 2) รวมคำสั่งของผู้ใช้ + กติกาโฆษณา + บังคับ 9:16
      const imagePrompt = `
Create ONE high-quality vertical promotional image (9:16) suitable for TikTok.

REFERENCE PRODUCT (must remain consistent):
${productDesc}

STRICT PRODUCT RULES:
- Keep the product EXACTLY the same as the reference: shape, colors, materials, textures, patterns, proportions.
- Do NOT redesign, modify, enhance, or alter the product.

SCENE & QUALITY:
- Create a NEW premium environment (do not copy background from reference).
- Cinematic premium lighting, high contrast, shallow depth of field.
- Product occupies ~60–70% of the frame.
- Clean commercial-grade background.

TEXT RULES:
- Thai only, formal correct spelling, no English characters.
- If unsure spelling, replace text with a clean solid graphic bar instead.

USER INSTRUCTIONS:
${soraPrompt}

Output: one single image, commercial-grade, TikTok-ready.
      `.trim();

      // 3) Generate Image (9:16) — ✅ ตั้ง size ตรงนี้
      const imgResp = await callOpenAIWithRetry(() =>
        client.images.generate({
          model: "gpt-image-1",
          prompt: imagePrompt,
          size: "1024x1792",          // ✅ 9:16 แนวตั้ง
          response_format: "b64_json" // ✅ ได้ base64 กลับมา
        })
      );

      const b64 = imgResp?.data?.[0]?.b64_json || null;
      if (!b64) {
        return res.status(502).json({ success: false, error: "No base64 image returned from image model" });
      }

      return res.json({
        success: true,
        mime: "image/png",
        filename: "generated.png",
        b64,
        meta: {
          receivedImage: shortFileInfo(img1)
        }
      });

    } catch (err) {
      console.error("generate-image error:", err);

      const status = err?.status || err?.response?.status || 500;
      let message = err?.message || "Server error";
      if (status === 429) {
        message = "OpenAI rate limit / quota reached (HTTP 429). Please wait or check billing/usage limits.";
      }

      return res.status(status).json({ success: false, error: message });
    }
  }
);

/** =========================
 * Start
 * ========================= */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`✅ Backend running on port ${port}`);
});
