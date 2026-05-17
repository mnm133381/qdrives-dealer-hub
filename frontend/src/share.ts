/**
 * Share helper — unified share flow used by every "share" affordance
 * across the app.
 *
 * Why a single helper instead of inlining Share.share() per screen?
 *   1. ONE place to enforce what data we leak in the share message.
 *      We never include reserve_price, internal IDs, or operator-only
 *      metadata. Anyone we share a link to is treated as anonymous.
 *   2. ONE place to handle the "user dismissed the sheet" case so
 *      we don't surface a false "share failed" toast.
 *   3. Graceful fallback: if the native share sheet fails (web
 *      browsers without navigator.share, an Android intent crash,
 *      an iOS extension permission glitch), we copy the URL to the
 *      clipboard and return a `copied: true` result so callers can
 *      show the right toast.
 *
 * Deep-link strategy:
 *   • Web: a regular https URL works in browsers AND can be opened
 *     by the installed APK via Android App Links / iOS Universal
 *     Links (configured in app.json via `scheme: "qdrives"` + the
 *     associatedDomains entry the EAS build adds).
 *   • Native: when launched via a qdrives:// scheme link, the
 *     expo-router file-based routing picks the matching /lot/[id]
 *     route automatically.
 *
 * Privacy invariants (verified by RUN 51):
 *   • We share the auction_id which is already part of the public
 *     URL on bidders' lot screens — no new exposure.
 *   • The link target is the same anonymous-readable GET endpoint
 *     anyone can already reach.
 *   • We do NOT include reserve_price, seller_id, internal cost
 *     fields, or any operator-only badges in the share text.
 */
import { Share, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';

const PUBLIC_BASE_URL =
  (process.env.EXPO_PUBLIC_BACKEND_URL || 'https://qdrives.app').replace(/\/$/, '');

export type ShareResult = {
  ok: boolean;
  copied: boolean;
  dismissed: boolean;
  error?: string;
};

/** Build the public web URL for an auction lot. Safe for guest open. */
export function buildAuctionShareUrl(auctionId: string): string {
  return `${PUBLIC_BASE_URL}/lot/${auctionId}`;
}

/** Compose a short, bidder-friendly share message. Strips reserve /
 *  internal data; only public fields go into the text. */
function composeAuctionShareMessage(opts: {
  title?: string;
  url: string;
  currentBid?: number;
}): string {
  const lines: string[] = [];
  if (opts.title) lines.push(`🚗 ${opts.title}`);
  lines.push('Live auction on Q Drives');
  if (typeof opts.currentBid === 'number' && opts.currentBid > 0) {
    lines.push(`Current bid: ₹${opts.currentBid.toLocaleString('en-IN')}`);
  }
  lines.push('');
  lines.push(opts.url);
  return lines.join('\n');
}

/**
 * Trigger the native share sheet for an auction. Falls back to
 * clipboard copy if the sheet is unavailable or errors out.
 */
export async function shareAuction(opts: {
  auctionId: string;
  title?: string;
  currentBid?: number;
}): Promise<ShareResult> {
  const url = buildAuctionShareUrl(opts.auctionId);
  const message = composeAuctionShareMessage({
    title: opts.title,
    url,
    currentBid: opts.currentBid,
  });

  // Web-native: prefer navigator.share when supported (mobile web,
  // recent desktop Chromium). Falls through to clipboard below.
  if (Platform.OS === 'web') {
    const nav: any = (typeof navigator !== 'undefined') ? navigator : null;
    if (nav && typeof nav.share === 'function') {
      try {
        await nav.share({ title: opts.title || 'Q Drives auction', text: message, url });
        return { ok: true, copied: false, dismissed: false };
      } catch (e: any) {
        // AbortError = user dismissed the sheet — don't toast "fail".
        if ((e?.name || '') === 'AbortError') {
          return { ok: false, copied: false, dismissed: true };
        }
        // Fall through to clipboard fallback below.
      }
    }
    // Web fallback — copy to clipboard.
    try {
      await Clipboard.setStringAsync(url);
      return { ok: true, copied: true, dismissed: false };
    } catch (e: any) {
      return { ok: false, copied: false, dismissed: false, error: e?.message || 'Clipboard unavailable' };
    }
  }

  // Native (iOS / Android) — RN Share API opens the OS share sheet
  // which already supports WhatsApp, SMS, Telegram, Email, Copy Link
  // etc. without any per-channel wiring.
  try {
    const res = await Share.share(
      Platform.OS === 'ios' ? { url, message } : { message },
      { dialogTitle: opts.title || 'Share auction' },
    );
    if (res.action === Share.dismissedAction) {
      return { ok: false, copied: false, dismissed: true };
    }
    return { ok: true, copied: false, dismissed: false };
  } catch (e: any) {
    // Native sheet errored — last-ditch clipboard fallback.
    try {
      await Clipboard.setStringAsync(url);
      return { ok: true, copied: true, dismissed: false, error: e?.message };
    } catch (clipErr: any) {
      return { ok: false, copied: false, dismissed: false, error: e?.message || clipErr?.message || 'Share failed' };
    }
  }
}
