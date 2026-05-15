/**
 * Native (iOS/Android) phone auth implementation backed by
 * @react-native-firebase/auth. The library reads google-services.json
 * (Android) and GoogleService-Info.plist (iOS) at build time so we
 * don't import config here.
 *
 * Auto-OTP retrieval on Android is provided by the SDK out of the box
 * — when the SMS app's hash matches the Firebase Phone-Auth hash the
 * code is auto-filled. iOS does not have an OS-level auto-retriever.
 *
 * RESILIENCE: We DO NOT use a static `import` for
 * @react-native-firebase/auth because that throws synchronously at
 * module-load time inside Expo Go (the native module RNFBAppModule
 * isn't linked there). A throw at the top of this file would prevent
 * EVERY exported symbol — including `PhoneAuthError` re-exported below
 * — from ever resolving, which used to cause the JS engine error
 * "Right hand side of instanceof is not an object" when `login.tsx`
 * tried `e instanceof PhoneAuthError` in its catch block.
 *
 * Instead we resolve the SDK lazily inside the methods. If it's
 * unavailable (Expo Go preview), every call throws a clear
 * PhoneAuthError instead of crashing the module load.
 */
import { PhoneAuthApi, PhoneAuthError, PhoneOtpHandle } from './phoneAuth';

// Lazy-resolved Firebase SDK. Wrapped in a try/require so the module
// can still load in environments without the native module (Expo Go).
type FbAuth = ReturnType<typeof require>;
let _auth: FbAuth | null = null;
let _authError: any = null;
function resolveAuth(): any {
  if (_auth) return _auth;
  if (_authError) throw _authError;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    const mod = require('@react-native-firebase/auth');
    _auth = mod.default || mod;
    return _auth;
  } catch (err: any) {
    _authError = new PhoneAuthError(
      'firebase_native_missing',
      'Phone auth needs a custom development build (Expo Go does not ship the Firebase native module). Use OTP `123456` while DEV_BYPASS is on, or install a production build.'
    );
    throw _authError;
  }
}

interface NativeHandle extends PhoneOtpHandle {
  readonly _kind: 'native';
  confirmation: any;
}

function mapError(err: any): PhoneAuthError {
  const code = String(err?.code || err?.message || 'unknown');
  // Common Firebase error codes surfaced to user-friendly messages.
  const map: Record<string, string> = {
    'auth/invalid-phone-number': 'That phone number looks invalid. Please double-check.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/quota-exceeded': 'SMS quota exceeded. Please try again shortly.',
    'auth/missing-phone-number': 'Please enter a phone number first.',
    'auth/invalid-verification-code': 'Incorrect OTP. Please re-enter the code.',
    'auth/session-expired': 'OTP expired. Please request a new code.',
    'auth/code-expired': 'OTP expired. Please request a new code.',
    'auth/network-request-failed': 'Network error — check your connection.',
    'auth/app-not-authorized': 'App is not authorised by Firebase. Operations: register the SHA fingerprint.',
    'auth/invalid-app-credential': 'App credential invalid. Operations: re-check google-services.json.',
  };
  return new PhoneAuthError(code, map[code] || err?.message || 'Phone auth failed.');
}

const nativePhoneAuth: PhoneAuthApi = {
  // Library is "available" on native ONLY if it actually loaded. In
  // Expo Go this returns false so the UI can show "use 123456 in dev"
  // instead of pretending the OTP was sent.
  isAvailable: () => {
    try { resolveAuth(); return true; } catch { return false; }
  },

  async sendOtp(phoneE164: string): Promise<NativeHandle> {
    try {
      const auth = resolveAuth();
      const confirmation = await auth().signInWithPhoneNumber(phoneE164);
      return { _kind: 'native', confirmation };
    } catch (err: any) {
      // resolveAuth() already throws PhoneAuthError instances when the
      // SDK is missing — preserve those so the UI shows the helpful
      // "needs custom build" message instead of a generic Firebase
      // error code.
      if (err instanceof PhoneAuthError) throw err;
      throw mapError(err);
    }
  },

  async confirmOtp(handle: PhoneOtpHandle, code: string): Promise<string> {
    if (handle._kind !== 'native') {
      throw new PhoneAuthError('wrong_handle', 'Internal error: wrong OTP handle.');
    }
    try {
      const cred = await (handle as NativeHandle).confirmation.confirm(code);
      const user = cred?.user;
      if (!user) {
        throw new PhoneAuthError('no_user', 'OTP confirmed but no user. Please retry.');
      }
      // Force-refresh so we hand the backend a fresh ID token.
      const idToken = await user.getIdToken(true);
      if (!idToken) {
        throw new PhoneAuthError('no_token', 'Could not obtain Firebase ID token.');
      }
      return idToken;
    } catch (err: any) {
      if (err instanceof PhoneAuthError) throw err;
      throw mapError(err);
    }
  },

  async signOut() {
    try {
      const auth = resolveAuth();
      await auth().signOut();
    } catch {
      /* swallow — including missing-native-module errors */
    }
  },
};

export default nativePhoneAuth;

// Re-export so callers (`import { PhoneAuthError } from
// '../../src/firebase/phoneAuth'`) get the class even when Metro
// resolves the import to this platform-specific file. Without this,
// `e instanceof PhoneAuthError` throws "Right hand side of instanceof
// is not an object" because the symbol is undefined at runtime.
export { PhoneAuthError } from './phoneAuth';
export type { PhoneOtpHandle, PhoneAuthApi } from './phoneAuth';
