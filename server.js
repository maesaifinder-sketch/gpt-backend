/**
 * server.js — All-in-one (GPT Prompt + Image Generation) + Multi-provider
 * - POST /api/generate-gpt-prompt  (fields: provider, soraPrompt, img1?, img2?)
 * - POST /api/generate-image       (fields: provider, soraPrompt, img1)
 * - GET  /health
 *
 * npm i express cors multer openai @google/generative-ai
 * Env:
 *  - OPENAI_API_KEY=sk-...
 *  - GEMINI_API_KEY=AIza...
 *  - GROK_API_KEY=xai-...
 *  - FLOW_API_URL=http://localhost:3000/api/v1/prediction/<flow-id>
 */

import express from "express";
import cors from "cors";
import multer from "multer";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();

/** =========================
 * CORS
 * ========================= */
const ALLOWED_ORIGINS = [
  "https://maesaifinder-sketch.github.io",
];

app.use(cors({
  origin(origin, cb){
    if (!origin) return cb(null, true); // allow curl/postman
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
 * Clients
 * ========================= */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/** =========================
 * Utils (retry)
 * ========================= */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function callWithRetry(makeCall, retries = 2){
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

function fileToBase64(file){
  // file = req.files?.img1?.[0]
  const mimeType = file?.mimetype || "application/octet-stream";
  const data = file?.buffer?.toString("base64") || "";
  return { mimeType, data };
}

/** =========================
 * Health
 * ========================= */
app.get("/health", (req,res)=>{
  res.json({ ok:true, service:"prompt-backend", version:"multi-provider" });
});

/** =========================
 * GPT Prompt API (multi-provider + vision for Gemini/Flow)
 * ========================= */
app.post(
  "/api/generate-gpt-prompt",
  upload.fields([{ name:"img1", maxCount:1 },{ name:"img2", maxCount:1 }]),
  async (req,res)=>{
    try{
      const provider = String(req.body?.provider || "openai").trim().toLowerCase();
      const soraPrompt = String(req.body?.soraPrompt || "").trim();

      if(!soraPrompt){
        return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      }

      const img1File = req.files?.img1?.[0] || null;
      const img2File = req.files?.img2?.[0] || null;

      const system = `
You are an expert prompt engineer for Sora video generation.
Create cinematic scene-based prompts (Scene 1..4).
English description only. No OBJECTIVE/INPUTS/CONSTRAINTS.`.trim();

      const user = `Sora prompt source:\n${soraPrompt}`;

      let text = "";

      // -------- OpenAI (ข้อความล้วน) --------
      if(provider === "openai"){
        if(!process.env.OPENAI_API_KEY){
          return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
        }
        const resp = await callWithRetry(() =>
          openai.responses.create({
            model: "gpt-4.1-mini",
            input: [
              { role:"system", content: system },
              { role:"user", content: user }
            ],
            temperature: 0.3,
            max_output_tokens: 1200
          })
        );
        text = (resp.output_text || "").trim();
      }

      // -------- Gemini (รองรับภาพจริง) --------
      else if(provider === "gemini"){
        if(!process.env.GEMINI_API_KEY){
          return res.status(500).json({ success:false, error:"Missing GEMINI_API_KEY" });
        }
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

        const parts = [{ text: `${system}\n\n${user}` }];

        if(img1File){
          const { mimeType, data } = fileToBase64(img1File);
          parts.push({ inlineData: { mimeType, data } });
        }
        if(img2File){
          const { mimeType, data } = fileToBase64(img2File);
          parts.push({ inlineData: { mimeType, data } });
        }

        const result = await callWithRetry(() =>
          model.generateContent({
            contents: [{ role: "user", parts }]
          })
        );

        text = result.response.text().trim();
      }

      // -------- Grok (xAI) --------
      else if(provider === "grok"){
        if(!process.env.GROK_API_KEY){
          return res.status(500).json({ success:false, error:"Missing GROK_API_KEY" });
        }
        const r = await callWithRetry(() =>
          fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${process.env.GROK_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: "grok-2",
              messages: [
                { role:"system", content: system },
                { role:"user", content: user }
              ],
              temperature: 0.3
            })
          })
        );
        const j = await r.json();
        text = j?.choices?.[0]?.message?.content?.trim() || "";
      }

      // -------- Flow (Flowise/Langflow รองรับภาพ) --------
      else if(provider === "flow"){
        if(!process.env.FLOW_API_URL){
          return res.status(500).json({ success:false, error:"Missing FLOW_API_URL" });
        }

        const uploads = [];
        if(img1File){
          const { mimeType, data } = fileToBase64(img1File);
          uploads.push({ name: "img1", type: mimeType, data });
        }
        if(img2File){
          const { mimeType, data } = fileToBase64(img2File);
          uploads.push({ name: "img2", type: mimeType, data });
        }

        const r = await callWithRetry(() =>
          fetch(process.env.FLOW_API_URL, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
            body: JSON.stringify({
              question: `${system}\n\n${user}`,
              uploads
            })
          })
        );
        const j = await r.json();
        text = (j.text || j.answer || j.result || "").trim();
      }

      else{
        return res.status(400).json({ success:false, error:`Unknown provider: ${provider}` });
      }

      if(!text){
        return res.status(502).json({ success:false, error:"Empty response from provider" });
      }

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
 * - รองรับจริง: OpenAI เท่านั้น
 * ========================= */
app.post(
  "/api/generate-image",
  upload.fields([{ name:"img1", maxCount:1 }]),
  async (req,res)=>{
    try{
      const provider = String(req.body?.provider || "openai").trim().toLowerCase();
      if(provider !== "openai"){
        return res.status(400).json({
          success:false,
          error:"Image generation currently supports OpenAI only"
        });
      }

      if(!process.env.OPENAI_API_KEY){
        return res.status(500).json({ success:false, error:"Missing OPENAI_API_KEY" });
      }

      const soraPrompt = String(req.body?.soraPrompt || "").trim();
      const img1 = req.files?.img1?.[0] || null;

      if(!soraPrompt) return res.status(400).json({ success:false, error:"Missing soraPrompt" });
      if(!img1) return res.status(400).json({ success:false, error:"Missing img1" });

      const imagePrompt = `
Create a high-end vertical 9:16 commercial product image.
Use the uploaded product image as reference for the product only.
Keep the product identical. New premium environment.
TikTok-ready, cinematic lighting, shallow depth of field.
User instructions:
${soraPrompt}
      `.trim();

      const imgResp = await callWithRetry(() =>
        openai.images.generate({
          model: "gpt-image-1",
          prompt: imagePrompt,
          size: "1024x1536"
        })
      );

      const b64 = imgResp?.data?.[0]?.b64_json;
      if(!b64){
        return res.status(502).json({ success:false, error:"Empty image result" });
      }

      return res.json({ success:true, mime:"image/png", b64 });

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
