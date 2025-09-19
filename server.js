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

async function rfetch(url, options = {}) {
  const headers = {
    "Authorization": `Bearer ${REPLICATE_TOKEN}`,
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers });
}

/** Vytvorí 1 predikciu (jediný obrázok) – official endpoint s fallbackom na version */
async function createSinglePrediction({ prompt, aspect }) {
  // vstup – posielame aj alias pre aspect pre prípad rôznych buildov
  const input = {
    prompt,
    ...(aspect ? { aspect_ratio: aspect, aspect } : {})
  };

  // 1) official-model endpoint (bez version)
  {
    const resp = await rfetch(`${MODEL_BASE}/predictions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    if (resp.ok) return resp.json();

    if (![404, 405, 400].includes(resp.status)) {
      const tx = await resp.text();
      throw new Error(`Official predictions failed: ${resp.status} ${tx}`);
    }
  }

  // 2) fallback: /v1/predictions s latest_version.id
  const infoResp = await rfetch(`${MODEL_BASE}`);
  if (!infoResp.ok) {
    const tx = await infoResp.text();
    throw new Error(`Failed to fetch model info: ${infoResp.status} ${tx}`);
  }
  const info = await infoResp.json();
  const versionId = info?.latest_version?.id;
  if (!versionId) throw new Error("Model response missing latest_version.id (fallback failed).");

  const resp2 = await rfetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: versionId, input })
  });
  const data2 = await resp2.json();
  if (!resp2.ok) {
    throw new Error(`Fallback predictions failed: ${resp2.status} ${JSON.stringify(data2)}`);
  }
  return data2;
}

/** Healthcheck */
app.get("/health", (_, res) => res.json({ ok: true }));

/** Spustí generovanie: ak numImages>1 → vytvorí viac samostatných predikcií paralelne */
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt, numImages, aspect } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt'." });
    }

    const n = Math.max(1, Math.min(4, Number(numImages) || 1));

    if (n === 1) {
      const data = await createSinglePrediction({ prompt, aspect });
      return res.json({
        // single prediction response (spätná kompatibilita)
        mode: "single",
        id: data.id,
        getUrl: data?.urls?.get,
        webUrl: data?.urls?.web,
        status: data.status
      });
    }

    // N > 1 → vytvor paralelne N predikcií (každá 1 obrázok)
    const jobs = Array.from({ length: n }, () =>
      createSinglePrediction({ prompt, aspect })
    );
    const results = await Promise.all(jobs);

    // vrátime batch so zoznamom prediction ID + webUrl pre každý
    return res.json({
      mode: "batch",
      count: results.length,
      items: results.map(r => ({
        id: r.id,
        getUrl: r?.urls?.get,
        webUrl: r?.urls?.web,
        status: r.status
      }))
    });
  } catch (err) {
    console.error("[/api/generate]", err);
    return res.status(500).json({ error: err.message });
  }
});

/** Proxy na polling jednej predikcie */
app.get("/api/predictions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const url = `https://api.replicate.com/v1/predictions/${id}`;
    const resp = await rfetch(url);
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    console.error("[/api/predictions/:id]", err);
    return res.status(500).json({ error: err.message });
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
