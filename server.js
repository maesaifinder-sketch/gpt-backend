// server2.js (single-file Render backend proxy)
// Supports: OpenAI, Google Gemini, xAI Grok
// Endpoints: GET /health , POST /api/generate
import express from "express";
import cors from "cors";

const app = express();

// ---------- CORS ----------
// Allow calls from GitHub Pages (and local dev). You can restrict later if needed.
app.use(cors({
  origin: true,              // reflect request origin
  credentials: false,
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.options("*", cors());

// ---------- Body ----------
app.use(express.json({ limit: "2mb" }));

// ---------- Helpers ----------
function pickEnvKey(provider){
  if(provider === "openai") return process.env.OPENAI_API_KEY || "";
  if(provider === "google") return process.env.GOOGLE_API_KEY || "";
  if(provider === "grok") return process.env.XAI_API_KEY || "";
  return "";
}

function cleanProvider(p){
  const v = String(p || "").toLowerCase();
  if(v === "openai" || v === "google" || v === "grok") return v;
  return "openai";
}

async function callOpenAI({ model, system, user }){
  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey) throw new Error("Missing OPENAI_API_KEY on server");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type":"application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "gpt-4.1-mini",
      messages: [
        { role:"system", content: system || "" },
        { role:"user", content: user || "" }
      ],
      temperature: 0.7
    })
  });
  const data = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(data?.error?.message || `OpenAI error (${r.status})`);
  return data?.choices?.[0]?.message?.content ?? "";
}

async function callGemini({ model, system, user }){
  const apiKey = process.env.GOOGLE_API_KEY;
  if(!apiKey) throw new Error("Missing GOOGLE_API_KEY on server");
  const m = model || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{ text: `${system || ""}\n\n${user || ""}` }]
      }],
      generationConfig: { temperature: 0.7 }
    })
  });
  const data = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(data?.error?.message || `Gemini error (${r.status})`);

  // Gemini: candidates[0].content.parts[].text
  const text = data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("") || "";
  return text;
}

async function callGrok({ model, system, user }){
  const apiKey = process.env.XAI_API_KEY;
  if(!apiKey) throw new Error("Missing XAI_API_KEY on server");
  // xAI is OpenAI-compatible in many setups; adjust base URL if yours differs.
  const base = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || "grok-2",
      messages: [
        { role:"system", content: system || "" },
        { role:"user", content: user || "" }
      ],
      temperature: 0.7
    })
  });
  const data = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(data?.error?.message || `Grok error (${r.status})`);
  return data?.choices?.[0]?.message?.content ?? "";
}

// ---------- Routes ----------
app.get("/health", (req,res)=> res.json({ ok:true, service:"gpt-backend", ts: Date.now() }));

app.post("/api/generate", async (req,res)=>{
  try{
    const provider = cleanProvider(req.body?.provider);
    const model = req.body?.model;
    const system = req.body?.system;
    const user = req.body?.user;

    // SECURITY NOTE:
    // We DO NOT accept apiKey from client anymore.
    // Keys live ONLY on Render Environment Variables.
    const envKey = pickEnvKey(provider);
    if(!envKey){
      return res.status(400).json({ error: `Server missing API key env for provider: ${provider}` });
    }

    let content = "";
    if(provider === "openai") content = await callOpenAI({ model, system, user });
    else if(provider === "google") content = await callGemini({ model, system, user });
    else content = await callGrok({ model, system, user });

    // content should be JSON string
    let data;
    try{
      data = JSON.parse(content);
    }catch(e){
      return res.status(200).json({
        error: "Model did not return valid JSON",
        raw: content?.slice?.(0, 4000) || ""
      });
    }
    return res.json(data);
  }catch(err){
    return res.status(500).json({ error: err?.message || String(err) });
  }
});

// ---------- Start ----------
const port = process.env.PORT || 3000;
app.listen(port, ()=> console.log("✅ Server listening on", port));
