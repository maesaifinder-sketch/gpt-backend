/**
 * server.js — All-in-one (GPT Prompt + Image Generation)
 * - POST /api/generate-gpt-prompt
 * - POST /api/generate-image
 * - GET  /health
 *
 * npm i express cors multer openai
 * package.json: { "type":"module", "scripts": { "start":"node server.js" } }
 * Env: OPENAI_API_KEY=sk-...
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
    return cb(new Error(`CORS blocked: ${origin}`));
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
  limits: { fileSize: 5 * 1024 * 1024 },
});

/** =========================
 * OpenAI
 * ========================= */
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** =========================
 * Utils
 * ========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function callOpenAIWithRetry(makeCall, retries = 2){
  let lastErr;
  for(let i=0;i<=retries;i++){
    try{ return await makeCall(); }
    catch(err){
      lastErr = err;
      const status = err?.status || err?.response?.status;
      if(status === 429 && i < retries){
        await sleep(1000 * Math.pow(2,i));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** =========================
 * Health
 * ========================= */
app.get("/health", (req,res)=>{
  res.json({ ok:true, service:"prompt-backend", version:"all-in-one" });
});

/** =========================
 * GPT Prompt API
 * ========================= */
app.post(
  "/api/generate-gpt-prompt",
  upload.fields([{ name:"img1", maxCount:1 },{ name:"img2", maxCount:1 }]),
  async (req,res)=>{
    try{
      if(!process.env.OPENAI_API_KEY){
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      if(!soraPrompt){
        return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      }

      const system = `
You are an expert prompt engineer for Sora video generation.
Create cinematic scene-based prompts (Scene 1..4).
English description only. No OBJECTIVE/INPUTS/CONSTRAINTS.`;

      const user = `Sora prompt source:\n${soraPrompt}`;

      const resp = await callOpenAIWithRetry(() =>
        client.responses.create({
          model: "gpt-4.1-mini",
          input: [
            { role:"system", content: system },
            { role:"user", content: user }
          ],
          temperature: 0.3,
          max_output_tokens: 1200
        })
      );

      const text = (resp.output_text || "").trim();
      return res.json({ success:true, prompt: text });

    }catch(err){
      console.error(err);
      const status = err?.status || 500;
      return res.status(status).json({ success:false, error: err?.message || "Server error" });
    }
  }
);

/** =========================
 * IMAGE GENERATION API (9:16)
 * ========================= */
app.post(
  "/api/generate-image",
  upload.fields([{ name:"img1", maxCount:1 }]),
  async (req,res)=>{
    try{
      if(!process.env.OPENAI_API_KEY){
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      const img1 = req.files?.img1?.[0] || null;

      if(!soraPrompt) return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      if(!img1) return res.status(400).json({ success:false, error:"Missing img1" });

      // รวม prompt สำหรับภาพโฆษณา
      const imagePrompt = `
Create a high-end vertical 9:16 commercial product image.
Use the uploaded product image as reference for the product only.
Keep the product identical. New premium environment.
TikTok-ready, cinematic lighting, shallow depth of field.
User instructions:
${soraPrompt}
      `.trim();

      const imgResp = await callOpenAIWithRetry(() =>
        client.images.generate({
          model: "gpt-image-1",
          prompt: imagePrompt,
          size: "1024x1536" // 9:16
        })
      );

      const b64 = imgResp?.data?.[0]?.b64_json;
      if(!b64){
        return res.status(502).json({ success:false, error:"Empty image result" });
      }

      return res.json({
        success: true,
        mime: "image/png",
        b64
      });

    }catch(err){
      console.error(err);
      const status = err?.status || 500;
      return res.status(status).json({ success:false, error: err?.message || "Image API error" });
    }
  }
);

/** =========================
 * Start
 * ========================= */
const port = Number(process.env.PORT || 3000);
app.listen(port, ()=> console.log(`✅ Backend running on ${port}`));
