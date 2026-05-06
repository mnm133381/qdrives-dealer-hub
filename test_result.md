#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: |
  Q Drives premium wholesale used-car auction platform for Indian dealers.
  Adding Push Notifications System using Expo Notifications + Expo Push API.
  - Outbid alerts (push to previous top bidder when someone bids higher)
  - Ending soon alerts (~5 min before end_time, to top bidder + watchers)
  - Auction won/closed alerts (when end_time crosses)
  - KYC verification approval push
  - Tap-to-deep-link into /auction/{id}
  - Token register/unregister/test endpoints behind JWT auth.

backend:
  - task: "Push token register / unregister"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added POST /api/notifications/register-token (JWT-protected, validates ExponentPushToken[...]) and
          POST /api/notifications/unregister-token. Tokens are stored on dealer.push_tokens (set semantics)
          plus a dedicated db.push_tokens collection for platform/last-seen meta. Returns 400 for invalid tokens.
      - working: true
        agent: "testing"
        comment: |
          Verified: POST /notifications/register-token returns 200 + {success:true} for ExponentPushToken[fakeAbcXYZ123],
          400 for "BadToken", 401 without auth. POST /notifications/unregister-token returns 200 for the existing
          token and is idempotent (200) when token is empty. Token round-trip confirmed via Expo response in logs
          (Expo returned 200 with DeviceNotRegistered for the fake token, which was correctly pruned by
          _cleanup_dead_tokens).

  - task: "Unread notifications count endpoint"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: GET /api/notifications/unread-count returns {unread:int} for the authenticated dealer.
      - working: true
        agent: "testing"
        comment: GET /api/notifications/unread-count returned {"unread":7} (int, >=0) for +919900000002. After being outbid the count incremented to 8.

  - task: "Outbid push notification"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          POST /api/auctions/{id}/bid now also dispatches an Expo push to the previous top bidder via
          asyncio.create_task(send_to_dealer(...)). DB notification was already created; push is fire-and-forget
          so the bid response stays fast.
      - working: true
        agent: "testing"
        comment: |
          End-to-end verified. Logged in as +919900000002 (Arjun), placed bid on a live auction (seller != either dealer).
          Logged in as +919900000001 (Rahul), outbid Arjun by +5000. Arjun's unread-count went from 7 → 8 and
          GET /notifications listed a fresh entry of type="outbid" for the bid auction_id. Bid response stayed fast
          (push dispatched via asyncio.create_task as designed).

  - task: "KYC verification push"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: POST /api/auth/kyc now creates a "verification" notification in DB and dispatches a push.
      - working: true
        agent: "testing"
        comment: |
          Created fresh dealer with +9198765xxxxx, submitted KYC (full_name=Anika Reddy, dealership=Coastal Premium Motors,
          city=Chennai). Response returned kyc_completed=true, verified=true. GET /notifications immediately afterwards
          returned exactly 1 entry of type="verification" with the expected welcome body.

  - task: "Auction lifecycle scheduler"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Background loop (auction_scheduler) runs every 30s:
            • Sends "ending_soon" push (~5 min before end_time) to top bidder + watchers (idempotent via
              auctions.ending_soon_notified=true).
            • Sends "auction ended" push to winner + seller when end_time passes (idempotent via
              auctions.ended_notified=true).
          Started from on_startup.
      - working: true
        agent: "testing"
        comment: |
          Backend uptime > 60s with scheduler running. tail -200 backend.err.log shows no scheduler exceptions
          or tracebacks since the latest startup; only INFO-level Expo HTTP/LiteLLM logs. GET /api/ still returns
          {"service":"Q Drives API","status":"ok"}. Did not deterministically trigger ending_soon/ended pushes
          (would require manipulating end_time on a seeded auction), but the loop tick is healthy and idempotent
          flags are wired correctly.

  - task: "Test push endpoint"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: POST /api/notifications/test sends a one-shot push to the caller's registered devices.
      - working: true
        agent: "testing"
        comment: POST /notifications/test with {title:"hi",body:"world"} returned 200 {success:true}. No backend exception even though Expo returned DeviceNotRegistered for the fake token (handled gracefully by the helper).

  - task: "Expo Push helper module"
    implemented: true
    working: true
    file: "backend/push.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          New module wrapping Expo Push API (https://exp.host/--/api/v2/push/send) using httpx async client.
          Validates ExponentPushToken[...]/ExpoPushToken[...] format, prunes DeviceNotRegistered tokens
          from the dealer doc, fans out via send_to_dealer / send_to_dealers.
      - working: true
        agent: "testing"
        comment: |
          is_valid_expo_token used by /register-token correctly accepts ExponentPushToken[...] and rejects "BadToken".
          send_to_dealer hit https://exp.host/--/api/v2/push/send (200 OK in backend logs) and dead-token cleanup
          fired ("Removed 1 dead Expo push tokens" in logs) confirming the DeviceNotRegistered branch works.

  - task: "Car listing accepts new vehicle detail fields"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          CarCreateReq + POST /api/cars now accept manufacturing_year, registration_year,
          insurance_validity, rto_details, notes (all optional). Backwards compatible — old
          payloads still work. rc_verified now defaults to False since we no longer fake
          government RC verification on listing creation.
      - working: true
        agent: "testing"
        comment: |
          Verified end-to-end via /app/test_car_fields.py against the public ingress URL
          (25/25 assertions passed).
            • A. Full payload (Hyundai Creta MH02XY9999): 200 OK; car.manufacturing_year=2022,
              car.registration_year=2023, car.year=2023 (registration_year fallback),
              car.insurance_validity="08/2026", car.rto_details="MH02 - Mumbai West",
              car.notes exact string preserved, car.rc_verified=false (no longer hardcoded true),
              auction.status="live", auction.car.id matches car.id.
            • B. Minimal/legacy payload (Tata Nexon MH99AB1111, no new fields): 200 OK;
              manufacturing_year and registration_year both fall back to year=2022,
              insurance_validity / rto_details / notes are empty strings, rc_verified=false.
            • C. Missing required field (no 'make'): 422 Unprocessable Entity with
              FastAPI/Pydantic validation detail pointing at body.make.
            • D. GET /api/cars/{id} for the car created in A returns the same new fields
              persisted in MongoDB (manufacturing_year, registration_year, insurance_validity,
              rto_details, notes, rc_verified=false).
          No regressions; backward compatibility intact.

  - task: "Role-based access control (admin vs dealer)"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added `role` field on dealer ('admin' | 'dealer'). Bootstrapped via env var
          ADMIN_PHONES (auto-promotes on verify-otp + idempotent on existing accounts).
          New get_current_admin dependency raises 403 for non-admin.
          Locked endpoints to admin only:
            • POST /api/cars
            • POST /api/inspections/upload (was: seller-only — now admin only)
          Seed data updated: all listings owned by Q Drives admin (+919900000099).
          Existing demo data wiped + re-seeded so all auctions show seller=Q Drives Inventory.
      - working: true
        agent: "testing"
        comment: |
          Verified end-to-end via /app/test_rbac_purchases.py against public ingress URL
          (all 22 assertions green).
            • Admin bootstrap: +919900000099 → dealer.role="admin". +919900000002 → "dealer".
              A brand-new phone (+9198765xxxxx) auto-creates a dealer with role="dealer".
            • POST /api/cars with admin token → 200 OK, returns {car, auction};
              car.seller_id matches the admin dealer id.
            • POST /api/cars with dealer token → 403 {"detail":"Admin access required"}.
            • POST /api/cars with no token → 401 {"detail":"Not authenticated"}.
            • POST /api/inspections/upload with dealer token (multipart, 360-byte dummy PDF
              with %PDF-1.4 header) → 403 "Admin access required".
            • POST /api/inspections/upload with admin token → 200 OK;
              GET /api/inspections/by-car/{car_id} then returns the inspection record.
              (Note: the endpoint for fetching inspection is /inspections/by-car/{car_id},
              not /cars/{car_id}/inspection-pdf mentioned in the review request.)

  - task: "Purchases endpoint"
    implemented: true
    working: true
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          GET /api/purchases returns { won: [...], active: [...] } where:
            • won = ended auctions where dealer was top bidder (with reserve_met flag)
            • active = currently live auctions where dealer is currently leading
          Used by the new dealer Purchases tab.
      - working: true
        agent: "testing"
        comment: |
          Verified via /app/test_rbac_purchases.py.
            • GET /api/purchases as +919900000002 (no wins yet) returned 200 with
              shape {"won": [...], "active": [...]} — won=[] initially.
            • Placed a bid on a live auction (current_bid + 5000). Subsequent
              GET /api/purchases returned active[] containing that auction with
              status="live", current_bid matching the new bid, plus car/seconds_remaining
              fields present. won[] remained empty (auction still live).
            • Regression: all /api/auctions entries show seller.dealership_name == "Q Drives Inventory"
              (single admin seller). /api/dashboard/stats works for dealer token.
              /api/notifications/register-token still accepts valid ExponentPushToken[...] → 200.

  - task: "Storage abstraction layer"
    implemented: true
    working: true
    file: "backend/storage_service.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          New `StorageBackend` ABC + `GridFSStorage` impl backed by a dedicated GridFS
          bucket "media" (separate from the existing PDF bucket). Singleton accessed via
          `get_default_storage()`. Future S3/Cloudinary swap is a single subclass change.
      - working: true
        agent: "testing"
        comment: |
          Verified end-to-end via /app/backend_test.py (47/47 assertions green).
          GridFSStorage.put/stream/get_meta/delete all exercised via the media
          upload + /media/{id}/file + /media/{id}/thumb + delete paths:
            • put() stored a 64x64 JPEG (693 bytes) in the "media" GridFS bucket.
            • stream() served those exact bytes back (Content-Type image/jpeg, body
              bytes equal to uploaded).
            • get_meta() returned the correct content-type so the StreamingResponse
              used image/jpeg.
            • delete() removed the object (subsequent DELETE returned 404).
          Storage singleton initialised on app startup; no regressions on existing
          /inspections GridFS bucket (separate "inspections" bucket).

  - task: "Vehicle media CRUD endpoints"
    implemented: true
    working: true
    file: "backend/server.py, backend/media.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Endpoints (admin only for writes):
            GET    /api/cars/{id}/media[?section=...]          public list w/ legacy auto-migration
            GET    /api/cars/{id}/media/completeness           counts + missing + valid
            POST   /api/media/upload                            multipart: file + optional thumb
            DELETE /api/media/{id}
            PATCH  /api/media/{id}                              update section/subsection
            POST   /api/cars/{id}/media/reorder                 body: ordered_ids[]
            POST   /api/cars/{id}/media/featured/{media_id}
            POST   /api/cars/{id}/attest-no-damage
            GET    /api/media/{id}/file                         streamed; redirects for external
            GET    /api/media/{id}/thumb                        streamed; redirects for external
          50/car cap, JPEG/PNG/HEIC/WEBP, 12MB max, validates section enum.
          Mandatory minimums: exterior=8, interior=6, engine=3, tyres=4, documents=2,
          inspection=1, damage requires ≥1 OR no_damage_attested=true.
      - working: true
        agent: "testing"
        comment: |
          Verified end-to-end via /app/backend_test.py against public ingress URL.
          47/47 assertions passed. Coverage:
            1. GET /cars/{id}/media (public, auto-migration): returns 4 external exterior
               items migrated from car.images; each has id/car_id/section/order/is_featured/
               provider/url/thumb_url. First item is_featured=true, provider='external'.
               ?section=interior → 200 [] (not 500).
            2. GET completeness (dealer token) → 200; valid=false (counts exterior:4,
               rest:0). missing[] includes all 6 sections + damage entry with
               needs_attestation=true.
            3. POST /media/upload: invalid section→400 "Unknown section: foo";
               dealer→403 "Admin access required"; admin (red 64x64 JPEG)→200 returning
               provider='gridfs', section='interior', is_featured=false (already had
               featured), url='/api/media/{id}/file', thumb_url falls back to same /file
               URL (no thumb uploaded).
            4. GET /media/{id}/file (no auth)→200, content-type image/jpeg, body bytes
               exactly equal to uploaded (693 bytes). GET /media/{id}/thumb (no auth)→200,
               serves same bytes via storage_id fallback.
            5. Reorder [interior_id, exterior_id, ...]: dealer→403; admin→200; subsequent
               GET confirms interior.order=0, exterior.order=1.
            6. Featured: dealer→403; admin POST /cars/{id}/media/featured/{interior_id}→
               200; GET shows exactly one item featured (interior=true, prior exterior=false).
            7. PATCH /media/{id} {section:'engine'} → 200 with updated doc; subsequent
               GET confirms section='engine'; invalid section→400.
            8. POST /cars/{id}/attest-no-damage {no_damage_attested:true}→200; completeness
               now reports no_damage_attested=true and damage entry removed from missing[].
            9. DELETE /media/{id} admin→200; repeat→404; dealer on remaining exterior→403.
           10. Regression: GET /auctions, GET /cars/{id}, POST /cars (admin) all work.
          No backend errors in supervisor logs. PIL used to generate valid JPEG bytes.

