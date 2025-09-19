import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);
const MODEL_OWNER = "bytedance";
const MODEL_NAME = "seedream-4";
const MODEL_BASE = `https://api.replicate.com/v1/models/${MODEL_OWNER}/${MODEL_NAME}`;

if (!REPLICATE_TOKEN) {
  console.warn("[WARN] Missing REPLICATE_API_TOKEN env var.");
}

/** --- Helpers --- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function abortableFetch(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    "Authorization": `Token ${REPLICATE_TOKEN}`, // Dôležité: "Token", nie "Bearer"
    ...(options.headers || {})
  };
  return fetch(url, { ...options, headers, signal: controller.signal })
    .finally(() => clearTimeout(t));
}

async function readResp(resp) {
  const text = await resp.text();
  try { return { raw: text, json: JSON.parse(text) }; }
  catch { return { raw: text, json: null }; }
}

function isTransient(status) {
  return [502, 503, 504, 408].includes(status);
}
function shouldRetry(respStatus, err) {
  if (respStatus && isTransient(respStatus)) return true;
  if (respStatus === 429) return true;
  if (err && ("" + err).toLowerCase().includes("aborted")) return true;
  if (err && ("" + err).toLowerCase().includes("timeout")) return true;
  return false;
}

async function fetchRetry(url, options = {}, label = "request") {
  let attempt = 0;
  let lastErr = null;
  while (attempt <= MAX_RETRIES) {
    try {
      const resp = await abortableFetch(url, options);
      if (resp.ok) return resp;

      const { raw } = await readResp(resp);
      // retry?
      if (shouldRetry(resp.status)) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[${label}] Retry ${attempt + 1}/${MAX_RETRIES} after ${resp.status}: ${raw.slice(0, 200)}`);
        await sleep(waitMs);
        attempt++;
        continue;
      }
      // non-retryable
      throw new Error(`[${label}] ${resp.status} ${raw}`);
    } catch (err) {
      lastErr = err;
      const msg = (err && err.message) ? err.message : String(err);
      if (shouldRetry(null, err) && attempt < MAX_RETRIES) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[${label}] Network/Timeout retry ${attempt + 1}/${MAX_RETRIES}: ${msg}`);
        await sleep(waitMs);
        attempt++;
        continue;
      }
      throw new Error(`[${label}] ${msg}`);
    }
  }
  throw lastErr || new Error(`[${label}] failed after retries`);
}

/** --- Core: Create one prediction (1 obrázok) --- */
async function createSinglePrediction({ prompt, aspect }) {
  const input = {
    prompt,
    ...(aspect ? { aspect_ratio: aspect, aspect } : {})
  };

  // 1) Skús "official" endpoint a požiadaj o sync odpoveď
  {
    const resp = await fetchRetry(
      `${MODEL_BASE}/predictions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Prefer": "wait" // ak model dovolí, čakáme na hotový výstup
        },
        body: JSON.stringify({ input })
      },
      "official-predict"
    );

    const body = await readResp(resp);
    // ak máme JSON s id/output, vrátime
    try {
      return body.json ?? JSON.parse(body.raw);
    } catch {
      // padneme do fallbacku
    }
  }

  // 2) Fallback: zistiť latest_version.id a použiť /v1/predictions (tiež skúsime sync)
  const infoResp = await fetchRetry(`${MODEL_BASE}`, {}, "model-info");
  const infoBody = await readResp(infoResp);
  const infoJson = infoBody.json || JSON.parse(infoBody.raw || "{}");
  const versionId = infoJson?.latest_version?.id;
  if (!versionId) {
    throw new Error(`[model-info] latest_version.id not found`);
  }

  const resp2 = await fetchRetry(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Prefer": "wait"
      },
      body: JSON.stringify({ version: versionId, input })
    },
    "predictions"
  );
  const body2 = await readResp(resp2);
  return body2.json ?? JSON.parse(body2.raw || "{}");
}

/** --- Health --- */
app.get("/health", (_, res) => {
  res.json({ ok: true, hasToken: Boolean(REPLICATE_TOKEN), timeoutMs: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
});

/** --- Start generation --- */
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
      // ak máme výstup už teraz (Prefer: wait), pošleme ho hneď
      const outputs =
        Array.isArray(data?.output) ? data.output :
        Array.isArray(data?.output?.images) ? data.output.images :
        Array.isArray(data?.output?.data) ? data.output.data : null;

      return res.json({
        mode: "single",
        id: data?.id ?? null,
        getUrl: data?.urls?.get ?? null,
        webUrl: data?.urls?.web ?? null,
        status: data?.status ?? null,
        output: outputs || null
      });
    }

    // batch – N paralelných predikcií (každá 1 obrázok)
    const jobs = Array.from({ length: n }, () => createSinglePrediction({ prompt, aspect }));
    const results = await Promise.all(jobs);

    // pripravíme zoznam id + hneď aj output (ak ho máme)
    const items = results.map(r => {
      const outputs =
        Array.isArray(r?.output) ? r.output :
        Array.isArray(r?.output?.images) ? r.output.images :
        Array.isArray(r?.output?.data) ? r.output.data : null;
      return {
        id: r?.id ?? null,
        getUrl: r?.urls?.get ?? null,
        webUrl: r?.urls?.web ?? null,
        status: r?.status ?? null,
        output: outputs || null
      };
    });

    return res.json({
      mode: "batch",
      count: items.length,
      items,
      tookMs: Date.now() - startedAt
    });
  } catch (err) {
    console.error("[/api/generate] ERROR:", err?.message || err);
    return res.status(502).json({ // 502, aby si to videl aj v UI ako gateway-type issue
      error: err?.message || String(err)
    });
  }
});

/** --- Poll one prediction (ak sme nedostali output hneď) --- */
app.get("/api/predictions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const resp = await fetchRetry(
      `https://api.replicate.com/v1/predictions/${id}`,
      {},
      "poll"
    );
    const body = await readResp(resp);
    return res.status(200).json(body.json ?? JSON.parse(body.raw || "{}"));
  } catch (err) {
    console.error("[/api/predictions/:id] ERROR:", err?.message || err);
    return res.status(502).json({ error: err?.message || String(err) });
  }
});

/** --- SPA fallback --- */
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
