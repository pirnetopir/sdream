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
const MODEL_VERSIONS_URL = `https://api.replicate.com/v1/models/${MODEL_OWNER}/${MODEL_NAME}/versions`;

let LATEST_VERSION_ID = null;

async function fetchLatestVersion() {
  const resp = await fetch(MODEL_VERSIONS_URL, {
    headers: { "Authorization": `Bearer ${REPLICATE_TOKEN}` }
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(`Failed to get model versions: ${resp.status} ${msg}`);
  }
  const data = await resp.json();
  // Replicate returns { results: [ { id, created_at, ... }, ... ] }
  const first = data?.results?.[0];
  if (!first?.id) throw new Error("No versions returned for the model.");
  LATEST_VERSION_ID = first.id;
  console.log("[Replicate] Latest version id:", LATEST_VERSION_ID);
  return LATEST_VERSION_ID;
}

// health
app.get("/health", (_, res) => res.json({ ok: true }));

// create prediction (async mode)
app.post("/api/generate", async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt'." });
    }
    if (!LATEST_VERSION_ID) {
      await fetchLatestVersion();
    }

    const resp = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${REPLICATE_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        version: LATEST_VERSION_ID,
        input: {
          // Seedream 4 supports 'prompt'; we keep simple here.
          prompt
        }
      })
    });

    const data = await resp.json();
    if (!resp.ok) {
      return res.status(resp.status).json({ error: data?.error || data });
    }
    // Return the prediction id and urls.get for client-side polling
    return res.json({
      id: data.id,
      getUrl: data?.urls?.get,
      webUrl: data?.urls?.web,
      status: data.status
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// proxy to get prediction status (and outputs)
app.get("/api/predictions/:id", async (req, res) => {
  const id = req.params.id;
  try {
    const url = `https://api.replicate.com/v1/predictions/${id}`;
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${REPLICATE_TOKEN}` }
    });
    const data = await resp.json();
    return res.status(resp.status).json(data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// fallback to index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    await fetchLatestVersion();
  } catch (e) {
    console.warn("[Startup] Could not prefetch model version:", e.message);
  }
  console.log(`Server listening on port ${PORT}`);
});