import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
if (!REPLICATE_TOKEN) {
  console.warn("[WARN] Missing REPLICATE_API_TOKEN env var.");
}

const MODEL_OWNER = "bytedance";
const MODEL_NAME = "seedream-4";
const MODEL_BASE = `https://api.replicate.com/v1/models/${MODEL_OWNER}/${MODEL_NAME}`;

/** Helper: call Replicate with proper token header (Token, nie Bearer) */
async function rfetch(url, options = {}) {
  const headers = {
    "Authorization": `Token ${REPLICATE_TOKEN}`,
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

/** Helper: read response safely for better error messages */
async function readResp(resp) {
  const text = await resp.text();
  try { return { raw: text, json: JSON.parse(text) }; }
  catch { return { raw: text, json: null }; }
}

/** Vytvorí 1 predikciu (jediný obrázok) – official endpoint s fallbackom na version */
async function createSinglePrediction({ prompt, aspect }) {
  const input = {
    prompt,
    // aspect ratio aliasy (niektoré buildy používajú `aspect`, iné `aspect_ratio`)
    ...(aspect ? { aspect_ratio: aspect, aspect } : {})
  };

  // 1) official-model endpoint (bez version)
  {
    const resp = await rfetch(`${MODEL_BASE}/predictions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });

    if (resp.ok) return await resp.json();

    if (![404, 405, 400].includes(resp.status)) {
      const body = await readResp(resp);
      throw new Error(`[Official predictions] ${resp.status} ${body.raw}`);
    }
  }

  // 2) fallback: /v1/predictions s latest_version.id
  const infoResp = await rfetch(`${MODEL_BASE}`);
  if (!infoResp.ok) {
    const body = await readResp(infoResp);
    throw new Error(`[Model info] ${infoResp.status} ${body.raw}`);
  }
  const info = await infoResp.json();
  const versionId = info?.latest_version?.id;
  if (!versionId) throw new Error("Model response missing latest_version.id (fallback failed).");

  const resp2 = await rfetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: versionId, input })
  });
  const body2 = await readResp(resp2);
  if (!resp2.ok) {
    throw new Error(`[Fallback predictions] ${resp2.status} ${body2.raw}`);
  }
  return body2.json ?? JSON.parse(body2.raw);
}

/** Healthcheck + debug token presence (neposiela token, len či je nastavený) */
app.get("/health", (_, res) => {
  res.json({ ok: true, hasToken: Boolean(REPLICATE_TOKEN) });
});

/** Spustí generovanie: ak numImages>1 → vytvorí viac samostatných predikcií paralelne */
app.post("/api/generate", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { prompt, numImages, aspect } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt'." });
    }
    if (!REPLICATE_TOKEN) {
      return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN on server." });
    }

    const n = Math.max(1, Math.min(4, Number(numImages) || 1));

    if (n === 1) {
      const data = await createSinglePrediction({ prompt, aspect });
      return res.json({
        mode: "single",
        id: data?.id ?? null,
        getUrl: data?.urls?.get ?? null,
        webUrl: data?.urls?.web ?? null,
        status: data?.status ?? null
      });
    }

    // N > 1 → vytvor paralelne N predikcií (každá 1 obrázok)
    const jobs = Array.from({ length: n }, () =>
      createSinglePrediction({ prompt, aspect })
    );

    const results = await Promise.all(jobs);

    return res.json({
      mode: "batch",
      count: results.length,
      items: results.map(r => ({
        id: r?.id ?? null,
        getUrl: r?.urls?.get ?? null,
        webUrl: r?.urls?.web ?? null,
        status: r?.status ?? null
      })),
      tookMs: Date.now() - startedAt
    });
  } catch (err) {
    console.error("[/api/generate] ERROR:", err?.message || err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/** Proxy na polling jednej predikcie */
app.get("/api/predictions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const url = `https://api.replicate.com/v1/predictions/${id}`;
    const resp = await rfetch(url);
    const body = await readResp(resp);
    if (!resp.ok) {
      console.error("[poll] non-OK", resp.status, body.raw);
      return res.status(resp.status).json({ error: body.json ?? body.raw });
    }
    return res.status(200).json(body.json ?? JSON.parse(body.raw));
  } catch (err) {
    console.error("[/api/predictions/:id] ERROR:", err?.message || err);
    return res.status(500).json({ error: String(err?.message || err) });
  }
});

/** SPA fallback */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
