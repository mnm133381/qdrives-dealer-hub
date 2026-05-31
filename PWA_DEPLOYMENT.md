# QD Auctions PWA — Deployment & Operations Playbook

> **Status**: Phases 1-3 production-ready. Phase 4 (custom domain + Lighthouse +
> cross-browser sign-off) is operational guidance below.

---

## 1. What was shipped

### Frontend
| Asset | Path | Purpose |
|---|---|---|
| Web App Manifest | `frontend/public/manifest.webmanifest` | Defines name, icons, theme, shortcuts, A2HS metadata |
| Service Worker | `frontend/public/sw.js` | Offline shell, runtime caching, Web Push handler |
| FCM Background SW | `frontend/public/firebase-messaging-sw.js` | Receives FCM web push when tab is closed |
| Offline Fallback | `frontend/public/offline.html` | Branded "you're offline" page |
| PWA Icons | `frontend/public/icons/*.png` | 192/512 any + maskable, 180 apple, 16/32 favicon |
| Favicon | `frontend/public/favicon.ico` | Legacy multi-res .ico |
| `robots.txt` | `frontend/public/robots.txt` | Crawler hints |
| Install Prompt UI | `frontend/src/components/InstallPrompt.tsx` | Soft A2HS banner + iOS hint + Update banner |
| PWA core | `frontend/src/pwa.ts` | initPwa(), install + update wiring, head injection (dev) |
| Web Push client | `frontend/src/webPush.ts` | FCM web messaging, token registration, foreground handler |
| HTML shell | `frontend/app/+html.tsx` | Static-export head with manifest, theme color, OG, SW bootstrap |
| Icon generator | `frontend/scripts/generate-pwa-icons.py` | Regenerates icons from brand master |

### Backend
| Change | File | Purpose |
|---|---|---|
| Token register accepts FCM web | `backend/server.py` (`/api/notifications/register-token`) | Stores web tokens with channel=`fcm_web` |
| FCM dispatcher | `backend/push.py` (`send_web_to_dealer`) | FCM HTTP v1 send via service-account JWT |
| Unified channel fan-out | `backend/push.py` (`send_to_dealer_all_channels`) | Optional: hit BOTH Expo + FCM web for a dealer |

---

## 2. Production deployment checklist

### A. Static export
```bash
cd /app/frontend
npx expo export --platform web --output-dir dist
```
This produces `dist/` containing the static SPA + everything from `public/` is copied to the root. Verify these are at the root of `dist`:
- `dist/manifest.webmanifest`
- `dist/sw.js`
- `dist/firebase-messaging-sw.js`
- `dist/offline.html`
- `dist/icons/*`
- `dist/favicon.ico`

### B. Hosting headers (CRITICAL)
The reverse-proxy / CDN MUST set:
| Path | Header |
|---|---|
| `/sw.js` | `Cache-Control: no-cache` (so SW updates roll out) |
| `/firebase-messaging-sw.js` | `Cache-Control: no-cache` |
| `/manifest.webmanifest` | `Content-Type: application/manifest+json` |
| `/index.html` | `Cache-Control: no-cache` |
| `/icons/*`, `/assets/*` | `Cache-Control: public, max-age=31536000, immutable` |
| `/*` (HTTPS) | strict-transport-security recommended |

### C. Custom domain
1. Configure DNS to point your domain (e.g. `qdrives.app`) to the static-hosting CNAME.
2. **Add the domain to Firebase Auth → Authentication → Settings → Authorized domains**, otherwise phone auth will reject the origin with `auth/unauthorized-domain`.
3. **Update `frontend/app.json`** if changing host:
   - `ios.associatedDomains` (Universal Links)
   - `android.intentFilters` (App Links)
   - `public/.well-known/assetlinks.json` SHA256
4. (Optional) Add Google Play Store install banner via `manifest.webmanifest` → `related_applications` (already configured).

### D. Required env vars

Frontend (`/app/frontend/.env`):
```
EXPO_PUBLIC_BACKEND_URL=https://qdrives.app
EXPO_PUBLIC_FCM_VAPID_KEY=<from Firebase Console>
```