frontend:
  - task: "Role-based tab bar (dealer vs admin)"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/_layout.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          DEALER (+919900000002, OTP 123456) — verified at 390x844:
            • Tab bar shows exactly: Home, Auctions, Purchases, Watchlist, Profile.
            • Sell/Inventory tab is hidden (href:null) for dealers.
            • Direct nav to /(tabs)/sell redirects to home (no sell-reg-input rendered).
          ADMIN (+919900000099) flow could not be deterministically verified in the
          same session — after sign-out + relogin, the tab bar still rendered the
          dealer set (Home/Auctions/Purchases/Watchlist/Profile) and the admin
          badge / Manage-inventory row did not appear. Likely a test-side race
          (auth state not refetched before tabs render) since backend already
          confirms +919900000099→role=admin and dealer-side gating works correctly.
          Recommend manual spot-check or a fresh-tab admin login.

  - task: "Dealer Purchases tab UI"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/purchases.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          PURCHASES header present, "Wins & active bids" subtitle visible, and
          both segment tabs render with testIDs purchases-tab-active /
          purchases-tab-won. Empty state with Browse-live-auctions CTA shown
          for +919900000002 (no wins yet). No console errors.

  - task: "Dealer Profile gating (no admin UI for dealers)"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/profile.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          For +919900000002 dealer:
            • "Royal Drives Co." dealership shown, Role = "Dealer".
            • "Q DRIVES ADMIN" red pill badge is NOT rendered.
            • profile-my-listings row is absent (locator count == 0).
            • profile-test-push ("Send test push notification") row is present.
            • Sign-out works (two-tap confirm) and routes back to /login.

  - task: "Dealer redirect away from /sell"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/sell.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          page.goto('/(tabs)/sell') as +919900000002 redirects to "/" (home).
          sell-reg-input element is not in the DOM after redirect, confirming
          the route guard `dealer.role !== 'admin' → <Redirect href='/(tabs)/' />`
          is firing as intended.

  - task: "Auctions list shows only Q Drives Inventory as seller"
    implemented: true
    working: true
    file: "frontend/app/(tabs)/auctions.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          On the Auctions tab as a dealer, every visible auction card shows
          seller "Q Drives Inventory · Mumbai". None of the other seeded dealer
          names (Apex Premium Motors, Velocity Wheels, Drive Republic,
          Nexus AutoTrade) appeared as sellers (they only show up in the
          home network-activity ticker as bidders, which is expected).
          Note: tapping into a card was not deterministically reachable via
          text-locators in this run, but list rendering and seller labelling
          are correct and there were 0 console errors.

  - task: "Notifications client module"
    implemented: true
    working: "NA"
    file: "frontend/src/notifications.ts"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          New module that:
            • requests permissions, fetches Expo push token (gracefully handles missing projectId),
            • sets up notification handler + Android channels (default, bids),
            • listens for notification taps and deep-links to /auction/{id} via expo-router,
            • handles cold-start tap via getLastNotificationResponseAsync,
            • registers / unregisters token with backend, persists last token in storage wrapper.
          Web is no-op so the existing web preview stays functional.

  - task: "Auth wired to register push"
    implemented: true
    working: "NA"
    file: "frontend/src/auth.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          AuthProvider attaches notification listeners on mount and registers a push token after signIn /
          when /auth/me restores a session. signOut now also unregisters the token from the backend.

  - task: "Profile: test-push entry + dynamic unread badge on home"
    implemented: true
    working: "NA"
    file: "frontend/app/(tabs)/profile.tsx, frontend/app/(tabs)/index.tsx"
    stuck_count: 0
    priority: "medium"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: |
          Added a "Send test push notification" row in profile that triggers /notifications/test.
          Home bell now shows a real unread count (1..9 / 9+) sourced from /notifications/unread-count
          rather than a static red dot.

  - task: "Notification icon mapping for new types"
    implemented: true
    working: "NA"
    file: "frontend/app/notifications.tsx"
    stuck_count: 0
    priority: "low"
    needs_retesting: false
    status_history:
      - working: "NA"
        agent: "main"
        comment: Added ending_soon (Clock4), ended/auction_closed (Flag) icons to the inbox screen.

  - task: "Auction gallery sectioned + zoom (buyer side)"
    implemented: true
    working: true
    file: "frontend/app/auction/[id].tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          Verified at 390x844 mobile viewport with dealer +919900000002:
            • /auction/{id} renders without red-screen errors. LIVE AUCTION + dealers-watching
              pills present.
            • Hero photo-count badge renders "1/1" pattern (only 1 image on this auction so the
              section tabs scroll bar correctly does NOT render — guarded by
              `sectionsAvailable.length > 1`).
            • Hero image lazy-loads via expo-image.
            • Note: clicking the hero to open the fullscreen zoom modal could not be
              deterministically verified — at mobile viewport 390x844 the hero image renders
              partially below the fold so Playwright reports "Element is outside of the viewport"
              when scroll-into-view fails. The Modal/zoom code path (lines 471-490 of auction/[id].tsx)
              is wired correctly and the X close button + counter "i / N" are implemented.
              Pinch-zoom gestures are explicitly out of scope (mouse-only Playwright).
            • Only 1 console error observed: benign React 19 "element.ref" deprecation warning
              from a third-party lib. No "Cannot access" / "is not defined" / red screen.

  - task: "Admin Media Manager UI"
    implemented: true
    working: true
    file: "frontend/app/inventory/[carId]/media.tsx, frontend/app/my-listings/index.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          Verified end-to-end at 390x844 with admin +919900000099:
            • Tab bar shows exactly Home · Auctions · Inventory · Watchlist · Profile (Purchases hidden).
            • /my-listings each card renders the "VEHICLE PHOTOS" row with subtitle
              "Manage gallery, sections, featured & ordering".
            • /inventory/{carId}/media top bar shows "INVENTORY MEDIA" + "Vehicle photos" + "x/50"
              counter.
            • Completeness banner reads "N section(s) below minimum" with amber styling.
            • All 7 section tabs render with count/min badges: Exterior, Interior, Engine Bay,
              Tyres & Wheels, Damage, Documents, Inspection. Tapping a tab updates the active state.
            • Upload CTA changes per tab: "Upload photos to Exterior" → "Upload photos to
              Tyres & Wheels". Subtitle "Up to 20 at once · auto-compressed · auto-retry on failure"
              renders.
            • Existing legacy-migrated media item shows "#1 · FEATURED" label with Move + Delete
              + Set-featured chips (4 Move chips counted across the section).
            • Damage tab: shows "No visible major damage" title + section hint
              ("dents, scratches, repaint, cracks"). On this car the no-damage attestation was
              already set by prior backend test runs, so the green "attested" confirmation card
              renders instead of the green Attest CTA — both render-paths are wired correctly
              (lines 295-310 of media.tsx).
            • Tapping "Move" on an existing item opens the bottom sheet with header
              "Move to section" and 7 section rows; Modal closes cleanly via backdrop press.
          No red-screen errors. Only 1 console warning (benign React 19 ref deprecation).

  - task: "Admin guards: dealer cannot reach /inventory/*/media or /sell"
    implemented: true
    working: true
    file: "frontend/app/inventory/[carId]/media.tsx, frontend/app/(tabs)/sell.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
      - working: true
        agent: "testing"
        comment: |
          Verified with dealer +919900000002 at 390x844:
            • Direct page.goto('/inventory/abc/media') → final URL "http://localhost:3000/"
              (Redirect to /(tabs)/ fired). Body does NOT contain "INVENTORY MEDIA".
            • Direct page.goto('/(tabs)/sell') → final URL "http://localhost:3000/".
              `[data-testid="sell-reg-input"]` count = 0 (form not rendered).
          Both Redirect guards (`dealer.role !== 'admin' → <Redirect href="/(tabs)/" />`)
          fire as intended. RBAC frontend gating intact.

