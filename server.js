/**
 * server.js (ไฟล์เดียวจบ) — Express + Multer (รับรูป 2 รูป) + OpenAI Responses API
 *
 * ✅ รองรับ:
 * - POST /api/generate-gpt-prompt (multipart/form-data)
 *   fields:
 *     - soraPrompt (string)  [required]
 *     - img1 (file)         [optional] รูปสินค้า
 *     - img2 (file)         [optional] รูปรายละเอียดสินค้า
 * - GET /health
 *
 * ✅ Deploy บน Render ได้ทันที
 * ✅ CORS ล็อกโดเมน GitHub Pages ของคุณ
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
 * =========================
 * ถ้าคุณมีโดเมนอื่นเพิ่ม ให้ใส่เพิ่มใน array ได้
 */
const ALLOWED_ORIGINS = [
  "https://maesaifinder-sketch.github.io",
];

app.use(cors({
  origin(origin, cb){
    // allow same-origin / curl / server-to-server
    if (!origin) return cb(null, true);
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

/** =========================
 * Routes
 * ========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "prompt-backend", version: "v2-multer-20260217" });
});

/**
 * POST /api/generate-gpt-prompt
 * multipart/form-data:
 *   - soraPrompt: string (required)
 *   - img1: file (optional)
 *   - img2: file (optional)
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

      // ตอนนี้ยังไม่ส่งรูปไปให้โมเดล (Vision) — แค่รับไว้ก่อน
      // คุณสามารถต่อยอดให้ส่งรูปเข้า Vision ได้ภายหลัง
      const imgSummary = {
        img1: shortFileInfo(img1),
        img2: shortFileInfo(img2),
      };

      const system = `
คุณคือผู้เชี่ยวชาญด้านการเขียน Prompt สำหรับ Sora AI (Video Generation)
หน้าที่ของคุณคือแปลงข้อมูลทั้งหมดให้เป็น Prompt สำหรับสร้างวิดีโอใน Sora โดยตรง

ข้อกำหนด:
- เขียนเป็นคำบรรยายฉากแบบภาพยนตร์
- แบ่งเป็น Scene 1, Scene 2, Scene 3, Scene 4
- ระบุ: สัดส่วนวิดีโอ, โทนภาพ, แสง, กล้อง, อารมณ์
- ห้ามใช้รูปแบบ OBJECTIVE, INPUTS, CONSTRAINTS
- ห้ามเขียน checklist
- ใช้ภาษาอังกฤษสำหรับคำบรรยายฉาก (Sora เข้าใจดีที่สุด)
- ผลลัพธ์ต้องเป็น Prompt พร้อมนำไปวางใน Sora ได้ทันที
      `.trim();

      const user = `
นี่คือ Sora Prompt ต้นทาง:
---
${soraPrompt}
---

ข้อมูลรูปอ้างอิงที่ผู้ใช้อัปโหลด (ยังไม่ได้วิเคราะห์ภาพด้วย Vision):
- รูปที่ 1 (img1): ${img1 ? `${img1.originalname} (${img1.mimetype}, ${img1.size} bytes)` : "ไม่ได้แนบ"}
- รูปที่ 2 (img2): ${img2 ? `${img2.originalname} (${img2.mimetype}, ${img2.size} bytes)` : "ไม่ได้แนบ"}

โปรดสร้าง "GPT Prompt" ที่เหมาะสำหรับนำไปให้ GPT/AI สร้างสคริปต์/พรมต์ต่อได้ทันที
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
        meta: {
          receivedImages: imgSummary
        }
      });

    } catch (err) {
      console.error("generate-gpt-prompt error:", err);

      const status = err?.status || err?.response?.status || 500;

      // ทำข้อความ error ให้เข้าใจง่าย
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

