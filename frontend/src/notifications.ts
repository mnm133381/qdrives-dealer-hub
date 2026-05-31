import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { api } from './api';
import { storage } from './storage';

/**
 * Q Drives push-notification client.
 *
 * - Web is intentionally a no-op (we only register on iOS/Android devices).
 * - Token registration is best-effort: we never let it crash auth flow.
 * - Tap on a push with a `auction_id` data payload deep-links into the
 *   live auction screen.
 */

const LAST_TOKEN_KEY = 'qdrives_push_token';

let initialised = false;
let receivedSub: Notifications.Subscription | null = null;
let responseSub: Notifications.Subscription | null = null;

/** Setup notification handler — must be called before showing any push. */
function setupHandler() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      // SDK 53+ shape:
      shouldShowBanner: true,
      shouldShowList: true,
      // Legacy fallback:
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    } as any),
  });
}

async function setupAndroidChannel() {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#B91C1C',
      sound: 'default',
    });
    await Notifications.setNotificationChannelAsync('bids', {
      name: 'Bid Alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 200, 100, 200],
      lightColor: '#B91C1C',
      sound: 'default',
    });
  } catch {}
}

function getProjectId(): string | undefined {
  // In Expo Go / dev clients this is sometimes empty. Both old and new keys
  // exist depending on SDK + how the project was created.
  const c: any = Constants;
  return (
    c?.expoConfig?.extra?.eas?.projectId ||
    c?.easConfig?.projectId ||
    c?.manifest?.extra?.eas?.projectId ||
    c?.manifest2?.extra?.eas?.projectId ||
    undefined
  );
}

export async function getExpoPushToken(): Promise<string | null> {
  if (Platform.OS === 'web') return null;
  if (!Device.isDevice) {
    // Simulators can't receive remote pushes
    return null;
  }
  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return null;

    const projectId = getProjectId();
    const tokenResp = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    return tokenResp?.data || null;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[push] failed to get expo token:', e);
    return null;
  }
}

function handleNotificationData(data: any) {
  if (!data || typeof data !== 'object') return;
  const auctionId = data.auction_id || data.auctionId;
  const broadcastId = data.broadcast_id || data.broadcastId;
  if (auctionId && typeof auctionId === 'string') {
    try {
      // Slight delay so router is mounted on cold start.
      // Carry the broadcast_id in the `fb` query param so the lot
      // screen can attribute the auction-view to this broadcast.
      setTimeout(() => {
        try {
          const path = broadcastId
            ? `/lot/${auctionId}?fb=${encodeURIComponent(broadcastId)}`
            : `/lot/${auctionId}`;
          router.push(path as any);
        } catch {}
      }, 80);
    } catch {}
  }
}

export function attachListeners() {
  if (Platform.OS === 'web') return;
  if (initialised) return;
  initialised = true;
  setupHandler();
  setupAndroidChannel();

  receivedSub = Notifications.addNotificationReceivedListener(() => {
    // Notification appears as system banner — nothing else to do here for now.
  });

  responseSub = Notifications.addNotificationResponseReceivedListener((resp) => {
    const data = resp?.notification?.request?.content?.data;
    handleNotificationData(data);
  });

  // Cold-start case: if user tapped a push that launched the app
  Notifications.getLastNotificationResponseAsync()
    .then((resp) => {
      if (resp?.notification?.request?.content?.data) {
        handleNotificationData(resp.notification.request.content.data);
      }
    })
    .catch(() => {});
}

export function detachListeners() {
  try { receivedSub?.remove(); } catch {}
  try { responseSub?.remove(); } catch {}
  receivedSub = null;
  responseSub = null;
  initialised = false;
}

/** Register the device's expo push token with the backend (idempotent).
 *
 * On web, we DON'T auto-prompt for notification permission (that would
 * be an anti-pattern most browsers suppress). Instead, if permission
 * was already granted in a prior session we silently re-register the
 * FCM web token \u2014 so the user's existing opt-in keeps working across
 * sessions. The explicit opt-in UI lives in the profile screen and
 * uses `enableWebPush()` from `./webPush` directly.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') {
    // Lazy import \u2014 keeps native bundles slim.
    try {
      const wp = await import('./webPush');
      if (wp.isWebPushConfigured() && wp.currentPermission() === 'granted') {
        return await wp.enableWebPush();
      }
    } catch {}
    return null;
  }
  attachListeners();
  const token = await getExpoPushToken();
  if (!token) return null;
  try {
    await api.registerPushToken(token, Platform.OS);
    try { await storage.setItem(LAST_TOKEN_KEY, token); } catch {}
    return token;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[push] backend register failed:', e);
    return null;
  }
}

/** On sign-out, drop the token from the backend so we stop pushing to this device. */
export async function unregisterFromPushNotifications(): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      const wp = await import('./webPush');
      await wp.disableWebPush();
    } catch {}
    return;
  }
  let token: string | null = null;
  try { token = await storage.getItem(LAST_TOKEN_KEY); } catch {}
  if (!token) return;
  try { await api.unregisterPushToken(token); } catch {}
  try { await storage.removeItem(LAST_TOKEN_KEY); } catch {}
}
