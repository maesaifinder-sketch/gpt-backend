// server.js — Script pro Proxy (single-file, zero deps)
// Node 18+ (Render uses Node 18/20) because we rely on global fetch.

const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;

// ====== CORS ======
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // allow file:// / any origin
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ====== Helpers ======
function send(res, status, obj) {
  setCORS(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
  });
}

// Attempt to pull JSON object from model output (optional convenience)
function extractJSONObject(text) {
  const t = (text || "").trim();
  if (!t) return null;

  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced ? fenced[1].trim() : t;

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;

  const slice = raw.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// ====== Provider calls ======
async function callOpenAI({ model, system, user }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY (set in Render env vars)");

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4.1-mini",
      messages: [
        { role: "system", content: system || "" },
        { role: "user", content: user || "" },
      ],
      temperature: 0.7,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || "OpenAI API error");
  const text = data?.choices?.[0]?.message?.content || "";
  return { text, raw: data };
}

async function callGemini({ model, system, user }) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("Missing GOOGLE_API_KEY (set in Render env vars)");

  const m = model || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        { role: "user", parts: [{ text: (system || "") + "\n\n" + (user || "") }] },
      ],
      generationConfig: { temperature: 0.7 },
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || "Gemini API error");

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

  return { text, raw: data };
}

async function callGrok({ model, system, user }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("Missing XAI_API_KEY (set in Render env vars)");

  const r = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "grok-2",
      messages: [
        { role: "system", content: system || "" },
        { role: "user", content: user || "" },
      ],
      temperature: 0.7,
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || "Grok API error");
  const text = data?.choices?.[0]?.message?.content || "";
  return { text, raw: data };
}

// ====== Simple in-memory rate limit (optional) ======
const hits = new Map(); // ip -> {count, ts}
function rateLimit(req, res) {
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown";
  const now = Date.now();
  const windowMs = 60_000;
  const max = 60; // 60 req/min/ip (ปรับได้)

  const v = hits.get(ip) || { count: 0, ts: now };
  if (now - v.ts > windowMs) {
    v.count = 0;
    v.ts = now;
  }
  v.count += 1;
  hits.set(ip, v);

  if (v.count > max) {
    send(res, 429, { ok: false, error: "Rate limit exceeded" });
    return false;
  }
  return true;
}

// ====== Server ======
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, { ok: true, name: "Script pro Proxy", uptime_s: Math.floor(process.uptime()) });
  }

  if (req.method === "POST" && url.pathname === "/api/storyboard") {
    if (!rateLimit(req, res)) return;

    try {
      const body = await readJSON(req);
      const provider = (body.provider || "openai").toLowerCase();
      const model = body.model || "";
      const system = body.system || "";
      const user = body.user || "";

      if (!user) {
        return send(res, 400, { ok: false, error: "Missing 'user' prompt" });
      }

      let result;
      if (provider === "openai") result = await callOpenAI({ model, system, user });
      else if (provider === "google") result = await callGemini({ model, system, user });
      else if (provider === "grok") result = await callGrok({ model, system, user });
      else return send(res, 400, { ok: false, error: "Unknown provider (use openai/google/grok)" });

      // optional: parse JSON for convenience
      const parsed = extractJSONObject(result.text);

      return send(res, 200, {
        ok: true,
        provider,
        model: model || null,
        text: result.text,
        parsed_json: parsed, // ถ้า parse ได้จะส่งมาให้เลย
      });
    } catch (e) {
      return send(res, 500, { ok: false, error: e?.message || String(e) });
    }
  }

  return send(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Script pro Proxy running on :${PORT}`);
});