Backend (`/app/backend/.env`):
```
FCM_SERVICE_ACCOUNT_PATH=/path/to/service-account.json   # required for web push DISPATCH
```

---

## 3. Web Push enablement (the only piece pending user action)

Web Push install + offline work today **without VAPID**. To enable actual notification delivery to the PWA:

### Step 1 — Generate VAPID key (frontend)
1. Firebase Console → Project Settings → Cloud Messaging tab.
2. "Web configuration" → "Web Push certificates" → Generate Key Pair.
3. Copy the public key into `/app/frontend/.env`:
   ```
   EXPO_PUBLIC_FCM_VAPID_KEY=B...
   ```
4. Restart the frontend.

### Step 2 — Service account (backend dispatcher)
1. Firebase Console → Project Settings → Service Accounts → "Generate new private key".
2. Save the JSON to a path on the server (mount as secret, NEVER commit).
3. Set in `/app/backend/.env`:
   ```
   FCM_SERVICE_ACCOUNT_PATH=/etc/secrets/qd-fcm-sa.json
   ```
4. Restart the backend.

### Step 3 — Wire the opt-in CTA
The infrastructure is ready, but no UI button currently calls `enableWebPush()`. Suggested integration: add a toggle in the profile screen:
```tsx
import { enableWebPush, disableWebPush, currentPermission, isWebPushConfigured } from '../src/webPush';
// In settings UI:
if (Platform.OS === 'web' && isWebPushConfigured()) {
  <Button onPress={enableWebPush}>Enable Notifications</Button>
}
```
(Or auto-prompt on a contextual event like "first time placing a bid".)

---

## 4. Lighthouse — target scores & how to hit them

### Pre-export checklist
- ✅ Manifest valid (icons, name, theme color, start_url, display).
- ✅ Service worker controls page, has fetch handler, offline fallback.
- ✅ HTTPS (required for SW + Push).
- ✅ Viewport meta tag present.
- ✅ Content theme-color matches manifest background.
- ✅ Apple touch icon present (180x180).

### Targets (after `expo export --platform web`)
| Metric | Target | Current architecture |
|---|---|---|
| Performance | 80+ | Bundle is large (~2-3MB initial) but cached aggressively |
| Accessibility | 90+ | Native RN components have ARIA built-in |
| Best Practices | 95+ | HTTPS, CSP-safe, no console warnings |
| SEO | 95+ | OG/meta tags via +html.tsx |
| PWA (chip) | ✅ Installable | All boxes checked |

### How to run Lighthouse
```bash
# After deploying to a public URL with HTTPS:
npx lighthouse https://qdrives.app/ --output html --output-path /tmp/lh.html --view
# Or in Chrome DevTools → Lighthouse tab → Mobile + PWA
```

### Known performance levers (if Performance < 80)
1. Code-split heavy admin routes (already isolated under `app/(admin)/`).
2. Lazy-load `react-native-reanimated` worklets / inspection PDF viewer.
3. Set `?priority=high` `fetchpriority="high"` on hero image of `/auctions`.
4. Preconnect to Firebase + backend origin from `+html.tsx`.
5. Image responsive `srcSet` via expo-image (already used).
6. Enable Brotli on the CDN.

---

## 5. Cross-browser sign-off matrix

Test these flows on EACH browser before marketing:

| Browser | Manifest install | Push | Phone Auth | Offline | Notes |
|---|---|---|---|---|---|
| **Chrome Android** | ✅ A2HS via beforeinstallprompt | ✅ FCM | ✅ Invisible reCAPTCHA | ✅ SW shell | Primary target |
| **Samsung Internet** | ✅ A2HS | ✅ | ✅ | ✅ | Default on Samsung |
| **Edge Android** | ✅ | ✅ | ✅ | ✅ | |
| **Firefox Android** | ⚠️ A2HS only via menu | ⚠️ Mozilla autopush | ✅ | ✅ | Push backend differs |
| **Safari iOS 16.4+** | ⚠️ Manual A2HS via Share | ⚠️ iOS PWA push only | ✅ | ✅ | iOS shows our custom hint |
| **Safari macOS** | ✅ A2HS | ✅ | ✅ | ✅ | macOS 13+ |
| **Chrome Desktop** | ✅ Omnibox install icon | ✅ | ✅ | ✅ | |

