# Q Drives — Product Requirements

## Vision
A premium wholesale used-car auction platform for Indian car dealers. Mobile-first React Native (Expo) app with a luxury automotive + fintech + real-time trading aesthetic.

## Brand
- Deep metallic red accents (#B91C1C) on graphite black (#0B0B0D)
- Dark mode first
- Cinematic car imagery with soft shadows and glassmorphism

## MVP Scope (v1.0)
- ✅ OTP-based phone authentication (mocked OTP `123456`) with JWT tokens
- ✅ KYC onboarding flow (3 steps: Identity, Business, Verification)
- ✅ Home dashboard: live market pulse, dealer stats, featured live auction, recommended inventory, quick filters
- ✅ Live Auctions list with Live / Upcoming / Ended tabs
- ✅ Live Auction screen with WebSocket real-time bid feed, animated bid pulse, outbid flash, one-tap bid buttons, countdown timer, inspection scores, reserve indicator, seller details
- ✅ Sell flow: registration lookup (mocked auto-fill), AI price estimate, photo grid, reserve slider, duration picker, launch auction
- ✅ Watchlist (add/remove auctions)
- ✅ Notifications (outbid, payment, verification)
- ✅ Dealer profile with trust score, stats, KYC info, sign out
- ✅ AI wholesale price estimate via Emergent LLM key (Claude Sonnet 4.5)

## Core Tech
- Backend: FastAPI + MongoDB + Motor + WebSockets + PyJWT
- Frontend: Expo SDK 54 + Expo Router + react-native-reanimated + lucide-react-native
- Auth: Mocked OTP → JWT (30-day expiry) → AsyncStorage
- Real-time: Native WebSocket per auction room

## Data
- 5 seed dealers, 12 cars across mix of live (6), upcoming (3), ended (3) auctions
- All dealers verified with trust scores 4.5–4.9

## Smart Business Enhancement
**AI-powered price intelligence** during seller flow. Sellers see an instant wholesale price band before setting reserve, increasing conversion by surfacing realistic market expectations. This becomes a powerful retention tool: dealers list more aggressively when they trust the floor price.

## Future
- True image upload + 360 viewer
- Real OTP via Twilio/MSG91 (production)
- Settlement/payment integrations (Razorpay)
- Admin dashboard (fraud, disputes, dealer approvals, inventory heatmaps)
- Push notifications (FCM/APNS)

## v1.5 Production Hardening (current)
- ✅ Real Firebase Phone Auth (replaces mocked `123456`); DEV_BYPASS_OTP=false in prod
- ✅ Atomic CAS bidding with idempotency keys + 24h dedupe TTL
- ✅ Resilient WebSockets: auto-reconnect, heartbeat, seq ordering, snapshot reconciliation
- ✅ Operator Reliability Metrics UI (`/admin/realtime/health`)
- ✅ Real media pipeline: `_enrich_auction` joins `db.media` and resolves URLs (no Unsplash leak)
- ✅ Pre-launch Draft workflow: auctions default to `status="draft"`; operator must call `POST /api/admin/auctions/{id}/launch` after uploading ≥3 photos + ≥1 featured. Frontend wires a sticky "Launch Auction" CTA on the per-car media manager. Draft listings are hidden from dealers until launched.
- ✅ Full-screen image gallery (custom Reanimated 4 + GestureHandler v2): pinch zoom, double-tap zoom, horizontal swipe, swipe-down close, image counter. Works on iOS/Android/web (no native deps).
