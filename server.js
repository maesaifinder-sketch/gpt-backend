/**
 * server.js — Express + Multer + OpenAI
 *
 * ✅ Endpoints:
 * - GET  /health
 * - POST /api/generate-gpt-prompt (multipart/form-data)
 *    fields: soraPrompt (required), img1(optional), img2(optional)
 * - POST /api/generate-image (multipart/form-data)
 *    fields: soraPrompt (required), img1(required)
 *
 * ✅ Deploy on Render
 * ✅ CORS locked to your GitHub Pages domain
 *
 * Install:
 *   npm i express cors multer openai
 *
 * package.json:
 *   "type":"module"
 *   "scripts": { "start":"node server.js" }
 *
 * Render Env:
 *   OPENAI_API_KEY=sk-...
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";

const app = express();

/** =========================
 * CORS
 * ========================= */
const ALLOWED_ORIGINS = [
  "https://maesaifinder-sketch.github.io",
];

app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"],
}));
app.options("*", cors());

/** =========================
 * Multer (memory)
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
        await sleep(1000 * Math.pow(2, i)); // 1s,2s,4s
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
  if(!file) return null;
  const b64 = file.buffer.toString("base64");
  return `data:${file.mimetype};base64,${b64}`;
}

/** =========================
 * Routes
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok:true, service:"prompt-backend", version:"all-in-one-v3" });
});

/**
 * POST /api/generate-gpt-prompt
 * multipart/form-data:
 * - soraPrompt (required)
 * - img1 (optional)
 * - img2 (optional)
 *
 * ✅ “งาน”: แปลง prompt เป็น Sora-ready video prompt (Scene 1-4)
 */
app.post(
  "/api/generate-gpt-prompt",
  upload.fields([{ name:"img1", maxCount:1 }, { name:"img2", maxCount:1 }]),
  async (req, res) => {
    try{
      if(!process.env.OPENAI_API_KEY){
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if(!soraPrompt){
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
Convert the user's request into a single Sora-ready VIDEO prompt.

Rules:
- Output must be directly usable in Sora
- Use Scene 1, Scene 2, Scene 3, Scene 4
- Include: aspect ratio, camera, lighting, mood, motion
- Do NOT use OBJECTIVE/INPUTS/CONSTRAINTS/CHECKLIST format
- Write in English (best for Sora)
      `.trim();

      const user = `
User request (source prompt):
---
${soraPrompt}
---

Uploaded refs (not required to analyze):
- img1: ${img1 ? img1.originalname : "none"}
- img2: ${img2 ? img2.originalname : "none"}

Generate the final Sora-ready video prompt.
      `.trim();

      const response = await callOpenAIWithRetry(() =>
        client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role:"system", content: system },
            { role:"user", content: user }
          ],
          temperature: 0.3,
          max_output_tokens: 1200,
        })
      );

      const promptText = (response.output_text || "").trim();
      if(!promptText){
        return res.status(502).json({ success:false, error:"Empty response from model" });
      }

      return res.json({ success:true, prompt: promptText, meta:{ receivedImages: imgSummary } });
    }catch(err){
      console.error("generate-gpt-prompt error:", err);
      const status = err?.status || err?.response?.status || 500;
      let message = err?.message || "Server error";
      if(status === 429) message = "OpenAI rate limit / quota reached (HTTP 429). Check billing/limits.";
      return res.status(status).json({ success:false, error: message });
    }
  }
);

/**
 * POST /api/generate-image
 * multipart/form-data:
 * - soraPrompt (required)
 * - img1 (required)  ✅ ใช้เฉพาะรูปสินค้า
 *
 * ✅ “ภาพ”: ให้ AI มองรูปสินค้า -> สรุปลักษณะสินค้า -> สร้างภาพโฆษณาแนวตั้ง 9:16
 * Response: { success:true, mime:"image/png", b64:"..." }
 */
app.post(
  "/api/generate-image",
  upload.fields([{ name:"img1", maxCount:1 }]),
  async (req, res) => {
    try{
      if(!process.env.OPENAI_API_KEY){
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if(!soraPrompt){
        return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      }

      const img1 = req.files?.img1?.[0] || null;
      if(!img1){
        return res.status(400).json({ success:false, error:"Missing img1 (product reference image)" });
      }

      const imgDataUrl = fileToDataUrl(img1);

      // 1) Vision วิเคราะห์สินค้า
      const visionSystem = `
You are an expert product visual analyst for advertising.
Describe ONLY what you see in the product image so it can be recreated faithfully.

Return a compact bullet list:
- product type
- key shape / silhouette
- main colors
- materials / textures
- patterns / prints (if any)
- any important details that must remain consistent

Write in English. No extra commentary.
      `.trim();

      const visionResp = await callOpenAIWithRetry(() =>
        client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role:"system", content: visionSystem },
            {
              role:"user",
              content: [
                { type:"input_text", text:"Analyze the product image for faithful recreation." },
                { type:"input_image", image_url: imgDataUrl },
              ]
            }
          ],
          temperature: 0.2,
          max_output_tokens: 300,
        })
      );

      const productDesc = (visionResp.output_text || "").trim();
      if(!productDesc){
        return res.status(502).json({ success:false, error:"Vision analysis returned empty" });
      }

      // 2) Prompt สำหรับสร้างภาพ 9:16
      const imagePrompt = `
Create ONE high-quality vertical promotional image (9:16) suitable for TikTok.

REFERENCE PRODUCT (must remain consistent):
${productDesc}

USER INSTRUCTIONS (follow closely):
${soraPrompt}

Composition:
- vertical 9:16 ad composition
- product is hero, ~60–70% of frame
- clean premium background, cinematic lighting, shallow depth of field
- remove any watermarks/logos/text from the reference; generate a new scene

Text overlay rules:
- Thai only, formal spelling, no English characters
- if unsure spelling, use a clean solid graphic bar instead of text

Output: single image, commercial-grade quality.
      `.trim();

      // 3) Generate image (9:16)
      // NOTE: หากบัญชีคุณยังไม่เปิดใช้งาน model ภาพ จะ error 400 ต้องเปิด Billing/Images access
      const imgResp = await callOpenAIWithRetry(() =>
        client.images.generate({
          model: "gpt-image-1",
          prompt: imagePrompt,
          size: "1024x1792",
          response_format: "b64_json",
        })
      );

      const b64 = imgResp?.data?.[0]?.b64_json || null;
      if(!b64){
        return res.status(502).json({ success:false, error:"No base64 image returned from image model" });
      }

      return res.json({
        success: true,
        mime: "image/png",
        filename: "generated.png",
        b64
      });

    }catch(err){
      console.error("generate-image error:", err);
      const status = err?.status || err?.response?.status || 500;
      let message = err?.message || "Server error";
      if(status === 429) message = "OpenAI rate limit / quota reached (HTTP 429). Check billing/limits.";
      return res.status(status).json({ success:false, error: message });
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