### Manual smoke test script (5 minutes per browser)
1. Open the staging URL in a fresh incognito window.
2. Verify "Install QD Auctions" banner appears within 10s (Chrome) or the iOS hint (Safari).
3. Open DevTools → Application → Manifest. All fields populated, no errors.
4. Open DevTools → Application → Service Workers. Status = "activated".
5. Open DevTools → Network → throttle to "Offline" → reload → see branded offline page.
6. Sign in with `+919900000001` / OTP `123456`. Verify reCAPTCHA widget mounts invisibly.
7. Navigate `/auctions`, tap a lot — verify it loads (REST + WS).
8. Trigger a test push (admin → broadcast). If VAPID configured, web push lands on the OS notification tray.

---

## 6. Maintenance — bumping the service worker

The SW version string in `sw.js` is:
```js
const SW_VERSION = 'qdauctions-pwa-v1.0.3';
```
On every meaningful deploy, **bump the version string** (e.g. `v1.0.4`). The next page load will:
1. Install the new SW in the background.
2. Fire `qd:sw-update-ready` → in-app "Refresh to update" banner.
3. User taps Refresh → `applyUpdate()` posts `SKIP_WAITING` → new SW activates → page reloads.

The old cache versions are purged automatically on activation.

---

## 7. Rollback

PWA is fully additive. To temporarily disable:
- **Disable install banner**: set `dismissed=true` in localStorage (`qd_install_dismissed_until`).
- **Kill the SW**: deploy an `sw.js` that simply calls `self.registration.unregister()` then `self.clients.matchAll().then(c => c.forEach(x => x.navigate(x.url)))`. This forces every client to drop the SW.
- **Disable web push**: clear `EXPO_PUBLIC_FCM_VAPID_KEY` from env (frontend stops requesting permission); clear `FCM_SERVICE_ACCOUNT_PATH` (backend stops dispatching).

The Android APK / Play Store build is **untouched** by any PWA change. Native users always continue working.

---

## 8. Files reference

```
/app/frontend/
├── public/
│   ├── manifest.webmanifest        ← PWA manifest
│   ├── sw.js                       ← Service worker (cache + push)
│   ├── firebase-messaging-sw.js    ← FCM background SW
│   ├── offline.html                ← Offline fallback
│   ├── favicon.ico                 ← Multi-res .ico
│   ├── robots.txt
│   ├── icons/                      ← All PWA + favicon variants
│   └── .well-known/assetlinks.json ← Android App Links (existing)
├── app/
│   ├── +html.tsx                   ← Web HTML shell (head + SW bootstrap)
│   └── _layout.tsx                 ← Mounts <InstallPrompt /> + initPwa()
├── src/
│   ├── pwa.ts                      ← Install/update/deep-link orchestration
│   ├── webPush.ts                  ← FCM web messaging client
│   ├── notifications.ts            ← Cross-platform push (native + web fallback)
│   ├── firebase/
│   │   ├── config.ts
│   │   └── phoneAuth.web.ts        ← Web Phone Auth via invisible reCAPTCHA
│   └── components/
│       └── InstallPrompt.tsx       ← Install + Update banners
├── scripts/
│   └── generate-pwa-icons.py       ← Regenerate icons from master
├── app.json                        ← web.{name, themeColor, display, ...}
└── .env                            ← EXPO_PUBLIC_FCM_VAPID_KEY=

/app/backend/
├── push.py                         ← Expo + FCM HTTP v1 dispatchers
└── server.py                       ← /api/notifications/register-token accepts web
```

---

_Last updated: PWA Phase 1-3 sprint (June 2025)._
