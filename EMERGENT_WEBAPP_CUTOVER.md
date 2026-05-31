# QD Auctions PWA — Emergent Web App Cutover Plan

> **Target**: provision a new **Emergent Web App** deployment slot that serves
> the pre-built Expo web export (`dist/`) via `npx serve` on port 8080, and
> map it to the custom domain **`app.qdrives.co.in`**.
>
> **Effort estimate**: 1–2 hours of clicking + 5–15 min of DNS propagation.
> **Code reuse**: ~100% — zero rewrites, same codebase generates both the Android APK
> (via the existing Expo slot) AND the PWA bundle (via this new Web App slot).

---

## What was pre-staged in the codebase

All of the following ship automatically with your next `expo export --platform web`:

| File | Change | Purpose |
|---|---|---|
| `frontend/package.json` | Added `build:web`, `serve:web`, `start:webapp` scripts | Defines the build + serve pipeline the Web App slot will run |
| `frontend/package.json` | Added `serve@14.x` as a runtime dependency | Static-file server, identical to `npx serve dist` |
| `serve.json` (project root) | Caching + SPA-routing config for `serve` | Critical for SW correctness, SPA hard-reload, manifest MIME type |
| `backend/server.py` CORS | Already `allow_origins=["*"]` — no change needed | Accepts requests from the new origin |
| `frontend/app.json` | iOS associatedDomains + Android intentFilters include `app.qdrives.co.in` | Universal Links / App Links auto-verify on the new host |
| `frontend/app/+html.tsx` | Canonical link + absolute og:url/og:image point at `app.qdrives.co.in` | SEO + WhatsApp/Twitter share cards |
| `frontend/public/sw.js` | Version bumped to `v1.1.0` for cutover | Invalidates all stale caches when users hit the new domain |

---

## Architecture overview

```
  +----------------------+         +-----------------------+
  | app.qdrives.co.in    |   DNS   |  Emergent CDN/Proxy   |
  | (user's browser)     +-------->+  (HTTPS, auto-SSL)    |
  +----------------------+         +----------+------------+
                                              |
               +------------------------------+--------------------------+
               |                                                         |
               v                                                         v
   +--------------------------+                            +-----------------------------+
   |  Emergent Web App slot   |                            |  Emergent backend (existing)|
   |  (NEW, B1 deployment)    |                            |  /api/*  (FastAPI on 8001)  |
   |                          |                            |  /ws/auction/<id> (WS)      |
   |  yarn build:web          |                            |  Mongo, FCM, Firebase, etc. |
   |    → produces dist/      |                            +-----------------------------+
   |  yarn serve:web          |
   |    → npx serve dist :8080|
   |                          |
   |  Serves only the static  |
   |  PWA bundle:             |
   |  • index.html            |
   |  • manifest.webmanifest  |
   |  • sw.js + fcm-sw.js     |
   |  • icons/, _expo/static/ |
   |  • offline.html, robots  |
   +--------------------------+
```

The NEW Web App slot serves **only the frontend static bundle**. All `/api/*`
and `/ws/*` requests are forwarded by Emergent's edge proxy to the **existing**
backend (which is unchanged). Same Mongo, same FCM dispatcher, same Firebase.

The **existing Expo slot stays alive** as the Android APK build source and as
your staging/QA endpoint.

---

## Pre-flight checklist (do all before clicking Deploy on Emergent)

- [x] `expo export --platform web` builds clean (verified — 7.0 MB dist, 0 errors)
- [x] `serve` dependency installed at `serve@14.2.6`
- [x] `serve.json` config covers SW no-cache, manifest MIME, SPA fallback, security headers
- [x] `package.json` scripts: `build:web`, `serve:web`, `start:webapp`
- [x] Backend CORS already `["*"]` — no widening needed
- [x] `frontend/app/+html.tsx` canonical = `https://app.qdrives.co.in/`
- [x] `frontend/app.json` deep-link domains include `app.qdrives.co.in`
- [x] `frontend/public/sw.js` version bumped (cache invalidation at cutover)
- [x] `EXPO_PUBLIC_FCM_VAPID_KEY` set (web push)
- [x] `FCM_SERVICE_ACCOUNT_PATH` set on backend (web push dispatcher live)
- [x] `EXPO_PUBLIC_BACKEND_URL` resolves to the same backend the existing Expo slot uses
- [ ] Firebase Console → Authentication → Settings → Authorized Domains:
      ADD `app.qdrives.co.in` (currently only the preview URL is authorized)
- [ ] DNS provider for `qdrives.co.in`: delete ANY existing `A`/`AAAA` records for `app`
      (stale records block SSL issuance — see Emergent support docs)

---

## Deployment workflow on Emergent

### Step 1 — Provision the Web App slot
From the Emergent dashboard, create a **new Web App deployment** (separate from
your existing Expo deployment slot). When prompted for build/start commands,
use these (already defined in `package.json`):

| Field | Value |
|---|---|
| Working directory | `frontend` |
| Install command | `yarn install --frozen-lockfile` |
| Build command | `yarn build:web` |
| Start command | `yarn serve:web` |
| Listening port | `8080` |
| Health check path | `/manifest.webmanifest` (returns 200 if PWA is alive) |

If the slot UI auto-detects the framework: choose **"Static / Node"** or
**"Custom"** — NOT Next.js, NOT Expo (this slot is purely a static-file server).

If the slot UI does NOT expose explicit build/start fields: you may need to
add an `emergent.json` or similar config — check the slot creation flow.

**Cost**: 50 credits/month (the same as your existing Expo slot).

