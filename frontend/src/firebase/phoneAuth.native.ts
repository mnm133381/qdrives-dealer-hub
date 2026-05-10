/**
 * Native (iOS/Android) phone auth implementation backed by
 * @react-native-firebase/auth. The library reads google-services.json
 * (Android) and GoogleService-Info.plist (iOS) at build time so we
 * don't import config here.
 *
 * Auto-OTP retrieval on Android is provided by the SDK out of the box
 * — when the SMS app's hash matches the Firebase Phone-Auth hash the
 * code is auto-filled. iOS does not have an OS-level auto-retriever.
 */
import auth, { FirebaseAuthTypes } from '@react-native-firebase/auth';
import { PhoneAuthApi, PhoneAuthError, PhoneOtpHandle } from './phoneAuth';

interface NativeHandle extends PhoneOtpHandle {
  readonly _kind: 'native';
  confirmation: FirebaseAuthTypes.ConfirmationResult;
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
  isAvailable: () => true,

  async sendOtp(phoneE164: string): Promise<NativeHandle> {
    try {
      const confirmation = await auth().signInWithPhoneNumber(phoneE164);
      return { _kind: 'native', confirmation };
    } catch (err: any) {
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
      throw mapError(err);
    }
  },

  async signOut() {
    try { await auth().signOut(); } catch { /* swallow */ }
  },
};

export default nativePhoneAuth;
