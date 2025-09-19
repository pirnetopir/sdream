# Seedream 4 + Replicate • Render starter

Minimalistický projekt (Node/Express + malé HTML UI), ktorý volá **Seedream 4** z **Replicate API**.

## Rýchly štart lokálne
1. `cp .env.example .env` a do `.env` vlož `REPLICATE_API_TOKEN` (nájdeš na replicate.com).
2. `npm install`
3. `npm start` a otvor `http://localhost:3000`

## Deploy na Render.com
1. Nahraj projekt na GitHub (napr. súkromný repo).  
2. Na **Render.com** → **New +** → **Web Service** → **Connect repository** (vyber tento repo).
3. Nastav:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node
4. V **Environment** premenných na Render pridaj:
   - `REPLICATE_API_TOKEN` (hodnotu nekopíruj do kódu, iba do Render secret).
5. Deploy. Po nabehnutí otvor URL služby (Render vygeneruje doménu).

> Pozn.: Server si sám pri štarte zistí **najnovší `version_id`** modelu `bytedance/seedream-4` a použije ho pri `POST /v1/predictions` (viď kód v `server.js`).

## API Endpoints tejto appky
- `POST /api/generate` — vytvorí prediction a vráti `{ id, getUrl, webUrl, status }`
- `GET /api/predictions/:id` — proxy na Replicate `GET /v1/predictions/{id}`

## Bezpečnosť
- Token ostáva na serveri. Frontend nikdy nepošle token do prehliadača.
- Render: nastav `REPLICATE_API_TOKEN` ako **secret env var**.

## Kde upravovať
- Frontend: `public/index.html`
- Backend: `server.js`

## Licencia
MIT