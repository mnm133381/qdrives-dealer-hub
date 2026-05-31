# QD Auctions PWA — `app.qdrives.co.in` Production Deployment

> **Status**: Code changes pre-staged. The deploy itself is a 3-click action you (the user) trigger from the Emergent dashboard. This doc is the complete playbook.

---

## TL;DR — what you need to do (the 4 steps)

| Step | Who | Where | Time |
|---|---|---|---|
| 1 | **You** | Emergent dashboard → **Deploy** button → **Deploy Now** | ~10–15 min |
| 2 | **You** | Emergent dashboard → **Link domain** → enter `app.qdrives.co.in` → **Entri** → follow on-screen DNS instructions | ~5 min |
| 3 | **You** | Your DNS provider (where `qdrives.co.in` is registered) → paste the records Entri shows you | ~2 min |
| 4 | **You** | Firebase Console → Authentication → Settings → Authorized Domains → add `app.qdrives.co.in` | ~30 sec |

After step 3, wait 5–30 minutes for DNS propagation and SSL provisioning. Then test at `https://app.qdrives.co.in`. That's it.

---

## 1) Trigger production deploy

In the Emergent dashboard:

1. Click **Deploy** (top-right area).
2. Click **Deploy Now**.
3. Wait 10–15 min for the build.
4. You'll receive a **production URL** that looks similar to (but not identical to) the preview URL — something like `https://qdrives-dealer-hub.emergentagent.com` (no "preview" subdomain).

