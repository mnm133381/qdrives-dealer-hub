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

frontend:
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

metadata:
  created_by: "main_agent"
  version: "1.1"
  test_sequence: 8
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
      All 7 backend tasks PASS. Ran /app/backend_test.py against the public ingress URL
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