/**
 * server.js — Express + Multer + OpenAI (Responses + Images Edit)
 * รองรับ:
 *  - GET  /health
 *  - POST /api/generate-gpt-prompt (multipart/form-data: soraPrompt, img1?, img2?)
 *  - POST /api/generate-image      (multipart/form-data: soraPrompt, img1)
 *
 * ใช้งานกับ Render + GitHub Pages
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
];

app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true); // allow curl / server-to-server
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

/** =========================
 * Multer (รับไฟล์เป็น memory)
 * ========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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
      if(status === 429 && i < retries){
        await sleep(1000 * Math.pow(2, i)); // 1s, 2s, 4s
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

/** =========================
 * Routes
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "prompt-backend", version: "all-in-one" });
});

/**
 * POST /api/generate-gpt-prompt
 * multipart/form-data:
 *   - soraPrompt (required)
 *   - img1 (optional)
 *   - img2 (optional)
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
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if (!soraPrompt) {
        return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      }

      const img1 = req.files?.img1?.[0] || null;
      const img2 = req.files?.img2?.[0] || null;

      const imgSummary = {
        img1: shortFileInfo(img1),
        img2: shortFileInfo(img2),
      };

      const system = `
You are an expert prompt engineer for Sora AI (video generation).
Convert all provided information into a cinematic Sora-ready prompt.
Rules:
- Describe scenes as: Scene 1, Scene 2, Scene 3, Scene 4
- Include: aspect ratio, lighting, camera, mood, motion
- Output must be directly usable in Sora
- Do NOT use sections like OBJECTIVE/INPUTS/CONSTRAINTS
- Write scene descriptions in English for best Sora understanding
      `.trim();

      const user = `
Original Sora Prompt:
---
${soraPrompt}
---

Reference images uploaded (not analyzed by vision yet):
- img1: ${img1 ? img1.originalname : "none"}
- img2: ${img2 ? img2.originalname : "none"}

Generate a final Sora-ready cinematic prompt.
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
        return res.status(502).json({ success:false, error:"Empty response from model" });
      }

      res.json({ success:true, prompt: promptText, meta:{ receivedImages: imgSummary } });
    } catch (err) {
      console.error("generate-gpt-prompt error:", err);
      const status = err?.status || err?.response?.status || 500;
      const message = status === 429
        ? "OpenAI rate limit / quota reached (HTTP 429). Check billing/limits."
        : (err?.message || "Server error");
      res.status(status).json({ success:false, error: message });
    }
  }
);

/**
 * POST /api/generate-image
 * multipart/form-data:
 *   - soraPrompt (required)
 *   - img1 (required)  // product reference image
 */
app.post(
  "/api/generate-image",
  upload.fields([{ name: "img1", maxCount: 1 }]),
  async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if (!soraPrompt) {
        return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      }

      const img1 = req.files?.img1?.[0] || null;
      if (!img1) {
        return res.status(400).json({ success:false, error:"Missing img1 (product reference image)" });
      }

      const imagePrompt = `
Create ONE high-quality promotional image optimized for a vertical 9:16 TikTok composition.

REFERENCE PRODUCT (STRICT):
- Keep the product EXACTLY the same as the reference image.
- Same shape, color, texture, material, proportions.
- Do NOT redesign or modify the product.

COMPOSITION (9:16 – CTR-FOCUSED):
- Optimize composition for vertical 9:16 viewing.
- Product occupies ~60–70% of frame, strong subject focus, high contrast.

SCENE:
- Create a NEW premium environment (luxury, clean, commercial-grade).
- Cinematic lighting, shallow depth of field.

TEXT (OPTIONAL):
- Thai only, formal spelling. If unsure spelling: use clean placeholder bar.

Additional context:
${soraPrompt}
      `.trim();

      const form = new FormData();
      const blob = new Blob([img1.buffer], { type: img1.mimetype || "image/png" });
      const file = new File([blob], img1.originalname || "reference.png", {
        type: img1.mimetype || "image/png",
      });

      form.append("model", "gpt-image-1");
      form.append("prompt", imagePrompt);
      form.append("image", file);
      form.append("size", "1024x1024");        // เสถียรสุด (จัดองค์ประกอบ 9:16 ด้วย prompt)
      form.append("response_format", "b64_json");

      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => "");
        return res.status(r.status).json({ success:false, error: errText || `OpenAI error ${r.status}` });
      }

      const json = await r.json();
      const b64 = json?.data?.[0]?.b64_json;
      if (!b64) {
        return res.status(502).json({ success:false, error:"No image returned from OpenAI" });
      }

      res.json({ success:true, mime:"image/png", b64 });
    } catch (err) {
      console.error("generate-image error:", err);
      const status = err?.status || 500;
      res.status(status).json({ success:false, error: err?.message || "Server error" });
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
