// server2.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== Middleware =====
app.use(cors({
  origin: "*",
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json());

// ===== Health Check =====
app.get("/health", (req, res) => {
  res.json({ ok: true, service: "script-pro-backend", time: new Date().toISOString() });
});

// ===== Generate API =====
app.post("/api/generate", async (req, res) => {
  try {
    const { provider, apiKey, model, system, user } = req.body;
    if (!provider || !apiKey) {
      return res.status(400).json({ error: "Missing provider or apiKey" });
    }

    let resultText = "";

    if (provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || "gpt-4.1-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.7
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data });
      resultText = data.choices?.[0]?.message?.content || "";
    }

    else if (provider === "google") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model || "gemini-1.5-flash")}:generateContent?key=${apiKey}`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: system + "\n\n" + user }] }
          ]
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data });
      resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    }

    else if (provider === "grok") {
      const r = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model || "grok-2",
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          temperature: 0.7
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(500).json({ error: data });
      resultText = data.choices?.[0]?.message?.content || "";
    }

    else {
      return res.status(400).json({ error: "Unknown provider" });
    }

    res.json({ ok: true, text: resultText });

  } catch (err) {
    console.error("API ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log("🚀 Script pro backend running on port", PORT);
});