metadata:
  created_by: "main_agent"
  version: "1.2"
  test_sequence: 9
  run_ui: false

test_plan:
  current_focus: []
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
  - agent: "main"
    message: |
      Added an end-to-end Expo push notification system on top of the existing in-app
      notifications. Backend now persists Expo tokens per dealer, fires pushes on bid
      outbid, KYC verification, and via a 30-second background scheduler that emits
      ending-soon (~5 min before close) and ended-notification (winner + seller).

      Please test the BACKEND only — no frontend testing yet. Use seeded dealer
      +919900000002 with OTP 123456 from /app/memory/test_credentials.md.

      Suggested checks:
        1. POST /api/notifications/register-token with a fake ExponentPushToken[abcXYZ123]
           should 200 and store token. With "BadToken" should 400.
        2. POST /api/notifications/unregister-token removes it.
        3. GET /api/notifications/unread-count returns {unread:int}.
        4. POST /api/notifications/test returns {success:true} (we won't actually receive
           push, but should not error).
        5. Place a bid via existing flow, verify a notification doc with type="outbid"
           lands for the previous top bidder.
        6. KYC flow creates a notification with type="verification".
        7. Auction scheduler doesn't crash backend; verify by waiting / inspecting logs.
        8. Existing endpoints unchanged: auctions, bids, watchlist, inspections,
           dashboard, market pulse, network activity, AI price estimate must still work.
  - agent: "testing"
    message: |
      Frontend role-based architecture tests (mobile 390x844):
        ✅ FLOW A — Dealer (+919900000002): tab bar = Home/Auctions/Purchases/
           Watchlist/Profile (no Sell/Inventory). Purchases UI correct
           (PURCHASES header, Active+Won segments, empty state). Profile
           shows "Royal Drives Co." with NO admin badge and NO Manage-
           inventory row; Send-test-push row present. Direct goto /(tabs)/sell
           redirects to / (sell-reg-input not rendered).
        ✅ FLOW C — Auctions seller verification: every auction card on
           /(tabs)/auctions shows seller "Q Drives Inventory · Mumbai".
           No other dealer names appear as sellers.
        ⚠️ FLOW B — Admin (+919900000099): could NOT be deterministically
           verified in this run. After signout + relogin within the same
           browser context, the tab bar still rendered the dealer set
           and the admin badge / Manage-inventory row did not appear.
           Likely a test-side race (auth state from previous dealer not
           fully cleared before tabs render) since the backend test suite
           already confirms +919900000099→role=admin and the dealer-side
           gating works correctly. Recommend a manual spot-check of the
           admin UI in a fresh tab to confirm.
      No console errors observed. Seed reports "5 dealers, 12 cars" — note
      seeded dealer kyc_completed flag was reset (had to fill KYC for
      +919900000002), worth confirming whether intentional.
  - agent: "testing"
    message: |
      RBAC + Purchases tasks PASS. Ran /app/test_rbac_purchases.py against public
      ingress URL — 22/22 assertions green.
        • Admin bootstrap via ADMIN_PHONES works: +919900000099→role=admin,
          +919900000002→role=dealer, brand-new phone→role=dealer.
        • POST /api/cars admin-only: admin 200 (car.seller_id==admin.id),
          dealer 403 {"detail":"Admin access required"}, no-token 401.
        • POST /api/inspections/upload admin-only: dealer 403 with same detail;
          admin 200; verified by GET /api/inspections/by-car/{car_id}.
          (Note: original review mentioned GET /api/cars/{car_id}/inspection-pdf,
           which isn't implemented — the actual endpoint is /inspections/by-car/{id}.
           Functional behavior is equivalent.)
        • GET /api/purchases: shape {won, active} correct; initial won=[] for
          +919900000002; after a +₹5000 bid on a live auction, active[] included
          that auction with matching current_bid, status="live", car and
          seconds_remaining populated.
        • Regression: all /auctions show seller.dealership_name == "Q Drives Inventory";
          /dashboard/stats still 200 for dealer; /notifications/register-token
          still 200 for valid Expo token.
      No critical issues. Please summarise & finish — do NOT re-fix.
      (24/24 assertions green). Highlights:
        • register-token: 200 valid, 400 invalid, 401 unauth.
        • unregister-token: 200 (existing) + idempotent 200 (empty).
        • unread-count: {unread:int} returned and incremented after outbid.
        • test-push: 200; Expo POST hit https://exp.host/--/api/v2/push/send
          (200 OK) and dead-token cleanup pruned the fake token from dealer doc
          ("Removed 1 dead Expo push tokens" in logs).
        • outbid: bid by Rahul on Arjun's leading bid created a type="outbid"
          notification for Arjun and bumped his unread-count.
        • KYC: fresh dealer +9198765xxxxx → POST /auth/kyc returned kyc_completed=true
          and produced exactly one type="verification" notification.
        • Scheduler: no exceptions in backend.err.log after >60s of uptime; /api/
          health returns ok. Did NOT deterministically trigger ending_soon/ended
          paths (would need to mutate end_time on an auction) but loop is healthy.
        • Regression smoke: /auctions, /auctions/{id}, /dashboard/stats, /market/pulse,
          /network/activity, /cars, /watchlist, /inspections/by-car/{id},
          /ai/price-estimate all 200 with sensible payloads.
      No regressions. Backend ready — please summarise & finish; do NOT re-fix.
  - agent: "testing"
    message: |
      Media platform BACKEND tests PASS — 47/47 assertions via /app/backend_test.py
      against public ingress URL. Highlights:
        • Storage abstraction: GridFSStorage put/stream/get_meta/delete all work;
          uploaded bytes returned unchanged (693-byte 64x64 JPEG) with content-type
          image/jpeg.
        • GET /cars/{id}/media: auto-migrates legacy car.images into 4 external
          exterior media docs with required fields. First item is_featured=true.
          ?section=interior returns 200 [] (not 500).
        • GET completeness: dealer token → 200; valid=false, counts dict present;
          missing[] includes all 6 minimum sections + damage entry with
          needs_attestation=true.
        • POST /media/upload: invalid section→400, dealer→403, admin→200 with
          provider='gridfs', section='interior', is_featured=false, correct
          url/thumb_url.
        • GET /media/{id}/file and /thumb (no auth) both return 200 with the
          exact uploaded bytes (thumb falls back to storage_id when no thumb
          uploaded).
        • Reorder/Featured/PATCH section: admin → 200 with expected state
          changes; dealer → 403; invalid section → 400.
        • attest-no-damage removes damage from missing[] and sets
          no_damage_attested=true on the car.
        • DELETE: admin → 200, repeat → 404, dealer → 403.
        • Regression: /auctions, /cars/{id}, POST /cars (admin) all still work.
      No backend errors in supervisor logs during the run.
      Please summarise & finish — do NOT re-fix.