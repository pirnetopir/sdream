import express from "express";
import fetch from "node-fetch";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "15mb" })); // kvôli dataURL uploadu
app.use(express.static(path.join(__dirname, "public")));

// --- uploads ---
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
app.use("/uploads", express.static(UPLOAD_DIR, {
  setHeaders(res){ res.setHeader("Cache-Control","public, max-age=31536000, immutable"); }
}));

// --- config ---
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60_000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 4);
const MODEL_OWNER = "bytedance";
const MODEL_NAME = "seedream-4";
const MODEL_BASE = `https://api.replicate.com/v1/models/${MODEL_OWNER}/${MODEL_NAME}`;

if (!REPLICATE_TOKEN) {
  console.warn("[WARN] Missing REPLICATE_API_TOKEN env var.");
}

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ensureHttpsProto(req){
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `https://${host}`;
}
function abortableFetch(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = {
    "Authorization": `Token ${REPLICATE_TOKEN}`,  // správne, používaj iba REPLICATE_TOKEN
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
  const s = String(err || "").toLowerCase();
  if (s.includes("aborted") || s.includes("timeout")) return true;
  return false;
}
async function fetchRetry(url, options = {}, label = "request") {
  let attempt = 0, lastErr = null;
  while (attempt <= MAX_RETRIES) {
    try {
      const resp = await abortableFetch(url, options);
      if (resp.ok) return resp;
      const { raw } = await readResp(resp);
      if (shouldRetry(resp.status)) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[${label}] Retry ${attempt + 1}/${MAX_RETRIES} after ${resp.status}: ${raw.slice(0, 200)}`);
        await sleep(waitMs); attempt++; continue;
      }
      throw new Error(`[${label}] ${resp.status} ${raw}`);
    } catch (err) {
      lastErr = err;
      if (shouldRetry(null, err) && attempt < MAX_RETRIES) {
        const waitMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        console.warn(`[${label}] Network/Timeout retry ${attempt + 1}/${MAX_RETRIES}: ${String(err)}`);
        await sleep(waitMs); attempt++; continue;
      }
      throw new Error(`[${label}] ${String(err?.message || err)}`);
    }
  }
  throw lastErr || new Error(`[${label}] failed after retries`);
}

// --- MIME/extension map ---
function extForMime(mime){
  const m = (mime||"").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/webp") return ".webp";
  if (m === "image/gif") return ".gif";
  if (m === "image/heic") return ".heic";
  if (m === "image/heif") return ".heif";
  return ".bin";
}
function parseDataUrl(dataUrl){
  const m = /^data:(.+);base64,(.*)$/i.exec(dataUrl || "");
  if (!m) throw new Error("Invalid data URL");
  const mime = m[1];
  const data = Buffer.from(m[2], "base64");
  return { mime, data, ext: extForMime(mime) };
}

// --- Debug endpoints ---
app.get("/debug/uploads", (_, res) => {
  let files = [];
  try { files = fs.readdirSync(UPLOAD_DIR); } catch {}
  res.json({ count: files.length, files });
});
app.get("/debug/ping", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: "missing url" });
  try{
    const resp = await fetch(url, { method: "HEAD" });
    res.json({ ok: resp.ok, status: resp.status, url });
  }catch(e){
    res.status(500).json({ ok:false, error: String(e), url });
  }
});

// --- upload (dataURL -> file -> public https URL + verifikácia) ---
app.post("/api/upload", async (req, res) => {
  try {
    const { dataUrl } = req.body || {};
    if (!dataUrl) return res.status(400).json({ error: "Missing 'dataUrl'." });
    const { data, ext, mime } = parseDataUrl(dataUrl);
    const name = crypto.randomBytes(8).toString("hex") + ext;
    const filePath = path.join(UPLOAD_DIR, name);
    fs.writeFileSync(filePath, data);
    const base = ensureHttpsProto(req);
    const url = `${base}/uploads/${name}`;

    // rýchle overenie prístupnosti
    let ok = false, status = 0;
    try {
      const h = await fetch(url, { method: "HEAD" });
      ok = h.ok; status = h.status;
      if (!ok) {
        const g = await fetch(url);
        ok = g.ok; status = g.status;
      }
    } catch {}
    if (!ok) {
      return res.status(500).json({ error: `Upload saved but not publicly accessible (status ${status}).`, url, mime });
    }
    return res.json({ url, mime, size: data.length });
  } catch (err) {
    console.error("[/api/upload] ERROR:", err?.message || err);
    return res.status(400).json({ error: String(err?.message || err) });
  }
});

/** --- core: one prediction (image optional) ---
 * IMPORTANT: for Seedream 4 on Replicate the reference image key is `image_input` (ARRAY)
 * See the model version API schema. :contentReference[oaicite:1]{index=1}
 */
async function createSinglePrediction({ prompt, aspect, imageUrl }) {
  // Ak posielame obrázok a nezadaný aspekt, nech sa zladí s ním
  const effectiveAspect = aspect || (imageUrl ? "match_input_image" : undefined);

  const input = {
    prompt,
    ...(effectiveAspect ? { aspect_ratio: effectiveAspect } : {}),
    // kľúčový fix: image_input musí byť pole URL
    ...(imageUrl ? { image_input: [imageUrl] } : {}),
    // voliteľne môžeš pridať aj rozlíšenie:
    // size: "2K", // 1K | 2K | 4K | "custom"
    // width/height iba keď size === "custom"
  };

  // 1) official (Prefer: wait)
  {
    const resp = await fetchRetry(
      `${MODEL_BASE}/predictions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Prefer": "wait" },
        body: JSON.stringify({ input })
      },
      "official-predict"
    );
    const body = await readResp(resp);
    try { return body.json ?? JSON.parse(body.raw || "{}"); } catch {}
  }

  // 2) fallback: version flow
  const infoResp = await fetchRetry(`${MODEL_BASE}`, {}, "model-info");
  const infoBody = await readResp(infoResp);
  const infoJson = infoBody.json || JSON.parse(infoBody.raw || "{}");
  const versionId = infoJson?.latest_version?.id;
  if (!versionId) throw new Error(`[model-info] latest_version.id not found`);

  const resp2 = await fetchRetry(
    "https://api.replicate.com/v1/predictions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Prefer": "wait" },
      body: JSON.stringify({ version: versionId, input })
    },
    "predictions"
  );
  const body2 = await readResp(resp2);
  return body2.json ?? JSON.parse(body2.raw || "{}");
}