**Cost**: 50 credits/month per deployed app. Includes:
- 24/7 managed infrastructure
- Auto SSL (Let's Encrypt-style, no manual certificate work)
- Custom domain mapping (included, no extra credits)
- Unlimited redeploys/updates

You can shut down the deployment any time to stop recurring charges. Up to 100 deployments per account.

---

## 2) Map your custom domain in Emergent

After deploy completes:

1. From the deployed app's settings, click **Link domain**.
2. Type: **`app.qdrives.co.in`**
3. Click **Entri** — this opens an embedded DNS-setup wizard.
4. Entri will detect your DNS provider (GoDaddy, Cloudflare, AWS Route 53, Namecheap, etc.) and show you the exact records to create.

**IMPORTANT pre-requisite (do this BEFORE Entri):**
> **Remove every existing `A` record for `app.qdrives.co.in`** from your DNS provider. Entri/Emergent will not overwrite existing records, and a stale A record will block SSL issuance.

---

## 3) DNS records you'll create

The **exact** records are shown to you in the Entri flow (they're routing-pool specific to your deployment). The general shape is one of these two patterns:

### Pattern A — CNAME (most common)
| Type | Host / Name | Value / Target | TTL |
|---|---|---|---|
| `CNAME` | `app` | `<value-from-Entri>` (e.g. `qdrives-dealer-hub.emergentagent.com.`) | 300 (5 min) |

### Pattern B — A + AAAA (some DNS providers force this for subdomains)
| Type | Host / Name | Value | TTL |
|---|---|---|---|
| `A` | `app` | `<IPv4 from Entri>` | 300 |
| `AAAA` | `app` | `<IPv6 from Entri>` | 300 |

### Common Entri also asks for a TXT verification record
| Type | Host / Name | Value | TTL |
|---|---|---|---|
| `TXT` | `_emergent.app` or `_entri.app` | `<token-from-Entri>` | 300 |

Use a **low TTL (300 seconds = 5 minutes)** during setup so you can iterate quickly if anything's wrong. You can raise it to 3600 once everything is verified live.

---

## 4) DNS propagation & SSL

- **Propagation**: usually 5–15 minutes; worst case 24h.
- **Check progress**: https://dnschecker.org/#A/app.qdrives.co.in (or CNAME if you used Pattern A). Wait for green checkmarks across most regions.
- **SSL certificate**: Emergent auto-provisions a certificate (typically via Let's Encrypt) once DNS resolves correctly. **No action from you.** SSL usually completes within 5–15 min after DNS is live.
- **Verification**:
  ```bash
  curl -sv https://app.qdrives.co.in/manifest.webmanifest 2>&1 | head -25
  ```
  You should see a TLS handshake to a `Let's Encrypt` or `Google Trust Services` certificate and the manifest JSON.

### Troubleshooting (per Emergent support)
If the site isn't live within 15 minutes:
1. Recheck DNS at your registrar — ensure **all old A records** for `app.qdrives.co.in` are removed.
2. In the Emergent dashboard → click **Entri** again → re-run the wizard.
3. Verify the TXT verification record was created correctly (case-sensitive value).

---

## 5) Firebase Authorized Domains (CRITICAL — auth will break without this)

The Firebase Phone Auth flow (reCAPTCHA + OTP) **strictly verifies the origin domain**. Until you add `app.qdrives.co.in`, every sign-in attempt from the new domain will fail with `auth/unauthorized-domain`.

**Steps:**
1. Open **Firebase Console** → select project **`autobid-platform`**.
2. Left sidebar → **Authentication** → top tabs → **Settings**.
3. Scroll to **Authorized domains** section.
4. Click **Add domain** → enter `app.qdrives.co.in` → Save.
5. Verify the list now contains:
   ```
   localhost                                              (default — keep)
   autobid-platform.firebaseapp.com                       (default — keep)
   autobid-platform.web.app                               (default — keep)
   qdrives-dealer-hub.preview.emergentagent.com           (existing — keep for staging tests)
   app.qdrives.co.in                                      (NEW — just added)
   ```

This is a one-time setting change — no code deploy needed.

---

## 6) Code-side changes (already staged — no action needed from you)

I've pre-updated the codebase so it's coherent under the new domain. These ship automatically on your next Emergent deploy:

| File | Change |
|---|---|
| `frontend/app.json` | `ios.associatedDomains` now includes `applinks:app.qdrives.co.in` (Universal Links) |
| `frontend/app.json` | Android `intentFilters` now includes `autoVerify=true` for `app.qdrives.co.in` (App Links) |
| `frontend/app/+html.tsx` | Added `<link rel="canonical" href="https://app.qdrives.co.in/">` + absolute `og:url` / `og:image` for clean WhatsApp/Twitter share cards |
| `frontend/public/manifest.webmanifest` | `start_url`, `scope`, `id` are all relative (`/`) — work on any domain, no edit needed |

### Asset Links SHA-256 (one follow-up before Play Store)
For Android Universal Links auto-verification on the new domain, the file `frontend/public/.well-known/assetlinks.json` currently has a placeholder fingerprint:
```json
"sha256_cert_fingerprints": ["REPLACE_WITH_EAS_BUILD_SHA256_FINGERPRINT"]
```
**This only matters for the Android APK side.** Until the APK build resumes (it's BLOCKED on the APK download issue with Emergent support), App Links fall back gracefully — the link still opens correctly in the browser PWA. Replace with the real fingerprint via `eas credentials --platform android --profile production` when you resume the native track.

---

## 7) Post-deployment verification checklist

Once DNS + SSL are live, run through this on a real mobile device:

```
🌐  Visit https://app.qdrives.co.in/
     → loads in <3 s
     → manifest.webmanifest, sw.js, icons all serve over HTTPS

📲  Chrome Android → menu → "Install app"
     → installs to home screen as "QD Auctions"
     → tap the home icon → opens in standalone (no browser chrome)

🔌  Switch to airplane mode → reload the PWA
     → /offline.html branded fallback renders cleanly

🔐  Sign in with phone + OTP
     → reCAPTCHA mounts invisibly, no "auth/unauthorized-domain" error
     → reaches /(tabs) home screen

🔔  Profile → "Enable Notifications" → grant permission
     → toggle flips to "Notifications on"
     → backend (curl) confirms a new row in db.push_tokens with channel="fcm_web"

📤  From a desktop browser, share a lot link:
     https://app.qdrives.co.in/lot/<some-auction-id>
     → opens the PWA, lands directly on the lot detail
     → WhatsApp preview shows the QD Auctions OG card (icon + title)

🚀  Run Lighthouse on https://app.qdrives.co.in/
     → Performance ≥ 80
     → Best Practices ≥ 95
     → SEO ≥ 95
     → PWA chip green (installable, has manifest, has SW, offline ready)
```

---

## 8) Final production URL for testing

After all 4 steps complete:

🔗 **`https://app.qdrives.co.in`**

This becomes the canonical URL for:
- Every shared auction lot (`https://app.qdrives.co.in/lot/{id}`)
- Marketing material / press / Play Store listing's "Visit website"
- Operator console SMS/email links
- WhatsApp / Instagram / Twitter share previews
- Onboarding email CTAs

The preview URL (`qdrives-dealer-hub.preview.emergentagent.com`) stays alive as a staging/QA endpoint — use it for testing risky changes before promoting.

---

## 9) Rollback

If anything goes wrong:
- **Bad deploy**: Emergent dashboard → deployment history → **Rollback** to the previous version (no extra credit cost).
- **Bad DNS**: revert the CNAME at your registrar — clients fall back to the preview URL.
- **Bad SSL**: usually self-heals in <30 min. If not, hit **Entri** again and re-run the verification.
- **Firebase auth broken on new domain**: ensure `app.qdrives.co.in` IS in the Authorized Domains list and there are no typos (no trailing slash, no `https://` prefix).

---

_Last updated: PWA Phase 1-3 + Custom Domain Staging Sprint (June 2025)._
