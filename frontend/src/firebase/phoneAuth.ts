/**
 * Cross-platform phone-auth API surface. Metro picks the platform
 * sibling automatically:
 *   - phoneAuth.native.ts  →  iOS / Android (uses @react-native-firebase/auth)
 *   - phoneAuth.web.ts     →  Web preview     (uses firebase JS SDK + reCAPTCHA)
 *
 * This file exists purely so TypeScript can resolve the API shape
 * regardless of platform during type-checking.
 */
export interface PhoneOtpHandle {
  // Opaque platform-specific handle returned by sendOtp().
  readonly _kind: 'native' | 'web';
}

export interface PhoneAuthApi {
  /**
   * Trigger an SMS OTP delivery. On web this also lazily mounts an
   * invisible reCAPTCHA into the DOM. The returned handle must be
   * passed to confirmOtp().
   */
  sendOtp(phoneE164: string): Promise<PhoneOtpHandle>;
  /** Verify the SMS code and return a Firebase ID token for backend exchange. */
  confirmOtp(handle: PhoneOtpHandle, code: string): Promise<string>;
  /** True if Firebase phone auth is operational on this platform. */
  isAvailable(): boolean;
  /** Sign the current Firebase user out (called after backend issues our JWT). */
  signOut(): Promise<void>;
}

export class PhoneAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// Default export gets shadowed by the platform-specific files via
// Metro's `.native.ts` / `.web.ts` resolution. This stub only runs
// on platforms we don't explicitly target (currently none).
const stub: PhoneAuthApi = {
  isAvailable: () => false,
  async sendOtp() {
    throw new PhoneAuthError('unsupported', 'Phone auth is not supported on this platform.');
  },
  async confirmOtp() {
    throw new PhoneAuthError('unsupported', 'Phone auth is not supported on this platform.');
  },
  async signOut() { /* no-op */ },
};

export default stub;