// --- health ---
app.get("/health", (_, res) => {
  res.json({
    ok: true,
    hasToken: Boolean(REPLICATE_TOKEN),
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxRetries: MAX_RETRIES
  });
});

// --- generate (batch) ---
app.post("/api/generate", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { prompt, numImages, aspect, imageUrl } = req.body || {};
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Missing 'prompt'." });
    if (!REPLICATE_TOKEN) return res.status(500).json({ error: "Missing REPLICATE_API_TOKEN on server." });

    const n = Math.max(1, Math.min(4, Number(numImages) || 1));
    const usedImageUrl = imageUrl || null;

    if (n === 1) {
      const data = await createSinglePrediction({ prompt, aspect, imageUrl: usedImageUrl });
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
        output: outputs || null,
        debug: { usedImageUrl, sentKeys: Object.keys({
          ...(usedImageUrl ? { image_input: [usedImageUrl] } : {}),
          ...(aspect ? { aspect_ratio: aspect } : {})
        }) }
      });
    }

    const jobs = Array.from({ length: n }, () => createSinglePrediction({ prompt, aspect, imageUrl: usedImageUrl }));
    const results = await Promise.all(jobs);

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
      tookMs: Date.now() - startedAt,
      debug: { usedImageUrl, note: "image_input[] used; aspect_ratio defaulted to match_input_image for i2i when not provided." }
    });
  } catch (err) {
    console.error("[/api/generate] ERROR:", err?.message || err);
    return res.status(502).json({ error: err?.message || String(err) });
  }
});

// --- poll ---
app.get("/api/predictions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const resp = await fetchRetry(`https://api.replicate.com/v1/predictions/${id}`, {}, "poll");
    const body = await readResp(resp);
    return res.status(200).json(body.json ?? JSON.parse(body.raw || "{}"));
  } catch (err) {
    console.error("[/api/predictions/:id] ERROR:", err?.message || err);
    return res.status(502).json({ error: err?.message || String(err) });
  }
});

// --- SPA fallback ---
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
