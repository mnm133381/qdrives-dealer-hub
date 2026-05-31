/* eslint-disable */
/**
 * Firebase Cloud Messaging — Web background handler
 * --------------------------------------------------------------
 * This SW runs ONLY when FCM web push is active. Foreground pushes
 * are handled by the main app via onMessage(). Background pushes
 * (tab closed / browser closed) land here.
 *
 * Loaded via compat builds because the modular SDK doesn't work in
 * service workers without bundling. v12.x compat is API-stable.
 */
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/12.13.0/firebase-messaging-compat.js');

// NOTE: these values mirror /app/frontend/src/firebase/config.ts.
// They are public client identifiers — safe to ship.
firebase.initializeApp({
  apiKey: 'AIzaSyDxcQHdrMgK0x9P5jtd2PHk2V4P9d368Lc',
  authDomain: 'autobid-platform.firebaseapp.com',
  projectId: 'autobid-platform',
  storageBucket: 'autobid-platform.firebasestorage.app',
  messagingSenderId: '4782680239',
  appId: '1:4782680239:android:a5ecff343ed8f8c3350c5a',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || 'QD Auctions';
  const body  = n.body  || d.body  || 'You have a new update.';
  const auctionId = d.auction_id || d.auctionId;
  const url = auctionId ? `/lot/${auctionId}` : (d.url || '/auctions');
  self.registration.showNotification(title, {
    body,
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: d.tag || (auctionId ? `lot-${auctionId}` : 'qd-fcm'),
    data: { url, ...d },
    vibrate: [200, 100, 200],
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clientsArr) {
      if ('focus' in c) {
        try { await c.focus(); } catch {}
        try { c.postMessage({ type: 'NAVIGATE', url: target }); } catch {}
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
