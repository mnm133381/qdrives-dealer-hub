/**
 * Web phone auth — uses firebase JS SDK with an invisible reCAPTCHA
 * verifier. Initialisation is lazy: the reCAPTCHA widget mounts the
 * first time sendOtp() runs against a DOM container with the id
 * `qdrives-recaptcha`. The verify screen renders a hidden View with
 * `nativeID="qdrives-recaptcha"` so the div exists when we need it.
 *
 * NOTE: Web preview phone auth requires the Firebase project to
 * whitelist the preview origin under Authentication → Settings →
 * Authorized domains. If absent, the call fails with
 * `auth/unauthorized-domain` and the user gets a clean error.
 */
import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  getAuth, RecaptchaVerifier, signInWithPhoneNumber,
  ConfirmationResult, Auth,
} from 'firebase/auth';
import { firebaseConfig } from './config';
import { PhoneAuthApi, PhoneAuthError, PhoneOtpHandle } from './phoneAuth';

interface WebHandle extends PhoneOtpHandle {
  readonly _kind: 'web';
  confirmation: ConfirmationResult;
}

let appInstance: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let verifier: RecaptchaVerifier | null = null;

function ensureInit(): Auth {
  if (!appInstance) {
    appInstance = getApps().length ? getApp() : initializeApp(firebaseConfig);
  }
  if (!authInstance) {
    authInstance = getAuth(appInstance);
  }
  return authInstance;
}

function ensureVerifier(): RecaptchaVerifier {
  const auth = ensureInit();
  if (verifier) return verifier;
  // Wait for DOM to have the container — the verify screen mounts a
  // <View nativeID="qdrives-recaptcha" /> which becomes a div on web.
  if (typeof document === 'undefined') {
    throw new PhoneAuthError('no_dom', 'reCAPTCHA host not available.');
  }
  // If the container is missing (e.g. the user navigated directly to
  // an internal route), inject one ourselves.
  let container = document.getElementById('qdrives-recaptcha');
  if (!container) {
    container = document.createElement('div');
    container.id = 'qdrives-recaptcha';
    container.style.position = 'fixed';
    container.style.bottom = '0';
    container.style.right = '0';
    container.style.width = '1px';
    container.style.height = '1px';
    container.style.opacity = '0';
    document.body.appendChild(container);
  }
  verifier = new RecaptchaVerifier(auth, 'qdrives-recaptcha', { size: 'invisible' });
  return verifier;
}

function mapError(err: any): PhoneAuthError {
  const code = String(err?.code || 'unknown');
  const map: Record<string, string> = {
    'auth/invalid-phone-number': 'That phone number looks invalid.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/quota-exceeded': 'SMS quota exceeded. Please try again shortly.',
    'auth/captcha-check-failed': 'reCAPTCHA failed. Please retry.',
    'auth/missing-phone-number': 'Please enter a phone number first.',
    'auth/invalid-verification-code': 'Incorrect OTP. Please re-enter the code.',
    'auth/session-expired': 'OTP expired. Please request a new code.',
    'auth/code-expired': 'OTP expired. Please request a new code.',
    'auth/unauthorized-domain': 'This origin is not authorised by Firebase. Add it under Auth → Settings → Authorized domains.',
    'auth/network-request-failed': 'Network error — check your connection.',
  };
  return new PhoneAuthError(code, map[code] || err?.message || 'Phone auth failed.');
}

const webPhoneAuth: PhoneAuthApi = {
  isAvailable: () => typeof document !== 'undefined',

  async sendOtp(phoneE164: string): Promise<WebHandle> {
    const auth = ensureInit();
    try {
      const v = ensureVerifier();
      const confirmation = await signInWithPhoneNumber(auth, phoneE164, v);
      return { _kind: 'web', confirmation };
    } catch (err: any) {
      // Reset the verifier on failure — re-using a stale captcha throws.
      try { verifier?.clear(); } catch {}
      verifier = null;
      throw mapError(err);
    }
  },

  async confirmOtp(handle: PhoneOtpHandle, code: string): Promise<string> {
    if (handle._kind !== 'web') {
      throw new PhoneAuthError('wrong_handle', 'Internal error: wrong OTP handle.');
    }
    try {
      const cred = await (handle as WebHandle).confirmation.confirm(code);
      const user = cred?.user;
      if (!user) throw new PhoneAuthError('no_user', 'OTP confirmed but no user.');
      const idToken = await user.getIdToken(true);
      if (!idToken) throw new PhoneAuthError('no_token', 'Could not obtain Firebase ID token.');
      return idToken;
    } catch (err: any) {
      throw mapError(err);
    }
  },

  async signOut() {
    try { await ensureInit().signOut(); } catch { /* swallow */ }
  },
};

export default webPhoneAuth;

// Re-export the error class so `import { PhoneAuthError } from
// '../../src/firebase/phoneAuth'` continues to work on web (Metro
// resolves the import to THIS file first because of the `.web.ts`
// extension; without this re-export, PhoneAuthError is `undefined`
// at runtime and any `e instanceof PhoneAuthError` check throws the
// JS engine error "Right hand side of instanceof is not an object").
export { PhoneAuthError } from './phoneAuth.shared';
export type { PhoneOtpHandle, PhoneAuthApi } from './phoneAuth.shared';
