/**
 * PWA helpers for QD Auctions web build.
 *
 * Responsibilities:
 *   - Capture and surface the `beforeinstallprompt` event so the app can
 *     show a soft "Install QD Auctions" prompt at the right moment.
 *   - Listen for SW update events (dispatched from +html.tsx bootstrap)
 *     and expose a `forceReload()` that activates the waiting worker.
 *   - Listen for SW push-tap deep-link events and route inside the SPA.
 *   - Provide install-state helpers (`isStandalone`, `isInstallable`,
 *     `dismissPromptFor`) used by the InstallPrompt UI component.
 *
 * IMPORTANT: All DOM access is guarded — every helper is safe to call
 * on native (returns false / no-op) so the same module can be imported
 * unconditionally from _layout.tsx.
 */
import { Platform } from 'react-native';
import { router } from 'expo-router';

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

const DISMISS_KEY = 'qd_install_dismissed_until';
const MIN_REPROMPT_DAYS = 7;

let capturedPrompt: BeforeInstallPromptEvent | null = null;
let listenerInstalled = false;
const readyListeners = new Set<() => void>();
const updateListeners = new Set<() => void>();

export function isWeb(): boolean {
  return Platform.OS === 'web';
}

/** True when the page is running as an installed PWA (standalone window). */
export function isStandalone(): boolean {
  if (!isWeb() || typeof window === 'undefined') return false;
  try {
    if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    // iOS Safari A2HS exposes navigator.standalone.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window.navigator as any).standalone === true) return true;
  } catch {}
  return false;
}

/** True if the browser supports manual SW installation prompting. */
export function isInstallable(): boolean {
  return capturedPrompt !== null;
}

/** iOS Safari doesn't fire beforeinstallprompt — we need a separate UX. */
export function isIosSafariEligible(): boolean {
  if (!isWeb() || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) && !((window as any).MSStream);
  const isSafari = /^((?!chrome|android|crios|fxios|edgios|opios).)*safari/i.test(ua);
  return isIos && isSafari && !isStandalone();
}

/** Has the user dismissed the prompt recently? */
export function isPromptSuppressed(): boolean {
  if (!isWeb() || typeof localStorage === 'undefined') return false;
  try {
    const until = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

export function suppressPromptForDays(days = MIN_REPROMPT_DAYS): void {
  if (!isWeb() || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now() + days * 24 * 60 * 60 * 1000));
  } catch {}
}

/** Fire the native install prompt. Resolves with the user's choice. */
export async function showInstallPrompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!capturedPrompt) return 'unavailable';
  try {
    await capturedPrompt.prompt();
    const choice = await capturedPrompt.userChoice;
    capturedPrompt = null;
    return choice.outcome;
  } catch {
    capturedPrompt = null;
    return 'dismissed';
  }
}

/** Subscribe to install-prompt-availability changes. */
export function onInstallReady(cb: () => void): () => void {
  readyListeners.add(cb);
  return () => readyListeners.delete(cb);
}

/** Subscribe to SW "update available" events. */
export function onUpdateReady(cb: () => void): () => void {
  updateListeners.add(cb);
  return () => updateListeners.delete(cb);
}

/** Tell the waiting SW to take over and reload the page. */
export function applyUpdate(): void {
  if (!isWeb() || typeof navigator === 'undefined') return;
  try {
    if (!('serviceWorker' in navigator)) { window.location.reload(); return; }
    navigator.serviceWorker.getRegistration().then((reg) => {
      const waiting = reg?.waiting;
      if (waiting) {
        waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      // Reload once the new SW takes control.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
      // Fallback after 1.5s in case controllerchange doesn't fire.
      setTimeout(() => { if (!reloaded) { reloaded = true; window.location.reload(); } }, 1500);
    });
  } catch {
    window.location.reload();
  }
}

/**
 * Initialise PWA listeners. Safe to call multiple times — idempotent.
 * Should be invoked once at app boot (from _layout.tsx useEffect).
 */
export function initPwa(): void {
  if (!isWeb() || typeof window === 'undefined' || listenerInstalled) return;
  listenerInstalled = true;

  // ----- Runtime head injection (dev safety net) -----
  // expo-router only renders +html.tsx during static export. In dev
  // (and during preview deploys that serve dev mode) the served HTML
  // is the generic Expo shell — so we inject the PWA meta tags + SW
  // registration ourselves. Idempotent: every helper checks for
  // existing nodes before adding.
  try { injectPwaHead(); } catch {}
  try { registerServiceWorker(); } catch {}

  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    capturedPrompt = e as BeforeInstallPromptEvent;
    readyListeners.forEach((cb) => { try { cb(); } catch {} });
  });

  window.addEventListener('appinstalled', () => {
    capturedPrompt = null;
    // Clear the dismiss flag so a future uninstall+reinstall flow works.
    try { localStorage.removeItem(DISMISS_KEY); } catch {}
  });

  window.addEventListener('qd:sw-update-ready', () => {
    updateListeners.forEach((cb) => { try { cb(); } catch {} });
  });

  // SW → page deep-link navigation (push notification taps in standalone PWAs).
  window.addEventListener('qd:sw-navigate', (ev: Event) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = (ev as any)?.detail?.url;
    if (typeof url === 'string' && url.startsWith('/')) {
      // Defer one tick so the router stack is mounted before push.
      setTimeout(() => {
        try { router.push(url as any); } catch {}
      }, 60);
    }
  });
}