### Step 2 — First deploy
Click **Deploy** / **Deploy Now**. Wait 10–15 min for the first build. The
logs should show:
  ```
  $ yarn build:web
  Web Bundled XXXXms node_modules/expo-router/entry.js (XXXX modules)
  Exported: dist/
  $ yarn serve:web
  INFO  Accepting connections at http://0.0.0.0:8080
  ```

Once the slot reports Live, you'll have a default Emergent production URL
(e.g. `https://qdrives-webapp.emergentagent.com`). Verify with:
```bash
curl -s -o /dev/null -w "%{http_code} \n" https://<production-url>/manifest.webmanifest
curl -s -o /dev/null -w "%{http_code} \n" https://<production-url>/sw.js
```
Both must return **200**.

### Step 3 — Bind `app.qdrives.co.in`
In the Web App slot settings:
1. Click **"Link domain"**
2. Type: `app.qdrives.co.in`
3. Click **"Entri"**
4. Entri auto-detects your DNS provider (Cloudflare / GoDaddy / Route 53 / etc.) and shows the exact records to create.
5. At your DNS provider — paste the records Entri tells you. **Delete any existing `A` record for `app.qdrives.co.in` first.**
6. Wait 5–15 min for DNS + SSL provisioning. Verify with:
```bash
curl -sv https://app.qdrives.co.in/manifest.webmanifest 2>&1 | head -25
```
Look for a valid TLS handshake and JSON body.

### Step 4 — Firebase Authorized Domains
1. Firebase Console → project `autobid-platform` → Authentication → Settings → Authorized domains
2. **Add**: `app.qdrives.co.in`
3. Verify the list now contains preview URL AND the new custom domain.

Without this step every phone-auth attempt from the new domain fails with
`auth/unauthorized-domain`.

---

## Smoke test on a real Android device (5 min)

Open Chrome on a real Android phone and walk through:

```
  [ ] https://app.qdrives.co.in/ loads in < 3 s, no console errors
  [ ] Chrome menu → "Install app" → home-screen icon = "QD Auctions"
  [ ] Launching from home-screen icon opens in standalone (no browser chrome)
  [ ] Airplane mode + reload → branded /offline.html renders
  [ ] Sign in with real phone + OTP → reaches /(tabs) home screen
      (any auth/unauthorized-domain error → Step 4 not done yet)
  [ ] Profile → "Enable Notifications" → grant permission
      → toggle flips to "Notifications on"
  [ ] Operator triggers an outbid (or any push event)
      → notification lands in OS tray
  [ ] Open a shared link  https://app.qdrives.co.in/lot/<some-id>
      → lands on lot detail, live bidding works
  [ ] WhatsApp share of  https://app.qdrives.co.in/lot/<id>
      → preview card shows QD Auctions logo + title (og: meta tags)
  [ ] DevTools → Application → Manifest — all fields populated, no warnings
  [ ] DevTools → Application → Service Workers — status "activated"
  [ ] Lighthouse audit on app.qdrives.co.in — PWA chip ✅,
      Performance ≥80, Best Practices ≥95
```

---

## Post-launch cutover (after smoke tests pass)

Once `app.qdrives.co.in` is verified live:

1. **Operator console / SMS templates**: update outbound auction-share links
   to use the new domain. Search/replace `qdrives-dealer-hub.preview.emergentagent.com`
   → `app.qdrives.co.in` in:
   - email/SMS templates (backend-side—none currently use a hard URL, but verify)
   - any printed marketing collateral
   - Play Store listing's "Visit website" field
2. **Optional 301 redirect**: if you want preview URL traffic to migrate, add
   a redirect rule in the existing Expo slot's hosting config. (Not strictly
   required — both URLs can coexist indefinitely.)
3. **Monitor** for 48 h:
   - Firebase Authentication → Users tab: confirm new sign-ins from the new domain
   - Backend logs: confirm `/api/notifications/register-token` is receiving
     `platform=web` tokens from real users
   - Lighthouse / GA / your analytics: traffic shift from preview → production
4. **Keep the preview URL alive** as staging — risky changes go to preview first,
   then promoted to `app.qdrives.co.in` after a 24-hour soak.

---

## Rollback plan

If the new domain misbehaves at any point:

| Symptom | Rollback |
|---|---|
| SSL fails to issue | Delete the new A/CNAME records at DNS → clients fall back to preview URL within seconds |
| Frontend bundle broken | Emergent dashboard → Web App slot → deployment history → **Rollback** to previous version (no extra cost) |
| Auth broken on new domain | Re-check Firebase Authorized Domains list; remove + re-add `app.qdrives.co.in` |
| Push notifications fail | The web push pipeline is unchanged — confirm `EXPO_PUBLIC_FCM_VAPID_KEY` is set in the Web App slot's env vars (separate from the Expo slot env) |
| Wholesale catastrophe | Shut down the Web App slot (saves 50 credits/mo). Existing Expo slot + preview URL continue serving all users as before. Zero downtime for the customer base. |

---

## Why this is a true "zero-rewrite" migration

The artifact deployed to the new Web App slot is **bit-for-bit identical** to
what already runs at the preview URL today — the same compiled bundles, the
same service worker, the same React Native Web components, the same Firebase
web SDK. The ONLY differences:

1. The build output is served from a new origin (`app.qdrives.co.in`) instead
   of the preview URL.
2. The serving process is `serve dist/` instead of `expo start` (production
   mode vs. dev tunnel — strictly better for users).
3. The slot has a stable hostname & custom domain capability that the Expo
   slot doesn't expose.

No screens were rewritten. No frameworks were swapped. No business logic
touched. The 60+ screens, the WebSocket bidding engine, the inspection
SoT aggregator, the reserve-price privacy stripper, the FCM dispatcher,
the deep-link routing — all continue working exactly as they do today.

---

_Last updated: B1 Migration Sprint (June 2025)._
