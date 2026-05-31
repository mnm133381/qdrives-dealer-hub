/**
 * Web Push (FCM) client for QD Auctions PWA.
 *
 * - Lazy-loads firebase/messaging only on the web platform.
 * - Requires a VAPID public key from Firebase Console → Cloud Messaging
 *   → Web Push certificates. Configured via `EXPO_PUBLIC_FCM_VAPID_KEY`.
 *   When the key is missing, every helper short-circuits to a clean
 *   no-op so the app still works (just without web push).
 * - Foreground messages are delivered via `onMessage()` and surfaced
 *   as in-app toasts; background messages are handled by the
 *   `firebase-messaging-sw.js` worker.
 * - The FCM registration token is sent to the backend with
 *   `platform: 'web'` so the dispatcher knows to route via FCM HTTP v1
 *   instead of the Expo push gateway.
 */
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { api } from './api';
import { firebaseConfig } from './firebase/config';

const WEB_TOKEN_KEY = 'qd_fcm_web_token';
const PROMPT_DISMISS_KEY = 'qd_push_prompt_dismissed_until';

export interface ForegroundPushPayload {
  title: string;
  body: string;
  data?: Record<string, any>;
}

const foregroundListeners = new Set<(p: ForegroundPushPayload) => void>();

function vapidKey(): string | undefined {
  // Read from Expo public env. Empty string is treated as missing.
  const k = (process.env.EXPO_PUBLIC_FCM_VAPID_KEY || '').trim();
  return k.length > 20 ? k : undefined;
}

export function isWebPushSupported(): boolean {
  if (Platform.OS !== 'web') return false;
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!('serviceWorker' in navigator)) return false;
  if (!('Notification' in window)) return false;
  if (!('PushManager' in window)) return false;
  return true;
}

/** True if VAPID is configured and Web Push can actually be used today. */
export function isWebPushConfigured(): boolean {
  return isWebPushSupported() && !!vapidKey();
}

export function currentPermission(): NotificationPermission | 'default' {
  if (!isWebPushSupported()) return 'default';
  try { return Notification.permission; } catch { return 'default'; }
}

export function isPushPromptSuppressed(): boolean {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return false;
  try {
    const until = parseInt(localStorage.getItem(PROMPT_DISMISS_KEY) || '0', 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch { return false; }
}

export function suppressPushPromptForDays(days = 14): void {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PROMPT_DISMISS_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
  } catch {}
}

async function ensureFirebaseAppAndMessaging() {
  // Dynamic imports so native bundles never pull in firebase/messaging.
  const { initializeApp, getApps, getApp } = await import('firebase/app');
  const messagingMod = await import('firebase/messaging');
  const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
  if (!(await messagingMod.isSupported().catch(() => false))) {
    return null;
  }
  const messaging = messagingMod.getMessaging(app);
  return { messaging, ...messagingMod };
}

/**
 * Request browser notification permission and register an FCM token
 * with the backend. Returns the token on success, null otherwise.
 *
 * Caller is responsible for showing a contextual UI BEFORE calling
 * this — raw permission prompts that fire on page load are an
 * anti-pattern most browsers now suppress.
 */
export async function enableWebPush(): Promise<string | null> {
  if (!isWebPushConfigured()) return null;
  try {
    // 1. Request permission.
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      suppressPushPromptForDays(7); // back off briefly on dismissal
      return null;
    }

    // 2. Ensure both SWs are ready. Browser registers /sw.js automatically,
    //    but FCM specifically needs /firebase-messaging-sw.js.
    let fcmReg: ServiceWorkerRegistration | undefined;
    try {
      fcmReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js', { scope: '/firebase-cloud-messaging-push-scope' });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[push] firebase SW register failed:', e);
    }

    // 3. Boot messaging + get a token.
    const bundle = await ensureFirebaseAppAndMessaging();
    if (!bundle) return null;
    const { messaging, getToken, onMessage } = bundle;
    const token = await getToken(messaging, {
      vapidKey: vapidKey(),
      serviceWorkerRegistration: fcmReg,
    });
    if (!token) return null;

    // 4. Register with backend (idempotent).
    try {
      await api.registerPushToken(token, 'web');
      try { localStorage.setItem(WEB_TOKEN_KEY, token); } catch {}
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[push] backend register failed:', e);
    }

    // 5. Wire up the foreground message handler (once).
    onMessage(messaging, (payload: any) => {
      const n = payload?.notification || {};
      const d = payload?.data || {};
      const item: ForegroundPushPayload = {
        title: n.title || d.title || 'QD Auctions',
        body: n.body || d.body || '',
        data: d,
      };
      foregroundListeners.forEach((cb) => { try { cb(item); } catch {} });
      // If we have an auction_id and the user taps the toast, route inside the SPA.
      // (The toast component invokes router.push directly; this is a fallback.)
    });

    return token;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[push] enable failed:', e);
    return null;
  }
}

export async function disableWebPush(): Promise<void> {
  if (Platform.OS !== 'web') return;
  let token: string | null = null;
  try { token = localStorage.getItem(WEB_TOKEN_KEY); } catch {}
  if (token) {
    try { await api.unregisterPushToken(token); } catch {}
    try { localStorage.removeItem(WEB_TOKEN_KEY); } catch {}
  }
  try {
    const bundle = await ensureFirebaseAppAndMessaging();
    if (bundle) await bundle.deleteToken(bundle.messaging);
  } catch {}
}

/** Subscribe to foreground FCM messages. Returns an unsubscribe fn. */
export function onForegroundPush(cb: (p: ForegroundPushPayload) => void): () => void {
  foregroundListeners.add(cb);
  return () => foregroundListeners.delete(cb);
}

/** Route to the deep link inside a payload, if present. */
export function navigateFromPayload(p: ForegroundPushPayload): void {
  const auctionId = p.data?.auction_id || p.data?.auctionId;
  if (auctionId) {
    try { router.push(`/lot/${auctionId}` as any); } catch {}
    return;
  }
  const url = p.data?.url;
  if (typeof url === 'string' && url.startsWith('/')) {
    try { router.push(url as any); } catch {}
  }
}
