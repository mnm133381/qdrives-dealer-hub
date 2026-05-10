/**
 * In-memory store for the Firebase phone-auth confirmation handle.
 *
 * We can't pass the handle through expo-router URL params (it's an
 * opaque object containing native references / closures). Instead we
 * stash it on a module-level singleton keyed by phone. The verify
 * screen reads it back, calls confirmOtp(), and clears it.
 */
import type { PhoneOtpHandle } from './phoneAuth';

const store = new Map<string, PhoneOtpHandle>();

export function setPendingOtpHandle(phone: string, handle: PhoneOtpHandle) {
  store.set(phone, handle);
}

export function takePendingOtpHandle(phone: string): PhoneOtpHandle | null {
  // Note: we DO NOT delete on take so a re-mount of verify.tsx (e.g.
  // hot reload during dev or accidental back/forward) still finds the
  // handle. It gets overwritten on each new sendOtp() call anyway.
  return store.get(phone) || null;
}

export function clearPendingOtpHandle(phone: string) {
  store.delete(phone);
}
