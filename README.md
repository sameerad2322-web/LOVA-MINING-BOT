# LOVA Mining — Telegram Mining Mini App on TON

**Tagline:** Mine Today, Earn Tomorrow  
**Token:** LOVA (`LOVA`) · Planned Supply: `1,000,000,000` Mintable Jetton on TON (Pre-Deployment Demo Balances)

## Architecture Overview

- **Frontend:** React 19, TypeScript, Tailwind CSS v4, `@tonconnect/ui-react`, `@ton/core`, Telegram WebApp SDK
- **Backend API:** Express (`server.ts` + `server/`) with HMAC-SHA256 Telegram `initData` validation, sliding-window rate limiting, signed session tokens, server-timestamp mining math, and TON blockchain Jetton verification
- **Database:** Supabase PostgreSQL (`supabase/schema.sql`) with Row Level Security (RLS) across all 16 tables; includes a local JSON fallback store for zero-config previewing before Supabase credentials are added
- **Hosting Target:** Cloudflare Pages + Workers (free tier) or any Node.js container (`npm run build && npm start`)

---

## 1. Supabase PostgreSQL Setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor → New Query**, paste the contents of `supabase/schema.sql`, and run it.
3. Copy your **Project URL** and **Service Role Key** from **Project Settings → API**.
4. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your server environment variables (never expose `SUPABASE_SERVICE_ROLE_KEY` to the browser).

---

## 2. Telegram Mini App Setup

1. Open [@BotFather](https://t.me/BotFather) on Telegram and create a bot (`/newbot`).
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in your server environment.
3. Configure your Mini App URL via `/newapp` or **Bot Settings → Menu Button** pointing to your deployed HTTPS URL.
4. Set `TELEGRAM_ALLOW_DEV_PREVIEW="false"` in production so only cryptographically verified `Telegram.WebApp.initData` requests are accepted.

---

## 3. TON Connect & 0.05 GRAM Jetton Verification

Wallet ownership verification uses a real **0.05 GRAM Jetton transfer** (not 0.05 TON) sent to `ADMIN_TON_WALLET_ADDRESS` via TON Connect.

Required server environment variables:

```env
GRAM_JETTON_MASTER_ADDRESS="<verified GRAM Jetton Master contract address>"
GRAM_JETTON_DECIMALS="9"
ADMIN_TON_WALLET_ADDRESS="<your TON receiving wallet address>"
TON_API_ENDPOINT="https://tonapi.io/v2"
TON_API_KEY="<optional tonapi.io free-tier key>"
```

Until `GRAM_JETTON_MASTER_ADDRESS`, `GRAM_JETTON_DECIMALS`, and `ADMIN_TON_WALLET_ADDRESS` are configured, GRAM payment verification stays safely disabled (`503 GRAM_VERIFICATION_NOT_CONFIGURED`) and never fakes payment success.

---

## 4. Admin Control Center Access

Set `ADMIN_BOOTSTRAP_SECRET` (a strong random secret) and/or `ADMIN_TELEGRAM_IDS` (comma-separated Telegram user IDs) in server environment variables. Navigate to **Profile → Admin Control Center** to authenticate securely.

---

## 5. Local Development & Deployment

```bash
npm install
npm run dev       # Starts Express API + Vite dev middleware on port 3000
npm run build     # Builds production frontend bundle into dist/
npm run start     # Runs production server
```

### Cloudflare Pages + Workers Deployment

1. Connect your repository to **Cloudflare Pages** (`npm run build`, output directory `dist`).
2. Deploy the Express API endpoints as a Cloudflare Worker / Pages Functions service or lightweight Node Worker with `wrangler.toml`, configuring all server-only secrets (`TELEGRAM_BOT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, `SESSION_SECRET`, `ADMIN_BOOTSTRAP_SECRET`, `TON_API_KEY`) via `wrangler secret put`.
