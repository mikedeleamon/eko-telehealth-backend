# Eko Telehealth — Backend API

The single shared API for the Eko Telehealth mobile app and admin console. It
implements the exact routes both clients already call (see
`eko_telehealth/src/api/` and `eko_telehealth_admin/src/lib/`), so going live is
config, not client rework.

**Stack:** Node 20 · TypeScript · Express 5 · Drizzle ORM → Supabase (Postgres) ·
JWT auth. External services: **Stream** (video + chat), **Flutterwave + PayPal**
(payments), **Resend** (email), **Cloudflare R2** (file storage).

## Design: boots first, lights up as keys land

Every integration is optional at startup. A route whose service isn't
configured returns **503** with a clear message instead of crashing — the
server-side echo of the app's mock-first design. Deploy the skeleton to Railway
today, then add credentials one service at a time. `GET /health` shows what's
live:

```json
{ "status": "ok", "services": { "database": true, "stream": false, "flutterwave": false,
  "paypal": false, "resend": false, "r2": false } }
```

## Local setup

```bash
npm install
cp .env.example .env        # fill in as accounts come online (see table below)
npm run db:push             # create tables in Supabase (needs DATABASE_URL)
npm run db:seed             # load the demo data (doctors, appointments, admin queues)
npm run dev                 # http://localhost:8080/health
```

Demo logins after seeding (password `Password123!`):

| Role | Email |
|---|---|
| Patient | `martin@ekotelehealth.com` |
| Doctor | `a.okafor@ekotelehealth.com` |
| Admin | `admin@ekotelehealth.com` |

## Environment variables

| Var | Service | Where to get it |
|---|---|---|
| `DATABASE_URL` | Supabase | Project Settings → Database → Connection string (Session pooler) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Auth | `openssl rand -hex 32` |
| `STREAM_API_KEY`, `STREAM_API_SECRET` | Stream | getstream.io → app → API key + secret |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_WEBHOOK_HASH` | Flutterwave | Dashboard → Settings → API Keys / Webhooks |
| `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_ENV` | PayPal | developer.paypal.com → REST app |
| `PAYPAL_WEBHOOK_ID` | PayPal | REST app → Add Webhook (`/webhooks/paypal`; subscribe to CHECKOUT.ORDER.APPROVED + PAYMENT.CAPTURE.COMPLETED/DENIED) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend | resend.com → API Keys |
| `TERMII_API_KEY`, `TERMII_SENDER_ID` | Termii | termii.com → dashboard (SMS OTP; cheapest for NG numbers) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Cloudflare R2 | R2 → Manage R2 API Tokens |
| `CORS_ORIGINS` | Core | comma-separated admin + dev origins |

**Secrets stay here.** `STREAM_API_SECRET`, payment secrets, and R2 keys live
only on the backend. The app only ever needs the *public* Stream API key
(returned in the token grants, and set as `EXPO_PUBLIC_STREAM_API_KEY`).

## Routes

Client (mobile): `/auth/{login,signup,forgot-password,verify}`, `/doctors`,
`/appointments`, `GET|POST /conversations`, `/conversations/:id/messages`,
`/notifications`, `/practice/{patients,agenda}`, `/payments/intent`,
`/calls/token`, `/chat/token`, `/uploads/presign`.
Admin: `/admin/{stats,providers/applications,reviews,users,appointments}` (+ decision POSTs).
Provider callbacks: `/webhooks/{flutterwave,paypal,stream}`.

## Stream chat: channels + transcripts

The backend owns chat channels and message history (the pitch's universal EMR +
moderation both require server-owned transcripts):

- **`POST /conversations { doctorId }`** creates (or returns) the thread and,
  via the `stream-chat` server SDK, an idempotent `messaging` channel whose id
  **is the conversation id**, with both participants as members. The mobile app
  should call this before opening a chat; it then watches the same channel.
- **`POST /webhooks/stream`** receives Stream's `message.new` events (verified by
  the `X-Signature` HMAC), and writes each message into the `messages` table +
  bumps the conversation's `lastMessage`/`unread`. Point your Stream app's
  **webhook URL** at `https://<railway-url>/webhooks/stream`. No extra env var —
  it verifies with `STREAM_API_SECRET`.

## Deploy to Railway

1. Push this folder to its own Git repo and create a Railway project from it
   (Railway auto-detects Node via Nixpacks; `railway.json` sets the start
   command + `/health` check).
2. Add all env vars in the Railway service **Variables** tab.
3. First deploy, then run `npm run db:push` and `npm run db:seed` once (Railway
   shell, or locally against the same `DATABASE_URL`).
4. Point the clients at the deployed URL and turn mock mode off:
   - Mobile `.env`: `EXPO_PUBLIC_API_URL=https://<railway-url>`,
     `EXPO_PUBLIC_USE_MOCK_API=false`, `EXPO_PUBLIC_REALTIME_PROVIDER=stream`.
   - Admin `.env.local`: `NEXT_PUBLIC_API_URL=https://<railway-url>`,
     `NEXT_PUBLIC_USE_MOCK_API=false`.

## Still to wire on the client side

- Mobile: call `POST /conversations { doctorId }` when opening a chat, and use
  the returned `id` as the Stream channel id (so the backend-owned channel with
  both members is used instead of the client's single-member fallback). The
  Stream Video + Stream Chat swap in `eko_telehealth/src/services/` is done.
- Set your Stream app's webhook URL to `/webhooks/stream` (see above).
- Register the payment webhooks in each dashboard: Flutterwave →
  `/webhooks/flutterwave` (+ secret hash), PayPal → `/webhooks/paypal`
  (subscribe to CHECKOUT.ORDER.APPROVED + PAYMENT.CAPTURE.COMPLETED/DENIED,
  then set `PAYPAL_WEBHOOK_ID`). PayPal orders are captured server-side on the
  approval webhook and confirmed only by the verified capture event.
