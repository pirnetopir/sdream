# Seedream 4 + Replicate • Render starter

Minimal projekt (Node/Express + malé HTML UI), ktorý volá **Seedream 4** z **Replicate API**.

## Lokálne
1. `cp .env.example .env` a vlož `REPLICATE_API_TOKEN`.
2. `npm install`
3. `npm start` → `http://localhost:3000`

## Render.com
1. Pushni repo na GitHub.
2. Render → **New Web Service** → Connect repo.
3. Build: `npm install`, Start: `npm start`, Environment: Node.
4. V **Environment Variables** pridaj `REPLICATE_API_TOKEN` (secret).
5. Deploy a otvor URL služby.

## Ako to volá API
- Primárne: `POST /v1/models/bytedance/seedream-4/predictions` (bez `version`).
- Fallback: `GET /v1/models/...` → `latest_version.id` → `POST /v1/predictions` s `version`.

## Endpoints
- `POST /api/generate` → vytvorí prediction, vráti `{ id, getUrl, webUrl, status }`
- `GET /api/predictions/:id` → polling stavu a výstupov

## Bezpečnosť
- Token je iba na serveri (NEposielaj do frontendu).
