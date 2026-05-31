// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * Web HTML shell for QD Auctions PWA.
 *
 * This file is rendered at static-export time AND at first byte for
 * web preview / production server-side bundles. It owns:
 *
 *   - PWA manifest link + theme color
 *   - Apple iOS A2HS meta tags (status bar, touch icon)
 *   - Microsoft tile metadata
 *   - SEO/OpenGraph/Twitter meta
 *   - Service worker registration bootstrap (deferred, post-load)
 *   - In-app navigation from SW push payloads (CustomEvent fan-out)
 *
 * IMPORTANT: Everything injected here runs BEFORE React boots, so
 * the SW registration runs even if the JS bundle is slow to load.
 * Keep this script tiny — we want to register the SW, then get out
 * of the way.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover, maximum-scale=5"
        />

        {/* PWA manifest + theme color (must match manifest.background_color
            for a seamless splash → app handover on Chrome Android). */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#08080A" />
        <meta name="color-scheme" content="dark" />
        <meta name="application-name" content="QD Auctions" />

        {/* Favicons / iOS touch icons */}
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
        <link rel="mask-icon" href="/icons/apple-touch-icon.png" color="#B91C1C" />

        {/* iOS Safari "Add to Home Screen" behaviour. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="QD Auctions" />
        <meta name="format-detection" content="telephone=no" />

        {/* Microsoft tiles (for Edge / Windows PWA installs). */}
        <meta name="msapplication-TileColor" content="#08080A" />
        <meta name="msapplication-TileImage" content="/icons/icon-192.png" />
        <meta name="msapplication-tap-highlight" content="no" />

        {/* SEO + Open Graph for shareable lot/auction links. */}
        <meta
          name="description"
          content="QD Auctions — India's trusted B2B wholesale used-car auction platform. Bid live, inspect transparently, settle securely."
        />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="QD Auctions" />
        <meta property="og:title" content="QD Auctions — Wholesale Used-Car Bidding" />
        <meta property="og:url" content="https://app.qdrives.co.in/" />
        <meta
          property="og:description"
          content="Live, transparent B2B used-car auctions for dealers. Inspect, bid, win."
        />
        <meta property="og:image" content="https://app.qdrives.co.in/icons/icon-512.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="QD Auctions — Wholesale Used-Car Bidding" />
        <meta name="twitter:image" content="https://app.qdrives.co.in/icons/icon-512.png" />
        <link rel="canonical" href="https://app.qdrives.co.in/" />

        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body > div:first-child { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0; }
              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
              /* iOS Safari A2HS: respect notch + home-bar safe insets. */
              @supports (padding: env(safe-area-inset-top)) {
                body { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
              }
              /* Prevent rubber-band scrolling on iOS standalone PWA. */
              html, body { overscroll-behavior-y: none; -webkit-tap-highlight-color: transparent; }
            `,
          }}
        />

        {/*
          Service worker bootstrap. Registers /sw.js after the page is
          interactive so it never delays first paint. Also wires up
          two CustomEvents:
            - 'qd:sw-update-ready' → app shows "Refresh to update" toast
            - 'qd:sw-navigate'     → app router pushes to deep-link URL
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                if (typeof window === 'undefined') return;
                if (!('serviceWorker' in navigator)) return;
                // Skip SW registration on localhost dev unless explicitly enabled,
                // so Metro HMR isn't fighting with the SW for /index.html.
                var allowDev = false;
                try { allowDev = window.localStorage && window.localStorage.getItem('qd_sw_dev') === '1'; } catch (e) {}
                var host = (location.hostname || '').toLowerCase();
                var isLocalDev = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
                if (isLocalDev && !allowDev) return;

                window.addEventListener('load', function () {
                  navigator.serviceWorker.register('/sw.js', { scope: '/' })
                    .then(function (reg) {
                      // Detect updated SW and notify the app.
                      function notifyUpdateReady() {
                        try { window.dispatchEvent(new CustomEvent('qd:sw-update-ready', { detail: { registration: reg } })); } catch (e) {}
                      }
                      if (reg.waiting && navigator.serviceWorker.controller) notifyUpdateReady();
                      reg.addEventListener('updatefound', function () {
                        var nw = reg.installing;
                        if (!nw) return;
                        nw.addEventListener('statechange', function () {
                          if (nw.state === 'installed' && navigator.serviceWorker.controller) notifyUpdateReady();
                        });
                      });
                      // Daily update check (helps PWAs that stay open across days).
                      setInterval(function () { try { reg.update(); } catch (e) {} }, 24 * 60 * 60 * 1000);
                    })
                    .catch(function (err) {
                      // eslint-disable-next-line no-console
                      console.warn('[pwa] SW registration failed:', err);
                    });

                  // Listen for SW → page messages (push notification taps).
                  navigator.serviceWorker.addEventListener('message', function (ev) {
                    if (!ev || !ev.data) return;
                    if (ev.data.type === 'NAVIGATE' && ev.data.url) {
                      try { window.dispatchEvent(new CustomEvent('qd:sw-navigate', { detail: { url: ev.data.url } })); } catch (e) {}
                    }
                  });
                });
              })();
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#08080A",
        }}
      >
        {children}
      </body>
    </html>
  );
}