// --------------------------------------------------------------
// Runtime head injection helpers — keep the PWA usable in BOTH
// expo dev mode (where +html.tsx isn't rendered) and production
// static exports (where +html.tsx already provides these tags).
// --------------------------------------------------------------
function ensureMeta(name: string, content: string): void {
  const sel = 'meta[name="' + name + '"]';
  let m = document.head.querySelector(sel) as HTMLMetaElement | null;
  if (!m) {
    m = document.createElement('meta');
    m.setAttribute('name', name);
    document.head.appendChild(m);
  }
  if (!m.getAttribute('content')) m.setAttribute('content', content);
}
function ensureLink(rel: string, href: string, attrs: Record<string, string> = {}): void {
  const sizes = attrs.sizes ? '[sizes="' + attrs.sizes + '"]' : '';
  const sel = 'link[rel="' + rel + '"]' + sizes;
  const existing = document.head.querySelector(sel);
  if (existing) return;
  const l = document.createElement('link');
  l.rel = rel;
  l.href = href;
  Object.entries(attrs).forEach(([k, v]) => l.setAttribute(k, v));
  document.head.appendChild(l);
}
function injectPwaHead(): void {
  if (typeof document === 'undefined') return;
  // Document title (Apple iOS uses this as A2HS label fallback).
  if (!document.title || document.title === '') document.title = 'QD Auctions';
  // Manifest + theme/colour-scheme.
  ensureLink('manifest', '/manifest.webmanifest');
  ensureMeta('theme-color', '#08080A');
  ensureMeta('color-scheme', 'dark');
  ensureMeta('application-name', 'QD Auctions');
  // Apple A2HS.
  ensureLink('apple-touch-icon', '/icons/apple-touch-icon.png', { sizes: '180x180' });
  ensureMeta('apple-mobile-web-app-capable', 'yes');
  ensureMeta('mobile-web-app-capable', 'yes');
  ensureMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
  ensureMeta('apple-mobile-web-app-title', 'QD Auctions');
  ensureMeta('format-detection', 'telephone=no');
  // Favicons.
  ensureLink('icon', '/favicon.ico');
  ensureLink('icon', '/icons/favicon-32.png', { type: 'image/png', sizes: '32x32' });
  ensureLink('icon', '/icons/favicon-16.png', { type: 'image/png', sizes: '16x16' });
  // Microsoft tiles.
  ensureMeta('msapplication-TileColor', '#08080A');
  ensureMeta('msapplication-tap-highlight', 'no');
  // Viewport — overwrite the bare expo viewport to add safe-area + scaling rules.
  const vp = document.head.querySelector('meta[name="viewport"]') as HTMLMetaElement | null;
  if (vp) {
    vp.setAttribute('content', 'width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover, maximum-scale=5');
  }
  // OpenGraph (best-effort — does nothing if scrapers can't run JS, but
  // the static export +html.tsx covers the build-time case).
  if (!document.head.querySelector('meta[property="og:title"]')) {
    const og = document.createElement('meta');
    og.setAttribute('property', 'og:title');
    og.setAttribute('content', 'QD Auctions — Wholesale Used-Car Bidding');
    document.head.appendChild(og);
  }
}

function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const host = (location.hostname || '').toLowerCase();
  const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
  let allowDev = false;
  try { allowDev = localStorage.getItem('qd_sw_dev') === '1'; } catch {}
  // Always allow on non-localhost hosts (preview & prod). On localhost,
  // require the dev flag so Metro HMR isn't fighting the SW for /index.html.
  if (isLocalDev && !allowDev) return;

  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then((reg) => {
        const notifyUpdate = () => {
          try { window.dispatchEvent(new CustomEvent('qd:sw-update-ready', { detail: { registration: reg } })); } catch {}
        };
        if (reg.waiting && navigator.serviceWorker.controller) notifyUpdate();
        reg.addEventListener('updatefound', () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) notifyUpdate();
          });
        });
        setInterval(() => { try { reg.update(); } catch {} }, 24 * 60 * 60 * 1000);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[pwa] SW registration failed:', err);
      });
    navigator.serviceWorker.addEventListener('message', (ev) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = (ev as any).data;
      if (data && data.type === 'NAVIGATE' && data.url) {
        try { window.dispatchEvent(new CustomEvent('qd:sw-navigate', { detail: { url: data.url } })); } catch {}
      }
    });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register);
}
